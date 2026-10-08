# Task Authoring Toolkit

This toolkit helps you create RL training tasks by capturing real coding agent mistakes. You work with a coding agent — Codex CLI by default, or Claude Code — in a real codebase, and when you notice a mistake, you snapshot the conversation. The snapshot becomes the basis for a task that tests whether agents make the same error.

This toolkit has two dev containers:

1. **Explore container** (`explore/`): This is where you interact with the codebase as a developer. It has both agents pre-installed — Codex CLI (the default) and Claude Code with its reduced `bash` + `str_replace_editor` toolset — along with the snapshot command. The repo has full git history and you can check out any commit.
2. **Authoring container** (toolkit root): This is where you build tasks, run Harbor trials, and package submissions.

If you want, you can also create a task fully from scratch – no need to start from a snapshot. But we think most people will find the snapshot approach easier. When you start from scratch, you're searching for a prompt that will cause the agent to make a mistake, which, at this point, is actually pretty tough.

But if you just use the agent naturally, you'll find mistakes pretty quickly. Plus, your prompts will generally be more realistic, because it'll be preceded by your natural conversation.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (running)
- The API key and base URL you were given

## Getting started

### 1. Create your `.env` file

```bash
[host] $ cat > .env <<'EOF'
ANTHROPIC_API_KEY=...
ANTHROPIC_BASE_URL=...
EOF
```

Use both values exactly as you were given them. `ANTHROPIC_BASE_URL` is what lets the
containers set up **every** agent — Codex included — from the one key, so leave it out and
`codex` will install but fail to authenticate.

### 2. Start the Explore container

```bash
[host] $ cd explore
[host] $ npx @devcontainers/cli up
```

The first build takes a few minutes. After that, startup is fast.

If you use VS Code, you can install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) and open the `explore/` folder — VS Code will prompt you to reopen in the container.

### 3. Open a shell and start your agent

```bash
[host] $ npx @devcontainers/cli exec bash
```

Then inside the container, start whichever agent you want to author with:

```bash
[devcontainer:explore] $ codex      # Codex CLI (the default)
[devcontainer:explore] $ claude     # Claude Code
```

Both are installed and pre-configured — model, reasoning effort and tool set are set up for you, so start them with no arguments.

**Pick one agent and use it for the whole task.** The task records which agent authored it, and every trial replays on that same agent, so exploring in one and snapshotting in the other measures the wrong thing. If you want to author with Claude, use Claude in the Authoring container as well.

Claude will ask you if you want to authenticate via the API key in the env, and tell you this isn't recommended. **Do it anyway.** For our usecase, it is recommended.

### Exploring a different commit

The Explore container starts at the default commit specified in `toolkit.json`. To explore a different point in the repo's history:

```bash
[devcontainer:explore] $ git checkout <commit-sha>
```

The repo has full git history, so you can check out any commit. Use `git log --oneline` to browse.

### Running the app in a browser

Some repos let you run the real app so you can click through the actual workflows while you explore. Inside the Explore container, one command does it:

```bash
[devcontainer:explore] $ run-app            # single-repo toolkit
[devcontainer:explore] $ run-app <repo>     # polyglot toolkit — name the member you want (`ls repos/`)
```

On a polyglot toolkit the bare form starts the toolkit's default member, which is probably not the one you're working on — first use of a member installs its dependencies and provisions its database, so it's worth naming the one you mean.

`run-app` makes sure the database is up, starts the app's server and client in the background, waits until they're listening, then prints the URL to open and a login. It writes logs to a file so your shell stays clean.

```bash
[devcontainer:explore] $ run-app --logs     # follow the logs (Ctrl-C stops following, not the app)
[devcontainer:explore] $ run-app --restart  # restart after a code change
[devcontainer:explore] $ run-app --stop     # stop the app
[devcontainer:explore] $ run-app --status   # is it running?
```

The welcome banner prints the exact URL and login for your repo when the container starts.

**Running more than one Explore container at once.** With zero config you can run _one of each repo_ side by side: each repo defaults to its own host port, and `run-app` always prints the right URL for the repo you're in.

To run _another container with its own separate working tree_ — e.g. to explore a different commit / repo state at the same time — use the `instance.js` helper. (If you only want several Claude sessions on the **same** state, you don't need this at all — just open more shells into the one container with `npx @devcontainers/cli exec bash`.) You do **not** unzip the toolkit again: each instance gets its own container, its own auto-picked host port, and its own repo working tree, so a `git checkout` in one never disturbs another.

Run these on the host, from the `explore/` folder (where you ran `up`):

```bash
[host] $ node instance.js b        # create/start instance "b", prints its URL
[host] $ node instance.js shell b   # open a shell in it (then run `run-app` inside)
[host] $ node instance.js list      # list your extra instances
[host] $ node instance.js stop b    # stop + remove it (keeps the repo clone)
```

The normal single container is still just `npx @devcontainers/cli up` — `instance.js` is only for running _extra_ ones. (First start of an instance builds its repo + deps, so it takes a few minutes, same as the first `up`.)

One caveat for **Palolo** specifically: a second Palolo container starts fine for exploring with Claude, but its app _in the browser_ won't fully work — the client is built to call the API at `localhost:3001`, so it reaches the first container's API, not its own. ZenBill has no such limitation and runs multiple instances cleanly.

**ZenBill note.** The ZenBill app routes by subdomain, so plain `http://localhost` shows only the Rails welcome page. To reach the real UI, add these to your host's `/etc/hosts`, then open `http://app.dev.zenbill.com:<port>`:

```
127.0.0.1 app.dev.zenbill.com api.dev.zenbill.com onboarding.dev.zenbill.com
```

### 4. Explore the codebase

Work with the agent naturally. Ask it to explore the codebase, analyze architecture, explain subsystems, evaluate design decisions — anything that exercises its reasoning about code. Either agent works through the shell rather than through dedicated file tools: Claude Code uses the same reduced `bash` + `str_replace_editor` toolset as Harbor trials (editing through `/opt/agent-cli/str_replace_editor`), and Codex works through its `exec` shell tool.

```
> I want to understand the payment processing subsystem. Give me a high-level overview.
```

Keep going. Ask follow-up questions. Push the agent to go deeper. The goal is to find a place where the agent makes a mistake — speculates without evidence, gets facts wrong, makes unsupported claims, etc.

### Browsing the reference-data corpus (only some toolkits)

Toolkits that ship a reference-data corpus (the source company's real slack / tickets / email /
support data at `data/zeta-corpus/`, mounted at `/data/zeta-corpus`) also ship a **corpus viewer**:
a local web UI with full-text search across every source, channel and ticket browsing, per-person
activity, and cross-references between tickets and the chat around them. It starts automatically
with the Explore container — the welcome banner prints the URL (also: `view-corpus`).

It's the fastest way to find a real moment to build a task around: an incident in
`errors-production`, the design debate behind a feature, the support fallout of a bug. Every doc
links back to its raw file under `/data/zeta-corpus/...` for use in task materials. The underlying
index (`data/corpus-index/corpus.db`, SQLite) is also directly queryable — schema and example
queries in `explore/corpus-viewer/README.md`. Toolkits without a corpus don't have any of this.

### 5. Snapshot the mistake

When you notice the agent made a mistake, run the snapshot command:

```
[claude] /create-snapshot:snapshot
[codex]  $snapshot
```

The agent will ask you some questions. Then it captures the full conversation, repo state, and your annotations into `snapshots/`.

**Tip:** If you need to rewind the conversation first (because the mistake was a few turns back), use Claude Code's undo feature to go back to the right point, then snapshot. Codex has no conversation rewind, so when authoring with Codex, snapshot as soon as you notice the mistake — there's no way back to an earlier turn.

### 6. Switch to the Authoring container

Go back to the toolkit root and start the Authoring container:

```bash
[host] $ cd ..
[host] $ npx @devcontainers/cli up
[host] $ npx @devcontainers/cli exec bash
```

Both agents are available here too. Start the same one you explored with — `claude` or `codex`.

### 7. Build a harbor task from the snapshot

```bash
[devcontainer:authoring] $ npx tsx scripts/snapshot-to-task.ts --snapshot explore/snapshots/<your-snapshot>
```

This creates a full harbor task in `harbor-tasks/` with:

- The workspace (repo at the right commit)
- The conversation session (for resume)
- `instruction.md` (auto-extracted from your last message)
- A Dockerfile that sets up session resume
- Scaffolded `tests/holistic-rubric.md` (you fill this in)

### 8. Write the holistic rubric

This is the part that requires your judgment.

Trials grade under the **Grading Standard**: eight criteria (Integrity, Narrow Correctness, Broader Correctness / craft, Persistence, Communication, Verification & Thoroughness, Common Sense, Thought Partnership) producing one score — the mean of the non-N/A criteria, minus any heavy penalties your rubric directs at the overall score, floored at 0.0. A penalty that names a criterion is folded into that criterion's score instead. The full standard is at `task-shared/grading-standard.md`, and it is embedded in the grader's system prompt (`tests/grader-system-prompt-consolidated.md`), so your rubric never restates it.

Open `harbor-tasks/<your-task>/tests/holistic-rubric.md` and fill it in: the task context, the ground truth you established while authoring, what strong and weak responses look like on each criterion, and any dealbreaker penalties — phrased qualitatively, naming a criterion or the overall score ("apply a heavy penalty to **Verification & Thoroughness**"), never numeric magnitudes, never points, never caps. The document must stand alone: the grader sees only it and the shared standard. Invoke the holistic-rubric skill in the Authoring container to draft it interactively: `/write-holistic-rubric` in claude, `$write-holistic-rubric` in codex.

Once the holistic rubric is final, you can convert it into the atomic rubric package with the `/write-atomic-rubric` skill (`$write-atomic-rubric` in codex). The skill writes `tests/atomic-rubric.yaml`, which restates every task-specific requirement as one separately judgeable criterion, plus `tests/grader-context.md`, which carries the context and ground truth those criteria rely on. Both files ship with your submission.

### 9. Run your task

```bash
[devcontainer:authoring] $ scripts/harbor-run harbor-tasks/<your-task> --force-build
```

This runs the full pipeline: agent resumes the conversation, produces an answer, grader evaluates it. Both agent and grader run inside a separate Harbor container that is created and destroyed automatically.

### 10. Check results

Results land in `harbor-jobs/`. For each trial:

- `verifier/reward.txt` — the score (0.0-1.0): the mean of the non-N/A criteria, minus any heavy penalties your holistic rubric directs at the overall score, floored at 0.0
- `verifier/reward-correctness.txt` — always the literal `N/A`: correctness lives inside the criteria (Narrow Correctness, Broader Correctness), not as a separate score
- `verifier/reward.json` — the score machine-readable: `{"reward": …}`
- `verifier/grade.json` — the grader's structured output: per-criterion `{score, rationale}` entries, any overall penalties, and the grader's holistic overall_score. This is the source of truth; reward.txt and `grade.md` are derived from it mechanically.
- `verifier/grade.md` — grader's reasoning rendered from `grade.json`, one section per criterion
- `verifier/agent-output/` — files the agent created or modified in the workspace

The end of `verifier/test-stdout.txt` prints the score at a glance.

### 11. Iterate

Run multiple times (`-k 4` for 4 parallel attempts). Read the grade.md files — every criterion section, not just the headline score. Adjust `tests/holistic-rubric.md` and re-run (`scripts/harbor-regrade` re-grades a captured run without re-running the agent; `scripts/harbor-regrade harbor-tasks/<slug> --all` re-grades every run you have captured, 2 at a time, and `--jobs N` changes that). Score clustering across runs is normal — what matters is that the task reliably produces clear signal worth grading, not landing in a specific score band. Runs that behaved differently should score differently. Only runs that finished cleanly count toward the four: a run cut short by an API error, a non-zero agent exit or the agent timeout never finished its turn, so re-run it rather than shipping it.

### 12. Copy reference runs

```bash
[devcontainer:authoring] $ npx tsx scripts/copy-reference-run.ts harbor-jobs/<job>/<trial>
```

### 13. Submit

```bash
[devcontainer:authoring] $ npx tsx scripts/submit-task.ts <your-task-slug>
```

Validates required files, checks for placeholder text, shows score distribution, creates a tarball.

## What's in here

```
explore/                            # Explore container workspace
  .devcontainer/                    # Container A config
  plugins/create-snapshot/          # Snapshot skill
  snapshots/                        # Snapshot output (shared with Authoring)
  corpus-viewer/                    # Corpus web viewer + index docs (corpus toolkits)
  repo/ — or repos/<member>/        # Source repo(s), bind-mounted read-write
data/                               # (corpus toolkits only)
  zeta-corpus/                      # Reference-data corpus (mounted at /data/zeta-corpus)
  corpus-index/                     # Prebuilt search index over it (corpus.db)
.devcontainer/                      # Authoring container config (Container B)
harbor-tasks/
  _task-scaffold/                   # Template for manual task creation
scripts/
  harbor-run                        # Run a task via Harbor
  build-workspace.sh                # Export repo at a commit into a task's workspace
  snapshot-to-task.ts               # Convert a snapshot into a harbor task
  copy-reference-run.ts             # Copy Harbor trial data into reference-runs
  submit-task.ts                    # Validate and package a task for submission
task-shared/                        # Shared infrastructure (don't modify)
repo/ — or repos/<member>/          # Full source repo(s) with git history
.claude/skills/                     # Skills for the Authoring container
CLAUDE.md                           # Project instructions (claude reads this)
AGENTS.md                           # Same instructions for other agents (generated; don't edit)
```

## Alternative: Manual task creation

If you want to create a task without the snapshot workflow (e.g., from a specific commit you found interesting):

```bash
[devcontainer:authoring] $ cp -r harbor-tasks/_task-scaffold harbor-tasks/my-task-slug
```

Edit `instruction.md`, `task.toml`, and `tests/holistic-rubric.md` directly. Then build the
workspace:

```bash
[devcontainer:authoring] $ bash scripts/build-workspace.sh my-task-slug
```

**Polyglot toolkits (multiple repos under `repos/`)** bundle members with different runtimes, so
set `[metadata].repo` in `task.toml` to the member your task targets before you run that command
(`ls task-shared/Dockerfile.*` lists them). `build-workspace.sh` reads it and wires up everything
member-specific: the base image in `environment/Dockerfile` and the member's test/lint/typecheck
checks in `tests/test-commands.sh`, which the grader runs as evidence for the correctness criteria. It
reports what it set, never overwrites a Dockerfile or `test-commands.sh` you've edited yourself, and
is safe to re-run. Single-repo toolkits need none of this — their scaffold already ships both.

If you see `Error: repo not found`, `[metadata].repo` doesn't name a member under `repos/`.

Then follow steps 9-13 above.

## Files you shouldn't edit

Three files in every task come from `task-shared/` and are managed by the toolkit:

| File                                         | What it does                                  |
| :------------------------------------------- | :-------------------------------------------- |
| `environment/Dockerfile`                     | Builds the container your trials run in       |
| `tests/test.sh`                              | Runs the grader and writes the scores         |
| `tests/grader-system-prompt-consolidated.md` | Defines the Grading Standard's eight criteria |

These decide how a trial runs and how a grade is produced, so they have to be identical
across every task — a reference run from an edited environment doesn't mean the same
thing as one from a stock environment, and there's no way to tell from the scores alone.

`harbor-run`, `build-workspace.sh` and `submit-task.ts` all check them and tell you what
they find, including the `cp` that restores the shipped copy. **None of them will stop
you.** You can run trials and submit with these files edited — we'd just rather know,
because a task whose grader files differ is hard to compare with the rest, and that's
worth a sentence in your submission notes.

Two things can make a file differ, and the message says which it looks like:

- **You changed it.** Restoring the shipped copy puts the task back on the same footing
  as everyone else's.
- **Your task predates the current release.** These files get updated between releases,
  so a task you started earlier keeps the older copies. That isn't a mistake — it does
  mean the task was graded with older versions than one built today, so restoring the
  current copies and re-running your trials is what makes the scores comparable.

If you hit a problem that makes you want to change one of these — a missing package, a
grader that won't run — report it rather than patching around it locally. The fix has to
work for every task built from this toolkit, not just yours, so a local edit tends to
mean the same problem is quietly hitting other people too.

The toolkit's own `scripts/` are checked the same way, and for the same reason. They
aren't part of any task, which is what makes an edit there easy to miss — but
`build-workspace.sh` stages each task's `tests/test-commands.sh`, fills in parts of its
`environment/Dockerfile`, and records the checksums a reviewer reads. Restoring means
re-extracting the toolkit zip over your copy; your tasks, snapshots and reference runs
are untouched by that. Scripts you add yourself are yours and are never reported.

## Key principles

- **Prompts should be realistic.** Work with Claude naturally — don't shape the conversation to make grading easier.
- **Grade outcomes, not process.** Assertions should be about what the answer contains, not which files the agent read.
- **Fact-check everything.** Every claim in the holistic rubric must be verified against the actual code.
- **Include failure scenarios.** Each issue should have concrete repro steps ending in a business-visible consequence.

See `.claude/skills/` for detailed guidance (available in the Authoring container).

## Troubleshooting

**"docker compose: command not found"** — Make sure you're running inside a dev container, not on your host.

**Harbor says "apiKeySource: none"** — Make sure your `.env` file has `ANTHROPIC_API_KEY` set, then restart the container.

**Fable/Mythos model errors** — Fable and Mythos may be unavailable. Use Opus until project instructions say otherwise. In the Authoring container, `claude` should run with `--model opus[1m] --effort max`; in the Explore container, it should also include `--tools Bash` plus the reduced-toolset note. Harbor trials on the claude-code harness use a concrete Opus id by default.

**Devcontainer build fails** — Make sure Docker Desktop is running with 4GB+ memory. Try `docker system prune` if low on disk.

**Container exited** — Re-run the `npx @devcontainers/cli up` command to restart.

**`http://localhost:<port>` shows nothing** — The app doesn't start on its own. Run `run-app` (on a polyglot toolkit, `run-app <repo>`) inside the Explore container (see "Running the app in a browser"), then open the URL it prints. For ZenBill, also add the `/etc/hosts` entries in that section.

**The database isn't running after a reboot or container stop** — Re-run `npx @devcontainers/cli up`; postgres is restarted automatically on every container start. (You no longer need to start it by hand.)

**Ports stopped working after a toolkit upgrade** — Docker fixes a container's port mappings when it's first created, so an old container won't pick up new ports just from `up`. Recreate it: `npx @devcontainers/cli up --remove-existing-container`. This wipes the container's Claude history, so run `/create-snapshot:snapshot` first if there's a conversation you want to keep.

**Snapshot command not found** — Make sure you're in the Explore container, not the Authoring container.

**claude: command not found** — The first container startup installs Claude Code. If it failed, try rebuilding: `npx @devcontainers/cli up --remove-existing-container --build-no-cache`

## Links

- [Dev containers](https://containers.dev/) — the open spec this toolkit uses
- [devcontainer CLI](https://www.npmjs.com/package/@devcontainers/cli) — the command-line tool for starting and managing dev containers
- [VS Code Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers) — how dev containers work in VS Code
- [Harbor](https://github.com/harbor-framework/harbor) — the evaluation framework used to run and grade tasks

### Docker Desktop alternatives

This toolkit requires a Docker-compatible runtime. [Docker Desktop](https://www.docker.com/products/docker-desktop/) is the most common, but these also work:

- [OrbStack](https://orbstack.dev) — fast, lightweight Docker alternative for macOS
- [Rancher Desktop](https://rancherdesktop.io) — open-source container management for Mac, Windows, and Linux
- [Colima](https://github.com/abiosoft/colima) — minimal container runtime for macOS and Linux
- [Podman Desktop](https://podman-desktop.io) — open-source Docker-compatible container tool (may need extra configuration for dev containers)
