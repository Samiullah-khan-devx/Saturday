#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadProfile, callBrain, saveHistory, saveKey, verifyKey, historyFile, APP_DIR, FALLBACK_MODELS, getPreferredModel, setPreferredModel } from "../lib/ai.mjs";
import { startTUI } from "../tui/ui.mjs";
import { listServers, listTools, callTool, loadRegistry, saveRegistry, disconnectAll } from "../lib/mcp.mjs";
import { loadSessions, persistSessions, fmtWhen } from "../lib/sessions.mjs";
import { summarize, compactSummary, bomCsv } from "../lib/kicad.mjs";
import { findCode, openFile, openFolder, diffFiles, statusInfo } from "../lib/vscode.mjs";
import { buildAskPrompt, buildFixPrompt, buildKicadPrompt } from "../brain/prompts.mjs";

const program = new Command();
program.name("saturday").description("✻ Saturday — coding CLI with VS Code + KiCad 10 support").version("1.0.0");

const ACC = chalk.hex("#E0915A");

// sunset gradient rule (aesthetic divider)
function gradRule(n = 56) {
  let s = "";
  for (let i = 0; i < n; i++) {
    const t = n <= 1 ? 0 : i / (n - 1);
    s += chalk.rgb(Math.round(224 + 21 * t), Math.round(145 + 53 * t), Math.round(90 + 42 * t))("─");
  }
  return s;
}
const pill = (t) => ACC("✻") + chalk.dim(` ${t}`);
const BANNER = `
${ACC(" ███████╗ █████╗ ████████╗██╗   ██╗██████╗ ██████╗  █████╗ ██╗   ██╗")}
${ACC(" ██╔════╝██╔══██╗╚══██╔══╝██║   ██║██╔══██╗██╔══██╗██╔══██╗╚██╗ ██╔╝")}
${ACC(" ███████╗███████║   ██║   ██║   ██║██████╔╝██║  ██║███████║ ╚████╔╝ ")}
${ACC(" ╚════██║██╔══██║   ██║   ██║   ██║██╔══██╗██║  ██║██╔══██║  ╚██╔╝  ")}
${ACC(" ███████║██║  ██║   ██║   ╚██████╔╝██║  ██║██████╔╝██║  ██║   ██║   ")}
${chalk.dim(" ╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝   ") + chalk.dim("v2 — coding cli · vscode + kicad 10")}
`;

function showBanner() {
  console.log(BANNER);
}

async function runOnce(mode, userText, opts = {}) {
  const profile = loadProfile();
  if (opts.tone) profile.tone = opts.tone;
  let system, label;
  if (mode === "ask") {
    label = "💬 ASK";
    system = buildAskPrompt(profile);
    userText = `PROJECT: ${opts.project || path.basename(process.cwd())}\n\nCONTEXT:\n${opts.context || ""}\n\nQUESTION:\n${userText}`;
  } else if (mode === "fix") {
    label = "🔧 FIX";
    system = buildFixPrompt(profile);
    userText = `PROJECT: ${opts.project || path.basename(process.cwd())}\n\nCONTEXT:\n${opts.context || ""}\n\nERROR / FAILING CODE:\n${userText}`;
  } else {
    label = "⚡ KICAD";
    system = buildKicadPrompt(profile);
    let hw = "";
    try {
      const s = summarize(opts.dir || ".");
      if (s.found) hw = compactSummary(s);
    } catch {}
    userText = `${hw ? hw + "\n\n" : ""}QUESTION:\n${userText}\n\nCONTEXT:\n${opts.context || ""}`;
  }

  console.log(chalk.dim(`\n${label} · thinking…`));
  if (opts.stream === false) {
    const spin = ora({ text: `✻ consulting ${label.toLowerCase()} brain…`, spinner: "dots", color: "yellow" }).start();
    try {
      const { text, model } = await callBrain(system, userText, { key: opts.key, model: opts.model });
      spin.succeed(`done via ${model}`);
      console.log("\n" + gradRule());
      console.log(text);
      console.log(gradRule() + "\n");
      saveHistory(mode, userText, text);
      if (opts.save) {
        fs.writeFileSync(opts.save, text);
        console.log(chalk.dim(`saved → ${opts.save}`));
      }
    } catch (e) {
      spin.fail("failed");
      console.error(chalk.red(e.message));
      process.exitCode = 1;
    }
    return;
  }
  // streaming (default)
  try {
    console.log("\n" + pill(`${label} · streaming…`) + "\n");
    const { text, model } = await callBrain(system, userText, {
      key: opts.key,
      model: opts.model,
      stream: true,
      onToken: (d) => process.stdout.write(d),
    });
    process.stdout.write("\n");
    console.log("\n" + gradRule());
    console.log(chalk.dim(`  ✦ done via ${model}`) + "\n");
    saveHistory(mode, userText, text);
    if (opts.save) {
      fs.writeFileSync(opts.save, text);
      console.log(chalk.dim(`saved → ${opts.save}`));
    }
  } catch (e) {
    console.error(chalk.red("\n" + e.message));
    process.exitCode = 1;
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

function brainOpts() {
  return [
    ["--project <t>", "project name (default: folder)"],
    ["--context <t>", "extra context"],
    ["--tone <t>", "tone override"],
    ["--key <k>", "OpenRouter key"],
    ["--model <m>", "preferred model (tried first)"],
    ["--no-anim", "disable animations"],
    ["--no-stream", "disable streaming"],
    ["--save <f>", "save output to file"],
    ["--ask", "prompt interactively"],
  ];
}

function applyBrainOpts(cmd) {
  for (const [flags, desc] of brainOpts()) cmd.option(flags, desc);
  return cmd;
}

// --- coding brains ---

applyBrainOpts(
  program
    .command("ask [question...]")
    .description("Ask a coding question (explain, review, how-to)")
).action(async (q, opts) => {
  let text = q.join(" ").trim() || (await readStdin());
  if (!text && opts.ask) text = await ask("Question: ");
  if (!text) return console.error(chalk.red('Usage: saturday ask "why is this promise pending?"  (or echo ... | saturday ask)'));
  await runOnce("ask", text, opts);
});

applyBrainOpts(
  program
    .command("fix [error...]")
    .description("Diagnose an error / failing code and get a patch")
).action(async (e, opts) => {
  let text = e.join(" ").trim() || (await readStdin());
  if (!text && opts.ask) text = await ask("Error or failing code: ");
  if (!text) return console.error(chalk.red("Usage: saturday fix \"TypeError: cannot read properties of undefined\""));
  await runOnce("fix", text, opts);
});

// --- kicad v10 (local parse, no AI needed — except `ask`) ---

program
  .command("kicad <action> [target...]")
  .description("KiCad 10 project tools: info | symbols | nets | bom | check | ask")
  .option("--dir <d>", "project folder (default .)")
  .option("--save <f>", "save output (bom/check) to file")
  .option("--key <k>", "OpenRouter key (only for `ask`)")
  .option("--model <m>", "preferred model (only for `ask`)")
  .option("--no-stream", "disable streaming (only for `ask`)")
  .action(async (action, target, opts) => {
    const dir = opts.dir || ".";
    if (action === "ask") {
      const q = target.join(" ").trim();
      if (!q) return console.error(chalk.red('Usage: saturday kicad ask "is C7 big enough for 24V?"'));
      await runOnce("kicad", q, { ...opts, dir });
      return;
    }
    const s = summarize(dir);
    if (!s.found) return console.error(chalk.red(`No KiCad project in ${path.resolve(dir)}`));
    const maybeSave = (content) => {
      if (opts.save) { fs.writeFileSync(opts.save, content); console.log(chalk.dim(`saved → ${opts.save}`)); }
    };
    if (action === "info") {
      console.log("\n" + pill(`kicad project · ${s.dir}`));
      if (s.sch && !s.sch.error) console.log(`  SCH ${s.sch.file}: ${s.sch.symbols.length} symbols · ${s.sch.sheets.length} sheets · ${s.sch.wires} wires`);
      if (s.sch?.error) console.log(chalk.red(`  SCH error: ${s.sch.error}`));
      if (s.pcb && !s.pcb.error) console.log(`  PCB ${s.pcb.file}: ${s.pcb.footprints.length} footprints · ${s.pcb.nets.length} nets · ${s.pcb.segments} tracks (~${s.pcb.trackLenMm}mm) · ${s.pcb.vias} vias · ${s.pcb.zones} zones`);
      if (s.pcb?.error) console.log(chalk.red(`  PCB error: ${s.pcb.error}`));
      if (s.check) {
        const ok = !s.check.missingOnPcb.length && !s.check.notInSch.length;
        console.log(ok ? chalk.green("  sch<->pcb refs match ✔") : chalk.yellow(`  missing on PCB: ${s.check.missingOnPcb.join(", ") || "—"} · not in SCH: ${s.check.notInSch.join(", ") || "—"}`));
      }
      console.log();
      return;
    }
    if (action === "symbols") {
      if (!s.sch || s.sch.error) return console.error(chalk.red("No parsable schematic"));
      for (const sym of s.sch.symbols) console.log(`  ${sym.ref}  ${sym.value}  [${sym.footprint || "no footprint"}]  (${sym.lib})`);
      return;
    }
    if (action === "nets") {
      if (!s.pcb || s.pcb.error) return console.error(chalk.red("No parsable PCB"));
      for (const n of s.pcb.nets) console.log(`  ${n.id}  ${n.name || "(unnamed)"}`);
      return;
    }
    if (action === "bom") {
      if (!s.sch || s.sch.error) return console.error(chalk.red("No parsable schematic"));
      const csv = bomCsv(s.sch.symbols);
      if (opts.save) { maybeSave(csv); return; }
      console.log(csv);
      return;
    }
    if (action === "check") {
      if (!s.check) return console.error(chalk.red("Need both schematic AND pcb to cross-check"));
      const lines = [
        `missing on PCB (${s.check.missingOnPcb.length}): ${s.check.missingOnPcb.join(", ") || "—"}`,
        `on PCB, not in SCH (${s.check.notInSch.length}): ${s.check.notInSch.join(", ") || "—"}`,
      ];
      console.log("\n" + pill("kicad sch<->pcb check"));
      lines.forEach((l) => console.log("  " + l));
      console.log();
      if (opts.save) maybeSave(lines.join("\n") + "\n");
      return;
    }
    console.error(chalk.red("Usage: saturday kicad <info|symbols|nets|bom|check|ask>  (see --help)"));
    process.exitCode = 1;
  });

// --- vscode ---

program
  .command("code <action> [args...]")
  .description("VS Code: status | open <file[:line]> | folder [dir] | diff <a> <b>")
  .action(async (action, args = []) => {
    try {
      if (action === "status") {
        const st = await statusInfo();
        console.log("\n" + pill("vscode status"));
        console.log(`  cli: ${st.cli ? `${st.cli} (${st.version})` : chalk.red("not found")}`);
        console.log(`  cwd: ${st.cwd} (${st.topLevel} entries)`);
        if (st.codeFiles.length) console.log(`  code: ${st.codeFiles.join(", ")}`);
        if (st.vscode) console.log(`  .vscode: ${Object.keys(st.vscode).join(", ") || "(empty)"}`);
        else console.log(chalk.dim("  .vscode: —"));
        console.log();
        return;
      }
      if (action === "open") {
        const target = args[0];
        if (!target) return console.error(chalk.red("Usage: saturday code open <file[:line]>"));
        const m = target.match(/^(.*?)(?::(\d+))?$/);
        console.log(chalk.green("✔ " + await openFile(m[1], m[2] ? Number(m[2]) : undefined)));
        return;
      }
      if (action === "folder") {
        console.log(chalk.green("✔ " + await openFolder(args[0] || ".")));
        return;
      }
      if (action === "diff") {
        if (args.length < 2) return console.error(chalk.red("Usage: saturday code diff <a> <b>"));
        console.log(chalk.green("✔ " + await diffFiles(args[0], args[1])));
        return;
      }
      console.error(chalk.red("Usage: saturday code <status|open|folder|diff>"));
      process.exitCode = 1;
    } catch (e) {
      console.error(chalk.red(e.message));
      process.exitCode = 1;
    }
  });

program
  .command("login")
  .description("Interactive login: save OpenRouter key + model")
  .option("--key <k>", "API key (skip prompt)")
  .option("--model <m>", "model slug or chain number (skip prompt)")
  .action(async (opts) => {
    let k = (opts.key || "").trim();
    if (!k) k = (await ask("🔐 OpenRouter key (sk-or-v1-...): ")).trim();
    if (!k) return console.error(chalk.red("No key given."));
    const spin = ora("verifying key…").start();
    const res = await verifyKey(k).catch(() => ({ ok: false, status: "network" }));
    if (res.ok) spin.succeed(`key valid${res.label ? ` (${res.label})` : ""}`);
    else spin.warn(`key check failed (${res.status || "network"}) — saving anyway`);
    saveKey(k);
    console.log(chalk.green("✔ key saved to ~/.saturday/config.json"));
    let m = (opts.model || "").trim();
    if (!m) {
      console.log(chalk.dim("\nModels:"));
      FALLBACK_MODELS.forEach((x, i) => console.log(chalk.dim(`  ${i + 1}. ${x}`)));
      m = (await ask("Preferred model (number, slug, or enter to skip): ")).trim();
    }
    if (m) {
      const n = Number(m);
      const slug = Number.isInteger(n) && n >= 1 && n <= FALLBACK_MODELS.length ? FALLBACK_MODELS[n - 1] : m;
      setPreferredModel(slug);
      console.log(chalk.green(`✔ preferred model → ${slug}`));
    }
    console.log(chalk.dim("\nDone. Run `saturday` to start."));
  });

program
  .command("config")
  .description("Save API key / view dev profile")
  .option("--key <k>", "save OpenRouter key to ~/.saturday/config.json")
  .action(async (opts) => {
    const dir = path.join(os.homedir(), APP_DIR);
    if (opts.key) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ key: opts.key.trim() }, null, 2));
      console.log(chalk.green("✔ key saved to ~/.saturday/config.json"));
      return;
    }
    console.log(chalk.bold("\nProfile (brain/dev-profile.json):"));
    console.log(JSON.stringify(loadProfile(), null, 2));
    console.log(chalk.dim("\nSet key: saturday login  (or saturday config --key sk-or-v1-...)"));
  });

program
  .command("history")
  .description("Show recent runs")
  .option("-n <n>", "count", "10")
  .action((opts) => {
    try {
      const lines = fs.readFileSync(historyFile(), "utf8").trim().split("\n").slice(-Number(opts.n));
      for (const l of lines) {
        const j = JSON.parse(l);
        console.log(chalk.dim(`\n[${j.t}] ${j.mode}`));
        console.log(chalk.dim(j.input.slice(0, 120) + "…"));
      }
    } catch {
      console.log(chalk.dim("No history yet. Runs are saved automatically."));
    }
  });

program
  .command("models")
  .description("List free models / set preferred (tried first)")
  .argument("[sel...]", "model slug or number, e.g. `2` or `use 2` or a slug")
  .action(async (sel) => {
    const toks = (sel || []).filter((t) => t.toLowerCase() !== "use");
    const use = toks[0];
    const preferred = getPreferredModel();
    if (use) {
      const n = Number(use);
      const slug = Number.isInteger(n) && n >= 1 && n <= FALLBACK_MODELS.length
        ? FALLBACK_MODELS[n - 1]
        : use;
      setPreferredModel(slug);
      console.log(chalk.green(`✔ preferred model → ${slug}`));
      return;
    }
    console.log("\n" + pill("models · free chain, tried in order"));
    const rows = FALLBACK_MODELS.map((m, i) => `  ${i + 1}. ${m}`);
    const wmax = Math.max(...rows.map((r) => r.length));
    rows.forEach((r, i) => {
      const star = FALLBACK_MODELS[i] === preferred ? chalk.green("  ★ preferred") : "";
      console.log(chalk.dim("  │ ") + r.padEnd(wmax) + star);
    });
    console.log(chalk.dim("  ╰" + "─".repeat(wmax + 2)));
    console.log(chalk.dim("\nSet one: saturday models use 2   (or any OpenRouter slug)"));
    if (preferred && !FALLBACK_MODELS.includes(preferred)) {
      console.log(chalk.dim(`Custom preferred: ${preferred}`));
    }
  });

const mcp = program.command("mcp").description("MCP servers & tools (fs, shell, custom stdio)");

mcp.command("list").description("Show configured MCP servers").action(async () => {
  const servers = await listServers();
  if (!servers.length) return console.log(chalk.dim("No MCP servers. Add one: saturday mcp add <name> <command...>"));
  console.log("\n" + pill("mcp servers") + "\n");
  for (const s of servers) {
    const dot = !s.enabled ? chalk.dim("○") : s.ok ? chalk.green("●") : chalk.red("●");
    console.log(`${dot} ${chalk.bold(s.name)}  ${chalk.dim(`[${s.type}]`)}${s.enabled ? "" : chalk.dim(" disabled")}`);
    console.log(chalk.dim(`   tools: ${s.tools.join(", ") || "(none)"}${s.error ? `  ⚠ ${s.error}` : ""}`));
  }
  disconnectAll();
});

mcp.command("tools").description("List all tools across servers").action(async () => {
  const tools = await listTools();
  if (!tools.length) return console.log(chalk.dim("No tools available."));
  for (const t of tools) console.log(`${chalk.cyan(t.name)}  ${chalk.dim(`[${t.server}]`)} — ${t.description}`);
  disconnectAll();
});

mcp.command("call <tool> [json]").description("Call a tool: mcp call fs_read '{\"path\":\"README.md\"}'").option("--stdin", "read JSON args from stdin (reliable in PowerShell: echo '{...}' | ...)").action(async (tool, json, opts) => {
  let args = {};
  let raw = json;
  if (opts.stdin) {
    raw = "";
    if (!process.stdin.isTTY) for await (const chunk of process.stdin) raw += chunk;
  }
  if (raw) {
    try { args = JSON.parse(raw.trim()); }
    catch { return console.error(chalk.red("Bad JSON args. PowerShell: use --stdin with a pipe. cmd.exe: '{\"path\":\".\"}'")); }
  }
  try {
    const { server, result } = await callTool(tool, args);
    console.log(chalk.dim(`[${server} → ${tool}]`));
    console.log(String(result).slice(0, 6000));
  } catch (e) {
    console.error(chalk.red(e.message));
    process.exitCode = 1;
  }
  disconnectAll();
});

mcp.command("add <name> <cmd...>").description("Add stdio server: mcp add gh -- npx -y gh-mcp").option("--env <kv...>", "env KEY=VAL").action(async (name, cmd, opts) => {
  const reg = loadRegistry();
  reg.servers = reg.servers || {};
  const env = {};
  for (const kv of opts.env || []) {
    const i = kv.indexOf("=");
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  reg.servers[name] = { type: "stdio", command: cmd[0], args: cmd.slice(1), env, enabled: true };
  saveRegistry(reg);
  console.log(chalk.green(`✔ MCP server "${name}" added → ${cmd.join(" ")}`));
});

mcp.command("remove <name>").description("Remove an MCP server").action(async (name) => {
  const reg = loadRegistry();
  if (!reg.servers?.[name]) return console.error(chalk.red(`No server "${name}"`));
  delete reg.servers[name];
  saveRegistry(reg);
  console.log(chalk.green(`✔ removed "${name}"`));
});

mcp.command("enable <name>").description("Enable a server").action(async (name) => {
  const reg = loadRegistry();
  if (!reg.servers?.[name]) return console.error(chalk.red(`No server "${name}"`));
  reg.servers[name].enabled = true;
  saveRegistry(reg);
  console.log(chalk.green(`✔ enabled "${name}"`));
});

mcp.command("disable <name>").description("Disable a server").action(async (name) => {
  const reg = loadRegistry();
  if (!reg.servers?.[name]) return console.error(chalk.red(`No server "${name}"`));
  reg.servers[name].enabled = false;
  saveRegistry(reg);
  console.log(chalk.green(`✔ disabled "${name}"`));
});

program
  .command("sessions")
  .description("List saved chat sessions (TUI chats persist here)")
  .argument("[action]", "'delete'")
  .argument("[target]", "number, name, or 'all'")
  .action(async (action, target) => {
    let sessions = loadSessions();
    if (action === "delete") {
      if (!target) return console.error(chalk.red("Usage: saturday sessions delete <number|name|all>"));
      if (target.toLowerCase() === "all") sessions = [];
      else {
        const n = Number(target);
        const idx = Number.isInteger(n) && n >= 1 && n <= sessions.length
          ? n - 1
          : sessions.findIndex((s) => s.name.toLowerCase() === target.toLowerCase() || s.id === target);
        if (idx < 0) return console.error(chalk.red(`No session "${target}"`));
        sessions.splice(idx, 1);
      }
      persistSessions(sessions);
      console.log(chalk.green("✔ sessions updated"));
      return;
    }
    if (!sessions.length) return console.log(chalk.dim("No saved sessions yet. Chats in `saturday` TUI persist automatically."));
    console.log("\n" + pill("sessions") + "\n");
    sessions.forEach((s, i) => {
      console.log(`  ${i + 1}. ${chalk.bold(s.name)}  ${chalk.dim(`(${s.messages.length} msgs · ${fmtWhen(s.updatedAt)})`)}`);
    });
    console.log(chalk.dim("\nDelete: saturday sessions delete <number|all>"));
  });

program
  .command("tui")
  .description("Full-screen coding UI (like claude code / opencode)")
  .option("--key <k>", "OpenRouter key")
  .option("--model <m>", "preferred model (tried first)")
  .option("--no-anim", "disable animations")
  .action(async (opts) => {
    await startTUI({ key: opts.key, model: opts.model, anim: opts.anim !== false });
  });

program
  .command("chat", { isDefault: false })
  .description("App UI (default) — use --simple for plain prompt loop")
  .option("--key <k>", "OpenRouter key")
  .option("--model <m>", "preferred model (tried first)")
  .option("--no-anim", "disable animations")
  .option("--simple", "plain readline loop instead of full-screen UI")
  .action(async (opts) => {
    if (!opts.simple) {
      await startTUI({ key: opts.key, model: opts.model, anim: opts.anim !== false });
      return;
    }
    showBanner();
    console.log(chalk.dim("Brains: /ask <q> · /fix <error> · /kicad <q> · /code open <file> · /profile · /help · /exit"));
    console.log(chalk.dim("Tip: just type a coding question. Prefix with /fix for errors, /kicad for hardware.\n"));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: ACC("saturday> ") });
    rl.prompt();
    rl.on("line", async (line) => {
      const input = line.trim();
      if (!input) return rl.prompt();
      if (["/exit", "/q", "exit"].includes(input)) return rl.close();
      if (input === "/help") {
        console.log("/ask <question> — coding Q&A\n/fix <error> — diagnose + patch\n/kicad <question> — KiCad 10 hardware\n/code open <file[:line]> — open in VS Code\n/profile — show dev profile\n/exit — quit");
        return rl.prompt();
      }
      if (input === "/profile") {
        console.log(JSON.stringify(loadProfile(), null, 2));
        return rl.prompt();
      }
      let mode = "ask";
      let text = input;
      if (input.startsWith("/fix ")) { mode = "fix"; text = input.slice(5); }
      else if (input.startsWith("/kicad ")) { mode = "kicad"; text = input.slice(7); }
      else if (input.startsWith("/ask ")) { mode = "ask"; text = input.slice(5); }
      else if (input.startsWith("/code ")) {
        console.log(chalk.dim("Tip: use `saturday code open <file>` outside chat, or the full TUI for /code."));
        return rl.prompt();
      }
      rl.pause();
      await runOnce(mode, text, { key: opts.key, model: opts.model });
      rl.resume();
      rl.prompt();
    });
    rl.on("close", () => console.log(chalk.dim("\nbye 👋")));
  });

// default with no args -> full-screen TUI
if (process.argv.length <= 2) {
  await startTUI({});
} else {
  program.parse();
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(chalk.cyan(q), (a) => { rl.close(); res(a.trim()); }));
}
