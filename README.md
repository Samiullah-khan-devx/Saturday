# ✻ Saturday v2 — coding CLI (VS Code + KiCad 10)

Terminal-first coding copilot. Ask questions, fix errors, analyze KiCad 10
hardware, jump to code in VS Code — no browser, no build step.

> v2 repurposed Saturday from a Fiverr copilot into a coding CLI.
> Old `reply`/`offer`/`auto` brains are gone; `ask`/`fix`/`kicad` replace them.

## Install — one line, then just type `saturday` anywhere

```bat
npm install -g https://github.com/Samiullah-khan-devx/saturday/archive/refs/heads/main.tar.gz
```

```bat
saturday
```

(PowerShell: use `saturday.cmd`. Re-run the install line after updates.)

## Setup — login (key + model in one go)

```bat
saturday login
REM prompts for OpenRouter key (verified live), then model pick
REM free key at https://openrouter.ai/keys
```

Or inside the TUI: `/login`. Edit dev memory: `brain/dev-profile.json`.

## App UI — `saturday`

Claude-style full-screen TUI: animated loader, live streaming, sessions that
persist + resume, 23 `/` commands with aliases, MCP tools, `@file` mentions.
Minimal surfaces: hairline message list with real markdown rendering —
aligned tables, fenced code blocks, accent section headers, hanging-indent
bullets, quotes, rules, links (user messages stay raw so pasted code and
pipes are never mangled), slim thinking line, OpenCode-style
chat box (mode · model title, grows to 5 rows, `^J` newline, per-line scroll,
cursor never lost). Status lives in a right-side panel on wide terminals
(folder · model · tokens + sparkline · clock · tips · keys), bottom bar on
narrow ones. Flicker-free: surgical row repaints, synced output,
native cursor, clean resize redraws.

Brains (persistent switch `/ask` `/fix` `/kicad` or `alt+1/2/3`):

- `💬 ask` — coding Q&A, explain, review (`@src/app.ts what does this do?`)
- `🔧 fix` — paste traceback → diagnosis + patch + verify command
- `⚡ kicad` — KiCad 10 hardware help, auto-reads the project in your folder

Extras: `/code open <file[:line]>` jumps to VS Code · `/session` chats ·
`/models` engine picker ★ · `/mcp` `/tools` `/call` · `/copy` `/retry`
`/export` · `/tone` `/project` `/context` · `/login` · `--no-anim` flag.
Scroll: pgup/pgdn page · shift+↑↓ lines · home top · end follow (pinned
view shows `▼ N more · M new · End to follow`, streaming never yanks you).

## One-shot commands (no UI)

```bat
saturday ask "why is this promise pending?" < app.js
saturday fix "TypeError: cannot read properties of undefined" --save fix.md
saturday kicad ask "is C7 big enough for 24V?" --dir ./psu-board
```

## KiCad 10 tools (local parse, no AI needed)

```bat
saturday kicad info --dir ./psu-board      REM symbols/sheets/tracks/vias + ref check
saturday kicad symbols --dir ./psu-board   REM R1 10k [0603] ...
saturday kicad nets --dir ./psu-board      REM net list from the PCB
saturday kicad bom --dir ./psu-board --save bom.csv
saturday kicad check --dir ./psu-board     REM sch<->pcb reference cross-check
```

Parses `.kicad_sch` / `.kicad_pcb` S-expressions directly (tolerant of v6→v10).

## VS Code

```bat
saturday code status            REM CLI found? workspace summary, .vscode files
saturday code open src/app.ts:42
saturday code folder .
saturday code diff a.ts b.ts
```

## Models / MCP / sessions / history

```bat
saturday models / models use 2
saturday mcp | mcp tools | mcp call shell_run '{"cmd":"npm test"}'
saturday mcp call fs_read '{"path":"src/app.ts"}'
saturday sessions | sessions delete 2
saturday history -n 10
```

Built-in MCP tools: `fs_read` `fs_list` `fs_write` (sandboxed to cwd),
`shell_run` (cwd-scoped, 60s timeout, output captured), `profile_get`,
`notes_append`. Add servers in `mcp/servers.json` or `saturday mcp add`.

## How it works

- `bin/saturday.mjs` — commander CLI + streaming renderer
- `tui/ui.mjs` — full-screen app (alt buffer, slash menu, live stream)
- `lib/ai.mjs` — OpenRouter free-model fallback + `~/.saturday/` store
- `lib/kicad.mjs` — S-expr parser + sch/pcb analysis + BOM
- `lib/vscode.mjs` — `code` CLI wrapper
- `lib/mcp.mjs` — MCP stdio client + built-in fs/shell/saturday servers
- `brain/` — `dev-profile.json` + ask/fix/kicad system prompts
