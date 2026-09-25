import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

// ── VS Code integration via the `code` CLI ──

function run(cmd, args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.killed) return reject(new Error("timed out"));
      resolve({ code: err?.code ?? 0, out: String(stdout || ""), err: String(stderr || "") });
    });
  });
}

const CANDIDATES = ["code", "code.cmd", "code-insiders", "code-insiders.cmd"];

export async function findCode() {
  for (const c of CANDIDATES) {
    try {
      const r = await run(c, ["--version"]);
      if (r.code === 0) return { cli: c, version: r.out.split("\n")[0].trim() };
    } catch {}
  }
  return { cli: null, version: "" };
}

export async function openFile(file, line) {
  const { cli } = await findCode();
  if (!cli) throw new Error("`code` CLI not found — install VS Code + enable shell command (Cmd+Shift+P → 'Shell Command: Install code')");
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${file}`);
  const args = line ? ["-g", `${abs}:${line}`] : [abs];
  await run(cli, [...args, "--reuse-window"]);
  return `${abs}${line ? `:${line}` : ""} → VS Code`;
}

export async function openFolder(dir = ".") {
  const { cli } = await findCode();
  if (!cli) throw new Error("`code` CLI not found");
  const abs = path.resolve(dir);
  await run(cli, [abs, "--reuse-window"]);
  return `${abs} → VS Code`;
}

export async function diffFiles(a, b) {
  const { cli } = await findCode();
  if (!cli) throw new Error("`code` CLI not found");
  await run(cli, ["--diff", path.resolve(a), path.resolve(b), "--reuse-window"]);
  return `diff ${a} ↔ ${b} → VS Code`;
}

export async function statusInfo() {
  const { cli, version } = await findCode();
  const cwd = process.cwd();
  let entries = [];
  try { entries = fs.readdirSync(cwd); } catch {}
  const codeFiles = entries.filter((e) => /\.(ts|tsx|js|jsx|py|cpp|h|hpp|c|rs|go|md|json)$/.test(e));
  let vscode = null;
  const vscDir = path.join(cwd, ".vscode");
  try {
    if (fs.statSync(vscDir).isDirectory()) {
      vscode = {};
      for (const f of ["settings.json", "tasks.json", "launch.json", "extensions.json"]) {
        const p = path.join(vscDir, f);
        if (fs.existsSync(p)) vscode[f] = "present";
      }
    }
  } catch {}
  return { cli, version, cwd, topLevel: entries.length, codeFiles: codeFiles.slice(0, 15), vscode };
}
