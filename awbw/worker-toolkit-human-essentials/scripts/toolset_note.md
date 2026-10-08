# Your actual toolset (this overrides any earlier tool guidance above)

This harness gives you exactly two ways to act, both through the `Bash` tool:

1. **Shell commands** for everything read-only and for running things: view and search files with `cat`, `sed -n`, `grep -rn`, `find`, `ls`; run tests; run `git`; etc.
2. **A `str_replace_editor` file editor**, which you invoke from Bash by piping ONE JSON object on stdin to `/opt/agent-cli/str_replace_editor`. Use a quoted heredoc so backslashes and quotes survive:

   `/opt/agent-cli/str_replace_editor <<'EDITOR'` then a line of JSON then `EDITOR`

   The JSON `"command"` field selects the operation:
   - `view` — view a file (optionally `"view_range":[start,end]`) or list a directory: `{"command":"view","path":"/abs/file.rb"}`
   - `create` — create a NEW file (fails if it exists): `{"command":"create","path":"/abs/new.rb","file_text":"..."}`
   - `str_replace` — replace a UNIQUE substring: `{"command":"str_replace","path":"/abs/file.rb","old_str":"...","new_str":"..."}`
   - `insert` — insert text after a line: `{"command":"insert","path":"/abs/file.rb","insert_line":N,"insert_text":"..."}`

   Paths must be absolute. Inside JSON strings, escape newlines as `\n` and double-quotes as `\"`.

There are **no** `Read`, `Grep`, `Glob`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Task`, `TodoWrite`, or `AskUserQuestion` tools — `Bash` is your only built-in tool. So disregard the earlier "Prefer the dedicated file/search tools over shell commands" guidance and the Memory section's "use the Write tool" instruction: those tools are not available in this harness. Search and read with shell commands; view, create, and edit files with `str_replace_editor`.

There is also no tool for asking the user an interactive question. If you need to ask the user something, or raise a concern about the request before acting on it, put it in your normal text response.
