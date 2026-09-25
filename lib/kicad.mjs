import fs from "node:fs";
import path from "node:path";

// ── KiCad v10 S-expression support (.kicad_sch / .kicad_pcb / .kicad_pro) ──
// Tolerant generic parser: works across KiCad 6→10 as long as files stay S-expr.

export function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "(" || c === ")") { toks.push(c); i++; }
    else if (/\s/.test(c)) { i++; }
    else if (c === '"') {
      let s = "";
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) { s += src[i + 1]; i += 2; }
        else { s += src[i]; i++; }
      }
      i++;
      toks.push({ str: s });
    } else {
      let j = i;
      while (j < src.length && !/[\s()"]/.test(src[j])) j++;
      toks.push(src.slice(i, j));
      i = j;
    }
  }
  return toks;
}

export function parseSexpr(src) {
  const toks = tokenize(src);
  let pos = 0;
  function node() {
    pos++; // consume (
    const list = [];
    while (pos < toks.length && toks[pos] !== ")") {
      list.push(toks[pos] === "(" ? node() : toks[pos++]);
    }
    if (toks[pos] !== ")") throw new Error("unbalanced parentheses in KiCad file");
    pos++;
    return list;
  }
  const roots = [];
  while (pos < toks.length) {
    if (toks[pos] === "(") roots.push(node());
    else pos++;
  }
  if (!roots.length) throw new Error("no S-expression found");
  return roots[0];
}

const val = (t) => (t && typeof t === "object" ? t.str : t);
const kids = (list, head) => list.filter((x) => Array.isArray(x) && x[0] === head);

function prop(node, name) {
  const p = node.find((x) => Array.isArray(x) && x[0] === "property" && val(x[1]) === name);
  return p ? val(p[2]) : "";
}

// ── schematic ──

export function analyzeSch(root) {
  if (!Array.isArray(root) || root[0] !== "kicad_sch") throw new Error("not a .kicad_sch file");
  const symbols = kids(root, "symbol")
    .filter((s) => kids(s, "lib_id").length > 0)
    .map((s) => ({
      ref: prop(s, "Reference"),
      value: prop(s, "Value"),
      footprint: prop(s, "Footprint"),
      lib: val(kids(s, "lib_id")[0]?.[1] || ""),
    }))
    .filter((s) => s.ref);
  const sheets = kids(root, "sheet").map((s) => ({
    name: prop(s, "Sheetname"),
    file: prop(s, "Sheetfile"),
  }));
  const labels = kids(root, "label").length + kids(root, "global_label").length;
  const wires = kids(root, "wire").length;
  return { symbols, sheets, labels, wires };
}

// ── pcb ──

export function analyzePcb(root) {
  if (!Array.isArray(root) || root[0] !== "kicad_pcb") throw new Error("not a .kicad_pcb file");
  const footprints = kids(root, "footprint").map((f) => ({
    ref: prop(f, "Reference") || val(f[1]),
    value: prop(f, "Value"),
    layer: val(kids(f, "layer")[0]?.[1] || ""),
  }));
  const nets = kids(root, "net").map((n) => ({ id: Number(val(n[1])), name: val(n[2]) }));
  const segs = kids(root, "segment");
  const vias = kids(root, "via").length;
  const zones = kids(root, "zone").length;
  let trackLen = 0;
  for (const s of segs) {
    const a = kids(s, "start")[0], b = kids(s, "end")[0];
    if (a && b) {
      const dx = Number(val(a[1])) - Number(val(b[1]));
      const dy = Number(val(a[2])) - Number(val(b[2]));
      if (Number.isFinite(dx) && Number.isFinite(dy)) trackLen += Math.hypot(dx, dy);
    }
  }
  return { footprints, nets, segments: segs.length, vias, zones, trackLenMm: Math.round(trackLen) };
}

// ── project ──

export function findProject(dir) {
  const abs = path.resolve(dir);
  let entries = [];
  try { entries = fs.readdirSync(abs); } catch { return { dir: abs, found: false }; }
  const pro = entries.find((e) => e.endsWith(".kicad_pro"));
  const base = pro ? pro.replace(/\.kicad_pro$/, "") : null;
  const pick = (ext) => {
    if (base && entries.includes(base + ext)) return path.join(abs, base + ext);
    const f = entries.find((e) => e.endsWith(ext));
    return f ? path.join(abs, f) : null;
  };
  const schFile = pick(".kicad_sch");
  const pcbFile = pick(".kicad_pcb");
  if (!schFile && !pcbFile) return { dir: abs, found: false };
  return { dir: abs, found: true, pro: pro ? path.join(abs, pro) : null, schFile, pcbFile };
}

export function summarize(dir = ".") {
  const proj = findProject(dir);
  if (!proj.found) return { ...proj, error: "no .kicad_sch / .kicad_pcb found" };
  const out = { ...proj };
  if (proj.schFile) {
    try { out.sch = { file: path.basename(proj.schFile), ...analyzeSch(parseSexpr(fs.readFileSync(proj.schFile, "utf8"))) }; }
    catch (e) { out.sch = { file: path.basename(proj.schFile), error: e.message }; }
  }
  if (proj.pcbFile) {
    try { out.pcb = { file: path.basename(proj.pcbFile), ...analyzePcb(parseSexpr(fs.readFileSync(proj.pcbFile, "utf8"))) }; }
    catch (e) { out.pcb = { file: path.basename(proj.pcbFile), error: e.message }; }
  }
  if (out.sch?.symbols && out.pcb?.footprints) {
    const sRefs = new Set(out.sch.symbols.map((s) => s.ref));
    const pRefs = new Set(out.pcb.footprints.map((f) => f.ref));
    out.check = {
      missingOnPcb: [...sRefs].filter((r) => !pRefs.has(r) && !r.startsWith("#")),
      notInSch: [...pRefs].filter((r) => !sRefs.has(r)),
    };
  }
  return out;
}

export function compactSummary(s) {
  if (!s.found) return "(no KiCad project in this folder)";
  const L = [`<kicad dir="${s.dir}">`];
  if (s.sch && !s.sch.error) {
    L.push(`SCHEMATIC ${s.sch.file}: ${s.sch.symbols.length} symbols, ${s.sch.sheets.length} sheets, ${s.sch.wires} wires`);
    for (const sym of s.sch.symbols.slice(0, 60)) {
      L.push(`  ${sym.ref} = ${sym.value} [${sym.footprint || "no footprint"}] (${sym.lib})`);
    }
    if (s.sch.symbols.length > 60) L.push(`  … +${s.sch.symbols.length - 60} more`);
  } else if (s.sch?.error) L.push(`SCHEMATIC parse error: ${s.sch.error}`);
  if (s.pcb && !s.pcb.error) {
    L.push(`PCB ${s.pcb.file}: ${s.pcb.footprints.length} footprints, ${s.pcb.nets.length} nets, ${s.pcb.segments} tracks (~${s.pcb.trackLenMm}mm), ${s.pcb.vias} vias, ${s.pcb.zones} zones`);
  } else if (s.pcb?.error) L.push(`PCB parse error: ${s.pcb.error}`);
  if (s.check) {
    if (s.check.missingOnPcb.length) L.push(`ON SCH, MISSING ON PCB: ${s.check.missingOnPcb.join(", ")}`);
    if (s.check.notInSch.length) L.push(`ON PCB, NOT IN SCH: ${s.check.notInSch.join(", ")}`);
    if (!s.check.missingOnPcb.length && !s.check.notInSch.length) L.push("sch<->pcb refs: all match ✔");
  }
  L.push("</kicad>");
  return L.join("\n");
}

// ── BOM ──

export function bomCsv(symbols) {
  const groups = new Map();
  for (const s of symbols) {
    const k = `${s.value} || ${s.footprint || "?"} || ${s.lib}`;
    if (!groups.has(k)) groups.set(k, { value: s.value, footprint: s.footprint || "", lib: s.lib, refs: [] });
    groups.get(k).refs.push(s.ref);
  }
  const rows = [["Designators", "Qty", "Value", "Footprint", "Lib"]];
  for (const g of groups.values()) rows.push([g.refs.join(" "), g.refs.length, g.value, g.footprint, g.lib]);
  return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
}
