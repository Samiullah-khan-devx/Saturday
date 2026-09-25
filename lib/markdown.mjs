import chalk from "chalk";

// ── minimal markdown renderer for the TUI (ANSI out, width-aware) ──

const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const BOLD = chalk.bold;
const DIM = chalk.dim;
const ACC = chalk.hex("#E0915A");
const CY = chalk.hex("#7DD3FC");

export function inline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, (_, t) => BOLD(t))
    .replace(/`([^`\n]+?)`/g, (_, t) => chalk.bgBlackBright.white(` ${t} `))
    .replace(/\[([^\]]+?)\]\((https?:[^)\s]+)\)/g, (_, t, u) => CY(t) + DIM(` (${u})`));
}

export function wrapRaw(text, width) {
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

// hard slice (code: never reflow, just cut to width)
function hardWrap(s, w) {
  const chars = [...s];
  if (chars.length <= w) return [s];
  const out = [];
  for (let i = 0; i < chars.length; i += w) out.push(chars.slice(i, i + w).join(""));
  return out;
}

function splitRow(l) {
  let t = l.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function renderTable(block, W) {
  let rows = block.map(splitRow);
  const cols = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => { while (r.length < cols) r.push(""); return r.slice(0, cols); });
  const align = new Array(cols).fill("l");
  const si = rows.findIndex((r) => r.length > 0 && r.every((c) => /^:?-+:?$/.test(c)));
  if (si >= 0) {
    rows[si].forEach((c, k) => {
      align[k] = c.startsWith(":") && c.endsWith(":") && c.length > 2 ? "c" : c.endsWith(":") ? "r" : "l";
    });
    rows.splice(si, 1);
  }
  if (!rows.length) return [];
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => vlen(r[c]))));
  let total = widths.reduce((a, b) => a + b, 0) + 3 * (cols - 1);
  while (total > W && Math.max(...widths) > 8) {
    widths[widths.indexOf(Math.max(...widths))]--;
    total = widths.reduce((a, b) => a + b, 0) + 3 * (cols - 1);
  }
  const cell = (s, k) => {
    const raw = s.length > widths[k] ? s.slice(0, Math.max(0, widths[k] - 1)) + "…" : s;
    const p = Math.max(0, widths[k] - vlen(raw));
    if (align[k] === "r") return " ".repeat(p) + inline(raw);
    if (align[k] === "c") {
      const l = Math.floor(p / 2);
      return " ".repeat(l) + inline(raw) + " ".repeat(p - l);
    }
    return inline(raw) + " ".repeat(p);
  };
  const out = [];
  rows.forEach((r, ri) => {
    const line = r.map(cell).join(DIM(" │ "));
    out.push(ri === 0 ? BOLD(line) : line);
    if (ri === 0) out.push(DIM(widths.map((w) => "─".repeat(w)).join("─┼─")));
  });
  return out;
}

export function renderMarkdown(text, width, indent = "  ") {
  const W = Math.max(20, width - vlen(indent));
  const out = [];
  const lines = String(text).split("\n");
  let i = 0;
  let pendingBlank = false;
  const emit = (s) => {
    if (pendingBlank && out.length) out.push("");
    pendingBlank = false;
    out.push(s);
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; pendingBlank = true; continue; }

    // fenced code block (blanks preserved inside)
    const fence = t.match(/^```(\w*)\s*$/);
    if (fence) {
      emit(indent + DIM(`┌─ ${fence[1] || "code"}`));
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        for (const c of hardWrap(lines[i].replace(/\t/g, "  "), W - 2)) {
          out.push(indent + DIM("│ ") + chalk.white(c));
        }
        i++;
      }
      emit(indent + DIM("└─"));
      i++;
      continue;
    }

    // table: run of pipe-lines (single stray pipe line stays text)
    if (t.startsWith("|")) {
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { block.push(lines[i]); i++; }
      if (block.length >= 2) {
        for (const l of renderTable(block, W)) emit(indent + l);
      } else {
        for (const l of wrapRaw(block[0].trim(), W)) emit(indent + inline(l));
      }
      continue;
    }

    // headings
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      for (const l of wrapRaw(h[2], W)) emit(indent + ACC(BOLD(l)));
      i++;
      continue;
    }

    // whole-line bold (brain section headers like **Offer Title:**)
    const wb = t.match(/^\*\*(.+?)\*\*:?\s*$/);
    if (wb) {
      for (const l of wrapRaw(wb[1], W)) emit(indent + ACC(BOLD(l)));
      i++;
      continue;
    }

    // horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      emit(indent + DIM("─".repeat(Math.min(W, 40))));
      i++;
      continue;
    }

    // quote
    const q = t.match(/^>\s?(.*)$/);
    if (q) {
      for (const l of wrapRaw(q[1], W - 2)) emit(indent + DIM("▏ ") + DIM(l));
      i++;
      continue;
    }

    // bullet list with hanging indent
    const b = t.match(/^(\s*)[-*•]\s+(.*)$/);
    if (b) {
      const pad = " ".repeat(Math.min(b[1].length, 6));
      const wl = wrapRaw(b[2], W - pad.length - 2);
      wl.forEach((l, k) => emit(indent + pad + (k === 0 ? CY("• ") : "  ") + inline(l)));
      i++;
      continue;
    }

    // numbered list
    const n = t.match(/^(\s*)(\d+[.)])\s+(.*)$/);
    if (n) {
      const marker = n[2] + " ";
      const wl = wrapRaw(n[3], Math.max(10, W - n[1].length - marker.length));
      wl.forEach((l, k) => emit(indent + n[1] + (k === 0 ? DIM(marker) : " ".repeat(marker.length)) + inline(l)));
      i++;
      continue;
    }

    // normal paragraph
    for (const l of wrapRaw(t, W)) emit(indent + inline(l));
    i++;
  }
  return out;
}
