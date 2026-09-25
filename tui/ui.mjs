import chalk from "chalk";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, execSync } from "node:child_process";
import { loadProfile, getKey, getPreferredModel, setPreferredModel, FALLBACK_MODELS, callBrain, saveHistory, saveKey, verifyKey, historyFile, APP_DIR } from "../lib/ai.mjs";
import { loadSessions, persistSessions, newSession, fmtWhen } from "../lib/sessions.mjs";
import { summarize, compactSummary } from "../lib/kicad.mjs";
import { openFile, openFolder, statusInfo } from "../lib/vscode.mjs";
import { listServers, listTools, callTool, disconnectAll } from "../lib/mcp.mjs";
import { buildAskPrompt, buildFixPrompt, buildKicadPrompt } from "../brain/prompts.mjs";
import { renderMarkdown } from "../lib/markdown.mjs";

// ── theme (claude-code warmth: terracotta accent, dim chrome) ──
const ACC = chalk.hex("#E0915A");
const ACC2 = chalk.hex("#F5C684");
const USER_C = chalk.hex("#7DD3FC");
const OK_C = chalk.hex("#86EFAC");
const ERR_C = chalk.hex("#FCA5A5");
const DIM = chalk.dim;
const BOLD = chalk.bold;

const COMMANDS = [
  { name: "/ask", desc: "coding Q&A — explain, review, how-to", i: "💬" },
  { name: "/fix", desc: "diagnose error + patch", i: "🔧" },
  { name: "/kicad", desc: "KiCad 10 hardware help", i: "⚡" },
  { name: "/code", desc: "VS Code: open <file[:line]> · folder · status", i: "📝" },
  { name: "/session", desc: "sessions: list · new · switch · rename · delete", i: "📑" },
  { name: "/models", desc: "pick preferred model ★", i: "★" },
  { name: "/model", desc: "show model fallback chain", i: "◈" },
  { name: "/mcp", desc: "MCP servers status", i: "🔌" },
  { name: "/tools", desc: "list MCP tools", i: "🛠" },
  { name: "/call", desc: "call a tool · /call fs_read {\"path\":\"x\"}", i: "▶" },
  { name: "/tone", desc: "view/set tone · /tone friendly", i: "🎨" },
  { name: "/project", desc: "view/set project context", i: "📌" },
  { name: "/context", desc: "view/set extra context", i: "📎" },
  { name: "/history", desc: "recent runs · /history 5", i: "🕘" },
  { name: "/copy", desc: "copy last answer to clipboard", i: "📋" },
  { name: "/stats", desc: "session stats", i: "📊" },
  { name: "/retry", desc: "re-run last prompt", i: "↻" },
  { name: "/export", desc: "export chat to markdown", i: "💾" },
  { name: "/clear", desc: "clear conversation", i: "🧹" },
  { name: "/profile", desc: "show seller profile", i: "👤" },
  { name: "/save", desc: "save last answer · /save out.txt", i: "💿" },
  { name: "/key", desc: "how to set API key", i: "🔑" },
  { name: "/login", desc: "login: set API key + model ★", i: "🔐" },
  { name: "/help", desc: "show help", i: "?" },
  { name: "/exit", desc: "quit saturday", i: "⏻" },
];

const MODES = {
  ask: { label: "ask", icon: "💬", color: chalk.hex("#7DD3FC") },
  fix: { label: "fix", icon: "🔧", color: chalk.hex("#FCD34D") },
  kicad: { label: "kicad", icon: "⚡", color: chalk.hex("#C4B5FD") },
};

// shortcuts & aliases (easy slashes) — "/s" → "/session", "/new bot" → "/session new bot"
export const SHORTCUTS = {
  "/s": "/session",
  "/m": "/models",
  "/h": "/history",
  "/r": "/retry",
  "/new": "/session new",
  "/list": "/session list",
  "/sw": "/session switch",
  "/del": "/session delete",
};
const ALIAS_OF = { "/session": "/s", "/models": "/m", "/history": "/h", "/retry": "/r" };

const GROUPS = [
  ["🧠 brain", ["ask", "fix", "kicad"]],
  ["📑 chats", ["session", "history", "retry", "export", "copy", "clear"]],
  ["★ model", ["models", "model"]],
  ["🔌 tools", ["mcp", "tools", "call", "code"]],
  ["⚙ setup", ["tone", "project", "context", "profile", "save", "key", "login"]],
  ["⏻ system", ["help", "exit"]],
];

export function helpText() {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  const L = ["✻ saturday — pick a slash (start typing / to filter):", ""];
  for (const [g, names] of GROUPS) {
    L.push(g);
    for (const n of names) {
      const c = byName["/" + n];
      if (!c) continue;
      const al = ALIAS_OF[c.name] ? `  [${ALIAS_OF[c.name]}]` : "";
      L.push(`  ${c.i || "·"} ${c.name}${al} — ${c.desc}`);
    }
    L.push("");
  }
  L.push("session shortcuts: /new <name> · /list · /sw <n> · /del <n>");
  L.push("keys: enter send · ^J newline · tab accept · ↑↓ history / navigate · alt+1/2/3 brain · @file attaches");
  L.push("scroll: pgup/pgdn page · shift+↑↓ lines · home top · end follow");
  return L.join("\n");
}

function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

export function closestCmd(cmd) {
  let best = null, bestD = 3;
  for (const c of COMMANDS) {
    const d = lev(cmd, c.name);
    if (d < bestD) { bestD = d; best = c.name; }
  }
  return best;
}

// deterministic confetti row (done-celebration effect)
export function confettiRow(frame, width, seed) {
  const glyphs = ["✦", "·", "✧", "*"];
  const cols = [ACC, ACC2, USER_C, OK_C];
  let s = "";
  for (let i = 0; i < width; i++) {
    const h = ((i * 2654435761 + seed * 40503 + frame * 97) >>> 0);
    if (h % 17 === 0) s += cols[(h >>> 3) % cols.length](glyphs[(h >>> 5) % glyphs.length]);
    else s += " ";
  }
  return s;
}

// scroll step math: cur null = following; returns null (follow) or pinned line
export function stepScroll(cur, d, max) {
  const next = (cur == null ? max : cur) + d;
  return next >= max ? null : Math.max(0, next);
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BOOT_STAGES = ["waking saturday", "loading brain prompts", "connecting MCP servers", "warming free models", "ready"];
const TIPS = [
  "tip: @file attaches a file",
  "tip: /models changes the engine",
  "tip: alt+1/2/3 switches brain",
  "tip: /copy grabs last answer",
  "tip: /retry re-runs last prompt",
];

const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

// gradient text helper (effect)
function gradient(text, from = [224, 145, 90], to = [245, 198, 132]) {
  const chars = [...text];
  return chars.map((c, i) => {
    const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
    const rgb = from.map((f, j) => Math.round(f + (to[j] - f) * t));
    return chalk.rgb(...rgb)(c);
  }).join("");
}

// enchanted rainbow shimmer (animated by frame) — no chalk.hsl dependency
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

export function enchanted(text, frame) {
  return [...text].map((c, i) => {
    if (c === " ") return " ";
    return chalk.rgb(...hslToRgb(i * 24 + frame * 36, 0.85, 0.72))(c);
  }).join("");
}

function wrap(text, width) {
  const out = [];
  for (const para of String(text).split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(" ")) {
      const test = line ? line + " " + word : word;
      if (vlen(test) > width) {
        if (line) out.push(line);
        let w = word;
        while (vlen(w) > width) { out.push(w.slice(0, width)); w = w.slice(width); }
        line = w;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

// sunset gradient over any string (keeps spaces plain)
function gradText(s) {
  const chars = [...s];
  return chars.map((c, i) => {
    if (c === " ") return " ";
    const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
    return chalk.rgb(Math.round(224 + 21 * t), Math.round(145 + 53 * t), Math.round(90 + 42 * t))(c);
  }).join("");
}

function boxTop(w, title = "") {
  if (!title) return DIM("╭" + "─".repeat(w - 2) + "╮");
  const t = ` ${title} `;
  const fill = Math.max(0, w - 2 - vlen(t));
  return DIM("╭") + ACC(t) + DIM("─".repeat(fill) + "╮");
}
const boxBot = (w) => DIM("╰" + "─".repeat(w - 2) + "╯");
const boxLine = (w, content = "") => {
  const pad = Math.max(0, w - 4 - vlen(content));
  return DIM("│ ") + content + " ".repeat(pad) + DIM(" │");
};

const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

function copyToClipboard(text) {
  try {
    if (process.platform === "win32") return spawnSync("clip", { input: text, shell: true }).status === 0;
    if (process.platform === "darwin") return spawnSync("pbcopy", { input: text }).status === 0;
    if (spawnSync("xclip", ["-selection", "clipboard"], { input: text }).status === 0) return true;
    return spawnSync("xsel", ["--clipboard", "--input"], { input: text }).status === 0;
  } catch { return false; }
}

export async function startTUI({ key, model, anim = true } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Saturday TUI needs an interactive terminal. Use: saturday ask --ask  or  saturday chat --simple");
    return;
  }
  const profile = loadProfile();
  const t0 = Date.now();
  const CWD_NAME = path.basename(process.cwd());
  let GIT_BRANCH = "";
  try { GIT_BRANCH = execSync("git branch --show-current", { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim(); } catch {}
  const state = {
    mode: "ask",
    preferredModel: model || getPreferredModel(),
    tone: "",
    proj: path.basename(process.cwd()),
    context: "",
    messages: [],
    input: "",
    cursor: 0,
    hist: [],
    histIdx: -1,
    busy: false,
    busySince: 0,
    busyTokens: 0,
    spinFrame: 0,
    tokens: 0,
    hasKey: !!getKey(key),
    login: null,
    lastAnswer: "",
    lastUser: null,
    lastModel: (model || FALLBACK_MODELS[0]).split("/").pop(),
    selIdx: 0,
    scroll: null, // null = follow live tail; number = pinned line
    followFrom: 0, // msg count when user pinned (for "N new")
    view: null, // last layout {total, visible, start} for scroll math
    boot: anim ? 0 : BOOT_STAGES.length,
    modelPicker: false,
    blink: true,
    lastTip: -1,
    pulse: 0,
    tokTimes: [],
    lastDone: null,
    exiting: false,
    sessionPicker: false,
  };

  // sessions: restore persisted chats (claude-code style resume)
  const stored = loadSessions();
  state.sessions = stored.length ? stored : [newSession("general")];
  state.sid = state.sessions[0].id;
  state.messages = state.sessions[0].messages;
  deriveLast();

  const cur = () => state.sessions.find((s) => s.id === state.sid) || state.sessions[0];

  function touch() {
    const c = cur();
    if (c) c.updatedAt = new Date().toISOString();
    persistSessions(state.sessions);
  }

  function deriveLast() {
    const rev = [...state.messages].reverse();
    const lastA = rev.find((m) => m.role === "assistant" && !m.error && m.text);
    const lastU = rev.find((m) => m.role === "user");
    state.lastAnswer = lastA ? lastA.text : "";
    state.lastUser = lastU ? { mode: lastU.mode, text: lastU.text } : null;
  }

  // ── scrolling: relative moves with bottom-snap, Home=top, End=follow ──
  function scrollBy(d) {
    const v = state.view;
    if (!v || v.total <= v.visible) return;
    const max = v.total - v.visible;
    if (state.scroll == null) state.followFrom = v.total;
    state.scroll = stepScroll(state.scroll, d, max);
    if (state.scroll == null) state.followFrom = 0;
    render();
  }
  function scrollEdge(where) {
    const v = state.view;
    if (!v || v.total <= v.visible) { state.scroll = null; render(); return; }
    if (where === "top") {
      if (state.scroll == null) state.followFrom = v.total;
      state.scroll = 0; // absolute top line (null means follow, so top needs 0)
    } else {
      state.scroll = null;
      state.followFrom = 0;
    }
    render();
  }

  function switchSession(id) {
    const t = state.sessions.find((s) => s.id === id);
    if (!t) return;
    state.sid = t.id;
    state.messages = t.messages;
    state.scroll = null;
    deriveLast();
    touch();
    render();
  }

  const out = process.stdout;
  const enterAlt = "\x1b[?1049h\x1b[H";
  const exitAlt = "\x1b[?1049l";
  // flicker fixes: hide hardware cursor while drawing, batch each frame
  const SYNC_ON = "\x1b[?2026h";
  const SYNC_OFF = "\x1b[?2026l";
  const HIDE = "\x1b[?25l";
  const SHOW = "\x1b[?25h";
  let lastFrame = "";
  let lastRows = null;
  out.write(enterAlt + HIDE);
  const cleanup = () => {
    try { persistSessions(state.sessions); } catch {}
    try { process.stdin.setRawMode(false); } catch {}
    try { clearInterval(tick); } catch {}
    try { clearInterval(idleTick); } catch {}
    try { clearInterval(bootTick); } catch {}
    try { disconnectAll(); } catch {}
    out.write(SHOW + exitAlt);
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  readline.emitKeypressEvents(process.stdin);
  try { process.stdin.setRawMode(true); } catch {}
  // redraw cleanly on terminal resize instead of leaving a stale layout
  try { out.on("resize", () => { lastFrame = ""; lastRows = null; render(); }); } catch {}

  const W = () => out.columns || 100;
  const H = () => out.rows || 30;
  // centered column: app renders at max 110 cols, middle of wide terminals
  let VW = 110;

  // ── boot splash (effect) ──
  const bootTick = setInterval(() => {
    if (state.boot >= BOOT_STAGES.length) { clearInterval(bootTick); render(); return; }
    state.boot++;
    render();
  }, 240);

  // ── aesthetic loader pieces ──
  const BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
  const LOGO_ROWS = [
    "███████╗ █████╗ ████████╗██╗   ██╗██████╗ ██████╗  █████╗ ██╗   ██╗",
    "██╔════╝██╔══██╗╚══██╔══╝██║   ██║██╔══██╗██╔══██╗██╔══██╗╚██╗ ██╔╝",
    "███████╗███████║   ██║   ██║   ██║██████╔╝██║  ██║███████║ ╚████╔╝ ",
    "╚════██║██╔══██║   ██║   ██║   ██║██╔══██╗██║  ██║██╔══██║  ╚██╔╝  ",
    "███████║██║  ██║   ██║   ╚██████╔╝██║  ██║██████╔╝██║  ██║   ██║   ",
    "╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝   ",
  ];

  // per-row sunset gradient + travelling sheen column
  function paintLogo(frame) {
    return LOGO_ROWS.map((row, r) => {
      const t = r / (LOGO_ROWS.length - 1);
      const base = [Math.round(224 + 21 * t), Math.round(145 + 53 * t), Math.round(90 + 42 * t)];
      const chars = [...row];
      const pos = (frame * 3) % (chars.length + 24) - 12;
      return chars.map((c, i) => {
        if (c === " ") return " ";
        const d = Math.abs(i - pos);
        if (d < 4) return chalk.rgb(255, 228, 178)(BOLD(c));
        return chalk.rgb(...base)(c);
      }).join("");
    });
  }

  // deterministic twinkling sparkle line
  function sparkleLine(frame, width, seed) {
    let s = "";
    for (let i = 0; i < width; i++) {
      const h = ((i * 2654435761 + seed * 40503) >>> 0);
      s += h % 29 === 0 && (frame + (h >>> 4)) % 4 < 2 ? chalk.gray("✦") : " ";
    }
    return s;
  }

  const center = (s, w) => " ".repeat(Math.max(0, Math.floor((w - vlen(s)) / 2))) + s;

  function splash() {
    const w = W();
    const narrow = w < 76;
    const p = Math.min(1, (Date.now() - t0) / 1250);
    const stage = BOOT_STAGES[Math.min(state.boot, BOOT_STAGES.length - 1)];
    const dots = "·".repeat(1 + (state.spinFrame % 3));
    const lines = ["", ""];
    if (!narrow) {
      const lw = 67;
      const pad = Math.max(0, Math.floor((w - lw) / 2));
      lines.push(" ".repeat(pad) + sparkleLine(state.spinFrame, lw, 7));
      for (const row of paintLogo(state.spinFrame)) lines.push(" ".repeat(pad) + row);
      lines.push(" ".repeat(pad) + sparkleLine(state.spinFrame + 2, lw, 21));
      lines.push(center(DIM("y o u r   c o d i n g   c o p i l o t"), w));
      lines.push(center(enchanted("✦ made by Samiullah Khan ✦", state.spinFrame), w));
    } else {
      lines.push(center(BOLD(gradient("✻ SATURDAY")), w));
      lines.push(center(DIM("your coding copilot"), w));
      lines.push(center(enchanted("made by Samiullah Khan", state.spinFrame), w));
    }
    lines.push("");
    // glowing progress bar with fractional tip
    const bw = Math.min(40, w - 22);
    const exact = p * bw;
    const full = Math.floor(exact);
    const part = BLOCKS[Math.floor((exact - full) * 8)];
    const bar = (full ? gradient("█".repeat(full)) : "") +
      (full < bw ? chalk.rgb(245, 198, 132)(part) + DIM("─".repeat(bw - full - 1)) : "");
    lines.push(center(`${ACC(SPINNER[state.spinFrame % SPINNER.length])}  ${bar}  ${DIM(Math.round(p * 100) + "%")}`, w));
    lines.push(center(DIM(`${stage}${dots}`), w));
    lines.push("", center(DIM("any key skips"), w));
    return lines;
  }

  // ── header ──
  function header() {
    const w = VW;
    const m = MODES[state.mode];
    // breathing logo: gentle glow pulse when idle
    const breathe = !state.busy && anim && Math.floor(Date.now() / 900) % 2 === 0;
    const logoC = breathe ? ACC2 : ACC;
    const left = BOLD(logoC(" ✻ saturday ")) + DIM("· ") + m.color(`${m.icon} ${m.label}`);
    const sessName = (cur()?.name || "").slice(0, 18);
    const sessChip = sessName ? DIM(" · ") + ACC(`📑 ${sessName}`) : "";
    const mid = state.preferredModel ? DIM(` · ★ ${state.preferredModel.split("/").pop()}`) : "";
    const right = state.busy
      ? ACC(`${SPINNER[state.spinFrame % SPINNER.length]} working ${((Date.now() - state.busySince) / 1000).toFixed(1)}s`)
      : state.hasKey ? OK_C("● ready") : ERR_C("● no key — /login");
    const pad = Math.max(1, w - vlen(left) - vlen(sessChip) - vlen(mid) - vlen(right));
    return left + sessChip + mid + " ".repeat(pad) + right;
  }

  // ── hero (empty state) ──
  function hero() {
    const w = Math.min(VW - 4, 76);
    const L = [];
    L.push(boxTop(w + 4, "✻ saturday"));
    L.push(boxLine(w + 4, BOLD("Your coding copilot — VS Code + KiCad 10 ready.")));
    L.push(boxLine(w + 4, ""));
    for (const t of [
      `${MODES.ask.color("💬  ask  ")}  @src/app.ts explain this · how do I debounce?`,
      `${MODES.fix.color("🔧  fix  ")}  paste a traceback, get a patch + verify cmd`,
      `${MODES.kicad.color("⚡  kicad")}  /kicad check · is C7 big enough for 24V?`,
    ]) {
      for (const l of wrap(t, w)) L.push(boxLine(w + 4, "  " + l));
    }
    L.push(boxLine(w + 4, ""));
    L.push(boxLine(w + 4, DIM("Switch:  /ask  /fix  /kicad   or  alt+1 / alt+2 / alt+3")));
    L.push(boxLine(w + 4, DIM("Attach: @file  ·  VS Code: /code  ·  Tools: /mcp  ·  Chats: /session")));
    L.push(boxLine(w + 4, ""));
    L.push(boxLine(w + 4, DIM("Try →  @package.json what does this project do?")));
    L.push(boxLine(w + 4, DIM("Try →  /code open src/index.ts:10")));
    if (!state.hasKey) L.push(boxLine(w + 4, ERR_C("No API key — type  /login  to sign in")));
    L.push(boxBot(w + 4));
    return L;
  }

  // ── thinking panel (animated stages while waiting for first token) ──
  function thinkingPanel() {
    const w = Math.min(VW - 4, 64);
    const els = (Date.now() - state.busySince) / 1000;
    const stage = els < 2 ? "reading context" : els < 6 ? `consulting ${MODES[state.mode].label} brain` : "writing answer";
    const dots = ".".repeat(1 + (state.spinFrame % 3));
    const rate = state.busyTokens > 10 ? ` · ${Math.round(state.busyTokens / Math.max(0.5, els))} tok/s` : "";
    // slim thinking indicator (no box)
    const L = [];
    L.push(`  ${ACC(SPINNER[state.spinFrame % SPINNER.length])}  ${stage}${dots}  ${DIM(els.toFixed(1) + "s" + rate)}`);
    const bw2 = 22;
    const pos2 = state.spinFrame % (bw2 + 8);
    let bar2 = "";
    for (let i = 0; i < bw2; i++) bar2 += i >= pos2 - 4 && i <= pos2 ? ACC2("━") : DIM("─");
    L.push(`  ${DIM("╰")} ${bar2}`);
    return L;
  }

  function slashMatches() {
    if (state.login || state.sessionPicker || !state.input.startsWith("/")) return [];
    const frag = state.input.split(" ")[0].toLowerCase();
    const out = COMMANDS.filter((c) => c.name.startsWith(frag));
    for (const [a, target] of Object.entries(SHORTCUTS)) {
      if (a.startsWith(frag) && !out.some((c) => c.name === a)) {
        const t = COMMANDS.find((c) => c.name === target.split(" ")[0]);
        if (t) out.push({ name: a, desc: `shortcut → ${target}`, i: t.i });
      }
    }
    return out.slice(0, 7);
  }

  function render() {
    if (state.boot < BOOT_STAGES.length) {
      const f = SYNC_ON + "\x1b[H\x1b[J" + splash().join("\n") + HIDE + SYNC_OFF;
      if (f !== lastFrame) { lastFrame = f; lastRows = null; out.write(f); }
      return;
    }
    const sideMode = W() >= 112;
    const SIDEW = 24;
    const w = (VW = sideMode ? Math.min(108, W() - SIDEW - 5) : Math.min(W(), 110)), h = H();
    const totalW = sideMode ? VW + 3 + SIDEW : VW;
    const gutter = " ".repeat(Math.max(0, Math.floor((W() - totalW) / 2)));
    const lines = [header(), DIM("─".repeat(w))];
    const padVis = (s, n) => s + " ".repeat(Math.max(0, n - vlen(s)));

    const msg = [];
    if (state.messages.length === 0) msg.push(...hero());
    for (const m of state.messages) {
      if (m.role === "user") {
        const files = m.files?.length ? DIM(`  📎 ${m.files.join(", ")}`) : "";
        msg.push(USER_C("❯") + DIM(` you · ${MODES[m.mode]?.label || m.mode}`) + files);
        for (const l of wrap(m.text, w - 2)) msg.push(l ? "  " + DIM(l) : "");
        msg.push("");
      } else if (m.role === "assistant") {
        if (m.streaming && !m.text) { msg.push(...thinkingPanel(), ""); continue; }
        const chip = MODES[m.mode]?.color(`✻ ${MODES[m.mode]?.label}`) || ACC("✻");
        const receipt = `  ✦ ${m.model || ""}${m.ms ? ` · ${(m.ms / 1000).toFixed(1)}s` : ""}${m.tok ? ` · ${fmtTok(m.tok)} tok` : ""}`;
        const pulsing = m === state.lastDone && state.pulse > 0;
        const meta = m.streaming
          ? DIM("  ") + (state.blink || !anim ? ACC("▍") : ACC("▏"))
          : m.error ? " " + ERR_C("(error)") : pulsing ? [ACC, ACC2, OK_C][state.pulse % 3](receipt) : DIM(receipt);
        msg.push(chip + meta);
        const body = m.text || DIM("thinking…");
        if (m.error || !m.text) {
          for (const l of wrap(body, w - 2)) msg.push(l ? (m.error ? ERR_C("  " + l) : "  " + l) : "");
        } else {
          for (const l of renderMarkdown(body, w)) msg.push(l);
        }
        if (pulsing) msg.push("  " + confettiRow(state.pulse, Math.max(10, w - 6), 11));
        msg.push("");
      } else {
        for (const l of wrap(m.text, w - 4)) msg.push(l ? DIM("  ") + ACC("✦ ") + DIM(l) : "");
        msg.push("");
      }
    }

    const popup = state.modelPicker || state.sessionPicker ? [] : slashMatches();
    if (state.selIdx >= popup.length) state.selIdx = 0;

    // input layout: opencode-style box — grows to 5 rows, per-line scroll (drives visible height)
    const m = MODES[state.mode];
    const prompt = m.color("❯ ");
    const shown = state.login?.step === "key" ? "•".repeat(state.input.length) : state.input;
    const MAXH = 5;
    const { lines: logLines, crow, coff } = cursorLine();
    let wtop = 0;
    if (logLines.length > MAXH) wtop = Math.min(Math.max(0, crow - MAXH + 1), logLines.length - MAXH);
    const vend = Math.min(logLines.length, wtop + MAXH);
    const irows = [];
    let curR = 0, curC = 0;
    for (let vi = wtop; vi < vend; vi++) {
      const ln = logLines[vi];
      const prefix = vi === 0 ? prompt : "  ";
      const capL = Math.max(10, w - 4 - vlen(prefix));
      let winL = 0;
      if (ln.length > capL) winL = vi === crow ? Math.min(Math.max(0, coff - Math.floor(capL * 0.7)), ln.length - capL) : 0;
      const visL = ln.slice(winL, winL + capL);
      const lm = winL > 0 ? DIM("…") : "";
      const rm = winL + capL < ln.length ? DIM("…") : "";
      if (vi === crow) {
        const beforeL = visL.slice(0, coff - winL);
        irows.push(prefix + lm + beforeL + visL.slice(coff - winL) + rm);
        curR = vi - wtop;
        curC = vlen(prefix + lm + beforeL);
      } else {
        irows.push(prefix + lm + visL + rm);
      }
    }
    let titleCore = state.login?.step === "key" ? "🔐 API key (hidden)"
      : state.login || state.modelPicker ? "★ pick model"
      : state.sessionPicker ? "📑 sessions"
      : `${m.icon} ${m.label} · ${state.lastModel}` +
        (state.tone ? ` · ${state.tone}` : "") +
        (state.proj ? ` · ${state.proj}` : "");
    while (vlen(titleCore) > w - 12 && titleCore.length > 8) titleCore = titleCore.slice(0, -1);

    const inputH = 2 + irows.length; // box borders + content rows
    const popupH = popup.length ? popup.length + 2 : 0;
    const visible = Math.max(4, h - 2 - inputH - popupH - 2);
    const start = state.scroll == null ? Math.max(0, msg.length - visible) : Math.max(0, Math.min(msg.length - visible, state.scroll));
    state.view = { total: msg.length, visible, start };
    if (start > 0) lines.push(center(DIM(`▲ ${start} more · pgup`), w));
    for (let i = start; i < Math.min(msg.length, start + visible); i++) lines.push(msg[i]);
    const hiddenBelow = msg.length - (start + visible);
    if (state.scroll != null) {
      const fresh = Math.max(0, msg.length - (state.followFrom || msg.length));
      lines.push(center(DIM(`▼ ${hiddenBelow} more${fresh ? ` · ${fresh} new` : ""} · End to follow`), w));
    } else if (hiddenBelow > 0) {
      lines.push(center(DIM(`▼ ${hiddenBelow} more · pgdn`), w));
    }

    // side mode: bottom-anchor the box with filler so the panel spans full height
    if (sideMode) {
      const pickerH = state.modelPicker ? 3 + FALLBACK_MODELS.length
        : state.sessionPicker ? 2 + state.sessions.length
        : popup.length ? 2 + popup.length : 0;
      const filler = Math.max(0, h - (lines.length + pickerH + inputH));
      for (let i = 0; i < filler; i++) lines.push("");
    }

    if (state.modelPicker) {
      lines.push(boxTop(w, "★ pick model (number, or paste any OpenRouter slug)"));
      FALLBACK_MODELS.forEach((mname, i) => {
        const star = mname === state.preferredModel ? ACC(" ★") : "";
        const row = ` ${i + 1}. ${mname}${star}`;
        lines.push(boxLine(w, i === state.selIdx ? chalk.bgHex("#2A2118").hex("#F5C684")(row) : " " + DIM(row)));
      });
      lines.push(boxLine(w, DIM("  esc cancel · enter applies highlighted")));
      lines.push(boxBot(w));
    } else if (state.sessionPicker) {
      lines.push(boxTop(w, "📑 sessions (number · name · `new <name>` · esc cancel)"));
      state.sessions.forEach((s, i) => {
        const mark = s.id === state.sid ? ACC("●") : DIM("○");
        const row = ` ${i + 1}. ${mark} ${s.name}  (${s.messages.length} msgs · ${fmtWhen(s.updatedAt)})`;
        lines.push(boxLine(w, i === state.selIdx ? chalk.bgHex("#2A2118").hex("#F5C684")(row) : " " + DIM(row)));
      });
      lines.push(boxBot(w));
    } else if (popup.length) {
      lines.push(boxTop(w, "/ commands"));
      popup.forEach((c, i) => {
        const label = `${c.i || "·"} ${c.name}`;
        const row = i === state.selIdx
          ? chalk.bgHex("#2A2118").hex("#F5C684")(` ${label} `) + DIM(`  ${c.desc}`)
          : USER_C(` ${label} `) + DIM(`  ${c.desc}`);
        lines.push(boxLine(w, row));
      });
      lines.push(boxBot(w));
    }

    // input box (opencode-style: grows, then scrolls)
    lines.push(boxTop(w, titleCore));
    for (const r of irows) lines.push(boxLine(w, r));
    lines.push(boxBot(w));

    // status: bottom bar in narrow mode, side panel in wide mode
    const sess = fmtTime(Date.now() - t0);
    const nowT = Date.now();
    while (state.tokTimes.length && state.tokTimes[0] < nowT - 3000) state.tokTimes.shift();
    let spark = "";
    if (state.tokTimes.length) {
      const BK = " ▁▂▃▄▅▆▇█";
      const buckets = new Array(10).fill(0);
      for (const t of state.tokTimes) buckets[9 - Math.min(9, Math.floor((nowT - t) / 300))]++;
      const mx = Math.max(1, ...buckets);
      spark = " " + ACC(buckets.map((c) => BK[Math.round((c / mx) * 8)]).join(""));
    }
    const tip = !state.busy && anim ? TIPS[Math.floor((Date.now() - t0) / 7000) % TIPS.length] + " · " : "";
    const hints = DIM(` ${tip}↵ send · ^J newline · tab ok · esc clear · ^C quit `);
    let side = null;
    if (sideMode) {
      const rule2 = DIM("─".repeat(SIDEW));
      side = [
        BOLD(ACC("✻ status")),
        `📁 ${CWD_NAME.slice(0, SIDEW - 3)}`,
        ...(GIT_BRANCH ? [DIM(`(${GIT_BRANCH.slice(0, SIDEW - 2)})`)] : []),
        rule2,
        ACC(`★ ${state.lastModel.slice(0, SIDEW - 3)}`),
        DIM(`tok ${fmtTok(state.tokens)}`) + spark,
        DIM(`⏱ ${sess} · ${state.messages.length} msgs`),
        rule2,
        ...wrap("tip: " + (!state.busy && anim ? TIPS[Math.floor((Date.now() - t0) / 7000) % TIPS.length] : "working…"), SIDEW).map((l) => DIM(l)),
        rule2,
        ...["↵ send", "^J newline", "tab ok", "esc clear", "^C quit"].map((k) => DIM(k)),
      ];
      while (side.length < h) side.push("");
      side = side.slice(0, h);
    } else {
      const bar = DIM(` 📁 ${CWD_NAME}${GIT_BRANCH ? ` (${GIT_BRANCH})` : ""} · ${state.lastModel} · tok ${fmtTok(state.tokens)}${spark} · ${sess} · ${state.messages.length} msgs `);
      const padB = Math.max(1, w - vlen(bar) - vlen(hints));
      lines.push(bar + " ".repeat(padB) + hints);
    }

    // flicker-free frame: repaint only changed rows when possible, else full redraw
    const newRows = sideMode
      ? lines.map((l, i) => gutter + padVis(l, VW) + DIM(" │ ") + (side[i] || ""))
      : lines.map((l) => gutter + l);
    let tail;
    if (!state.busy) {
      const endPad = sideMode ? 1 : 2; // boxBot (+ status bar in narrow mode)
      const row = lines.length - endPad - irows.length + curR + 1;
      const col = gutter.length + 2 + curC + 1;
      tail = `\x1b[${row};${col}H${SHOW}`;
    } else {
      tail = HIDE;
    }
    const full = SYNC_ON + "\x1b[H\x1b[J" + newRows.join("\n") + tail + SYNC_OFF;
    if (full === lastFrame) return;
    if (process.env.SATURDAY_DEBUG) {
      const diffs = !lastRows || lastRows.length !== newRows.length ? "LEN" : newRows.filter((r, i) => r !== lastRows[i]).length;
      process.stderr.write(`[render] rows=${newRows.length} lastRows=${lastRows ? lastRows.length : "null"} diffs=${diffs} input=${JSON.stringify(state.input.slice(-12))}\n`);
    }
    if (lastRows && lastRows.length === newRows.length) {
      const diffs = [];
      for (let i = 0; i < newRows.length; i++) if (newRows[i] !== lastRows[i]) diffs.push(i);
      // ≤3 rows (or none — cursor-only move) → rewrite just those + park cursor
      if (diffs.length <= 3) {
        let seq = SYNC_ON;
        for (const d of diffs) seq += `\x1b[${d + 1};1H\x1b[2K${newRows[d]}`;
        seq += tail + SYNC_OFF;
        lastFrame = full;
        lastRows = newRows;
        out.write(seq);
        return;
      }
    }
    lastFrame = full;
    lastRows = newRows;
    out.write(full);
  }

  let renderTimer = null;
  const scheduleRender = () => {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 90);
  };
  const tick = setInterval(() => {
    if (!anim) return;
    if (state.busy || state.boot < BOOT_STAGES.length) { state.spinFrame++; state.blink = !state.blink; render(); }
    else if (state.pulse > 0) { state.pulse--; render(); }
  }, 150);
  const idleTick = setInterval(() => {
    if (!anim || state.busy || state.boot < BOOT_STAGES.length || state.exiting) return;
    const tipIdx = Math.floor((Date.now() - t0) / 7000);
    if (tipIdx !== state.lastTip) { state.lastTip = tipIdx; render(); }
  }, 1000);

  // goodbye splash on exit (effect)
  function exitFlow() {
    if (state.exiting) return;
    state.exiting = true;
    try { clearInterval(tick); } catch {}
    try { clearInterval(idleTick); } catch {}
    try { clearInterval(bootTick); } catch {}
    const w = Math.min(W() - 4, 60);
    const L = ["", ""];
    L.push(boxTop(w + 4, "bye"));
    L.push(boxLine(w + 4, `  ${gradient("✻ see you soon")}  ${DIM(`· ${state.messages.length} msgs · ${fmtTok(state.tokens)} tok · ${fmtTime(Date.now() - t0)}`)}`));
    L.push(boxBot(w + 4));
    const eg = " ".repeat(Math.max(0, Math.floor((W() - Math.min(W(), 110)) / 2)));
    lastFrame = "";
    lastRows = null;
    out.write(SYNC_ON + "\x1b[H\x1b[J" + L.map((l) => eg + l).join("\n") + HIDE + SYNC_OFF);
    setTimeout(() => { cleanup(); process.exit(0); }, 450);
  }

  // logical-line helpers for the multiline input box
  function cursorLine() {
    const ll = state.input.split("\n");
    let acc = 0;
    for (let i = 0; i < ll.length; i++) {
      if (state.cursor <= acc + ll[i].length) return { lines: ll, crow: i, coff: state.cursor - acc };
      acc += ll[i].length + 1;
    }
    return { lines: ll, crow: ll.length - 1, coff: ll[ll.length - 1].length };
  }
  function lineStart(ll, i) {
    let s = 0;
    for (let j = 0; j < i; j++) s += ll[j].length + 1;
    return s;
  }

  // @file mentions → attach file contents (claude-code style)
  function resolveMentions(text) {
    const files = [...text.matchAll(/@([^\s@]+)/g)].map((m) => m[1]);
    if (!files.length) return { text, attached: [] };
    const attached = [];
    const blocks = [];
    for (const f of [...new Set(files)]) {
      try {
        const abs = f.startsWith("/") ? f : `${process.cwd()}/${f}`;
        const content = fs.readFileSync(abs, "utf8");
        const cap = content.length > 20000 ? content.slice(0, 20000) + "\n…[truncated]" : content;
        blocks.push(`<file path="${f}">\n${cap}\n</file>`);
        const kb = (Buffer.byteLength(cap) / 1024).toFixed(1);
        attached.push(`${f} (${kb}kb)`);
      } catch {
        throw new Error(`can't read @${f} — file not found`);
      }
    }
    return { text: `${text}\n\nATTACHED FILES:\n${blocks.join("\n")}`, attached };
  }

  async function submit(raw) {
    const text = raw.trim();
    if (!text) return;

    // login step 1: API key (masked input)
    if (state.login?.step === "key") {
      if (!text) {
        state.messages.push({ role: "system", text: "key can't be empty — paste it, or esc to cancel" });
        render();
        return;
      }
      state.input = ""; state.cursor = 0;
      state.messages.push({ role: "system", text: "verifying key…" });
      render();
      const res = await verifyKey(text).catch(() => ({ ok: false, status: "network" }));
      state.messages.pop();
      saveKey(text);
      state.hasKey = true;
      if (res.ok) state.messages.push({ role: "system", text: `✔ key valid${res.label ? ` (${res.label})` : ""} — saved to ~/.saturday/config.json` });
      else state.messages.push({ role: "system", text: `⚠ key check failed (${res.status || "network"}) — saved anyway, /login to retry` });
      // step 2/2: pick model
      state.login.step = "model";
      state.modelPicker = true;
      state.selIdx = Math.max(0, FALLBACK_MODELS.indexOf(state.preferredModel));
      render();
      return;
    }

    // model picker mode
    if (state.modelPicker) {
      state.modelPicker = false;
      state.login = null;
      const n = Number(text);
      let slug = text;
      if (Number.isInteger(n) && n >= 1 && n <= FALLBACK_MODELS.length) slug = FALLBACK_MODELS[n - 1];
      if (text.toLowerCase() === "none" || text.toLowerCase() === "auto") slug = "";
      if (slug) {
        state.preferredModel = slug;
        setPreferredModel(slug);
        state.messages.push({ role: "system", text: `★ preferred model → ${slug}  (saved, tried first)` });
      } else {
        state.preferredModel = "";
        setPreferredModel("");
        state.messages.push({ role: "system", text: "preferred model cleared — auto chain" });
      }
      state.input = ""; state.cursor = 0;
      render();
      return;
    }

    // session picker mode
    if (state.sessionPicker) {
      state.sessionPicker = false;
      state.input = ""; state.cursor = 0;
      const low = text.toLowerCase();
      if (low.startsWith("new")) {
        const name = text.slice(3).trim() || "new chat";
        const s = newSession(name);
        state.sessions.push(s);
        switchSession(s.id);
        state.messages.push({ role: "system", text: `📑 new session → ${s.name}` });
        touch(); render();
        return;
      }
      const n = Number(text);
      if (Number.isInteger(n) && n >= 1 && n <= state.sessions.length) {
        switchSession(state.sessions[n - 1].id);
        return;
      }
      const hit = state.sessions.find((s) => s.name.toLowerCase() === low || s.id === text);
      if (hit) { switchSession(hit.id); return; }
      state.messages.push({ role: "system", text: `no session "${text}" — number, name, or "new <name>"` });
      render();
      return;
    }

    if (text.startsWith("/")) {
      let [cmd, ...rest] = text.split(" ");
      let arg = rest.join(" ").trim();
      if (SHORTCUTS[cmd]) {
        const expanded = (SHORTCUTS[cmd] + (arg ? " " + arg : "")).split(" ");
        cmd = expanded[0]; rest = expanded.slice(1); arg = rest.join(" ").trim();
      }
      const say = (t) => { state.messages.push({ role: "system", text: t }); render(); };
      if (cmd === "/exit" || cmd === "/q") { exitFlow(); return; }
      if (cmd === "/clear") { state.messages = []; state.scroll = null; touch(); render(); return; }
      if (cmd === "/session") {
        const [sub, ...restArgs] = arg.split(" ");
        const subArg = restArgs.join(" ").trim();
        const list = () => state.sessions.map((s, i) => `${i + 1}. ${s.id === state.sid ? "● " : "○ "}${s.name}  (${s.messages.length} msgs · ${fmtWhen(s.updatedAt)})`).join("\n");
        if (!sub) {
          state.sessionPicker = true;
          state.selIdx = Math.max(0, state.sessions.findIndex((s) => s.id === state.sid));
          state.input = ""; state.cursor = 0;
          render();
          return;
        }
        if (sub === "list") { say("📑 sessions:\n" + list() + "\n\nswitch: /session switch <n|name> · new: /session new <name>"); return; }
        if (sub === "new") {
          const s = newSession(subArg);
          state.sessions.push(s);
          switchSession(s.id);
          say(`📑 new session → ${s.name}`);
          return;
        }
        if (sub === "switch") {
          const n = Number(subArg);
          const t = Number.isInteger(n) && n >= 1 && n <= state.sessions.length
            ? state.sessions[n - 1]
            : state.sessions.find((s) => s.name.toLowerCase() === subArg.toLowerCase() || s.id === subArg);
          if (!t) { say(`no session "${subArg}"\n` + list()); return; }
          switchSession(t.id);
          return;
        }
        if (sub === "rename") {
          if (!subArg) { say("Usage: /session rename <name>"); return; }
          cur().name = subArg.slice(0, 60);
          touch(); render();
          return;
        }
        if (sub === "delete") {
          const n = Number(subArg);
          const idx = Number.isInteger(n) && n >= 1 && n <= state.sessions.length
            ? n - 1
            : state.sessions.findIndex((s) => s.name.toLowerCase() === subArg.toLowerCase() || s.id === subArg);
          if (idx < 0) { say(`no session "${subArg}"\n` + list()); return; }
          if (state.sessions.length === 1) {
            state.sessions[0].messages = [];
            state.sessions[0].name = "general";
            state.messages = state.sessions[0].messages;
            deriveLast(); touch(); render();
            say("last session cleared");
            return;
          }
          const [gone] = state.sessions.splice(idx, 1);
          if (gone.id === state.sid) {
            state.sid = state.sessions[0].id;
            state.messages = state.sessions[0].messages;
            deriveLast();
          }
          touch(); render();
          say(`deleted "${gone.name}"`);
          return;
        }
        if (sub === "clear") { state.messages = []; state.scroll = null; touch(); render(); return; }
        say("Usage: /session [list · new <name> · switch <n|name> · rename <name> · delete <n|name> · clear]");
        return;
      }
      if (cmd === "/help") { say(helpText()); return; }
      if (cmd === "/profile") { say(JSON.stringify(loadProfile(), null, 2)); return; }
      if (cmd === "/model") {
        const pref = state.preferredModel;
        say("Chain (tried in order):\n" + FALLBACK_MODELS.map((x, i) => `${i + 1}. ${x}${x === pref ? "  ★ preferred" : ""}`).join("\n") + `\n\n/preferred: ${pref || "(auto)"}   ·   change: /models`);
        return;
      }
      if (cmd === "/models") {
        state.modelPicker = true;
        state.selIdx = Math.max(0, FALLBACK_MODELS.indexOf(state.preferredModel));
        state.input = ""; state.cursor = 0;
        render();
        return;
      }
      if (cmd === "/mcp") {
        say("checking MCP servers…");
        try {
          const servers = await listServers();
          if (!servers.length) { say("No MCP servers configured.\nAdd:  saturday mcp add <name> <command...>  ·  or edit mcp/servers.json"); return; }
          state.messages.pop();
          say(servers.map((s) => {
            const dot = !s.enabled ? "○" : s.ok ? "●" : "●";
            return `${dot} ${s.name} [${s.type}]${s.enabled ? "" : " (disabled)"}\n   tools: ${s.tools.join(", ") || "(none)"}${s.error ? `\n   ⚠ ${s.error}` : ""}`;
          }).join("\n") + "\n\n/tools lists tools · /call <tool> '<json>' runs one");
        } catch (e) { say("MCP error: " + e.message); }
        return;
      }
      if (cmd === "/tools") {
        try {
          const tools = await listTools();
          say(tools.length ? tools.map((t) => `${t.name}  [${t.server}] — ${t.description}`).join("\n") : "No tools available.");
        } catch (e) { say("MCP error: " + e.message); }
        return;
      }
      if (cmd === "/call") {
        const sp = arg.indexOf(" ");
        const tool = sp < 0 ? arg : arg.slice(0, sp);
        const jsonStr = sp < 0 ? "{}" : arg.slice(sp + 1);
        if (!tool) { say("Usage: /call <tool> '<json args>'  ·  e.g. /call fs_read {\"path\":\"README.md\"}"); return; }
        let args = {};
        try { args = JSON.parse(jsonStr); } catch { say("Bad JSON args."); return; }
        say(`running ${tool}…`);
        try {
          const { server, result } = await callTool(tool, args);
          state.messages.pop();
          say(`[${server} → ${tool}]\n${String(result).slice(0, 3000)}`);
        } catch (e) { state.messages.pop(); say("tool error: " + e.message); }
        return;
      }
      if (cmd === "/tone") {
        if (!arg) { say(`tone: ${state.tone || profile.tone + " (profile default)"}\nset: /tone friendly but sharp`); return; }
        state.tone = arg; say(`tone → ${arg}`); return;
      }
      if (cmd === "/project") {
        if (!arg) { say(`project: ${state.proj || "(none)"}\nset: /project my-app`); return; }
        if (arg === "clear") { state.proj = ""; say("project cleared"); return; }
        state.proj = arg; say(`project → ${arg}`); return;
      }
      if (cmd === "/context") {
        if (!arg) { say(`context: ${state.context || "(none)"}\nset: /context Node 24, no tests yet`); return; }
        if (arg === "clear") { state.context = ""; say("context cleared"); return; }
        state.context = arg; say("context saved"); return;
      }
      if (cmd === "/history") {
        try {
          const n = Number(arg) || 5;
          const lines = fs.readFileSync(historyFile(), "utf8").trim().split("\n").slice(-n);
          say(lines.map((l) => { const j = JSON.parse(l); return `[${j.t}] ${j.mode}: ${j.input.slice(0, 100)}…`; }).join("\n"));
        } catch { say("No history yet."); }
        return;
      }
      if (cmd === "/copy") {
        if (!state.lastAnswer) { say("Nothing to copy yet."); return; }
        say(copyToClipboard(state.lastAnswer) ? "📋 last answer copied to clipboard" : "clipboard failed (linux needs xclip/xsel)");
        return;
      }
      if (cmd === "/stats") {
        const c = cur();
        say(`📑 ${c.name} · app session: ${fmtTime(Date.now() - t0)} · messages: ${state.messages.length} · tokens streamed: ${fmtTok(state.tokens)}\nmodel: ${state.lastModel} · preferred: ${state.preferredModel || "(auto)"} · chats: ${state.sessions.length}\nbrain: ${state.mode}${state.tone ? ` · tone: ${state.tone}` : ""}${state.proj ? ` · proj: ${state.proj}` : ""}`);
        return;
      }
      if (cmd === "/retry") {
        if (!state.lastUser) { say("Nothing to retry yet."); return; }
        const { mode, text: lt } = state.lastUser;
        let body = lt, attached = [];
        try {
          const r = resolveMentions(lt);
          body = r.text; attached = r.attached;
        } catch (e) { say(e.message); return; }
        state.mode = mode;
        state.messages.push({ role: "user", mode, text: lt, files: attached });
        touch();
        await runBrain(mode, body, attached, false);
        return;
      }
      if (cmd === "/export") {
        const slug = (cur()?.name || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30) || "chat";
        const f = arg || `saturday-${slug}-${Date.now()}.md`;
        const mdOut = state.messages.map((m) => m.role === "user" ? `## 🙋 [${m.mode}]\n${m.text}` : m.role === "assistant" ? `## ✻ [${m.mode}]\n${m.text}` : `> ${m.text}`).join("\n\n---\n\n");
        fs.writeFileSync(f, `# Saturday export — ${new Date().toLocaleString()}\n\n${mdOut}\n`);
        say(`exported → ${f}`);
        return;
      }
      if (cmd === "/save") {
        const f = arg || `saturday-${Date.now()}.txt`;
        fs.writeFileSync(f, state.lastAnswer || "(nothing yet)");
        say(`saved → ${f}`);
        return;
      }
      if (cmd === "/key") { say("Fastest: /login  (paste key + pick model inside the UI)\nOr:  saturday config --key sk-or-v1-...   ·   free keys at https://openrouter.ai/keys"); return; }
      if (cmd === "/login") {
        state.modelPicker = false;
        state.login = { step: "key" };
        state.input = ""; state.cursor = 0;
        say("🔐 login — step 1/2: paste your OpenRouter key (hidden) · esc cancels\nFree key: https://openrouter.ai/keys");
        return;
      }
      if (cmd === "/ask" || cmd === "/fix" || cmd === "/kicad") {
        state.mode = cmd.slice(1);
        if (arg) return submit(arg);
        say(`switched to ${MODES[state.mode].icon} ${state.mode} brain`);
        return;
      }
      if (cmd === "/code") {
        const [sub2, ...rest2] = arg.split(" ");
        const targ = rest2.join(" ").trim();
        try {
          if (sub2 === "open" && targ) {
            const m = targ.match(/^(.*?)(?::(\d+))?$/);
            say(await openFile(m[1], m[2] ? Number(m[2]) : undefined));
          } else if (sub2 === "folder") {
            say(await openFolder(targ || "."));
          } else if (!sub2 || sub2 === "status") {
            const st = await statusInfo();
            say(`VS Code: ${st.cli ? `${st.cli} (${st.version})` : "CLI not found"}\nwd: ${st.cwd} (${st.topLevel} entries)${st.codeFiles.length ? `\ncode: ${st.codeFiles.join(", ")}` : ""}${st.vscode ? `\n.vscode: ${Object.keys(st.vscode).join(", ") || "(empty)"}` : ""}`);
          } else {
            say("Usage: /code [open <file[:line]> · folder [dir] · status]");
          }
        } catch (e) { say("vscode: " + e.message); }
        return;
      }
      const guess = closestCmd(cmd);
      say(`unknown ${cmd}${guess ? ` — did you mean ${guess}?` : " — /help for list."}`);
      return;
    }

    // normal send with current mode
    let body = text, attached = [];
    try {
      const r = resolveMentions(text);
      body = r.text; attached = r.attached;
    } catch (e) {
      state.messages.push({ role: "system", text: e.message });
      render();
      return;
    }
    const mode = state.mode;
    const cs = cur();
    if (cs && cs.name === "new chat") cs.name = text.slice(0, 32).trim() || "new chat";
    state.messages.push({ role: "user", mode, text, files: attached });
    state.lastUser = { mode, text: body };
    touch();
    await runBrain(mode, body, attached, text);
  }

  async function runBrain(mode, body, attached, histText) {
    const aiMsg = { role: "assistant", mode, text: "", streaming: true };
    state.messages.push(aiMsg);
    if (histText !== false) {
      state.hist.unshift(typeof histText === "string" && histText ? histText.split("\n")[0] : body.split("\n")[0]);
    }
    state.histIdx = -1;
    state.busy = true;
    state.busySince = Date.now();
    state.busyTokens = 0;
    render();

    const prof = loadProfile();
    if (state.tone) prof.tone = state.tone;
    let system, user;
    if (mode === "ask") {
      system = buildAskPrompt(prof);
      user = `PROJECT: ${state.proj}\n\nEXTRA CONTEXT: ${state.context}\n\nQUESTION:\n${body}`;
    } else if (mode === "fix") {
      system = buildFixPrompt(prof);
      user = `PROJECT: ${state.proj}\n\nERROR / FAILING CODE:\n${body}\n\nCONTEXT:\n${state.context}`;
    } else {
      system = buildKicadPrompt(prof);
      let hw = "";
      try {
        const s = summarize(process.cwd());
        if (s.found) hw = compactSummary(s) + "\n\n";
      } catch {}
      user = `${hw}QUESTION:\n${body}\n\nEXTRA CONTEXT:\n${state.context}`;
    }

    const started = Date.now();
    let tok = 0;
    try {
      const { text: full, model } = await callBrain(system, user, {
        key,
        model: state.preferredModel,
        stream: true,
        onToken: (d) => { aiMsg.text += d; tok++; state.tokens++; state.busyTokens = tok; state.tokTimes.push(Date.now()); if (state.tokTimes.length > 400) state.tokTimes.splice(0, 100); scheduleRender(); },
      });
      aiMsg.streaming = false;
      aiMsg.model = model;
      aiMsg.ms = Date.now() - started;
      aiMsg.tok = tok;
      state.lastModel = model.split("/").pop();
      state.lastAnswer = full;
      state.lastDone = aiMsg;
      state.pulse = anim ? 4 : 0;
      saveHistory(mode, body, full);
    } catch (e) {
      aiMsg.streaming = false;
      aiMsg.error = true;
      aiMsg.text = e.message;
    }
    state.busy = false;
    state.scroll = null;
    touch();
    render();
  }

  process.stdin.on("keypress", (ch, k = {}) => {
    if (k.ctrl && k.name === "c") { exitFlow(); return; }
    if (k.ctrl && k.name === "j") {
      if (state.busy || state.login?.step === "key") return;
      state.input = state.input.slice(0, state.cursor) + "\n" + state.input.slice(state.cursor);
      state.cursor++;
      render(); return;
    }
    if (state.login?.step === "key" && (k.name === "up" || k.name === "down" || k.name === "tab")) return;
    if (state.boot < BOOT_STAGES.length) {
      state.boot = BOOT_STAGES.length;
      try { clearInterval(bootTick); } catch {}
      render();
      return;
    }
    if (state.busy) return;
    if (k.meta && ["1", "2", "3"].includes(k.name)) {
      state.mode = k.name === "1" ? "ask" : k.name === "2" ? "fix" : "kicad";
      render(); return;
    }
    const popup = state.modelPicker || state.sessionPicker ? [] : slashMatches();
    if (k.name === "return") {
      if (state.modelPicker && !state.input.trim()) {
        // enter on highlighted row applies it
        const slug = FALLBACK_MODELS[state.selIdx];
        state.input = slug; state.cursor = slug.length;
      } else if (state.sessionPicker && !state.input.trim()) {
        // enter on highlighted session switches to it
        const s = state.sessions[state.selIdx];
        state.input = ""; state.cursor = 0; state.scroll = null; state.selIdx = 0;
        if (s) switchSession(s.id);
        return;
      } else if (popup.length && !state.input.includes(" ") && state.input.length > 1) {
        state.input = popup[state.selIdx].name + " ";
        state.cursor = state.input.length;
        render();
        return;
      }
      const v = state.input;
      state.input = ""; state.cursor = 0; state.scroll = null; state.selIdx = 0;
      submit(v);
      return;
    }
    if (k.name === "backspace") {
      if (state.cursor > 0) {
        state.input = state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor);
        state.cursor--; state.selIdx = 0;
        render();
      }
      return;
    }
    if (k.name === "left") { state.cursor = Math.max(0, state.cursor - 1); render(); return; }
    if (k.name === "right") { state.cursor = Math.min(state.input.length, state.cursor + 1); render(); return; }
    if (k.name === "up") {
      if (state.modelPicker) { state.selIdx = (state.selIdx + FALLBACK_MODELS.length - 1) % FALLBACK_MODELS.length; render(); return; }
      if (state.sessionPicker) { state.selIdx = (state.selIdx + state.sessions.length - 1) % state.sessions.length; render(); return; }
      if (popup.length) { state.selIdx = (state.selIdx + popup.length - 1) % popup.length; render(); return; }
      if (k.shift) { scrollBy(-3); return; }
      {
        const { lines: ll, crow: cr2, coff: cf2 } = cursorLine();
        if (ll.length > 1 && cr2 > 0) {
          state.cursor = lineStart(ll, cr2 - 1) + Math.min(cf2, ll[cr2 - 1].length);
          render(); return;
        }
      }
      if (state.hist.length) {
        state.histIdx = Math.min(state.hist.length - 1, state.histIdx + 1);
        state.input = state.hist[state.histIdx]; state.cursor = state.input.length;
        render();
      }
      return;
    }
    if (k.name === "down") {
      if (state.modelPicker) { state.selIdx = (state.selIdx + 1) % FALLBACK_MODELS.length; render(); return; }
      if (state.sessionPicker) { state.selIdx = (state.selIdx + 1) % state.sessions.length; render(); return; }
      if (popup.length) { state.selIdx = (state.selIdx + 1) % popup.length; render(); return; }
      if (k.shift) { scrollBy(3); return; }
      {
        const { lines: dl, crow: dcr, coff: dcf } = cursorLine();
        if (dl.length > 1 && dcr < dl.length - 1) {
          state.cursor = lineStart(dl, dcr + 1) + Math.min(dcf, dl[dcr + 1].length);
          render(); return;
        }
      }
      if (state.histIdx > 0) { state.histIdx--; state.input = state.hist[state.histIdx]; }
      else { state.histIdx = -1; state.input = ""; }
      state.cursor = state.input.length; render(); return;
    }
    if (k.name === "pageup") { scrollBy(-10); return; }
    if (k.name === "pagedown") { scrollBy(10); return; }
    if (k.name === "home") { scrollEdge("top"); return; }
    if (k.name === "end") { scrollEdge("bottom"); return; }
    if (k.name === "escape") {
      if (state.login || state.modelPicker || state.sessionPicker) { state.login = null; state.modelPicker = false; state.sessionPicker = false; state.input = ""; state.cursor = 0; state.selIdx = 0; render(); return; }
      state.input = ""; state.cursor = 0; state.scroll = null; state.selIdx = 0; render(); return;
    }
    if (k.name === "tab") {
      if (state.modelPicker) {
        const slug = FALLBACK_MODELS[state.selIdx];
        state.input = slug; state.cursor = slug.length; render(); return;
      }
      if (state.sessionPicker) {
        const s = state.sessions[state.selIdx];
        state.input = ""; state.cursor = 0; state.scroll = null; state.selIdx = 0;
        if (s) switchSession(s.id);
        return;
      }
      if (popup.length) {
        state.input = popup[state.selIdx].name + " ";
        state.cursor = state.input.length;
        render();
      }
      return;
    }
    if (ch && ch.length === 1 && !k.ctrl && !k.meta) {
      state.input = state.input.slice(0, state.cursor) + ch + state.input.slice(state.cursor);
      state.cursor++; state.selIdx = 0;
      render();
    }
  });

  render();
}
