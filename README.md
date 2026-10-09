# claude_rakefile

This repo is how I'm learning the Surge AI task-authoring platform: instead of memorizing its README, I grow a
Rakefile. Each time I hit a step I don't understand, like starting the Explore container, building a Harbor task
from a snapshot, running trials, copying reference runs, or checking `[verifier.env]`, I ask Claude to turn that step
into a Rake task. Writing the prompt makes me say what I think the step does, and reading the task that comes back
shows me what it actually does. `rake -T` then lists everything I've learned so far, and `rake task:list` shows how
far along each task in a toolkit is.

The Rakefile points at a toolkit through `TASK_TOOLKIT` (the Zeta platform toolkit by default, or the Human
Essentials one under `awbw/`). It wraps the toolkit's own scripts rather than replacing them, so the chain
`task:from_snapshot` → `task:build` → `task:run` → `task:reference` → `task:submit` runs the same commands the
toolkit documents, with each prerequisite encoded rather than remembered. Alongside it are leftover experiments
from the same learning loop: Claude launchers (`claude:run`, `claude:docker`, `claude:popup`), a hunt for Dockerfiles
on GitHub, and a small Shoes/Scarpe roguelike that started as a way to test GUI apps headlessly.
