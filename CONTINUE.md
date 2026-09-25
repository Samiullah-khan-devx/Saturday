# CONTINUE — Saturday handoff (read this on the new computer)

Saturday v2 is a terminal coding copilot: full-screen TUI (like Claude Code),
`ask`/`fix`/`kicad` AI brains over OpenRouter free models, VS Code launcher,
KiCad 10 project tools, MCP tool servers, persistent chat sessions.

## 1. Setup on a fresh machine

```bat
git clone <this-repo-url>
cd fiverr-brain
node --version        REM need Node 20+
npm.cmd install
npm.cmd install -g .  REM or: npm.cmd link   → then `saturday` works anywhere
saturday login        REM paste OpenRouter key (verified live), pick model
saturday              REM launch TUI
```

PowerShell note: type `saturday.cmd` (this box blocks `.ps1` shims).
No key yet? Free one at https://openrouter.ai/keys. Key + model + history
live in `~/.saturday/` (config.json, sessions.json, history.jsonl) — per-machine,
never in git. `.env` (gitignored) also works for the key.

## 2. Verify everything still works

```bat
node --check bin/saturday.mjs tui/ui.mjs lib/ai.mjs lib/kicad.mjs lib/vscode.mjs lib/mcp.mjs lib/markdown.mjs lib/sessions.mjs brain/prompts.mjs
saturday models                                    REM free-model chain
saturday mcp tools                                 REM fs_*, shell_run, profile_get…
saturday code status                               REM needs VS Code `code` CLI
saturday ask "what does ??= do?" --no-stream       REM end-to-end AI call
```

## 3. Repo map (what lives where)

| Path | Job |
|---|---|
| `bin/saturday.mjs` | CLI entry: `ask`/`fix`/`kicad`/`code`/`login`/`models`/`mcp`/`sessions`/`tui`/`chat`. `bin/fiverr.mjs` is just a rename shim. |
| `tui/ui.mjs` | Full-screen app (~1300 lines): alt-buffer render, slash menu, streaming, sessions, login flow, pickers. Exports `SHORTCUTS`, `closestCmd`, `helpText`, `confettiRow`, `stepScroll`, `enchanted` (all unit-tested). |
| `lib/ai.mjs` | OpenRouter client: `FALLBACK_MODELS` chain, preferred-model-first, 404-retry, `~/.saturday` key/model store, `verifyKey`. |
| `lib/kicad.mjs` | KiCad S-expr parser + `summarize/compactSummary/bomCsv`. Tolerant v6→v10. |
| `lib/vscode.mjs` | `code` CLI wrapper: find/open/diff/status. Degrades cleanly when absent. |
| `lib/mcp.mjs` | MCP stdio JSON-RPC client + built-ins: `fs_*` (cwd-sandboxed), `shell_run` (cwd-scoped, 60s cap), `profile_get`, `notes_append`. |
| `lib/markdown.mjs` | TUI renderer: aligned tables, fenced code, headings, lists, links. Assistant-only; user text stays raw. |
| `lib/sessions.mjs` | Chat persistence (`~/.saturday/sessions.json`, cap 20×100). |
| `brain/prompts.mjs` | `buildAskPrompt/Fix/KicadPrompt`. `brain/dev-profile.json` = editable persona. |
| `mcp/servers.json` | Server registry (built-ins on; add stdio servers here or via CLI). |

## 4. How to extend (copy-paste patterns)

- **New `/command`**: add entry to `COMMANDS` in `tui/ui.mjs`, handle `cmd === "/x"` in `submit()`, add row to `GROUPS` so `/help` lists it.
- **New brain**: add `buildXPrompt` in `brain/prompts.mjs` → `MODES` entry → `submit()`/`runBrain()` branch → `runOnce()` branch + CLI subcommand in `bin/saturday.mjs`.
- **New MCP tool**: add to `BUILTINS` in `lib/mcp.mjs`, register in `mcp/servers.json`. External server: `saturday mcp add name -- npx -y pkg`.
- **New model in chain**: edit `FALLBACK_MODELS` in `lib/ai.mjs`, or `saturday models use <slug>`.
- **Tune persona/pricing**: `brain/dev-profile.json` only — no code changes needed.

## 5. Known gotchas (don't re-learn these)

- Free-model slugs **rotExpire**: refresh with
  `node -e "fetch('https://openrouter.ai/api/v1/models').then(r=>r.json()).then(j=>j.data.filter(m=>m.id.endsWith(':free')).forEach(m=>console.log(m.id)))"`
  then update `FALLBACK_MODELS`. 404s auto-fall-through (by design).
- PowerShell mangles inline JSON (`mcp call`): use `--stdin` with a pipe.
- `SATURDAY_DEBUG=1` prints render decisions (flicker hunting).
- Headless TUI tests: fake `isTTY` + stub `setRawMode`, capture `stdout.write`, emit `keypress` events (see git history for `*-check.tmp.mjs` patterns — they were throwaway, rewrite as needed).
- `state.scroll`: `null` = follow tail, `0` = top line. Don't bulk-replace one with the other (broke Home once).
- Bit shifts on hashes must be `>>>` (signed `>>` gives negative array indexes — crashed confetti once).

## 6. Ideas backlog (not started)

- `shell_run` allowlist/deny-list for destructive commands.
- Agentic loop: let brains auto-call MCP tools (`@file` already injects; full tool-use needs `tools:` param support per model).
- `saturday kicad` interactive DRC-ish checks (clearance guesses from track widths).
- Publish to npm (`npm publish`, bin already configured).
- `tui` mouse-wheel scroll (needs custom escape parser — readline swallows wheel bytes; risky, hence keyboard-only today).
