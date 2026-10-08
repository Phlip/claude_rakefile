---
description: Capture a snapshot of the current conversation and repo state.
---

# Create Snapshot

You are capturing a snapshot of the current conversation and repo state so it can be replayed as an RL training task.

## Step 1: Ask annotation questions

**Important — tell the user this first, verbatim:**

> ⚠️ This snapshot captures your entire conversation history with me, not just the most
> recent turn. If you told me the answer earlier in this conversation, or steered me
> toward it, the agent will see that same context when the snapshot replays — and will
> probably solve the task without making the mistake. Your task will be contaminated.
>
> If you've leaked the answer at any point in this conversation: if your agent can rewind
> (Claude Code's `/rewind`), rewind to a point before the contamination and snapshot from
> there. If it can't — codex has no rewind — this snapshot is not salvageable: start a
> fresh session, reproduce the mistake without steering, and snapshot that instead.

Wait for the user to acknowledge before moving on.

Ask the user each of these questions **one at a time** as plain text, waiting for their response before proceeding to the next:

1. "What were you trying to do?"
2. "What were you hoping was going to happen?"
3. "What did the agent actually do instead?"

## Step 2: Propose a slug

Based on the user's answers, generate a **short kebab-case slug** (2-4 words) that captures the essence of the mistake. For example: `bad-refactor`, `wrong-test-strategy`, `missed-edge-case`.

Present your suggestion and ask the user to confirm or provide an alternative.

## Step 3: Write annotation file and run capture

Write the annotation to a temporary JSON file, then run the capture script.

Write this JSON to a temp file (use a path like `/tmp/snapshot-annotation-<timestamp>.json`):

```json
{
  "what_trying": "<answer to question 1>",
  "what_hoping": "<answer to question 2>",
  "what_happened": "<answer to question 3>"
}
```

Then run:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/capture-snapshot.mjs" --slug <slug> --annotation <temp-file-path> --output-dir "${CLAUDE_PLUGIN_ROOT}/../../snapshots" --plugin-data "${CLAUDE_PLUGIN_DATA:-${CLAUDE_PLUGIN_ROOT}/.data}"
```

Report the script's stdout output verbatim to the user. Do not paraphrase or shorten paths.
