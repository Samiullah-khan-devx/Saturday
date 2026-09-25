import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

export const FALLBACK_MODELS = [
  "z-ai/glm-5.2:free",
  "qwen/qwen3.8-27b:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "cohere/north-mini-code:free",
  "liquid/lfm-2.5-2.6b:free",
];

export const APP_NAME = "saturday";
export const APP_DIR = ".saturday";
export const LEGACY_DIR = ".fiverr-brain";

function readConfigFile() {
  for (const dir of [APP_DIR, LEGACY_DIR]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), dir, "config.json"), "utf8"));
      if (cfg.key) return cfg.key;
    } catch {}
  }
  return "";
}
export function loadProfile() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, "brain", "dev-profile.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return { devName: "Developer", role: "", languages: [], stack: [], tone: "direct", rules: [] };
  }
}

export function getKey(explicit) {
  if (explicit?.trim()) return explicit.trim();
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim();
  return readConfigFile();
}

export function getPreferredModel(explicit) {
  if (explicit?.trim()) return explicit.trim();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), APP_DIR, "config.json"), "utf8"));
    if (cfg.model) return cfg.model;
  } catch {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), LEGACY_DIR, "config.json"), "utf8"));
    if (cfg.model) return cfg.model;
  } catch {}
  return "";
}

export function setPreferredModel(model) {
  const dir = path.join(os.homedir(), APP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "config.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  cfg.model = model;
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
}
export function historyFile() {
  const p = path.join(os.homedir(), APP_DIR, "history.jsonl");
  try {
    fs.accessSync(p);
    return p;
  } catch {}
  return path.join(os.homedir(), LEGACY_DIR, "history.jsonl");
}

function headers(key) {
  return {
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://localhost/saturday-cli",
    "X-Title": "Saturday CLI",
  };
}

async function tryModel(model, key, system, user, stream, onToken) {
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.7,
    max_tokens: 2000,
    stream: !!stream,
  };
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(body),
  });
  if (r.status === 429 || r.status === 500 || r.status === 502 || r.status === 503) {
    throw Object.assign(new Error(`${model} busy (${r.status})`), { retryable: true });
  }
  if (r.status === 404) {
    // OpenRouter returns 404 for retired/renamed slugs — try next model
    throw Object.assign(new Error(`${model} retired (404)`), { retryable: true });
  }
  if (!r.ok) {
    const t = await r.text();
    if (r.status === 401 || r.status === 403) {
      throw Object.assign(
        new Error(`Invalid OPENROUTER_API_KEY (${r.status}). Run: saturday config --key sk-or-v1-...  (free at https://openrouter.ai/keys)`),
        { retryable: false }
      );
    }
    const retryable = r.status === 429 || r.status >= 500;
    throw Object.assign(new Error(`${model} error ${r.status}: ${t.slice(0, 300)}`), { retryable });
  }
  if (!stream) {
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content || "";
    if (!text.trim()) throw Object.assign(new Error(`${model} empty`), { retryable: true });
    return { text, model };
  }
  // SSE streaming
  let full = "";
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content || "";
        if (delta) {
          full += delta;
          onToken?.(delta);
        }
      } catch {}
    }
  }
  if (!full.trim()) throw Object.assign(new Error(`${model} empty stream`), { retryable: true });
  return { text: full, model };
}

export async function callBrain(system, user, { key, model, stream = false, onToken } = {}) {
  const k = getKey(key);
  if (!k) {
    throw new Error(
      "Missing OPENROUTER_API_KEY.\n  Run: saturday config --key sk-or-v1-...\n  Or:  copy .env.example to .env and add your key (free at https://openrouter.ai/keys)"
    );
  }
  const preferred = model || getPreferredModel();
  const queue = preferred
    ? [preferred, ...FALLBACK_MODELS.filter((m) => m !== preferred)]
    : [...FALLBACK_MODELS];
  let lastErr = "";
  for (const m of queue) {
    try {
      return await tryModel(m, k, system, user, stream, onToken);
    } catch (e) {
      lastErr = e.message;
      if (!e.retryable) throw e;
    }
  }
  throw new Error("All free models busy. Retry in 30s. Last: " + lastErr);
}

export async function verifyKey(k) {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${k}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json().catch(() => ({}));
    return { ok: true, label: j.data?.label || "" };
  } catch {
    return { ok: false, status: "network" };
  }
}

export function saveKey(k) {
  const dir = path.join(os.homedir(), APP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "config.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  cfg.key = k.trim();
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
}

export function saveHistory(mode, input, output) {
  try {
    const dir = path.join(os.homedir(), APP_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ t: new Date().toISOString(), mode, input: input.slice(0, 500), output: output.slice(0, 8000) }) + "\n";
    fs.appendFileSync(path.join(dir, "history.jsonl"), line);
  } catch {}
}
