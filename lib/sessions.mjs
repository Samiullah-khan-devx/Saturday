import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { APP_DIR } from "./ai.mjs";

const MAX_SESSIONS = 20;
const MAX_MSGS = 100;

function file() {
  return path.join(os.homedir(), APP_DIR, "sessions.json");
}

export function newSession(name = "new chat") {
  const now = new Date().toISOString();
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: name?.trim() || "new chat",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function loadSessions() {
  try {
    const arr = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s) => s && typeof s.id === "string" && Array.isArray(s.messages))
      .map((s) => ({
        id: s.id,
        name: String(s.name || "new chat").slice(0, 60),
        createdAt: s.createdAt || s.updatedAt || new Date().toISOString(),
        updatedAt: s.updatedAt || new Date().toISOString(),
        messages: s.messages.slice(-MAX_MSGS),
      }));
  } catch {
    return [];
  }
}

export function persistSessions(sessions) {
  try {
    const dir = path.dirname(file());
    fs.mkdirSync(dir, { recursive: true });
    const slim = sessions.slice(-MAX_SESSIONS).map((s) => ({
      ...s,
      messages: s.messages.slice(-MAX_MSGS),
    }));
    fs.writeFileSync(file(), JSON.stringify(slim, null, 2));
  } catch {}
}

export function fmtWhen(iso) {
  try {
    const d = new Date(iso);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return sameDay ? hm : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hm;
  } catch {
    return "";
  }
}
