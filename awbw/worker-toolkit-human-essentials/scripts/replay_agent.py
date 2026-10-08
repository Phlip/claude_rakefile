"""
Harbor agent adapter that re-grades an existing reference run by replaying
its captured workspace state — no model calls, no agent work.

Reads a `reference_run_dir` pointing at a `reference-runs/<id>/` directory
captured during a prior real trial. Inside that dir:

  agent/trajectory.json — the grader reads this via the symlink
                          /tmp/outputs/task_transcript.txt → /logs/agent/trajectory.json
  agent-output/         — files the agent created or modified (captured by
                          tests/test.sh after the agent ran)
  agent-output/_HARBOR_DELETIONS.txt
                        — list of tracked files the agent deleted (one path
                          per line). Empty/absent when nothing was deleted.

On run() (after the trial's docker env is up and /workspace has the base
state from the Dockerfile's COPY workspace/), the adapter:

  1. Uploads agent-output/ into /workspace — overlays the agent's surviving
     edits on top of the base workspace.
  2. Applies _HARBOR_DELETIONS.txt by `rm -f`'ing each listed path under
     /workspace. (The marker file itself was uploaded in step 1; it gets
     removed too so the verifier's re-capture doesn't pick it up as
     untracked content.)
  3. Uploads trajectory.json to /logs/agent/trajectory.json so the grader
     sees the same transcript it would have on the original run.

Verifier then runs as it would for any real trial — exact same code path,
exact same artifacts, just with the agent phase replaced by a deterministic
file-overlay. See scripts/harbor-regrade for the host-side wrapper.

Older reference runs captured before the deletion-capture line shipped
(verifier-deletion-capture PR #219) won't have _HARBOR_DELETIONS.txt; the
deletion-replay step is a no-op in that case. Deletions made in those runs
remain lost.
"""

from pathlib import Path, PurePosixPath

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

# Sibling module (shipped alongside in the worker toolkit; on PYTHONPATH via
# harbor-regrade). Kept harbor-free so its logic stays unit-testable.
from reference_run_capture import captured_mutating_tools

_WORKSPACE = PurePosixPath("/workspace")
_DELETIONS_MARKER = "_HARBOR_DELETIONS.txt"


class ReplayAgent(BaseAgent):
    """Replays a captured reference run so the verifier can be re-graded
    without invoking the model again."""

    SUPPORTS_WINDOWS: bool = False  # paths below assume POSIX /workspace.

    def __init__(
        self,
        logs_dir,
        reference_run_dir: str,
        source_agent_import_path: str | None = None,
        source_model_name: str | None = None,
        **kwargs,
    ):
        # `source_*` are provenance, not behaviour: harbor-regrade reads them off the
        # source run and passes them so THIS replay's result.json records which
        # harness and model produced the trajectory being graded. A replay reports
        # `replay_agent:ReplayAgent` with model_name null, and the source run is
        # usually deleted (a regrade is copied back over what it regraded), so a bare
        # reference_run_dir pointer does not survive as provenance.
        #
        # They must be accepted here rather than left in **kwargs: harbor records the
        # trial config's agent kwargs regardless of what the agent does with them, but
        # BaseAgent would reject the unknown keys and take every regrade down with it.
        self._source_agent_import_path = source_agent_import_path
        self._source_model_name = source_model_name
        super().__init__(logs_dir=logs_dir, **kwargs)
        ref = Path(reference_run_dir).expanduser().resolve()
        if not ref.is_dir():
            raise FileNotFoundError(f"reference_run_dir does not exist: {ref}")
        self._reference_run_dir = ref
        self._agent_output_dir = ref / "agent-output"
        self._trajectory_path = ref / "agent" / "trajectory.json"

    @staticmethod
    def name() -> str:
        return "replay"

    def version(self) -> str:
        return "1.0.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        # No installation needed; the verifier brings everything it requires.
        return

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Advisory tasks — the agent only reads and answers in chat — make NO
        # workspace edits, so a faithful capture of one has an empty (or, in
        # older pipelines, absent) agent-output/. That is not a data gap: the
        # deliverable is the agent's final message, captured in
        # agent/trajectory.json, which the grader reads via
        # /tmp/outputs/task_transcript.txt. So overlay captured edits when
        # present; otherwise grade the base workspace + transcript, exactly
        # what the original advisory grading saw.
        if not self._agent_output_dir.is_dir():
            mutating = captured_mutating_tools(self._reference_run_dir)
            if mutating:
                # The agent edited files but they weren't captured — grading the
                # base workspace would silently score the wrong state. Refuse.
                raise FileNotFoundError(
                    f"reference_run_dir {self._reference_run_dir} has no "
                    f"agent-output/ but its captured transcript shows "
                    f"file-mutating tool calls {sorted(mutating)}. The agent's "
                    f"workspace edits were lost at capture time, so this run "
                    f"cannot be faithfully re-graded — re-capture it."
                )
            self.logger.warning(
                "reference_run %s has no agent-output/ and made no "
                "file-mutating tool calls — treating it as an advisory run and "
                "grading the base workspace + captured transcript.",
                self._reference_run_dir,
            )
            # Skip the overlay/deletion steps; fall through to trajectory upload.
            await self._upload_trajectory(environment)
            return

        # 1. Overlay captured agent edits onto the base /workspace.
        await environment.upload_dir(
            source_dir=str(self._agent_output_dir),
            target_dir=str(_WORKSPACE),
        )

        # 2. Apply captured deletions, if present. Read the marker from the
        #    host so we don't have to shell into the container to parse it,
        #    then issue per-path rm's plus a final cleanup of the marker
        #    itself (which was uploaded in step 1).
        host_marker = self._agent_output_dir / _DELETIONS_MARKER
        if host_marker.exists():
            deletion_paths = [
                line.strip()
                for line in host_marker.read_text().splitlines()
                if line.strip()
            ]
            for raw in deletion_paths:
                self._validate_relative_path(raw)
                await environment.exec(
                    command=f'rm -f -- "/workspace/{raw}"',
                    user="root",
                )
            await environment.exec(
                command=f'rm -f -- "/workspace/{_DELETIONS_MARKER}"',
                user="root",
            )

        # 3. Materialize the captured trajectory at the path the grader's
        #    test.sh symlinks to /tmp/outputs/task_transcript.txt.
        await self._upload_trajectory(environment)

    async def _upload_trajectory(self, environment: BaseEnvironment) -> None:
        """Upload agent/trajectory.json to the path the grader's test.sh
        symlinks to /tmp/outputs/task_transcript.txt. Shared by the normal
        (overlay) path and the advisory (no agent-output) path."""
        if self._trajectory_path.exists():
            env_paths = EnvironmentPaths.for_os(environment.os)
            await environment.upload_file(
                source_path=str(self._trajectory_path),
                target_path=str(env_paths.agent_dir / "trajectory.json"),
            )
        else:
            # The grader's test.sh reads /tmp/outputs/task_transcript.txt,
            # which symlinks to trajectory.json. Without the file the symlink
            # dangles and the grader sees an empty transcript — so the regrade
            # will look like the agent did nothing. Yell via harbor's own
            # logger (self.logger is a child of harbor.utils.logger) so the
            # warning lands in trial.log, not a stray "replay-agent" logger
            # nothing's wired to.
            self.logger.warning(
                "reference_run %s has no agent/trajectory.json — the grader "
                "will see an empty transcript. Investigate whether the source "
                "run was produced by an older harbor that didn't write the "
                "ATIF file (or by snapshot_agent before the multi-JSONL fix).",
                self._reference_run_dir,
            )

    @staticmethod
    def _validate_relative_path(raw: str) -> None:
        """Guard against absolute paths and `..` traversal in the deletions
        manifest. The marker should only list paths *under* the workspace
        root; anything else is a captured-data integrity problem worth
        failing loudly on."""
        if not raw or raw.startswith("/"):
            raise ValueError(f"refusing absolute path in {_DELETIONS_MARKER}: {raw!r}")
        if ".." in PurePosixPath(raw).parts:
            raise ValueError(f"refusing `..` traversal in {_DELETIONS_MARKER}: {raw!r}")
