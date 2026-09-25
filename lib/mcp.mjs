import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { APP_DIR, loadProfile } from "./ai.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ── built-in tool servers (run in-process, sandboxed) ──

function guardRoot(p) {
  const base = path.resolve(process.cwd());
  const abs = path.resolve(base, p);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`blocked: ${p} is outside workspace (${base})`);
  }
  return abs;
}

const BUILTINS = {
  fs: {
    description: "Workspace file access (sandboxed to current folder)",
    tools: [
      {
        name: "fs_read",
        description: "Read a text file from the workspace",
        args: { path: "relative file path" },
        run: async ({ path: p }) => {
          const abs = guardRoot(p);
          const content = fs.readFileSync(abs, "utf8");
          return content.length > 50000 ? content.slice(0, 50000) + "\n…[truncated]" : content;
        },
      },
      {
        name: "fs_list",
        description: "List directory entries",
        args: { path: "relative dir path (default .)" },
        run: async ({ path: p = "." }) => {
          const abs = guardRoot(p);
          return fs.readdirSync(abs).map((e) => {
            const st = fs.statSync(path.join(abs, e));
            return (st.isDirectory() ? "📁 " : "📄 ") + e;
          }).join("\n");
        },
      },
      {
        name: "fs_write",
        description: "Write (create/overwrite) a text file in the workspace",
        args: { path: "relative file path", content: "file content" },
        run: async ({ path: p, content = "" }) => {
          const abs = guardRoot(p);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content);
          return `wrote ${content.length} chars → ${p}`;
        },
      },
    ],
  },
  saturday: {
    description: "Saturday brain helpers",
    tools: [
      {
        name: "profile_get",
        description: "Get the developer profile (languages, stack, conventions)",
        args: {},
        run: async () => JSON.stringify(loadProfile(), null, 2),
      },
      {
        name: "notes_append",
        description: "Append a note to ~/.saturday/notes.md",
        args: { text: "note text" },
        run: async ({ text = "" }) => {
          const f = path.join(os.homedir(), APP_DIR, "notes.md");
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.appendFileSync(f, `\n## ${new Date().toLocaleString()}\n${text}\n`);
          return `noted → ${f}`;
        },
      },
    ],
  },
  shell: {
    description: "Run shell commands in the workspace (output captured)",
    tools: [
      {
        name: "shell_run",
        description: "Run a shell command in the workspace dir. Returns exit code + stdout/stderr.",
        args: { cmd: "command line", cwd: "relative working dir (default .)", timeout_ms: "kill after ms (default 60000)" },
        run: async ({ cmd, cwd = ".", timeout_ms = 60000 }) => {
          if (!cmd?.trim()) throw new Error("cmd is required");
          const dir = guardRoot(cwd);
          return new Promise((resolve) => {
            const child = spawn(String(cmd), {
              cwd: dir,
              shell: true,
              windowsHide: true,
              timeout: Math.max(1000, Math.min(300000, Number(timeout_ms) || 60000)),
            });
            let out = "", err = "";
            child.stdout?.on("data", (d) => { out += d; });
            child.stderr?.on("data", (d) => { err += d; });
            child.on("error", (e) => resolve(`exit: error\nstderr: ${e.message}`));
            child.on("close", (code) => {
              const cap = (s) => (s.length > 20000 ? s.slice(0, 20000) + "\n…[truncated]" : s);
              resolve(`exit: ${code}\n--- stdout ---\n${cap(out) || "(empty)"}\n--- stderr ---\n${cap(err) || "(empty)"}`);
            });
          });
        },
      },
    ],
  },
};

// ── registry ──

export function registryPath() {
  return path.join(ROOT, "mcp", "servers.json");
}

export function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(registryPath(), "utf8"));
  } catch {
    return { servers: {} };
  }
}

export function saveRegistry(reg) {
  fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
  fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
}

// ── stdio MCP client (JSON-RPC 2.0, newline-delimited) ──

let nextId = 1;

class StdioServer {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.proc = null;
    this.pending = new Map();
    this.tools = null;
    this.error = null;
  }

  connect() {
    if (this.proc) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        this.proc = spawn(this.cfg.command, this.cfg.args || [], {
          stdio: ["pipe", "pipe", "ignore"],
          env: { ...process.env, ...(this.cfg.env || {}) },
          shell: false,
        });
      } catch (e) {
        this.error = e.message;
        return resolve();
      }
      const rl = readline.createInterface({ input: this.proc.stdout });
      rl.on("line", (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { res, rej, timer } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else res(msg.result);
        }
      });
      this.proc.on("error", (e) => { this.error = e.message; });
      this.proc.on("exit", (code) => {
        if (!this.tools) this.error = `exited with code ${code}`;
        for (const { rej, timer } of this.pending.values()) { clearTimeout(timer); rej(new Error("server exited")); }
        this.pending.clear();
        this.proc = null;
      });
      // MCP handshake
      this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "saturday", version: "1.0.0" },
      }, 15000)
        .then(() => {
          this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
          return this.request("tools/list", {}, 15000);
        })
        .then((r) => { this.tools = r.tools || []; resolve(); })
        .catch((e) => { this.error = e.message; resolve(); });
    });
  }

  send(msg) {
    try { this.proc?.stdin.write(JSON.stringify(msg) + "\n"); } catch {}
  }

  request(method, params, timeout = 20000) {
    return new Promise((res, rej) => {
      if (!this.proc) return rej(new Error("not connected"));
      const id = nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`timeout waiting for ${method}`));
      }, timeout);
      this.pending.set(id, { res, rej, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async callTool(name, args) {
    await this.connect();
    if (this.error && !this.tools) throw new Error(`${this.name}: ${this.error}`);
    const r = await this.request("tools/call", { name, arguments: args || {} });
    const parts = (r.content || []).map((c) => (c.type === "text" ? c.text : JSON.stringify(c)));
    return parts.join("\n") || JSON.stringify(r);
  }

  disconnect() {
    try { this.proc?.kill(); } catch {}
    this.proc = null;
  }
}

// ── unified facade ──

const stdioCache = new Map();

export async function listServers() {
  const reg = loadRegistry();
  const out = [];
  for (const [name, cfg] of Object.entries(reg.servers || {})) {
    if (cfg.type === "builtin") {
      const b = BUILTINS[cfg.builtin];
      out.push({ name, type: "builtin", enabled: cfg.enabled !== false, ok: !!b, tools: (b?.tools || []).map((t) => t.name), error: b ? null : `unknown builtin ${cfg.builtin}` });
    } else {
      if (cfg.enabled === false) {
        out.push({ name, type: "stdio", enabled: false, ok: false, tools: [], error: "disabled" });
        continue;
      }
      let s = stdioCache.get(name);
      if (!s) { s = new StdioServer(name, cfg); stdioCache.set(name, s); }
      await s.connect();
      out.push({ name, type: "stdio", enabled: true, ok: !s.error, tools: (s.tools || []).map((t) => t.name), error: s.error });
    }
  }
  return out;
}

export async function listTools() {
  const reg = loadRegistry();
  const out = [];
  for (const [name, cfg] of Object.entries(reg.servers || {})) {
    if (cfg.enabled === false) continue;
    if (cfg.type === "builtin") {
      for (const t of BUILTINS[cfg.builtin]?.tools || []) {
        out.push({ server: name, name: t.name, description: t.description, args: t.args });
      }
    } else {
      let s = stdioCache.get(name);
      if (!s) { s = new StdioServer(name, cfg); stdioCache.set(name, s); }
      await s.connect();
      for (const t of s.tools || []) {
        out.push({ server: name, name: t.name, description: t.description || "", args: Object.keys(t.inputSchema?.properties || {}) });
      }
    }
  }
  return out;
}

export async function callTool(name, args = {}) {
  const reg = loadRegistry();
  for (const [srv, cfg] of Object.entries(reg.servers || {})) {
    if (cfg.enabled === false) continue;
    if (cfg.type === "builtin") {
      const t = BUILTINS[cfg.builtin]?.tools.find((x) => x.name === name);
      if (t) return { server: srv, result: await t.run(args) };
    } else {
      let s = stdioCache.get(srv);
      if (!s) { s = new StdioServer(srv, cfg); stdioCache.set(srv, s); }
      await s.connect();
      if ((s.tools || []).some((t) => t.name === name)) {
        return { server: srv, result: await s.callTool(name, args) };
      }
    }
  }
  const all = (await listTools()).map((t) => t.name);
  throw new Error(`unknown tool "${name}". Available: ${all.join(", ") || "(none)"}`);
}

export function disconnectAll() {
  for (const s of stdioCache.values()) s.disconnect();
  stdioCache.clear();
}
