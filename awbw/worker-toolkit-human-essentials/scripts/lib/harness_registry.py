"""harness_registry.py — Python loader for ``scripts/harness-registry.toml``.

The ONE loader for the registry: TS callers shell into ``resolve_harness.py`` rather than
parse the TOML themselves, which is why the toolkit ships no TOML parser for TS (its
package.json has no zod/smol-toml).

This module supersedes ``benchmark_models_lib``'s ``HARNESS_BY_IMPORT_PATH`` and
``LEGACY_BARE_MODEL_AGENTS``; those should read from here rather than keep private
copies.

Harbor-free and dependency-free (stdlib ``tomllib``) so it can be imported from a
sandbox agent, a plain unit test, or the devcontainer python alike.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

REGISTRY_PATH = Path(__file__).resolve().parent.parent / "harness-registry.toml"

MODEL_ID_SHAPES = frozenset({"bare", "provider/model", "provider:model"})


@dataclass(frozen=True)
class Harness:
    """One harness, as declared in harness-registry.toml."""

    id: str
    label: str
    agent_import_path: str
    model_id_shape: str
    writes_atif: bool
    capture: bool
    seed_native: bool
    seed_atif: bool
    agent_import_path_single_turn: str | None = None
    # Browser-opt-in variants (`[metadata] browser = true`). A harness that has no variant
    # keeps its normal class: codex, for instance, gains the browser and its disclosure but
    # has no `Read` equivalent to switch toolsets for.
    agent_import_path_browser: str | None = None
    agent_import_path_single_turn_browser: str | None = None
    import_path_aliases: tuple[str, ...] = ()
    legacy_bare_model_rows: bool = False
    default_model: str | None = None
    effort_kwarg: str = ""
    effort_default: str | None = None
    # Agent kwarg that opts a trial into the harness's fast/priority serving mode
    # (claude-code: fast mode). Empty means the harness has none and --fast refuses.
    fast_kwarg: str = ""
    key_env: str | None = None
    base_url_env: str | None = None
    proxy_path: str | None = None
    flaky_hangs: bool = False
    enabled: bool = True
    # Worker-container fields; see the registry header.
    authoring: bool = False
    cli: str | None = None
    install: str | None = None
    skills_dir: str | None = None
    auth_path: str | None = None
    auth_key_env: str | None = None
    explore_launch: str | None = None
    config_path: str | None = None
    # Config the harness needs wherever it runs, trial sandbox included.
    agent_config: str | None = None
    # Config for both worker containers (explore and authoring).
    container_config: str | None = None
    # Config for the EXPLORE container only — the capture hooks, whose commands ship in
    # explore/plugins/. Writing them in authoring would register hooks against files that
    # are not there, firing on every prompt.
    explore_config: str | None = None
    # Fields added for a later phase, kept verbatim so this loader doesn't have to
    # be edited in lockstep with the schema.
    extra: dict = field(default_factory=dict, compare=False)

    def agent_import_path_for(self, *, multi_turn: bool, browser: bool = False) -> str:
        """Agent class to launch. Multi-turn tasks need the resuming class; a
        single-turn task given it would try to resume a session that isn't there.

        ``browser`` selects the opt-in variant, which for claude also carries the ``Read``
        built-in — a different toolset is a different agent, so it is a different class with
        its own name rather than a flag on the canonical one. Harnesses without a variant fall
        through to their normal class."""
        if browser:
            variant = (
                self.agent_import_path_browser
                if multi_turn
                else (self.agent_import_path_single_turn_browser or self.agent_import_path_browser)
            )
            if variant:
                return variant
        if multi_turn:
            return self.agent_import_path
        return self.agent_import_path_single_turn or self.agent_import_path

    def row_label(self, model: str) -> str:
        """Row identity for one trial: bare model for legacy harnesses (so
        published manifests keep their labels), else ``<harness>:<model>``."""
        return model if self.legacy_bare_model_rows else f"{self.id}:{model}"

    def agent_config_overrides(self) -> dict[str, str]:
        """``agent_config`` as flat ``dotted.key -> value`` pairs in CLI-override form.

        Values are rendered bare — ``disabled``, not ``"disabled"``. Every consumer
        interpolates these into a shell command, which would strip the quotes anyway;
        emitting them would only make the result depend on how many shell layers the
        string crosses. Bare is what the CLIs document (``-c model="o3"`` reaches the
        binary as ``model=o3``).

        These settings ride the command line as ``-c dotted.key=value`` everywhere the
        harness runs, never a config file. A trial sandbox rules the file out: the
        harness's own runner appends root keys to it, and TOML has no way back to the
        root scope once a table has opened, so a table we appended would swallow them.
        Overrides compose in any order and beat the file, so the same rendering serves
        the explore launcher too — one declaration, one mechanism.
        """
        if not self.agent_config:
            return {}
        try:
            parsed = tomllib.loads(self.agent_config)
        except tomllib.TOMLDecodeError as exc:
            raise HarnessRegistryError(
                f"{self.id}: agent_config is not valid TOML ({exc})"
            ) from exc

        flat: dict[str, str] = {}

        def walk(node: dict, prefix: str) -> None:
            for key, value in node.items():
                path = f"{prefix}{key}"
                if isinstance(value, dict):
                    walk(value, f"{path}.")
                elif isinstance(value, bool):
                    flat[path] = "true" if value else "false"
                elif isinstance(value, (int, float)):
                    flat[path] = str(value)
                elif isinstance(value, str):
                    if value != value.strip() or any(c in value for c in " \"'\\"):
                        raise HarnessRegistryError(
                            f"{self.id}: agent_config key {path!r} has a value needing "
                            "shell quoting, which the -c override form cannot carry"
                        )
                    flat[path] = value
                else:
                    raise HarnessRegistryError(
                        f"{self.id}: agent_config key {path!r} has type "
                        f"{type(value).__name__}, which has no -c override form"
                    )

        walk(parsed, "")
        return flat

    def container_config_text(self, *, surface: str) -> str | None:
        """Config file body for a worker container. `surface` is "explore" or
        "authoring"; explore additionally gets `explore_config`. Root keys come from
        `container_config` first, so appending a table section stays valid TOML."""
        parts = [self.container_config]
        if surface == "explore":
            parts.append(self.explore_config)
        kept = [part.strip("\n") for part in parts if part and part.strip()]
        return "\n\n".join(kept) + "\n" if kept else None

    def agent_config_flags(self) -> str:
        """``agent_config`` as a ``-c key=value`` command-line string."""
        return " ".join(
            f"-c {key}={value}"
            for key, value in sorted(self.agent_config_overrides().items())
        )

    def explore_launch_command(self) -> str | None:
        """``explore_launch`` with the registry's own values substituted in.

        The worker's Explore session and the trial must run the same agent, so the
        model, effort and reductions are declared once here and rendered into both.
        A literal in the launch string would be a second declaration, and the two
        would drift the first time one of them was updated alone.

        Only these three placeholders are substituted; ``$@`` and
        ``$RACCOON_TOOLSET_NOTE`` stay for the launcher's own shell to expand.
        """
        if not self.explore_launch:
            return None
        return (
            self.explore_launch.replace("$RACCOON_AGENT_FLAGS", self.agent_config_flags())
            .replace("$RACCOON_MODEL", self.default_model or "")
            .replace("$RACCOON_EFFORT", self.effort_default or "")
        )

    def known_import_paths(self) -> tuple[str, ...]:
        paths = [self.agent_import_path, *self.import_path_aliases]
        if self.agent_import_path_single_turn:
            paths.append(self.agent_import_path_single_turn)
        return tuple(paths)


_KNOWN_FIELDS = frozenset(
    {
        "id",
        "label",
        "agent_import_path",
        "agent_import_path_single_turn",
        "agent_import_path_browser",
        "agent_import_path_single_turn_browser",
        "import_path_aliases",
        "legacy_bare_model_rows",
        "default_model",
        "model_id_shape",
        "effort_kwarg",
        "effort_default",
        "fast_kwarg",
        "key_env",
        "base_url_env",
        "proxy_path",
        "writes_atif",
        "capture",
        "seed_native",
        "seed_atif",
        "flaky_hangs",
        "enabled",
        "authoring",
        "cli",
        "install",
        "skills_dir",
        "auth_path",
        "auth_key_env",
        "explore_launch",
        "config_path",
        "agent_config",
        "container_config",
        "explore_config",
    }
)

_REQUIRED_FIELDS = (
    "id",
    "label",
    "agent_import_path",
    "model_id_shape",
    "writes_atif",
    "capture",
    "seed_native",
    "seed_atif",
)


class HarnessRegistryError(ValueError):
    """Malformed registry. Raised rather than tolerated: a broken registry is a
    broken deployment, and silently defaulting would pick the wrong agent."""


def _references_agent_flags(launch: str) -> bool:
    return "$RACCOON_AGENT_FLAGS" in launch or "${RACCOON_AGENT_FLAGS}" in launch


@dataclass(frozen=True)
class HarnessRegistry:
    version: int
    harnesses: tuple[Harness, ...]

    def all(self) -> tuple[Harness, ...]:
        return self.harnesses

    def enabled(self) -> tuple[Harness, ...]:
        return tuple(h for h in self.harnesses if h.enabled)

    def authoring(self) -> tuple[Harness, ...]:
        """Harnesses a worker can author with — what the worker containers install.
        Narrower than enabled(): a harness can be runnable in a trial without having
        an authoring story (no CLI to converse with, or no capture)."""
        return tuple(h for h in self.harnesses if h.enabled and h.authoring)

    def find(self, harness_id: str) -> Harness | None:
        return next((h for h in self.harnesses if h.id == harness_id), None)

    def require(self, harness_id: str) -> Harness:
        harness = self.find(harness_id)
        if harness is not None:
            return harness
        available = ", ".join(sorted(h.id for h in self.enabled()))
        raise HarnessRegistryError(
            f'Unknown harness "{harness_id}". Available: {available}'
        )

    def by_import_path(self, agent: str) -> Harness | None:
        """Resolve an agent identity — a ``name()`` or import path from
        ``result.json`` ``config.agent``, or a manifest row — to its harness."""
        needle = (agent or "").strip()
        if not needle:
            return None
        for harness in self.harnesses:
            if needle == harness.id or needle in harness.known_import_paths():
                return harness
        return None


def _build(entry: dict, index: int) -> Harness:
    for name in _REQUIRED_FIELDS:
        if name not in entry:
            raise HarnessRegistryError(
                f"harness[{index}]: missing required field '{name}'"
            )
    shape = entry["model_id_shape"]
    if shape not in MODEL_ID_SHAPES:
        raise HarnessRegistryError(
            f"harness[{index}] ({entry['id']}): model_id_shape {shape!r} not one of "
            f"{sorted(MODEL_ID_SHAPES)}"
        )
    # These three reach `eval` in setup-harnesses.sh, which is how they support the
    # `${CODEX_HOME:-$HOME/.codex}` default-value syntax that python's expandvars cannot
    # express. Under eval a backtick or $( would EXECUTE, so refuse them here — the registry
    # is ours, but "ours" is not an argument that survives a careless future edit.
    for shell_field in ("config_path", "auth_path", "skills_dir"):
        value = entry.get(shell_field)
        if not isinstance(value, str):
            continue
        # A backtick or $( executes outright. A double quote closes the string these are
        # interpolated into, and a semicolon then starts a new command inside it — same
        # outcome, one step removed.
        bad = [t for t in ("`", "$(", '"', ";") if t in value]
        if bad:
            raise HarnessRegistryError(
                f"harness[{index}] ({entry['id']}): {shell_field} contains "
                f"{', '.join(repr(t) for t in bad)} ({value!r}). This value is shell-"
                f"expanded, so that would execute; use plain $VAR or ${{VAR:-default}} only."
            )

    launch = entry.get("explore_launch")
    if entry.get("agent_config") and launch and not _references_agent_flags(launch):
        raise HarnessRegistryError(
            f"harness[{index}] ({entry['id']}): declares agent_config but its "
            "explore_launch does not pass $RACCOON_AGENT_FLAGS. The worker's session "
            "would then run with a different toolset than the trial it is authoring "
            "for, which is the drift agent_config exists to prevent."
        )
    return Harness(
        id=entry["id"],
        label=entry["label"],
        agent_import_path=entry["agent_import_path"],
        agent_import_path_single_turn=entry.get("agent_import_path_single_turn"),
        agent_import_path_browser=entry.get("agent_import_path_browser"),
        agent_import_path_single_turn_browser=entry.get("agent_import_path_single_turn_browser"),
        import_path_aliases=tuple(entry.get("import_path_aliases", ())),
        legacy_bare_model_rows=bool(entry.get("legacy_bare_model_rows", False)),
        default_model=entry.get("default_model"),
        model_id_shape=shape,
        effort_kwarg=entry.get("effort_kwarg", ""),
        effort_default=entry.get("effort_default"),
        fast_kwarg=entry.get("fast_kwarg", ""),
        key_env=entry.get("key_env"),
        base_url_env=entry.get("base_url_env"),
        proxy_path=entry.get("proxy_path"),
        writes_atif=bool(entry["writes_atif"]),
        capture=bool(entry["capture"]),
        seed_native=bool(entry["seed_native"]),
        seed_atif=bool(entry["seed_atif"]),
        flaky_hangs=bool(entry.get("flaky_hangs", False)),
        enabled=bool(entry.get("enabled", True)),
        authoring=bool(entry.get("authoring", False)),
        cli=entry.get("cli"),
        install=entry.get("install"),
        skills_dir=entry.get("skills_dir"),
        auth_path=entry.get("auth_path"),
        auth_key_env=entry.get("auth_key_env"),
        explore_launch=entry.get("explore_launch"),
        config_path=entry.get("config_path"),
        agent_config=entry.get("agent_config"),
        container_config=entry.get("container_config"),
        explore_config=entry.get("explore_config"),
        extra={k: v for k, v in entry.items() if k not in _KNOWN_FIELDS},
    )


_cache: dict[Path, HarnessRegistry] = {}


def load_harness_registry(path: Path | str = REGISTRY_PATH) -> HarnessRegistry:
    """Parse and validate the registry. Raises HarnessRegistryError on a malformed
    file, a duplicate id, or an import path claimed by two harnesses (which would
    make ``by_import_path`` depend on declaration order)."""
    resolved = Path(path).resolve()
    if resolved in _cache:
        return _cache[resolved]

    with open(resolved, "rb") as handle:
        doc = tomllib.load(handle)

    if "version" not in doc:
        raise HarnessRegistryError("harness-registry: missing 'version'")
    entries = doc.get("harness") or []
    if not entries:
        raise HarnessRegistryError("harness-registry: no [[harness]] entries")

    harnesses = tuple(_build(entry, i) for i, entry in enumerate(entries))

    seen_ids: set[str] = set()
    for harness in harnesses:
        if harness.id in seen_ids:
            raise HarnessRegistryError(
                f"harness-registry: duplicate harness id: {harness.id}"
            )
        seen_ids.add(harness.id)

    owners: dict[str, str] = {}
    for harness in harnesses:
        for import_path in harness.known_import_paths():
            owner = owners.get(import_path)
            if owner is not None and owner != harness.id:
                raise HarnessRegistryError(
                    f'harness-registry: import path "{import_path}" claimed by both '
                    f'"{owner}" and "{harness.id}"'
                )
            owners[import_path] = harness.id

    registry = HarnessRegistry(version=int(doc["version"]), harnesses=harnesses)
    _cache[resolved] = registry
    return registry
