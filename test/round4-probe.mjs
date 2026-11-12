#!/usr/bin/env node
// round4-probe: records mimoLive's WebSocket (/api/v1/socket) and says, for every message, which document,
// which layer / variant / Layer Set, and which attributes changed. Round 4 asks whether the socket can tell
// takectl that someone changed the on-air document in mimoLive's own UI.
//   node test/round4-probe.mjs <seconds> <label> [--raw <file.jsonl>]   → test/round4-probe-<label>.txt
// Changes are diffed against a baseline read over HTTP at the start, then against the previous message for
// the same resource. Live values (audio levels, output values such as a clock's time string, a document's
// running duration) are counted, not listed: they arrive every 200 ms to 1 s whether or not anyone touches
// anything. Everything else is listed with its time, so it can be lined up with what was done.
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const RAW = flag("--raw");
const SECS = Number(args[0]) || 60;
const LABEL = args[1] || "run";
const HOST = process.env.MIMOLIVE || "http://localhost:8989";
const API = `${HOST}/api/v1`;
const OUT = join(HERE, `round4-probe-${LABEL}.txt`);
const out = [];
const say = (s) => { out.push(s); console.log(s); writeFileSync(OUT, out.join("\n") + "\n"); };
const get = async (p) => (await fetch(API + p, { signal: AbortSignal.timeout(5000) })).json();
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8) + "." + String(ms % 1000).padStart(3, "0");

// Flatten attributes to "path → JSON value" so two versions can be compared key by key. input-descriptions
// are skipped: large, static, and never what changed.
const flat = (v, p = "", o = {}) => {
  if (v && typeof v === "object" && !Array.isArray(v)) { for (const [k, x] of Object.entries(v)) if (k !== "input-descriptions") flat(x, p ? `${p}/${k}` : k, o); }
  else o[p] = stable(v);
  return o;
};
// The socket and HTTP send the same objects with their keys in a different order: compare sorted.
function stable(v) { return JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x)); }
// Never print a file path (a logo layer's image, a document's file): this file goes into the package.
const shown = (j) => { if (j === undefined) return "∅"; const s = String(j); return /"(\/|file:|~)/.test(s) ? "<path>" : s.length > 40 ? s.slice(0, 37) + "…\"" : s; };

// Names, and a baseline of every resource, over HTTP.
const name = {}; // "type:id" → readable name
const docOf = {}; // "type:id" → document id
const base = {}; // "type:id" → flat attributes
const docs = (await get("/documents")).data;
for (const d of docs) {
  name[`documents:${d.id}`] = d.attributes.name; docOf[`documents:${d.id}`] = d.id; base[`documents:${d.id}`] = flat(d.attributes);
  for (const l of (await get(`/documents/${d.id}/layers`)).data) {
    name[`layers:${l.id}`] = l.attributes.name; docOf[`layers:${l.id}`] = d.id; base[`layers:${l.id}`] = flat(l.attributes);
    for (const v of (await get(`/documents/${d.id}/layers/${l.id}/variants`)).data) {
      name[`variants:${v.id}`] = `${l.attributes.name} › ${v.attributes.name}`; docOf[`variants:${v.id}`] = d.id; base[`variants:${v.id}`] = flat(v.attributes);
    }
  }
  for (const s of (await get(`/documents/${d.id}/layer-sets`)).data) {
    name[`layer-sets:${s.id}`] = s.attributes.name; docOf[`layer-sets:${s.id}`] = d.id; base[`layer-sets:${s.id}`] = flat(s.attributes);
  }
}
const docName = (id) => name[`documents:${id}`] ?? `doc ${id}`;

// Live values: what changes by itself while a show runs.
const LIVE_KEY = /(^|\/)(duration|formatted-duration)$|AudioLevel|^output-values\//;
const isLive = (keys) => keys.length > 0 && keys.every((k) => LIVE_KEY.test(k));
// The rule proposed for round 4, applied to every listed line and marked ◆: a layer, variant or Layer Set
// added, removed or changed (other than live values), on any layer but TALLY. Which document is on air,
// and whether takectl itself caused it, are for takectl to decide; this marks what the socket offers.
const WATCHED = new Set(["layers", "variants", "layer-sets"]);
const candidate = (type, ev, who, keys) => WATCHED.has(type) && !/^TALLY( ›|$)/.test(who) && (ev === "added" || ev === "removed" || keys.some((k) => !LIVE_KEY.test(k)));

const t0 = Date.now();
say(`round4-probe "${LABEL}": ${SECS} s of ${HOST.replace(/\/\/[^:/]+/, "//<host>")}/api/v1/socket, started ${new Date(t0).toTimeString().slice(0, 8)}`);
say(`documents: ${docs.map((d) => `${d.attributes.name} (${d.attributes["live-state"]})`).join(", ")}`);
say("");
const live = new Map(); // "doc · type event name · keys" → count
const kinds = new Map(); // "type event" → count
let n = 0;
const ws = new WebSocket(`${HOST.replace(/^http/, "ws")}/api/v1/socket`);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("socket did not open")); });
ws.onclose = (e) => say(`${clock(Date.now())}  socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`);
ws.onmessage = (msg) => {
  const at = Date.now(); n++;
  let m; try { m = JSON.parse(msg.data); } catch { say(`${clock(at)}  not JSON: ${String(msg.data).slice(0, 80)}`); return; }
  if (RAW) appendFileSync(RAW, JSON.stringify({ at, m }) + "\n");
  const type = m.type ?? "?", ev = m.event ?? "?", key = `${type}:${m.id}`;
  kinds.set(`${type} ${ev}`, (kinds.get(`${type} ${ev}`) ?? 0) + 1);
  const self = m.data?.links?.self ?? "";
  const doc = m["document-id"] ?? self.match(/\/documents\/(\d+)/)?.[1] ?? docOf[key] ?? (type === "documents" ? m.id : null);
  if (m.data?.attributes?.name && !name[key]) name[key] = type === "variants" && m["layer-id"] ? `${name[`layers:${m["layer-id"]}`] ?? "?"} › ${m.data.attributes.name}` : m.data.attributes.name;
  const who = name[key] ?? `${type} ${String(m.id).slice(0, 8)}`;
  let keys = [], detail = "";
  if (ev === "values-changed") {
    const f = flat(m.data ?? {}); keys = Object.keys(f);
    detail = keys.slice(0, 6).map((k) => `${k.replace(/^input-values\//, "")} = ${shown(f[k])}`).join(", ");
  } else if (m.data?.attributes) {
    const f = flat(m.data.attributes), was = base[key];
    if (was) {
      keys = [...new Set([...Object.keys(f), ...Object.keys(was)])].filter((k) => f[k] !== was[k]);
      detail = keys.slice(0, 6).map((k) => `${k.replace(/^input-values\//, "")}: ${shown(was[k])} → ${shown(f[k])}`).join(", ") + (keys.length > 6 ? `, … ${keys.length - 6} more` : "");
    } else detail = "(first sight, no baseline)";
    base[key] = f;
  } else if (type === "datastores") detail = `datastore ${m.id}`;
  else detail = JSON.stringify(m).slice(0, 160);
  if (ev === "changed" && keys.length === 0 && base[key]) { live.set(`${docName(doc)} · ${type} ${ev} ${who} · no change`, (live.get(`${docName(doc)} · ${type} ${ev} ${who} · no change`) ?? 0) + 1); return; }
  if (isLive(keys)) { const g = `${docName(doc)} · ${type} ${ev} ${who} · ${[...new Set(keys.map((k) => k.replace(/^input-values\//, "")))].join(" ")}`; live.set(g, (live.get(g) ?? 0) + 1); return; }
  say(`${clock(at)} ${candidate(type, ev, who, keys) ? "◆" : " "} ${docName(doc).padEnd(9)} ${`${type} ${ev}`.padEnd(22)} ${who.padEnd(26)} ${detail}`);
};
// Ends after SECS, or early on Ctrl-C / kill, with the summary either way.
const stopped = await new Promise((r) => { setTimeout(() => r(null), SECS * 1000); for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => r(sig)); });
ws.onclose = null; ws.close();
const ran = ((Date.now() - t0) / 1000).toFixed(0);
say("");
say(`${n} messages in ${ran} s${stopped ? ` (stopped early by ${stopped} at ${clock(Date.now())})` : ""}. By kind: ${[...kinds].map(([k, c]) => `${k} ${c}`).join(", ")}`);
say("Live values (counted, not listed):");
for (const [g, c] of [...live].sort((a, b) => b[1] - a[1])) say(`  ${String(c).padStart(5)}  ${g}`);
process.exit(0);
