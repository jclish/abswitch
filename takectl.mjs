#!/usr/bin/env node
// takectl — A/B composition switcher controller for mimoLive 7
//
// Three mimoLive documents:
//   A, B      composition documents, each publishing NDI (video only)
//   MASTER    Video Switcher layer (slot 1 = NDI-A, slot 2 = NDI-B) + program audio
//
// takectl holds the PGM/PVW role state, performs TAKE/CUT through the Video
// Switcher's own signal endpoints, verifies the result from the switcher's live
// slot (source tally is only a witness), flips tally layers in A/B, persists state
// in MASTER's data store, and exposes a tiny HTTP API for Bitfocus Companion / Stream Deck.
//
// Zero dependencies. Node 22+ (global fetch + WebSocket). Run: node takectl.mjs (or double-click
// start.command). Config: takectl.config.json next to this file. Without one, takectl starts in
// setup mode and serves /setup, which writes it (see README).

import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = process.env.TAKECTL_CONFIG || join(here, "takectl.config.json");
const examplePath = join(here, "takectl.config.example.json");
// null = not set up yet: setup mode (/setup writes the config, then takectl starts running).
let CFG = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : null;

// ---------------------------------------------------------------- helpers

// Hooks (round 2, item 9b). Keyed by the Layer Set taken TO ("Interview"), or by a pair
// ("Wide -> Interview"; "→" also works), which wins over the name. Each entry:
//   { "pre": [action…], "waitMs": 300, "post": [action…] }
// action: { "layer": "Lower Third", "set": "live" | "off" } or { "layerSet": "Name" },
//   "in": "program" (default: the outgoing Program document for pre, the new one for post) | "master",
//   post actions may add "delayMs". Config "hooks" + MASTER's "abswitch-hooks" datastore (that one
//   wins, key by key).
// A reason short enough for a key (round 3 polish): the full one goes to the readout and the tooltip.
const SHORT_WHY = [
  [/^no TAKE or CUT yet/, "no TAKE yet"], [/^Preview changed/, "Preview changed"], [/a PUSH changed Program/, "PUSH since"],
  [/steps push changed Program/, "steps since"], [/^PANIC/, "PANIC since"], [/outside takectl/, "changed outside"],
  [/^already undone/, "already undone"], [/came out of SAFE/, "came from SAFE"], [/SAFE is on air/, "SAFE on air"],
  [/something else is on air/, "other slot on air"], [/steps are being pushed/, "steps running"], [/did not land/, "TAKE failed"],
  [/rehears/, "rehearsal"], [/has no active Layer Set/, "no look in PVW"], [/has no Layer Set named/, "not in PGM"],
  [/transition is in progress/, "in transition"], [/^PGM unknown/, "PGM unknown"], [/a new (transition|commit)/, "a new TAKE"],
];
const shortWhy = (why) => (why ? SHORT_WHY.find(([re]) => re.test(why))?.[1] ?? why.split(/\s+/).slice(0, 3).join(" ") : null);
const NO_HOOKS = Object.freeze({ key: null, pre: [], post: [], waitMs: 0 });
const REHEARSAL_HOLD_MS = 2000; // a rehearsal's hooks stay visible this long after the last one, then Preview is put back
function normHooks(obj, origin) {
  const hooks = {}, errors = [];
  if (obj == null) return { hooks, errors };
  if (typeof obj !== "object" || Array.isArray(obj)) return { hooks, errors: [`${origin}: hooks must be an object keyed by Layer Set name`] };
  for (const [key, h] of Object.entries(obj)) {
    if (!h || typeof h !== "object" || Array.isArray(h)) { errors.push(`${origin} "${key}": not an object`); continue; }
    const acts = (list, which) => (Array.isArray(list) ? list : list == null ? [] : [list]).filter((a, i) => {
      const ok = a && typeof a === "object" && ["program", "master", undefined].includes(a.in) &&
        ((typeof a.layer === "string" && a.layer && ["live", "off", undefined].includes(a.set)) || (typeof a.layerSet === "string" && a.layerSet)) &&
        (a.delayMs === undefined || (which === "post" && Number(a.delayMs) >= 0));
      if (!ok) errors.push(`${origin} "${key}" ${which}[${i}]: wants {"layer": name, "set": "live"|"off"} or {"layerSet": name}, optional "in": "program"|"master"${which === "post" ? ', "delayMs"' : ""}`);
      return ok;
    }).map((a) => ({ ...a, set: a.layer ? a.set ?? "live" : undefined, delayMs: Number(a.delayMs) || 0 }));
    hooks[key] = { key, origin, pre: acts(h.pre, "pre"), post: acts(h.post, "post"), waitMs: Math.max(0, Number(h.waitMs) || 0) };
  }
  return { hooks, errors };
}
const pairOf = (key) => { const m = String(key).split(/\s*(?:->|→)\s*/); return m.length === 2 && m[0] && m[1] ? m.map((x) => x.trim().toLowerCase()) : null; };

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(host) {
  const base = host.replace(/\/$/, "") + "/api/v1";
  const headers = { "Content-Type": "application/vnd.api+json" };
  if (CFG?.apiPasswordSha256) headers["X-MimoLive-Password-SHA256"] = CFG.apiPasswordSha256;
  const out = { base, onWrite: null };
  const call = async (method, path, body) => {
    // Round 4: a write is reported before it is sent, so the watcher knows its events are takectl's own.
    if (out.onWrite && (method !== "GET" || /\/(setLive|setOff|recall)$/.test(path))) { try { out.onWrite(method, path); } catch {} }
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(CFG?.httpTimeoutMs ?? 3000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`${method} ${path} → ${res.status} ${t.slice(0, 200)}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (res.status === 204) return null;
    return ct.includes("json") ? res.json() : res.text();
  };
  return Object.assign(out, {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    put: (p, b) => call("PUT", p, b),
    patch: (p, b) => call("PATCH", p, b),
    raw: call,
  });
}

const attr = (obj) => obj?.attributes ?? {};
const pwHeader = () => (CFG?.apiPasswordSha256 ? { "X-MimoLive-Password-SHA256": CFG.apiPasswordSha256 } : {});
const lname = (layer) => attr(layer)["name"] || attr(layer)["output-values"]?.tvOut_SettingName || "";
// The bench stopwatch layer. Live in A or B it goes to air, so preflight (and doctor) refuse.
const COUNTER_LAYER = "COUNTER";
// The Video Switcher's per-slot tally codes (output-values tvOut_tvIn_VideoSource{A..H}ImageTallyState)
// on 7.0b3: 40 = program, 30 = effect, 10 = in-use. Both of our slots at 30 = a transition is in flight.
const SLOT_EFFECT = 30;
const SLOT_PROGRAM = 40;
// Any read with both of our slots at SLOT_EFFECT is in flight and is never a decision: not in
// resync(), verify(), panic()'s loop or doctor (ruling 2026-11-09).
// In flight for longer than this is shown as /state.warning "transition stalled (… ms)": visible,
// never a decision. TAKECTL_STALL_MS is a test hook only — 7.0b3 caps a real dissolve at 5 s, so
// the bench lowers the threshold to see the warning on the real app; leave it unset in a show.
const STALL_MS = Number(process.env.TAKECTL_STALL_MS) || 5000;
// While takectl's own transition is busy, only these may resync; wake-ups stand aside so a read taken
// before the switcher has moved cannot flip the roles back.
const RESYNC_WHILE_BUSY = new Set(["verify", "panic"]);
// Fallback (source tally) only: "in flight" longer than this (the 5 s dissolve cap plus a margin)
// means the tally cannot be trusted (CHANGES item 9's stuck "program"). Ruling 2026-11-11.
const FALLBACK_INFLIGHT_MAX_MS = 6000;
const isLoopback = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
// The switcher keys takectl's truth comes from (probed on 7.0b3, 2026-11-09). If a build lacks
// them, doctor fails loudly and takectl runs on source tally with a permanent warning.
const LIVE_SLOT_KEY = "tvGroup_Hidden_Inputs__currentLiveSource";
const slotCodeKey = (slot) => `tvOut_tvIn_VideoSource${String.fromCharCode(64 + Number(slot))}ImageTallyState`;
// The switcher's live slot when it shows no source (an empty slot cut to, probed 2026-11-11: Cut_4 into an
// empty slot 4 reads 9, the switcher's "Below").
const SLOT_BELOW = 9;
const isDocRole = (r) => r === "A" || r === "B";
// Round 3. The switcher's dissolve length (probed 2026-11-11): "Duration", 0–5 s; written above 5 it still
// runs 5 s. A dissolve settles about 60 ms after the value read.
const DURATION_KEY = "tvIn_TransitionDuration";
const DISSOLVE_EXTRA_MS = 60;
const RATE_MIN_S = 0.1, RATE_MAX_S = 5;
const LOOK_SLOTS = 8; // keys per bus (a second bank is a v0.4 item)
const DSK_RE = /^DSK\s+(.+)$/i; // MASTER layers named "DSK <label>" above the switcher are downstream keys
// Look thumbnails live beside the config under generated names; a look name never becomes a path.
const thumbsDir = () => join(dirname(cfgPath), "thumbs");
const thumbFile = (name) => createHash("sha256").update(String(name)).digest("hex").slice(0, 40) + ".jpg";
const THUMB_FILE_RE = /^[0-9a-f]{40}\.jpg$/;
const NDI_OUT = "com.boinx.mimoLive.outputDestination.ndi";

// ---------------------------------------------------------------- shared discovery rules
// Used by Master.discover(), the doctor checks and /setup, so all three agree.

const findDocByName = (docs, name) => docs.find((d) => attr(d).name?.toLowerCase().includes(String(name).toLowerCase()));
const findSwitcherLayer = (layers, name) =>
  layers.find((l) => lname(l).toLowerCase() === String(name || "").toLowerCase()) ||
  layers.find((l) => /videoswitcher/i.test(attr(l)["composition-id"] || "")) ||
  layers.find((l) => /video switcher/i.test(lname(l)));
// Signal keys look like tvGroup_Control__Cut_1_TypeSignal / tvGroup_Control__Dis_2_TypeSignal
function scanSignals(iv) {
  const signals = { cut: {}, dis: {} };
  for (const k of Object.keys(iv)) {
    if (!k.endsWith("_TypeSignal")) continue;
    let m;
    if ((m = k.match(/cut[^0-9]*([1-9])/i))) signals.cut[m[1]] = k;
    else if ((m = k.match(/dis(?:solve)?[^0-9]*([1-9])/i))) signals.dis[m[1]] = k;
  }
  return signals;
}
// Which switcher slot holds a source: scan input-values for its id (or uuid tail).
// [drift 3] 7.0b3 names the slot inputs by LETTER: tvIn_VideoSourceAImage = slot 1 …
// tvIn_VideoSourceHImage = slot 8 (the ninth, "Below", has no image input).
function slotOfSource(iv, src) {
  const uuid = src.id.split("-").slice(1).join("-");
  for (const [k, v] of Object.entries(iv)) {
    if (typeof v !== "string") continue;
    if (v === src.id || v === uuid || v.endsWith(uuid)) {
      const letter = k.match(/^tvIn_VideoSource([A-H])Image$/);
      if (letter) return String(letter[1].charCodeAt(0) - 64);
      const m = k.match(/([1-9])(?:_|$)/);
      if (m) return m[1];
    }
  }
  return null;
}

// ---------------------------------------------------------------- discovery

class Doc {
  constructor(role, host, nameMatch) {
    this.role = role; // "A" | "B" | "MASTER"
    this.host = host;
    this.nameMatch = nameMatch;
    this.api = api(host);
    this.id = null;
    this.name = null;
    this.layers = [];
    this.tallyLayerId = null;
    this.ndiOutId = null;
  }
  async discover() {
    const docs = await this.api.get("/documents");
    const hit = docs.data.find((d) => attr(d).name?.toLowerCase().includes(this.nameMatch.toLowerCase()));
    if (!hit) throw new Error(`[${this.role}] no open document matching "${this.nameMatch}" on ${this.host}`);
    this.id = hit.id;
    this.name = attr(hit).name;
    this.liveState = attr(hit)["live-state"];
    this.layers = (await this.api.get(`/documents/${this.id}/layers`)).data;
    if (CFG.tallyLayerName) {
      const t = this.layers.find((l) => lname(l).toLowerCase() === CFG.tallyLayerName.toLowerCase());
      this.tallyLayerId = t?.id ?? null;
    }
    const outs = (await this.api.get(`/documents/${this.id}/output-destinations`)).data;
    const ndi = outs.find((o) => attr(o)["output-destination-type"] === "com.boinx.mimoLive.outputDestination.ndi");
    this.ndiOutId = ndi?.id ?? null;
    this.ndiOutLive = ndi ? attr(ndi)["live-state"] : null;
    return this;
  }
  async refreshDoc() {
    const d = await this.api.get(`/documents/${this.id}`);
    this.liveState = attr(d.data)["live-state"];
    if (this.ndiOutId) {
      const o = await this.api.get(`/documents/${this.id}/output-destinations/${this.ndiOutId}`);
      this.ndiOutLive = attr(o.data)["live-state"];
    }
  }
  async setTally(on) {
    if (!this.tallyLayerId) return;
    this.tallyWant = on;
    await this.api.get(`/documents/${this.id}/layers/${this.tallyLayerId}/${on ? "setLive" : "setOff"}`).catch((e) =>
      log(`[${this.role}] tally ${on ? "on" : "off"} failed: ${e.message}`)
    );
    // 7.0b3: a setOff landing ~15 ms after a setLive leaves the layer in "shutdown" for good (seen
    // after TAKE then PANIC at once), and a stuck layer ignores setLive until it gets another setOff.
    // Read back once the 0.5 s out-animation should be over and repair toward what is wanted by then.
    clearTimeout(this.tallyCheck);
    this.tallyCheck = setTimeout(() => this.repairTally().catch(() => {}), 800);
  }
  async repairTally() {
    const read = async () => attr((await this.api.get(`/documents/${this.id}/layers/${this.tallyLayerId}`)).data)["live-state"];
    const want = this.tallyWant;
    const st = await read();
    if (want ? st === "live" || st === "startup" : st === "off") return;
    log(`[${this.role}] TALLY reads "${st}" while ${want ? "live" : "off"} is wanted; repairing`);
    const cmd = (live) => this.api.get(`/documents/${this.id}/layers/${this.tallyLayerId}/${live ? "setLive" : "setOff"}`);
    if (st === "shutdown" || !want) await cmd(false); // the only command a stuck layer answers
    if (want) { await sleep(100); await cmd(true); }
    await sleep(700);
    if (this.tallyWant === want) log(`[${this.role}] TALLY after repair: "${await read()}"`);
  }
  async activeLayerSetName() {
    // Proposal 5: an empty Layer Set reads active: true on 7.0b3 (it matches any state), so it is
    // skipped; PUSH, MIRROR and history all ask this question.
    const sets = (await this.api.get(`/documents/${this.id}/layer-sets`)).data;
    return sets.find((s) => attr(s).active && (attr(s).layers?.length ?? 0) > 0)?.attributes?.name ?? null;
  }
  // Hooks address layers by name; a fresh read each time, so a renamed or deleted layer is reported.
  // hook: true when a hook is switching it (round 4: a layer a hook switched on is not watched until it is off).
  async setLayerByName(name, on, hook = false) {
    const layers = (await this.api.get(`/documents/${this.id}/layers`)).data;
    const l = layers.find((x) => lname(x).toLowerCase() === String(name).toLowerCase());
    if (!l) throw new Error(`no layer named "${name}" in "${this.name}"`);
    if (hook && on) this.onHookOn?.([l.id]);
    await this.api.get(`/documents/${this.id}/layers/${l.id}/${on ? "setLive" : "setOff"}`);
  }
  async recallLayerSetByName(name, hook = false) {
    const sets = (await this.api.get(`/documents/${this.id}/layer-sets`)).data;
    const s = sets.find((x) => attr(x).name === name);
    if (!s) throw new Error(`[${this.role}] no layer set named "${name}"`);
    if (hook) this.onHookOn?.((attr(s).layers ?? []).filter((x) => x.action && x.action !== "off").map((x) => x["layer-id"]));
    await this.api.get(`/documents/${this.id}/layer-sets/${s.id}/recall`);
  }
}

class Master extends Doc {
  async discover() {
    await super.discover();
    const vs = findSwitcherLayer(this.layers, CFG.switcherLayerName);
    if (!vs) throw new Error(`[MASTER] no Video Switcher layer found`);
    this.switcherId = vs.id;
    this.switcherName = lname(vs);
    const iv = attr(vs)["input-values"] || {};
    this.signals = scanSignals(iv);
    // Which switcher slot holds which NDI source — by source name in MASTER.
    const sources = (await this.api.get(`/documents/${this.id}/sources`)).data;
    const byName = (needle) => sources.find((s) => attr(s).name?.toLowerCase().includes(needle.toLowerCase()));
    this.srcA = byName(CFG.master.sourceNameA);
    this.srcB = byName(CFG.master.sourceNameB);
    if (!this.srcA || !this.srcB) throw new Error(`[MASTER] NDI sources "${CFG.master.sourceNameA}" / "${CFG.master.sourceNameB}" not found`);
    this.slotA = CFG.master.slotA ?? slotOfSource(iv, this.srcA) ?? "1";
    this.slotB = CFG.master.slotB ?? slotOfSource(iv, this.srcB) ?? "2";
    // The safe source (optional): PANIC cuts to it instead of A. A configured one that is missing or in
    // no slot leaves PANIC on A, with a warning and a red doctor check; it never stops takectl.
    const safeName = CFG.master.sourceNameSafe;
    this.srcSafe = safeName ? sources.find((s) => attr(s).name === safeName) ?? byName(safeName) : null;
    this.slotSafe = this.srcSafe ? CFG.master.slotSafe ?? slotOfSource(iv, this.srcSafe) : null;
    if ([this.slotA, this.slotB].map(String).includes(String(this.slotSafe))) this.slotSafe = null;
    this.safeProblem = safeName && !this.slotSafe ? (this.srcSafe ? `"${attr(this.srcSafe).name}" is in no switcher slot of its own` : `MASTER has no source "${safeName}"`) : null;
    if (this.slotSafe && !this.signals.cut[this.slotSafe]) { this.safeProblem = `the switcher has no cut signal for the safe source's slot ${this.slotSafe}`; this.slotSafe = null; }
    // Hidden-key guard (v0.2 round 1): takectl's truth is the switcher's live slot and per-slot codes.
    // Without them, run on source tally (the v0.1 design) with a permanent warning, never refuse to start.
    const ov = attr(vs)["output-values"] || {};
    this.hasSlotTruth = LIVE_SLOT_KEY in iv && slotCodeKey(this.slotA) in ov && slotCodeKey(this.slotB) in ov;
    // Round 2: the STINGER layer above the switcher, if MASTER has one, and how long its animation runs.
    const st = this.layers.find((l) => lname(l).toLowerCase() === String(CFG.stingerLayerName || "STINGER").toLowerCase());
    this.stingerId = st?.id ?? null;
    this.stingerAnimMs = st ? Math.round(1000 * (attr((await this.api.get(`/documents/${this.id}/layers/${st.id}`)).data)["input-values"]?.tvGroup_Animation__Duration_TypeDuration ?? 0.4)) : 0;
    return this;
  }
  // The dissolve length as the switcher has it now (null if it cannot be read): read at every TAKE, so a
  // change made in mimoLive's own UI is honoured.
  async readDuration() {
    const v = attr((await this.api.get(`/documents/${this.id}/layers/${this.switcherId}`)).data)["input-values"]?.[DURATION_KEY];
    return typeof v === "number" ? v : null;
  }
  // FTB, the downstream keys and the stinger, from one read of MASTER's layers (top first by index).
  async readTopLayers() {
    const ls = (await this.api.get(`/documents/${this.id}/layers`)).data;
    const swIndex = attr(ls.find((l) => l.id === this.switcherId) ?? {}).index ?? Infinity;
    const on = (l) => ["live", "startup"].includes(attr(l)["live-state"]);
    const ftbName = String(CFG.ftbLayerName || "FTB").toLowerCase();
    const ftb = ls.find((l) => lname(l).toLowerCase() === ftbName);
    const dsk = [], dskBelow = [];
    for (const l of [...ls].sort((x, y) => (attr(x).index ?? 0) - (attr(y).index ?? 0))) {
      const m = lname(l).match(DSK_RE);
      if (!m) continue;
      ((attr(l).index ?? 0) < swIndex ? dsk : dskBelow).push({ id: l.id, name: lname(l), label: m[1].trim(), on: on(l) });
    }
    return { ftb: ftb ? { id: ftb.id, on: on(ftb), state: attr(ftb)["live-state"] } : null, dsk, dskBelow };
  }
  signalUrl(kind, slot) {
    const key = this.signals[kind][slot];
    if (!key) throw new Error(`[MASTER] no ${kind} signal for slot ${slot}; found: ${JSON.stringify(this.signals)}`);
    return `/documents/${this.id}/layers/${this.switcherId}/signals/${key}`;
  }
  // Proposal 1: is MASTER actually receiving each NDI source? 7.0b3 sets video-device-connected false
  // when a sender stops advertising while its output still reports live (probed 2026-11-11). It does
  // NOT drop when the sending document's NDI output is merely switched off; "A sends NDI" covers that.
  async connected() {
    const [a, b] = await Promise.all([
      this.api.get(`/documents/${this.id}/sources/${this.srcA.id}`),
      this.api.get(`/documents/${this.id}/sources/${this.srcB.id}`),
    ]);
    return { A: attr(a.data)["video-device-connected"], B: attr(b.data)["video-device-connected"] };
  }
  async tally() {
    const [a, b, c] = await Promise.all([
      this.api.get(`/documents/${this.id}/sources/${this.srcA.id}`),
      this.api.get(`/documents/${this.id}/sources/${this.srcB.id}`),
      this.slotSafe ? this.api.get(`/documents/${this.id}/sources/${this.srcSafe.id}`) : null,
    ]);
    return { A: attr(a.data)["tally-state"], B: attr(b.data)["tally-state"], ...(c ? { SAFE: attr(c.data)["tally-state"] } : {}) };
  }
  // Which role a live slot is: A, B, the safe source, or something else (an empty slot reads 9).
  roleOfSlot(slot) {
    if (slot == null || slot === "") return null;
    if (String(slot) === String(this.slotA)) return "A";
    if (String(slot) === String(this.slotB)) return "B";
    if (this.slotSafe && String(slot) === String(this.slotSafe)) return "SAFE";
    return "OTHER";
  }
  // Ground truth for PGM: the switcher's own live slot (input-values currentLiveSource, 1-based) and
  // its per-slot tally codes, read from one response. The slot flips at the END of a dissolve; for
  // the length of it both slots read 30. The switcher sends no WebSocket event of its own when it
  // switches (probed 2026-11-09), so this is read on wake-ups, never pushed.
  async switcherState() {
    if (this.hasSlotTruth === false) return this.tallyState();
    const l = await this.api.get(`/documents/${this.id}/layers/${this.switcherId}`);
    const iv = attr(l.data)["input-values"] || {};
    const ov = attr(l.data)["output-values"] || {};
    const slot = iv[LIVE_SLOT_KEY];
    const code = (s) => ov[slotCodeKey(s)];
    const codes = { A: code(this.slotA), B: code(this.slotB), ...(this.slotSafe ? { SAFE: code(this.slotSafe) } : {}) };
    // In flight = any slot at 30. A dissolve between two filled slots reads 30 on both; one into or out
    // of an empty slot reads 30 on the filled slot only (probed 2026-11-11), and is in flight all the same.
    const all = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ov[slotCodeKey(n)]).filter((v) => v !== undefined);
    return { slot, pgm: this.roleOfSlot(slot), codes, inFlight: all.some((c) => c === SLOT_EFFECT) };
  }
  // Fallback when the switcher does not expose its live slot: the same shape, derived from the two
  // sources' tally-state and mapped onto the switcher's codes (program 40, effect 30, else 10).
  // "effect" on either, or "program" on both, is in flight (the v0.1 heuristics). Weaker than the
  // switcher's own slot: a source tally stuck at "program" (CHANGES item 9) reads as in flight.
  async tallyState() {
    const t = await this.tally();
    const code = (v) => (v === "program" ? SLOT_PROGRAM : v === "effect" ? SLOT_EFFECT : 10);
    const roles = Object.keys(t);
    const onProgram = roles.filter((r) => t[r] === "program");
    const inFlight = roles.some((r) => t[r] === "effect") || onProgram.length > 1;
    const pgm = inFlight || onProgram.length !== 1 ? null : onProgram[0];
    const codes = Object.fromEntries(roles.map((r) => [r, inFlight ? SLOT_EFFECT : code(t[r])]));
    return { slot: pgm ? (pgm === "A" ? this.slotA : pgm === "B" ? this.slotB : this.slotSafe) : null, pgm, codes, inFlight, fromTally: true, raw: t };
  }
  // MASTER's datastores (saved with the document): role state, steps lists, history, hooks.
  async readStore(id) {
    try {
      const r = await fetch(`${this.api.base}/documents/${this.id}/datastores/${id}`, { headers: pwHeader(), signal: AbortSignal.timeout(CFG?.httpTimeoutMs ?? 3000) });
      if (r.ok) return await r.json();
    } catch {}
    return null;
  }
  async writeStore(id, obj) {
    await fetch(`${this.api.base}/documents/${this.id}/datastores/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json", ...pwHeader() }, body: JSON.stringify(obj),
    }).catch((e) => log(`datastore ${id} not written: ${e.message}`));
  }
  // Proposal 4: the datastore calls send the password header too when one is configured.
  async readState() {
    try {
      const r = await fetch(`${this.api.base}/documents/${this.id}/datastores/${CFG.stateStoreId || "abswitch-state"}`, { headers: pwHeader(), signal: AbortSignal.timeout(CFG?.httpTimeoutMs ?? 3000) });
      if (r.ok) return await r.json();
    } catch {}
    return null;
  }
  async writeState(state) {
    await fetch(`${this.api.base}/documents/${this.id}/datastores/${CFG.stateStoreId || "abswitch-state"}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...pwHeader() },
      body: JSON.stringify(state),
    }).catch((e) => log(`state persist failed: ${e.message}`));
  }
}

// ---------------------------------------------------------------- controller

// ---------------------------------------------------------------- round 4: watching A and B
// mimoLive's socket carries every change to a document, made in its window or over the API (probed
// 2026-11-11, test/round4-probe-*.txt); a message never says which. takectl keeps the last known state of
// each layer, variant and Layer Set in A and B and compares each message with it. A change counts unless
// it is: on TALLY or a layer named in watchIgnoreLayers; on a layer a hook switched on that has not read
// "off" since; on a layer takectl itself just wrote, until it settles plus 0.5 s (3 s at most); a Layer
// Set's "active" (mimoLive derives it from the layers); or a live value (output values, audio levels).
// Counted in Program: the warning in the Program header, until TAKE, CUT, UNDO or PANIC, or a tap on it.
// Counted in Preview: "Preview touched" (UNDO is off) and, once Preview settles, its look's thumbnail is
// taken again. Nothing here ever blocks or sends a command.
const OWN_SETTLE_MS = 500, OWN_MAX_MS = 3000; // takectl's own write: until its layers settle + 0.5 s, 3 s at most
const PVW_SETTLE_MS = 1000; // Preview is settled after this long with no change and no layer in "shutdown"
const BURST_MS = 600; // more messages about the same layer within this are the same change (a fade, typing)
// A layer switched on flickers its source names ("None", then back ~300 ms later in a message of its own;
// probed 2026-11-11 on the real app): input values that change this soon after the layer switched are not
// changes of their own.
const FLICKER_MS = 600;
const LIVE_INPUT_RE = /AudioLevel/; // input values that move by themselves
const WATCHED_TYPES = new Set(["layers", "variants", "layer-sets"]);
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const isOnState = (s) => s === "live" || s === "startup";
const clockTime = (ms) => new Date(ms).toTimeString().slice(0, 8);
const ignoreList = () => (Array.isArray(CFG?.watchIgnoreLayers) ? CFG.watchIgnoreLayers.map((x) => String(x)) : []);
function inputLabel(k, desc) {
  const ui = desc?.[k]?.uiName;
  if (ui) return ui;
  return k.replace(/^tv(Group|In|Out)_/, "").replace(/^[A-Za-z0-9]+__/, "").replace(/_Type[A-Za-z]*$/, "").replace(/_/g, " ").trim() || k;
}
// "Lower Third on", "Lower Third: Title", "Layer Set "Wide" edited", "layer "Logo" added"
function fmtChange(e) {
  if (!e) return "";
  const [first, ...rest] = e.details;
  const head = /^(on|off|added|removed|edited)$/.test(first) ? `${e.label} ${first}` : `${e.label}: ${first}`;
  return [head, ...rest].join(", ");
}

class Watcher {
  constructor(sw) {
    this.sw = sw;
    this.on = true; // WATCH PGM: runtime only, on at every start
    this.hostUp = new Map(); // host → true (socket open) | false (closed after it had been open)
    this.st = { A: new Map(), B: new Map() }; // "type:id" → { live, iv, name, index, volume, rest, layerId }
    this.names = { A: new Map(), B: new Map() }; // layer id → name (kept after a layer is removed)
    this.sets = { A: new Map(), B: new Map() }; // Layer Set id → the layer ids its recall switches
    this.own = { A: new Map(), B: new Map() }; // layer id ("*": every layer) → { until, cap }
    this.hookOn = { A: new Set(), B: new Set() }; // layers a hook switched on, until they read "off"
    this.switchedAt = { A: new Map(), B: new Map() }; // layer id → when it last switched on or off
    this.seq = 0; // every message counts one; a re-read keeps what a message updated while it was reading
    this.touched = { A: new Map(), B: new Map() }; // "type:id" → seq of its last message
    this.change = null; // Program: { role, first, at, n, list: [{ key, label, details, at }] }
    this.pvwBurst = null;
    this.pvwTimer = null;
  }
  doc(role) { return this.sw.doc(role); }
  get watched() { return [this.sw.A.host, this.sw.B.host].every((h) => this.hostUp.get(h) === true); }
  ignored(name) { const n = String(name ?? "").toLowerCase(); return ignoreList().some((x) => x.toLowerCase() === n); }
  isTally(role, id, name) { return id === this.doc(role).tallyLayerId || String(name ?? "").toLowerCase() === String(CFG.tallyLayerName || "TALLY").toLowerCase(); }

  snap(type, a, layerId = null) {
    if (type === "layer-sets") { const { active, ...rest } = a; return { rest: stable(rest), name: a.name, layerId: null }; }
    const iv = {};
    for (const [k, v] of Object.entries(a["input-values"] ?? {})) if (!LIVE_INPUT_RE.test(k)) iv[k] = stable(v);
    return { live: a["live-state"], iv, name: a.name, index: a.index, volume: a.volume === undefined ? undefined : stable(a.volume), layerId };
  }
  // What changed between two versions, in words; empty if nothing that counts. A key one side lacks (HTTP
  // and the socket do not always carry the same ones) is never a change.
  diff(type, o, n, desc, justSwitched = false) {
    if (type === "layer-sets") return o.rest !== n.rest ? ["edited"] : [];
    const out = [];
    // A variant's own on/off and name follow its layer and its settings; the layer's messages say it.
    if (type === "layers" && o.live !== undefined && n.live !== undefined && isOnState(o.live) !== isOnState(n.live)) out.push(isOnState(n.live) ? "on" : "off");
    if (out.length) return out; // the inputs a layer flickers while it switches are not changes of their own
    if (!justSwitched) for (const k of Object.keys(n.iv)) if (k in o.iv && o.iv[k] !== n.iv[k]) out.push(inputLabel(k, desc));
    if (type === "layers") {
      if (o.index !== undefined && n.index !== undefined && o.index !== n.index) out.push("moved");
      if (o.volume !== undefined && n.volume !== undefined && o.volume !== n.volume) out.push("volume");
      if (o.name && n.name && o.name !== n.name) out.push(`renamed "${n.name}"`);
    }
    return [...new Set(out)];
  }

  // takectl's own writes (api() reports each before sending it) and the layers hooks switch on.
  ownWrite(role, method, path) {
    let m;
    if ((m = path.match(/\/layers\/([^/]+)\/(setLive|setOff)$/))) this.markOwn(role, [m[1]]);
    else if ((m = path.match(/\/layer-sets\/([^/]+)\/recall$/))) { const ids = this.sets[role].get(m[1]); this.markOwn(role, ids ?? ["*"]); }
    else if (method !== "GET" && (m = path.match(/\/layers\/([^/]+)(?:\/variants\/[^/]+)?$/))) this.markOwn(role, [m[1]]);
  }
  markOwn(role, ids) { const now = Date.now(); for (const id of ids) this.own[role].set(id, { until: now + OWN_SETTLE_MS, cap: now + OWN_MAX_MS }); }
  markHookOn(role, ids) { for (const id of ids) this.hookOn[role].add(id); }
  // Is this message takectl's own write settling? Every message about the layer keeps the window open
  // while it reads "shutdown", and until 0.5 s after its last message otherwise, 3 s at most.
  ownNow(role, layerId, live) {
    const now = Date.now();
    const o = this.own[role].get(layerId) ?? this.own[role].get("*");
    if (!o || now > o.until) return false;
    o.until = live === "shutdown" ? o.cap : Math.min(o.cap, Math.max(o.until, now + OWN_SETTLE_MS));
    return true;
  }

  handle(host, m) {
    if (!m || !WATCHED_TYPES.has(m.type)) return;
    const role = ["A", "B"].find((r) => { const d = this.doc(r); return d.host === host && String(d.id) === String(m["document-id"]); });
    if (!role) return;
    const type = m.type, ev = m.event;
    const key = `${type}:${m.id}`, map = this.st[role], prev = map.get(key);
    this.touched[role].set(key, ++this.seq);
    const a = m.data?.attributes;
    const layerId = type === "layers" ? m.id : type === "variants" ? m["layer-id"] ?? m.data?.relationships?.layer?.data?.id ?? prev?.layerId ?? null : null;
    if (type === "layers" && a?.name) this.names[role].set(m.id, a.name);
    if (type === "layer-sets" && Array.isArray(a?.layers)) this.sets[role].set(m.id, a.layers.map((x) => x["layer-id"]));
    let details = [];
    const justSwitched = !!layerId && Date.now() - (this.switchedAt[role].get(layerId) ?? 0) < FLICKER_MS;
    if (ev === "removed") { map.delete(key); if (type === "layer-sets") this.sets[role].delete(m.id); details = ["removed"]; }
    else if (ev === "added") { if (a) map.set(key, this.snap(type, a, layerId)); details = ["added"]; }
    else if (ev === "values-changed") {
      const iv = Object.fromEntries(Object.entries(m.data?.["input-values"] ?? {}).filter(([k]) => !LIVE_INPUT_RE.test(k)).map(([k, v]) => [k, stable(v)]));
      if (prev && Object.keys(iv).length) { const next = { ...prev, iv: { ...prev.iv, ...iv } }; map.set(key, next); details = this.diff(type, prev, next, null, justSwitched); }
    } else if (ev === "changed" && a) {
      let next = this.snap(type, a, layerId);
      // A message that switches a layer (or its variant: they come in either order) carries the flicker as its
      // input values: keep the ones from before, and hold input changes off for FLICKER_MS.
      const switching = !!prev && type !== "layer-sets" && prev.live !== undefined && next.live !== undefined && isOnState(prev.live) !== isOnState(next.live);
      if (switching) { this.switchedAt[role].set(layerId, Date.now()); next = { ...next, iv: prev.iv }; }
      map.set(key, next);
      if (prev) details = this.diff(type, prev, next, a["input-descriptions"], justSwitched || switching);
    } else return;
    // Followed for every message, whether or not it changes anything that counts.
    const live = a?.["live-state"];
    const own = layerId ? this.ownNow(role, layerId, live) : false;
    const hooked = !!layerId && this.hookOn[role].has(layerId);
    if (hooked && type === "layers" && (ev === "removed" || live === "off")) this.hookOn[role].delete(layerId);
    if (!details.length || own || hooked) return;
    const name = layerId ? this.names[role].get(layerId) ?? "a layer" : null;
    if (layerId && (this.isTally(role, layerId, name) || this.ignored(name))) return;
    let label = name, d = details;
    if (type === "layer-sets") label = `Layer Set "${a?.name ?? prev?.name ?? "?"}"`;
    else if (type === "layers" && (ev === "added" || ev === "removed")) label = `layer "${name}"`;
    else if (type === "variants" && (ev === "added" || ev === "removed")) d = [`variant ${ev}`];
    this.count(role, layerId ?? key, label, d);
  }

  count(role, key, label, details) {
    const sw = this.sw, now = Date.now();
    if (role === sw.pgm) {
      if (!this.on) return;
      const c = this.change?.role === role ? this.change : (this.change = { role, first: now, at: now, n: 0, list: [] });
      c.at = now;
      const last = c.list[c.list.length - 1];
      if (last && last.key === key && now - last.at < BURST_MS) { last.at = now; for (const x of details) if (!last.details.includes(x)) last.details.push(x); return; }
      const e = { key, label, details: [...details], at: now };
      c.list.push(e); c.n++;
      if (c.list.length > 20) c.list.splice(1, 1); // keep the first; it is the one the header names
      sw.note(`CHANGED IN MIMOLIVE: ${fmtChange(e)} (Program, document ${role})`);
    } else if (role === sw.pvw) {
      const b = this.pvwBurst;
      if (b && b.key === key && now - b.at < BURST_MS) b.at = now;
      else {
        this.pvwBurst = { key, at: now };
        const what = fmtChange({ label, details });
        sw.pvwTouched = `${what}, by hand in mimoLive`;
        sw.note(`Preview changed by hand in mimoLive: ${what} (document ${role}); no UNDO`);
      }
      clearTimeout(this.pvwTimer);
      this.pvwTimer = setTimeout(() => this.pvwSettled(role).catch((e) => sw.note(`Preview thumbnail not refreshed: ${e.message}`)), PVW_SETTLE_MS);
    }
  }
  // Preview has settled after a change by hand: read which look it now shows and take that look's thumbnail.
  async pvwSettled(role) {
    const sw = this.sw;
    if (sw.stopped || sw.pvw !== role) return;
    if ([...this.st[role].values()].some((v) => v.live === "shutdown")) { this.pvwTimer = setTimeout(() => this.pvwSettled(role).catch(() => {}), 250); return; }
    await sw.refreshLayerSets();
    const look = sw.liveLook[role];
    if (!look || sw.pvw !== role) return;
    await sw.takeThumb(role, look);
    sw.note(`thumbnail of "${look}" taken again: Preview ${role} was changed by hand`);
  }

  // The last known state, read over HTTP: at start, when the operator accepts a change, and after the
  // socket comes back (compare: what changed meanwhile counts, as "while not watched").
  async baseline(role, compare = false) {
    const d = this.doc(role), seq0 = this.seq;
    const layers = (await d.api.get(`/documents/${d.id}/layers`)).data;
    const variants = await Promise.all(layers.map((l) => d.api.get(`/documents/${d.id}/layers/${l.id}/variants`).then((r) => r.data ?? []).catch(() => [])));
    const sets = (await d.api.get(`/documents/${d.id}/layer-sets`)).data;
    const fresh = new Map(), setLayers = new Map();
    layers.forEach((l, i) => {
      this.names[role].set(l.id, lname(l));
      fresh.set(`layers:${l.id}`, this.snap("layers", attr(l), l.id));
      for (const v of variants[i]) fresh.set(`variants:${v.id}`, this.snap("variants", attr(v), l.id));
    });
    for (const s of sets) { fresh.set(`layer-sets:${s.id}`, this.snap("layer-sets", attr(s))); setLayers.set(s.id, (attr(s).layers ?? []).map((x) => x["layer-id"])); }
    const old = this.st[role];
    // A message that arrived while this read was in flight is newer than the read: keep what it said.
    for (const [key, sq] of this.touched[role]) if (sq > seq0) { if (old.has(key)) fresh.set(key, old.get(key)); else fresh.delete(key); }
    // A layer that has just switched (or that this read finds switched) shows its flicker as input values:
    // keep the ones known before, as a switching message does.
    const now = Date.now();
    for (const [key, v] of fresh) {
      if (!v.layerId || !old.has(key)) continue;
      const lo = old.get(`layers:${v.layerId}`), lf = fresh.get(`layers:${v.layerId}`);
      const switchedNow = !!lo && !!lf && lo.live !== undefined && lf.live !== undefined && isOnState(lo.live) !== isOnState(lf.live);
      if (switchedNow) this.switchedAt[role].set(v.layerId, now);
      if (switchedNow || now - (this.switchedAt[role].get(v.layerId) ?? 0) < FLICKER_MS) fresh.set(key, { ...v, iv: old.get(key).iv });
    }
    this.st[role] = fresh;
    this.sets[role] = setLayers;
    for (const id of [...this.hookOn[role]]) { const st = fresh.get(`layers:${id}`)?.live; if (st === undefined || st === "off") this.hookOn[role].delete(id); }
    if (!compare) return 0;
    let n = 0;
    const found = (key, v, details) => {
      const type = key.slice(0, key.indexOf(":"));
      const name = v.layerId ? this.names[role].get(v.layerId) : null;
      if (!details.length || (v.layerId && (this.isTally(role, v.layerId, name) || this.ignored(name) || this.hookOn[role].has(v.layerId)))) return;
      const label = type === "layer-sets" ? `Layer Set "${v.name}"` : type === "layers" && /^(added|removed)$/.test(details[0]) ? `layer "${name}"` : name;
      const d = type === "variants" && /^(added|removed)$/.test(details[0]) ? [`variant ${details[0]}`] : details;
      this.count(role, v.layerId ?? key, label, [...d, "while not watched"]);
      n++;
    };
    for (const [key, v] of fresh) { const o = old.get(key); found(key, v, o ? this.diff(key.slice(0, key.indexOf(":")), o, v) : ["added"]); }
    for (const [key, v] of old) if (!fresh.has(key)) found(key, v, ["removed"]);
    return n;
  }
  async baselineAll() { await Promise.all(["A", "B"].map((r) => this.baseline(r))); }

  up(host) {
    const was = this.hostUp.get(host);
    this.hostUp.set(host, true);
    if (was !== false) return;
    for (const r of ["A", "B"]) {
      if (this.doc(r).host !== host) continue;
      this.baseline(r, true)
        .then((n) => this.sw.note(`watch: socket back; document ${r} re-read${n ? `, ${n} change(s) made while not watched` : ", nothing changed meanwhile"}`))
        .catch((e) => this.sw.note(`watch: document ${r} not re-read after the socket came back: ${e.message}`));
    }
  }
  down(host) {
    if (this.hostUp.get(host) === true) this.sw.note("NOT WATCHED: the event socket closed; a change made in mimoLive's window cannot be seen until it is back");
    this.hostUp.set(host, false);
  }

  clearPgm(why) { if (this.change) { this.sw.note(`CHANGED IN MIMOLIVE cleared by ${why}`); this.change = null; } }
  async dismiss() {
    const c = this.change, role = this.sw.pgm;
    this.change = null;
    if (isDocRole(role)) await this.baseline(role).catch((e) => this.sw.note(`watch: document ${role} not re-read: ${e.message}`));
    this.sw.note(c ? `CHANGED IN MIMOLIVE accepted (${c.n} change${c.n === 1 ? "" : "s"}): document ${role} as it is now is what takectl expects` : `watch: nothing to accept; document ${role} re-read`);
    return { ok: true, accepted: c ? c.n : 0 };
  }
  setOn(on) {
    this.on = on;
    if (!on) this.change = null;
    this.sw.note(`WATCH PGM ${on ? "on" : "off: changes made in mimoLive's window to Program are not flagged"}`);
    return { ok: true, on };
  }
  // A warning about a document that is no longer on air is dropped: it was about that document as Program.
  current() { return this.change && this.change.role === this.sw.pgm ? this.change : null; }
  view() {
    const c = this.current();
    return { on: this.on, watched: this.watched, ignore: ignoreList(),
      change: c ? { doc: c.role, since: c.first, at: c.at, n: c.n, what: fmtChange(c.list[0]), list: c.list.slice(-5).map(fmtChange) } : null,
      // a change kept for a document that is not on air now (an outside cut took it off): it shows again if that
      // document comes back on air the same way. TAKE, CUT, UNDO and PANIC clear it, so it is null after them.
      offAir: this.change && !c ? { doc: this.change.role, n: this.change.n, what: fmtChange(this.change.list[0]) } : null };
  }
  warnings() {
    const c = this.current(), all = [...this.names.A.values(), ...this.names.B.values()].map((x) => x.toLowerCase());
    const unknown = ignoreList().filter((n) => !all.includes(n.toLowerCase()));
    return [
      // Short: the readout must show it whole on an iPad (when, and the tap, are on the header strip)
      c ? `CHANGED IN MIMOLIVE: ${fmtChange(c.list[0])}${c.n > 1 ? ` (+${c.n - 1} more)` : ""}` : null,
      !this.watched ? "NOT WATCHED: no events from mimoLive" : null,
      CFG.watchIgnoreLayers !== undefined && !Array.isArray(CFG.watchIgnoreLayers) ? "watchIgnoreLayers must be a list of layer names; it is ignored" : null,
      unknown.length && (this.names.A.size || this.names.B.size) ? `watchIgnoreLayers: ${unknown.map((n) => `"${n}"`).join(", ")} match${unknown.length === 1 ? "es" : ""} no layer in A or B` : null,
    ].filter(Boolean);
  }
  stop() { clearTimeout(this.pvwTimer); }
}

class Switcher {
  constructor() {
    this.A = new Doc("A", CFG.a.host, CFG.a.documentName);
    this.B = new Doc("B", CFG.b.host, CFG.b.documentName);
    this.M = new Master("MASTER", CFG.master.host, CFG.master.documentName);
    this.pgm = null; // "A" | "B"
    this.busyUntil = 0;
    this.lastTake = null;
    this.lastError = null;
    this.lastErrorAt = null; // when lastError was set; /state reports its age so a stale one reads as stale
    this.events = [];
    this.takeSeq = 0; // bumped by every transition and panic; a stale verify() must not touch TALLY
    this.verifyTimer = null; // the pending verify() of the last transition; panic() cancels it
    this.switcherRaw = null; // last switcherState() read
    this.tallyRaw = null; // last source tally read (the witness)
    this.disagreeSince = null; // when source tally first disagreed with the switcher, this episode
    this.warning = null; // set once a disagreement outlasts one settle period; shown in /state
    this.takeEndsAt = 0; // when takectl's last TAKE/CUT should have landed: panic()'s wait hint
    this.settlePending = false; // verify() ended in flight: the next settled read decides and settles TALLY
    this.inFlightSince = null; // first read of the current in-flight stretch (both slots at 30)
    this.stalled = false; // in flight for more than STALL_MS; shown in /state.warning
    this.stallTimer = null;
    this.layerSets = []; // Layer Set names present in both A and B (A's order), for the operator page
    // Round 2
    this.stingerOn = CFG.stinger === true; // the stinger option (runtime toggle; default from the config)
    this.stingerWarning = null;
    this.stingerClearAt = 0; // when the stinger's reveal has finished: post-hooks wait for it
    this.hookWarning = null; // a failed hook: shown, never reverts a take
    this.hooksStore = {}; // hooks from MASTER's datastore (override the config's, key by key)
    this.pendingLand = null; // the last commit, until it is confirmed: then history is logged and post-hooks fire
    this.landSeq = 0;
    this.postTimers = []; // pending post-hooks (and a rehearsal); PANIC and the next commit cancel them
    this.hookEpoch = 0;
    this.hooksRunning = 0;
    this.hookIdx = null; // config + datastore hooks, indexed (rebuilt when the datastore's change)
    this.history = []; // committed Program changes {from, to, kind, ts}
    this.steps = { list: [], recording: false, running: null };
    this.stepLists = {}; // named steps lists, saved in MASTER's datastore
    this.undoable = null; // the last TAKE/CUT, if it can be taken back
    this.undoWhy = "no TAKE or CUT yet";
    this.pvwTouched = null; // what went to Preview since that TAKE (a controller command): no UNDO
    this.activeLook = { A: null, B: null }; // each document's look, as /state shows it
    // Safe source: while it (or any other slot) is on air, a TAKE goes to this document, shown as Preview.
    this.safeTarget = null;
    this.rehearsal = null; // a "rehearse hooks" run in Preview, until Preview is put back
    // Round 3
    this.rateS = null; // the switcher's dissolve length, last read
    this.top = { ftb: null, dsk: [], dskBelow: [] }; // FTB and downstream keys, last read
    this.progress = null; // { start, ms } of the transition in progress, for TAKE's progress bar
    this.thumbs = Object.create(null); // look name → { file, ts }, from thumbs/index.json (no prototype: any name is just a key)
    this.outputs = { rec: null, stream: null }; // MASTER's File Recording / Live Streaming: true live, false off, null none
    this.onAirSince = null; // when Program's current look went to air (history, else takectl's own observation)
    this.otherSlot = null; // the live slot while pgm is "OTHER"
    this.historyLoaded = false; // a MASTER-only PANIC controller never loaded history, so must not write it
    this.lookMem = { A: null, B: null }; // the last Layer Set each document read as active, or takectl recalled there
    this.liveLook = { A: null, B: null }; // the Layer Set each document reads as active (PUSH and steps use only this)
    // Round 4: A and B watched over the socket; takectl's own writes and hooks are told to the watcher first.
    this.watch = new Watcher(this);
    this.sockets = new Map(); // host → WebSocket
    for (const d of [this.A, this.B]) {
      d.api.onWrite = (method, path) => this.watch.ownWrite(d.role, method, path);
      d.onHookOn = (ids) => this.watch.markHookOn(d.role, ids);
    }
  }

  // Every switcher read goes through here, so the stall indicator sees all of them.
  async readSwitcher() {
    let s = await this.M.switcherState();
    if (s.fromTally) s = this.fallbackExpiry(s);
    this.observe(s);
    return s;
  }
  // Source-tally mode only: "in flight" expires after FALLBACK_INFLIGHT_MAX_MS. Then PGM is takectl's
  // last commanded state, flagged unconfirmed (PANIC never counts it as landed), TALLY follows it, and
  // a permanent warning says so (ruling 2026-11-11).
  // Once unreliable, every read shows the commanded state (permanent until takectl restarts): a
  // source stuck at "program" must never let PANIC count A as landed.
  fallbackExpiry(s) {
    const now = Date.now();
    if (this.tallyUnreliable) return this.commanded(s);
    if (!s.inFlight) { this.fbInFlightSince = null; clearTimeout(this.fbTimer); return s; }
    if (this.fbInFlightSince == null) {
      this.fbInFlightSince = now;
      // Look again right after the limit, so the expiry does not wait for the next 5 s poll.
      clearTimeout(this.fbTimer);
      this.fbTimer = setTimeout(() => this.resync("fallback-expiry").catch(() => {}), FALLBACK_INFLIGHT_MAX_MS + 50);
    }
    if (now - this.fbInFlightSince <= FALLBACK_INFLIGHT_MAX_MS || !this.pgm) return s;
    this.tallyUnreliable = true;
    this.note(`WARNING source tally unreliable: in flight for ${now - this.fbInFlightSince} ms (A=${s.raw?.A}, B=${s.raw?.B}); showing last commanded state, PGM=${this.pgm}`);
    return this.commanded(s);
  }
  commanded(s) {
    const pgm = this.pgm;
    if (!pgm) return s;
    const codes = Object.fromEntries(Object.keys(s.codes).map((r) => [r, r === pgm ? SLOT_PROGRAM : 10]));
    return { ...s, inFlight: false, pgm, slot: this.slot(pgm) ?? s.slot, codes, unconfirmed: true };
  }
  // A transition in flight longer than STALL_MS sets the stall warning (both TALLYs stay lit and the
  // operator sees why). It decides nothing; the next settled read clears it.
  observe(s) {
    const now = Date.now();
    if (s.inFlight) {
      if (this.inFlightSince == null) {
        this.inFlightSince = now;
        clearTimeout(this.stallTimer);
        this.stallTimer = setTimeout(() => this.resync("stall").catch(() => {}), STALL_MS + 50);
      } else if (!this.stalled && now - this.inFlightSince > STALL_MS) {
        this.stalled = true;
        this.note(`WARNING transition stalled: both slots at ${SLOT_EFFECT} for ${now - this.inFlightSince} ms (slot ${s.slot}); deciding nothing`);
      }
    } else if (this.inFlightSince != null) {
      if (this.stalled) this.note(`transition no longer stalled: settled on slot ${s.slot} after ${now - this.inFlightSince} ms`);
      this.inFlightSince = null;
      this.stalled = false;
      clearTimeout(this.stallTimer);
    }
  }
  async refreshLayerSets() {
    const sets = async (d) => (await d.api.get(`/documents/${d.id}/layer-sets`)).data;
    const [sa, sb] = await Promise.all([sets(this.A), sets(this.B)]);
    const a = sa.map((x) => attr(x).name), b = sb.map((x) => attr(x).name);
    const active = (ss) => ss.find((x) => attr(x).active && (attr(x).layers?.length ?? 0) > 0)?.attributes?.name ?? null;
    this.liveLook = { A: active(sa), B: active(sb) };
    for (const [r, ss] of [["A", sa], ["B", sb]]) { const n = active(ss); if (n) this.lookMem[r] = n; }
    this.activeLook = { A: active(sa) ?? this.lookMem.A, B: active(sb) ?? this.lookMem.B };
    this.layerSets = a.filter((n) => b.includes(n));
    // Every name in either document, A's order then B-only names, so the page can grey a name
    // that only one document has and say why (round 1, item 3).
    this.layerSetsAll = [...a, ...b.filter((n) => !a.includes(n))].map((name) => ({ name, inA: a.includes(name), inB: b.includes(name) }));
    // Ruling 2026-11-11: a name in only one document is a warning, not a doctor failure.
    const onlyA = a.filter((n) => !b.includes(n)), onlyB = b.filter((n) => !a.includes(n));
    this.layerSetWarning = onlyA.length || onlyB.length
      ? `Layer Sets in only one document (A: ${onlyA.join(", ") || "none"}; B: ${onlyB.join(", ") || "none"}); their buttons stay greyed`
      : null;
  }
  // In SAFE (or OTHER) the TAKE target is Preview everywhere; the other document is idle.
  get pvw() {
    if (this.pgm === "A") return "B";
    if (this.pgm === "B") return "A";
    if (this.inSafe) return this.safeTarget ?? "A";
    return null;
  }
  get inSafe() {
    return this.pgm === "SAFE" || this.pgm === "OTHER";
  }
  safeWhat() {
    return this.pgm === "OTHER" ? `something else is on air (switcher slot ${this.otherSlot})` : "SAFE is on air";
  }
  doc(role) {
    return role === "A" ? this.A : this.B;
  }
  slot(role) {
    return role === "A" ? this.M.slotA : role === "B" ? this.M.slotB : role === "SAFE" ? this.M.slotSafe : null;
  }
  // lastError is kept until the next successful TAKE, CUT or PANIC clears it (ruling 6): a refusal
  // the operator did not see is still information, so it never expires on its own.
  setError(msg) {
    this.lastError = msg;
    this.lastErrorAt = msg ? Date.now() : null;
  }
  note(msg) {
    log(msg);
    this.events.unshift({ ts: Date.now(), msg });
    this.events.length = Math.min(this.events.length, 50);
  }

  async start() {
    await Promise.all([this.A.discover(), this.B.discover(), this.M.discover()]);
    this.note(`A="${this.A.name}" B="${this.B.name}" MASTER="${this.M.name}" switcher="${this.M.switcherName}" slots A=${this.M.slotA} B=${this.M.slotB}`);
    this.note(`signals cut=${JSON.stringify(this.M.signals.cut)} dis=${JSON.stringify(this.M.signals.dis)}`);
    await this.resync("startup");
    await this.watch.baselineAll().catch((e) => this.note(`watch: A and B not read (${e.message}); changes are compared from the first message on`));
    this.connectSocket();
    await this.refreshLayerSets().catch((e) => this.note(`layer sets not read: ${e.message}`));
    this.history = (await this.M.readStore("abswitch-history"))?.events ?? [];
    this.historyLoaded = true;
    // Time on the current look: the last history entry, if it put Program's current look on air.
    const lastH = this.history[this.history.length - 1];
    this.onAirSince = lastH && (lastH.to === this.activeLook[this.pgm] || (this.inSafe && lastH.to === "SAFE")) ? lastH.ts : null;
    this.liveTimer = setInterval(() => this.refreshLive().catch(() => {}), CFG.livePollMs ?? 1000);
    this.stepLists = (await this.M.readStore("abswitch-steps"))?.lists ?? {};
    this.hooksStore = (await this.M.readStore("abswitch-hooks")) ?? {};
    try { this.thumbs = Object.assign(Object.create(null), JSON.parse(readFileSync(join(thumbsDir(), "index.json"), "utf8"))); } catch { this.thumbs = Object.create(null); }
    await this.refreshTop().catch(() => {});
    this.misses = 0;
    this.pollTimer = setInterval(async () => {
      if (!(await this.healthy())) return;
      this.resync("poll").catch(() => {});
      this.refreshLayerSets().catch(() => {});
      this.refreshTop().catch(() => {});
    }, CFG.pollMs ?? 5000);
    this.pushCompanion().catch(() => {});
  }
  // Ruling 2026-11-11: losing mimoLive (or one of the three documents) after a ready start drops back to
  // not-ready with the same 3 s retry, and the next start reads PGM from the switcher. Two failed health
  // reads in a row count as lost: on the poll, or 1 s apart after the WebSocket closes.
  async healthy() {
    if (this.stopped) return false;
    try {
      await Promise.all([this.A, this.B, this.M].map((d) => d.api.get(`/documents/${d.id}`)));
      this.misses = 0;
      return true;
    } catch (e) {
      if (++this.misses >= 2) this.lost(e.message);
      return false;
    }
  }
  lost(reason) {
    if (this.stopped) return;
    this.note(`LOST: ${reason}`);
    this.stop();
    this.onLost?.(reason);
  }
  stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.stallTimer);
    clearTimeout(this.verifyTimer);
    clearTimeout(this.fbTimer);
    clearTimeout(this.pushTimer);
    clearInterval(this.liveTimer);
    clearTimeout(this.thumbTimer);
    clearTimeout(this.stingerTimer);
    clearTimeout(this.stingerCheck);
    for (const t of this.postTimers) clearTimeout(t);
    this.steps.running = null;
    for (const d of [this.A, this.B]) clearTimeout(d.tallyCheck);
    this.watch.stop();
    for (const ws of this.sockets.values()) { try { ws.close(); } catch {} }
  }

  // Truth = the Video Switcher's live slot. Wake = WebSocket "sources changed" for the two NDI
  // sources, and the poll: they only cause this read, they are never facts. Witness = the two
  // sources' tally-state, read alongside and compared, never acted on (see witness()).
  async resync(reason) {
    if (Date.now() < this.busyUntil && !RESYNC_WHILE_BUSY.has(reason)) return;
    if (this.persistedPvw === undefined) this.persistedPvw = (await this.M.readState().catch(() => null))?.pvw ?? null;
    // A read that was sent before a TAKE or PANIC started can come back after it: it describes the old
    // state, so it must not set roles (found 2026-11-11: a poll's read put pgm back to A after PANIC to SAFE).
    const seq0 = this.takeSeq;
    const stale = () => !RESYNC_WHILE_BUSY.has(reason) && (this.takeSeq !== seq0 || Date.now() < this.busyUntil || this.preparing);
    let s, t;
    for (let i = 0; ; i++) {
      [s, t] = await Promise.all([this.readSwitcher(), this.M.tally()]);
      if (stale()) return;
      this.switcherRaw = s;
      this.tallyRaw = t;
      if (!s.inFlight) break;
      // Both slots at 30: a transition is in flight. That is "busy, come back", not a state: keep
      // the roles (the sources' events at its end wake us again). This replaces the old tally
      // heuristics ("both program → keep" and [drift 2] "effect → keep"). With no roles yet
      // (startup), wait it out.
      if (this.pgm != null || i >= 10) return;
      await sleep(150);
    }
    let pgm = s.pgm;
    if (pgm == null) {
      pgm = this.pgm ?? (await this.M.readState())?.pgm ?? "A";
      if (reason !== "poll")
        this.note(`switcher live slot ${s.slot} holds neither A (slot ${this.M.slotA}) nor B (slot ${this.M.slotB}); keeping PGM=${pgm}`);
    }
    this.witness(s, t);
    if (pgm === "OTHER") this.otherSlot = s.slot;
    if (pgm !== this.pgm || this.settlePending) {
      const prev = this.pgm;
      // Into SAFE or OTHER from a document: the TAKE target is the document that was Preview. At start,
      // the one MASTER's state names, else A.
      if ((pgm === "SAFE" || pgm === "OTHER") && !this.inSafe) {
        this.safeTarget = isDocRole(prev) ? (prev === "A" ? "B" : "A") : (() => { const v = this.persistedPvw; return isDocRole(v) ? v : "A"; })();
      }
      this.pgm = pgm;
      if (prev !== null && prev !== pgm) this.note(`PGM changed outside takectl (${reason}): ${prev} → ${pgm}; re-syncing tally`);
      if (this.settlePending) this.note(`transition settled on a later read (${reason}): PGM=${pgm}`);
      const land = this.settlePending ? this.pendingLand : null;
      if (prev !== null && prev !== pgm && !this.settlePending) { this.undoable = null; this.undoWhy = "Program changed outside takectl"; this.onAirSince = Date.now(); }
      this.settlePending = false;
      await this.applyRoles();
      if (land && !land.push) land.role === pgm ? this.landed(land.id) : this.dropLand(land.id, "the take did not land");
    }
  }

  // Source tally is a witness. Agreement: the switcher's PGM source reads "program" and the other one
  // does not ("effect" on either is a transition and counts as agreement). A disagreement that
  // outlasts one settle period is logged once per episode, with the switcher's per-slot codes from
  // the same read, and shown as /state.warning. It never changes roles or TALLY.
  witness(s, t) {
    if (s.fromTally) return; // running on source tally: nothing independent to compare it with
    const settle = CFG.settleMs ?? 250;
    const roles = Object.keys(t);
    const agrees = !s.pgm || roles.some((r) => t[r] === "effect") ||
      (s.pgm === "OTHER" ? roles.every((r) => t[r] !== "program") : t[s.pgm] === "program" && roles.every((r) => r === s.pgm || t[r] !== "program"));
    if (agrees) {
      if (this.warning) this.note(`source tally agrees with switcher again (A=${t.A}, B=${t.B}, slot=${s.slot})`);
      this.disagreeSince = null;
      this.warning = null;
      return;
    }
    const now = Date.now();
    if (this.disagreeSince == null) {
      this.disagreeSince = now;
      setTimeout(() => this.resync("witness").catch(() => {}), settle + 50); // look again after one settle period
      return;
    }
    if (!this.warning && now - this.disagreeSince > settle) {
      this.warning = `source tally disagrees with switcher (${Object.entries(t).map(([r, v]) => `${r}=${v}`).join(", ")}, slot=${s.slot})`;
      this.note(`WARNING ${this.warning}; switcher per-slot codes in the same read ${Object.entries(s.codes).map(([r, v]) => `${r}=${v}`).join(" ")} (40 program, 30 effect, 10 in-use); disagreeing since ${new Date(this.disagreeSince).toISOString()}`);
    }
  }

  // Immediate: PGM's TALLY on and PVW's off together. Startup, resync and panic use this.
  async applyRoles() {
    await Promise.all([this.applyIncoming(), this.releaseOutgoing()]);
  }
  // Transition, first half: the incoming (new PGM) TALLY lights and the roles are persisted at once.
  async applyIncoming() {
    if (isDocRole(this.pgm)) await this.doc(this.pgm).setTally(true);
    await this.M.writeState({ pgm: this.pgm, pvw: this.pvw, ts: Date.now(), by: "takectl" });
    await this.pushCompanion();
  }
  // Transition, second half: the outgoing TALLY goes off only once verify() has confirmed the new
  // PGM, so both are lit through the dissolve and the document still on air never reads dark.
  async releaseOutgoing() {
    for (const r of ["A", "B"]) if (r !== this.pgm) await this.doc(r).setTally(false); // in SAFE: both off
  }

  async preflight(target) {
    const d = this.doc(target);
    await d.refreshDoc();
    const problems = [];
    if (d.liveState !== "live") problems.push(`${target} document is not live (show not started)`);
    if (d.ndiOutId && d.ndiOutLive !== "live") problems.push(`${target} NDI output is not live`);
    if (!d.ndiOutId) problems.push(`${target} has no NDI output destination`);
    const slot = this.slot(target);
    if (!this.M.signals.dis[slot] && !this.M.signals.cut[slot]) problems.push(`MASTER has no switcher signal for slot ${slot}`);
    // Proposal 1, read as: each NDI source, whenever it is the TAKE's target. Requiring both would refuse
    // a TAKE away from a dead on-air source, the one TAKE the operator then needs (flagged in CHANGES).
    const conn = await this.M.connected();
    if (conn[target] === false) problems.push(`MASTER is not receiving ${target}'s NDI ("${(target === "A" ? this.M.srcA : this.M.srcB).attributes?.name}" not connected)`);
    // Both documents, not just the target: the outgoing one stays on air through the dissolve.
    for (const role of ["A", "B"]) {
      const doc = this.doc(role);
      const layers = (await doc.api.get(`/documents/${doc.id}/layers`)).data;
      if (layers.some((l) => lname(l).toLowerCase() === COUNTER_LAYER.toLowerCase() && attr(l)["live-state"] === "live"))
        problems.push(`${role} has a live "${COUNTER_LAYER}" layer (bench stopwatch) — it would go to air; switch it off or delete it in "${doc.name}"`);
    }
    return problems;
  }

  // TAKE, CUT, UNDO, PUSH and steps share one gate: between a command's busy check and the moment it
  // marks itself busy there are several reads, and a second command arriving then (a TAKE and a PUSH
  // pressed together, from Companion) must not pass the same check. PANIC never waits at this gate.
  async gate(fn) {
    if (this.preparing) return { ok: false, error: "busy: transition in progress (another TAKE, CUT, PUSH or UNDO is being prepared)" };
    if (this.rehearsal) return { ok: false, error: this.rehearsalBusy() };
    this.preparing = true;
    try { return await fn(); } finally { this.preparing = false; }
  }
  transition(kind, opts = {}) { return this.gate(() => this.transitionInner(kind, opts)); }
  push(opts = {}) { return this.gate(() => this.pushInner(opts)); }
  async transitionInner(kind, opts = {}) {
    const now = Date.now();
    if (now < this.busyUntil) return { ok: false, error: `busy: transition in progress (${this.busyUntil - now} ms left)` };
    if (this.steps.running) return { ok: false, error: "steps are being pushed: wait for them, or press PANIC" };
    // Panic always wins a race with TAKE: a /panic arriving from here on bumps takeSeq, and this
    // transition then yields instead of sending (or owning) its signal.
    const seq0 = this.takeSeq;
    const yieldToPanic = (when) => {
      const msg = `${kind.toUpperCase()} not completed: /panic arrived ${when}`;
      this.note(msg);
      return { ok: false, error: msg };
    };
    if (!this.pgm) await this.resync("pre-take");
    if (!this.pgm) return { ok: false, error: "PGM unknown: the switcher is still mid-transition; try again" };
    const target = this.pvw;
    const fromSafe = this.inSafe; // a TAKE out of SAFE (or OTHER) goes to the target document
    if (CFG.preflight !== false) {
      const problems = await this.preflight(target);
      if (problems.length) {
        this.setError(problems.join("; "));
        this.note(`REFUSED ${kind.toUpperCase()} → ${target}: ${this.lastError}`);
        return { ok: false, error: this.lastError };
      }
    }
    if (this.takeSeq !== seq0) return yieldToPanic("during preflight; signal not sent");
    // Round 2: the looks either side, their hooks, and the stinger.
    const fromLook = fromSafe ? null : await this.look(this.pgm);
    const toLook = await this.look(target);
    let hooks = opts.undo ? NO_HOOKS : this.hooksFor(fromLook, toLook);
    // Out of SAFE there is no outgoing Program document: document pre-hooks are skipped, MASTER ones run.
    if (fromSafe && hooks.pre.some((a) => a.in !== "master")) hooks = { ...hooks, pre: hooks.pre.filter((a) => a.in === "master") };
    // Round 3: CUT is always a bare cut, as on an ATEM: it ignores the transition setting and never fires
    // the stinger (UNDO of a CUT too). Its hooks still run.
    const sting = kind === "cut" ? { use: false } : await this.stingerReady();
    if (sting.refuse) { this.setError(sting.refuse); this.note(`REFUSED ${kind.toUpperCase()}: ${sting.refuse}`); return { ok: false, error: sting.refuse }; }
    if (kind !== "cut") this.stingerWarning = sting.warn ?? null;
    const slot = this.slot(target);
    const useDis = !sting.use && kind === "take" && this.M.signals.dis[slot];
    const url = this.M.signalUrl(useDis ? "dis" : "cut", slot);
    // The dissolve's length is read from the switcher at every TAKE (ruling 2026-11-11): value + 60 ms; the
    // config's dissolveMs only if the key cannot be read.
    let dur = 0;
    if (useDis) {
      const secs = await this.M.readDuration().catch(() => null);
      if (secs != null) this.rateS = secs;
      dur = secs != null ? Math.round(Math.min(secs, RATE_MAX_S) * 1000) + DISSOLVE_EXTRA_MS : CFG.dissolveMs ?? 500;
    }
    const cover = sting.use ? (CFG.stingerCoverMs ?? 500) : 0;
    this.busyUntil = now + (hooks.pre.length ? (hooks.waitMs ?? 0) + 1000 : 0) + cover + dur + (CFG.settleMs ?? 250);
    this.busyKind = "take";
    this.progress = { start: now, ms: (hooks.pre.length ? hooks.waitMs ?? 0 : 0) + (sting.use ? cover + (CFG.stingerOffMs ?? 120) + (this.M.stingerAnimMs || 400) : dur), kind };
    const how = sting.use ? "cut under the stinger" : useDis ? "dissolve" : "cut";
    this.note(`${opts.undo ? "UNDO" : kind.toUpperCase()} → ${target} (slot ${slot}, ${how})`);
    this.cancelHooks("a new transition"); // the last commit's pending post-hooks (or a rehearsal) never land on the wrong document
    this.hookWarning = null;
    if (hooks.pre.length) {
      this.note(`hooks before (${hooks.key}): ${hooks.pre.map((a) => this.chip(a, "pre")).join(", ")}`);
      await this.runPre(hooks.pre, fromSafe ? null : this.doc(this.pgm), seq0);
      await sleep(hooks.waitMs ?? 0);
      if (this.takeSeq !== seq0) return yieldToPanic("during the pre-hooks; signal not sent");
    }
    if (sting.use) {
      // stingerIn() also cancels the last commit's stinger read-back, which would otherwise switch this
      // stinger off mid-cover on a quick second TAKE. The cover timer starts once setLive has returned.
      await this.stingerIn();
      await sleep(cover);
      if (this.takeSeq !== seq0) return yieldToPanic("under the stinger; signal not sent");
    }
    this.busyUntil = Date.now() + dur + (CFG.settleMs ?? 250);
    this.takeEndsAt = this.busyUntil;
    try {
      await this.M.api.get(url);
    } catch (e) {
      if (this.takeSeq !== seq0) return yieldToPanic("while the signal was in flight");
      this.busyUntil = 0;
      this.setError(e.message);
      this.note(`transition failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
    // A /panic that arrived while the signal was in flight owns MASTER now; its loop deals with the
    // transition just started. Do not take the roles back from it.
    if (this.takeSeq !== seq0) return yieldToPanic("while the signal was in flight; panic owns the result");
    // Flip roles optimistically so the operator can start composing in the new PVW immediately,
    // then verify against the switcher once the dissolve has settled.
    if (sting.use) { this.stingerOff(); this.busyUntil = Math.max(this.busyUntil, this.stingerClearAt); }
    this.pgm = target;
    this.watch.clearPgm(opts.undo ? "UNDO" : kind.toUpperCase()); // round 4: a TAKE, CUT or UNDO clears CHANGED IN MIMOLIVE (a PUSH does not)
    this.lastTake = { kind: opts.undo ? "undo" : kind, target, ts: now, transition: sting.use ? "stinger" : useDis ? "dissolve" : "cut", ms: sting.use ? cover : dur, look: toLook };
    this.setError(null); // ruling 6: a successful TAKE/CUT clears the last error (verify may set a new one)
    const seq = ++this.takeSeq;
    const land = this.commitLand({ role: target, from: fromSafe ? "SAFE" : fromLook, to: toLook, kind: opts.undo ? "undo" : kind, hooks, safe: fromSafe });
    if (opts.undo) { this.undoable = null; this.undoWhy = "already undone"; }
    else if (fromSafe) { this.undoable = null; this.undoWhy = "the TAKE came out of SAFE"; }
    else { this.undoable = { kind, land }; this.undoWhy = null; }
    // UNDO needs Preview as the TAKE left it; pre-hooks went to the outgoing document, which is Preview now.
    const prePvw = hooks.pre.filter((a) => a.in !== "master");
    this.pvwTouched = prePvw.length ? `the pre-hooks changed it (${prePvw.map((a) => this.chip(a, "pre")).join(", ")})` : null;
    await this.applyIncoming(); // outgoing TALLY stays lit until verify() confirms
    this.verifyTimer = setTimeout(() => this.verify(target, seq, land).catch(() => {}), dur + (CFG.settleMs ?? 250));
    return { ok: true, pgm: this.pgm, pvw: this.pvw, transition: sting.use ? "stinger" : useDis ? "dissolve" : "cut", ms: sting.use ? cover : dur, look: toLook };
  }

  // Completion read for verify(). A read with both slots at 30 is in flight and never a decision,
  // whatever the slot, so re-read up to 3 times at 150 ms while in flight. Returns the last read —
  // which may still be in flight, and then the caller must not decide on it — or null if
  // isStale() turned true meanwhile.
  async confirmSlot(isStale) {
    let s = await this.readSwitcher();
    for (let i = 0; i < 3 && s.inFlight; i++) {
      await sleep(150);
      if (isStale()) return null;
      s = await this.readSwitcher();
    }
    return s;
  }

  async verify(expected, seq, land) {
    const stale = () => seq !== this.takeSeq; // a newer transition or a panic now owns roles and TALLY
    if (stale()) return;
    const s = await this.confirmSlot(stale);
    if (!s || stale()) return;
    const t = await this.M.tally();
    if (stale()) return;
    this.switcherRaw = s;
    this.tallyRaw = t;
    if (s.inFlight) {
      // Still in flight after the retries: no decision either way. Both TALLYs stay lit; the next
      // settled read (the sources' events at the transition's end, or the poll) decides and settles them.
      this.settlePending = true;
      this.note(`verify: switcher still mid-transition after 3 retries (slot ${s.slot}); the next settled read decides`);
      return;
    }
    if (s.pgm !== expected) {
      this.setError(`verify failed: expected ${expected} on air, switcher live slot ${s.slot}`);
      this.note(this.lastError);
      this.dropLand(land, "the take did not land");
      await this.resync("verify");
      await this.applyRoles(); // both TALLYs are lit at this point; settle them to the resynced PGM
    } else {
      this.setError(null);
      this.witness(s, t);
      await this.releaseOutgoing();
      this.landed(land);
    }
  }

  // Copy the PGM doc's active Layer Set to the PVW doc (same name in both documents).
  async mirror() {
    // Ruling 13: mid-transition, "which document is PVW" is the question takectl has decided not to
    // answer, so mirroring into it would be a guess. Refused while busy or in flight.
    if (Date.now() < this.busyUntil) return { ok: false, error: "busy: a transition is in progress; MIRROR would have to guess which document is PVW" };
    if (this.rehearsal) return { ok: false, error: this.rehearsalBusy() };
    if (this.inSafe) return { ok: false, error: `MIRROR is refused while ${this.safeWhat()}: there is no Program look to copy` };
    const sw = await this.readSwitcher();
    if (sw.inFlight) return { ok: false, error: "busy: the switcher is mid-transition; MIRROR would have to guess which document is PVW" };
    const name = await this.doc(this.pgm).activeLayerSetName();
    if (!name) return { ok: false, error: `no active layer set in ${this.pgm}` };
    await this.doc(this.pvw).recallLayerSetByName(name);
    this.touchPvw(this.pvw, name, "MIRROR");
    this.note(`MIRROR: ${this.pgm} "${name}" → ${this.pvw}${this.steps.recording ? " (step recorded)" : ""}`);
    return { ok: true, layerSet: name, pvw: this.pvw };
  }

  // Recall a Layer Set by name in whichever document is PVW right now, so "compose only in the GREEN
  // document" holds by construction. Refused if that name is not in the PVW document, and — since
  // the point is never to touch what is on air — while a transition is busy or in flight, or when a
  // fresh switcher read says the PVW document is the one on air.
  async recallPvwLayerSet(name) {
    if (!this.pgm) return { ok: false, error: "PGM unknown; no PVW document to recall into" };
    const refuse = (why) => {
      this.note(`REFUSED PVW layer set "${name}": ${why}`);
      return { ok: false, error: why };
    };
    if (Date.now() < this.busyUntil) return refuse("a transition is in progress; wait for it to land");
    if (this.rehearsal) return refuse(this.rehearsalBusy());
    const s = await this.readSwitcher();
    if (s.inFlight) return refuse("the switcher is mid-transition; wait for it to land");
    if (s.pgm === this.pvw) return refuse(`${this.pvw} is on air (switcher slot ${s.slot}); roles are being resynced`);
    const pvw = this.pvw;
    const doc = this.doc(pvw);
    const sets = (await doc.api.get(`/documents/${doc.id}/layer-sets`)).data;
    const set = sets.find((x) => attr(x).name === name);
    if (!set) return refuse(`no Layer Set named "${name}" in ${pvw} ("${doc.name}")`);
    await doc.api.get(`/documents/${doc.id}/layer-sets/${set.id}/recall`);
    this.touchPvw(pvw, name, `Layer Set "${name}" recalled`);
    this.note(`PVW LAYER SET: "${name}" recalled in ${pvw}${this.steps.recording ? " (step recorded)" : ""}`);
    return { ok: true, layerSet: name, pvw, document: doc.name };
  }

  // PANIC: A on air, whatever was happening; the one button that must never need pressing twice.
  // It loops on the switcher's live state (ruling 2026-11-09): cut to A; read one settle period
  // later (a read sent the instant a cut returns can still show the old slot); if that read is not
  // A on program with B not in flight, wait and cut again; at most 3 rounds, then report. A cut
  // sent while a transition is in flight is overridden by it (probe: Cut_1 202 ms into Dis_2 still
  // ended on slot 2), so an in-flight read waits settleMs — or, if takectl's own TAKE is running,
  // until it should have landed (takeEndsAt + settleMs). That timing is only a hint; the switcher's
  // reads are the authority, which also covers a transition started outside takectl.
  async panic() {
    // With a safe source configured PANIC cuts to it, else to A (doctor warns about that).
    const role = this.M.slotSafe ? "SAFE" : "A";
    const name = role === "SAFE" ? "the safe source" : "A";
    const idle = !this.preparing && Date.now() >= this.busyUntil; // nothing of takectl's in progress
    const prev = this.pgm;
    const pressPvw = this.pvw; // a TAKE out of SAFE goes to the document that was Preview when PANIC was pressed
    const seq = ++this.takeSeq; // a TAKE in preflight or awaiting its signal yields; a pending verify() stands down
    clearTimeout(this.verifyTimer); // cancel it outright; the seq guard covers one already running
    this.watch.clearPgm("PANIC");
    // Round 2: PANIC cancels everything pending: post-hooks, a steps push, and takes any stinger off.
    // It leaves FTB as it is.
    this.cancelHooks("PANIC");
    if (this.steps.running) { this.note(`PANIC: steps push stopped at step ${this.steps.running.i + 1} of ${this.steps.running.n}`); this.steps.running = null; }
    clearTimeout(this.stingerTimer);
    this.stingerSetOff();
    this.undoable = null;
    this.undoWhy = "PANIC since the TAKE";
    if (role === "SAFE" && isDocRole(prev)) this.safeTarget = pressPvw;
    const reh = this.rehearsal;
    if (reh) {
      this.rehearsal = null;
      if (role === "SAFE" || reh.pvw !== role) this.restoreRehearsal(reh).catch(() => {});
      else this.hookWarning = `PANIC ended a rehearsal: ${reh.pvw} went on air with the rehearsed layers (${reh.saved.map((x) => x.name).join(", ")})`;
    }
    // Logged, marked, never counted in the likely-next emphasis.
    this.logHistory({ from: isDocRole(prev) ? this.activeLook[prev] ?? null : prev, to: role === "SAFE" ? "SAFE" : this.activeLook.A ?? null, kind: "panic" });
    const mine = () => seq === this.takeSeq;
    const superseded = { ok: true, pgm: role, superseded: true }; // a later /panic took over
    const settle = CFG.settleMs ?? 250;
    const hint = this.takeEndsAt;
    this.busyKind = "take";
    this.busyUntil = Number.MAX_SAFE_INTEGER; // TAKE/CUT refused and wake-ups stand aside until panic reports
    this.settlePending = false;
    const t0 = Date.now();
    const onTarget = (s) => !s.unconfirmed && s.pgm === role && s.codes[role] === SLOT_PROGRAM && !s.inFlight;
    const codesText = (s) => Object.entries(s.codes).map(([r, c]) => `${r}=${c}`).join(" ");
    const cut = () => this.M.api.get(this.M.signalUrl("cut", this.slot(role)));
    try {
      // Already on the safe source with nothing of takectl's in progress: confirm, answer, no cut.
      if (role === "SAFE" && prev === "SAFE" && idle) {
        const s0 = await this.readSwitcher();
        if (!mine()) return superseded;
        if (onTarget(s0)) {
          this.switcherRaw = s0;
          this.setError(null);
          await this.applyRoles();
          this.note(`PANIC: the safe source is already on air (slot ${s0.slot}); no cut sent`);
          return { ok: true, pgm: role, rounds: 0, ms: Date.now() - t0, already: true };
        }
      }
      this.pgm = role;
      let s = null;
      let round = 0;
      while (round < 3) {
        round++;
        await cut();
        if (round === 1) {
          this.note(`PANIC: cut to ${name}${role === "SAFE" ? ` (slot ${this.slot("SAFE")}); TAKE target ${this.pvw}` : ""}`);
          await this.applyRoles();
        }
        await sleep(settle);
        if (!mine()) return superseded;
        s = await this.readSwitcher();
        if (onTarget(s) || round === 3) break;
        const wait = s.inFlight ? Math.max(settle, hint + settle - Date.now()) : 0;
        this.note(`PANIC: round ${round} read slot ${s.slot}, codes ${codesText(s)}${s.inFlight ? " (in flight: the cut was overridden)" : ""}; cutting to ${name} again in ${wait} ms`);
        await sleep(wait);
        if (!mine()) return superseded;
      }
      this.switcherRaw = s;
      const ms = Date.now() - t0;
      if (onTarget(s)) {
        this.setError(null);
        if (this.pgm !== role) { this.note(`PANIC: roles read ${this.pgm} meanwhile; the switcher confirms ${role}`); this.pgm = role; await this.applyRoles(); }
        this.note(`PANIC: ${name} confirmed on air (slot ${s.slot}, codes ${codesText(s)}) after ${round} round(s), ${ms} ms`);
        this.lastTake = { kind: "panic", target: role, ts: t0, transition: "cut", ms: 0 };
        return { ok: true, pgm: role, rounds: round, ms };
      }
      // Never ok:true unconfirmed, never hang (ruling 2026-11-11): the cuts were sent, say so.
      const why = s.unconfirmed ? "source tally unreliable" : `switcher slot ${s.slot}, codes ${codesText(s)}`;
      this.setError(`cut to ${name} sent, cannot confirm (${round} rounds; ${why})`);
      this.note(`PANIC: ${this.lastError}`);
      await this.resync("panic"); // report the truth; an in-flight read decides nothing here either
      return { ok: false, sent: true, error: this.lastError, pgm: this.pgm, rounds: round, ms };
    } finally {
      if (mine()) this.busyUntil = 0;
    }
  }

  // ---- Round 2: looks, landing, hooks, stinger, PUSH, steps, history, UNDO

  // A document's look: its active Layer Set, or — when none reads active, as after a hook switched a
  // layer the set does not expect — the last one it read as active or takectl recalled there.
  async look(role) {
    const live = await this.doc(role).activeLayerSetName().catch(() => null);
    if (live) this.lookMem[role] = live;
    return live ?? this.lookMem[role] ?? null;
  }
  touchPvw(role, name, why) {
    this.scheduleThumb(role, name);
    this.lookMem[role] = name;
    this.activeLook[role] = name;
    this.liveLook[role] = name;
    this.pvwTouched = why;
    if (this.steps.recording) this.steps.list.push({ name, at: Date.now() });
  }

  // A commit (TAKE, CUT, PUSH, a step, UNDO) is pending until it is confirmed; only then is it
  // logged in history and do its post-hooks start. A failed verify, PANIC or the next commit drops it.
  commitLand({ role, from, to, kind, hooks, push = false, safe = false }) {
    const id = ++this.landSeq;
    this.pendingLand = { id, role, from, to, kind, push, safe, post: hooks.post, key: hooks.key };
    if (to) { this.lookMem[role] = to; this.activeLook[role] = to; if (push) this.liveLook[role] = to; }
    return id;
  }
  dropLand(id, why) {
    const p = this.pendingLand;
    if (!p || p.id !== id) return;
    this.pendingLand = null;
    if (p.post.length) this.note(`post-hooks skipped (${p.key}): ${why}`);
    if (this.undoable?.land === id) { this.undoable = null; this.undoWhy = why; }
  }
  landed(id) {
    const p = this.pendingLand;
    if (!p || p.id !== id) return;
    this.pendingLand = null;
    this.logHistory(p);
    if (!p.post.length) return;
    // Post-hooks start once the commit is confirmed, and not before a stinger has cleared.
    const wait = Math.max(0, this.stingerClearAt - Date.now());
    this.note(`hooks after (${p.key}) on ${p.role}, in ${wait} ms: ${p.post.map((a) => this.chip(a, "post")).join(", ")}`);
    this.runTimed(p.post, this.doc(p.role), wait, "post");
  }
  // Post-hooks (and a rehearsal) each on its own timer; cancelHooks() stops the ones not yet run.
  runTimed(list, doc, wait, which) {
    const epoch = this.hookEpoch;
    for (const a of list) {
      const t = setTimeout(async () => {
        this.postTimers = this.postTimers.filter((x) => x !== t);
        if (epoch !== this.hookEpoch) return;
        this.hooksRunning++;
        try { await this.runAction(a, doc); this.note(`hook ${which}: ${this.chip(a, which)} (${a.in === "master" ? "MASTER" : doc.role})`); }
        catch (e) { this.hookFailed(a, which, e); }
        finally { this.hooksRunning--; }
      }, wait + (a.delayMs || 0));
      this.postTimers.push(t);
    }
  }
  cancelHooks(why) {
    this.hookEpoch++;
    const n = this.postTimers.length;
    for (const t of this.postTimers) clearTimeout(t);
    this.postTimers = [];
    if (this.pendingLand) this.dropLand(this.pendingLand.id, why);
    if (n) this.note(`${n} pending hook action(s) cancelled: ${why}`);
  }
  async runAction(a, doc) {
    const d = a.in === "master" ? this.M : doc;
    if (a.layerSet) await d.recallLayerSetByName(a.layerSet, true);
    else await d.setLayerByName(a.layer, a.set !== "off", true);
  }
  // Pre-hooks run in order on the outgoing Program document; a failure warns and the take goes on.
  async runPre(list, doc, seq0) {
    for (const a of list) {
      if (this.takeSeq !== seq0) return;
      try { await this.runAction(a, doc); this.note(`hook pre: ${this.chip(a, "pre")} (${a.in === "master" ? "MASTER" : doc.role})`); }
      catch (e) { this.hookFailed(a, "pre", e); }
    }
  }
  hookFailed(a, which, e) {
    this.hookWarning = `hook failed (${this.chip(a, which)}): ${e.message}`;
    this.note(`WARNING ${this.hookWarning}; the take stands`);
  }
  chip(a, which) {
    const what = a.layerSet ? `set "${a.layerSet}"` : `${a.layer} ${a.set === "off" ? "out" : "in"}`;
    return `${which === "pre" ? "first" : "then"}: ${a.in === "master" ? "MASTER " : ""}${what}${a.delayMs ? ` +${a.delayMs} ms` : ""}`;
  }
  hookIndex() {
    if (this.hookIdx) return this.hookIdx;
    const c = normHooks(CFG.hooks, "config"), d = normHooks(this.hooksStore, "datastore");
    const pairs = new Map(), names = new Map();
    for (const h of [...Object.values(c.hooks), ...Object.values(d.hooks)]) {
      const pr = pairOf(h.key);
      if (pr) pairs.set(pr.join("\u0000"), h);
      else names.set(h.key.trim().toLowerCase(), h);
    }
    return (this.hookIdx = { pairs, names, errors: [...c.errors, ...d.errors] });
  }
  hooksFor(from, to) {
    if (!to) return NO_HOOKS;
    const { pairs, names } = this.hookIndex();
    return (from && pairs.get(`${from.toLowerCase()}\u0000${to.toLowerCase()}`)) ?? names.get(to.toLowerCase()) ?? NO_HOOKS;
  }
  async saveHooks(obj) {
    const { errors } = normHooks(obj, "body");
    if (errors.length) return { ok: false, error: errors.join("; ") };
    await this.M.writeStore("abswitch-hooks", obj);
    this.hooksStore = obj;
    this.hookIdx = null;
    this.note(`hooks saved in MASTER's datastore: ${Object.keys(obj).join(", ") || "(none)"}`);
    return { ok: true, hooks: Object.keys(obj) };
  }
  hooksView() {
    const { pairs, names, errors } = this.hookIndex();
    return { config: CFG.hooks ?? {}, datastore: this.hooksStore, inUse: [...names.values(), ...pairs.values()].map(({ key, origin, pre, waitMs, post }) => ({ key, origin, pre, waitMs, post })), errors };
  }
  // "rehearse hooks": the post-hooks of a take to Preview's look, run in Preview (MASTER actions are
  // skipped: MASTER is on air). Counts as touching Preview; the next commit cancels what has not run.
  async rehearseHooks() {
    if (!this.pgm) return { ok: false, error: "PGM unknown" };
    if (this.rehearsal) return { ok: false, error: this.rehearsalBusy() };
    if (Date.now() < this.busyUntil) return { ok: false, error: "a transition is in progress; wait for it to land" };
    const s = await this.readSwitcher();
    if (s.inFlight) return { ok: false, error: "the switcher is mid-transition; wait for it to land" };
    if (s.pgm === this.pvw) return { ok: false, error: `${this.pvw} is on air (switcher slot ${s.slot}); roles are being resynced` };
    const from = this.inSafe ? null : await this.look(this.pgm), to = await this.look(this.pvw);
    const h = this.hooksFor(from, to);
    if (!h.post.length) return { ok: false, error: `no post-hooks for a take to ${to ? `"${to}"` : "Preview (no look)"}` };
    const acts = h.post.filter((a) => a.in !== "master");
    const skipped = h.post.length - acts.length;
    if (!acts.length) return { ok: false, error: "the post-hooks for this look all act in MASTER, which is on air: nothing to rehearse in Preview" };
    // Ruling 2026-11-11: a rehearsal puts Preview back. Record the live state of every layer its hooks
    // will touch (all of them when a hook recalls a Layer Set; TALLY is takectl's and left alone), then
    // restore each one 2 s after the last hook has run.
    const pvw = this.pvw, doc = this.doc(pvw);
    const tallyName = String(CFG.tallyLayerName || "TALLY").toLowerCase();
    const named = new Set(acts.filter((a) => a.layer).map((a) => a.layer.toLowerCase()));
    const all = acts.some((a) => a.layerSet);
    const saved = (await doc.api.get(`/documents/${doc.id}/layers`)).data
      .filter((l) => lname(l).toLowerCase() !== tallyName && (all || named.has(lname(l).toLowerCase())))
      .map((l) => ({ id: l.id, name: lname(l), live: ["live", "startup"].includes(attr(l)["live-state"]) }));
    this.cancelHooks("rehearsal");
    this.pvwTouched = "rehearse hooks";
    const r = (this.rehearsal = { pvw, saved, restoreAt: null, ends: Date.now() + Math.max(0, ...acts.map((a) => a.delayMs || 0)) + REHEARSAL_HOLD_MS });
    this.note(`REHEARSE hooks (${h.key}) in Preview ${pvw}: ${acts.map((a) => this.chip(a, "post")).join(", ")}${skipped ? `; ${skipped} MASTER action(s) skipped` : ""}; put back ${REHEARSAL_HOLD_MS / 1000} s after the last one`);
    const epoch = this.hookEpoch;
    this.runTimed(acts, doc, 0, "post");
    (async () => {
      await sleep(Math.max(0, ...acts.map((a) => a.delayMs || 0)) + 50);
      while (this.rehearsal === r && this.hookEpoch === epoch && (this.postTimers.length || this.hooksRunning)) await sleep(50);
      if (this.rehearsal !== r) return;
      r.restoreAt = Date.now() + REHEARSAL_HOLD_MS;
      await sleep(REHEARSAL_HOLD_MS);
      if (this.rehearsal === r) await this.restoreRehearsal(r);
    })().catch((e) => { if (this.rehearsal === r) { this.rehearsal = null; this.hookWarning = `rehearsal not put back: ${e.message}`; } });
    return { ok: true, look: to, pvw, ran: acts.map((a) => this.chip(a, "post")), skipped: skipped ? `${skipped} MASTER action(s) skipped: MASTER is on air` : null,
      restores: saved.map((x) => `${x.name} ${x.live ? "live" : "off"}`) };
  }
  // Put every recorded layer back to the state it had before the rehearsal.
  async restoreRehearsal(r) {
    const doc = this.doc(r.pvw);
    const now = new Map((await doc.api.get(`/documents/${doc.id}/layers`)).data.map((l) => [l.id, ["live", "startup"].includes(attr(l)["live-state"])]));
    const changed = r.saved.filter((x) => now.has(x.id) && now.get(x.id) !== x.live);
    for (const x of changed) await doc.api.get(`/documents/${doc.id}/layers/${x.id}/${x.live ? "setLive" : "setOff"}`);
    if (this.rehearsal === r) this.rehearsal = null;
    this.note(`REHEARSE: Preview ${r.pvw} put back${changed.length ? ` (${changed.map((x) => `${x.name} ${x.live ? "live" : "off"}`).join(", ")})` : " (nothing had changed)"}`);
  }
  rehearsalBusy() {
    const r = this.rehearsal;
    if (!r) return null;
    return `busy: rehearsing hooks in Preview ${r.pvw}; it is put back ${Math.max(0, Math.ceil(((r.restoreAt ?? r.ends) - Date.now()) / 1000))} s from now`;
  }

  // Stinger: a layer in MASTER above the switcher. Checked fresh before every commit.
  async stingerReady() {
    if (!this.stingerOn) return { use: false };
    const name = CFG.stingerLayerName || "STINGER";
    let l;
    try { l = (await this.M.api.get(`/documents/${this.M.id}/layers`)).data.find((x) => lname(x).toLowerCase() === name.toLowerCase()); }
    catch (e) { return { use: false, warn: `stinger not read (${e.message}): committed without it` }; }
    if (!l) { this.M.stingerId = null; return { use: false, warn: `stinger is on but "${this.M.name}" has no "${name}" layer: committed without it` }; }
    if (this.M.stingerId !== l.id || !this.M.stingerAnimMs) {
      this.M.stingerId = l.id;
      this.M.stingerAnimMs = Math.round(1000 * (attr((await this.M.api.get(`/documents/${this.M.id}/layers/${l.id}`)).data)["input-values"]?.tvGroup_Animation__Duration_TypeDuration ?? 0.4));
    }
    let st = attr(l)["live-state"];
    if (st === "shutdown" && Date.now() < this.stingerClearAt + 300) { // still clearing from the last commit
      await sleep(this.stingerClearAt + 300 - Date.now());
      st = attr((await this.M.api.get(`/documents/${this.M.id}/layers/${l.id}`)).data)["live-state"];
    }
    if (st === "live" || st === "startup") return { refuse: `the stinger ("${name}") is already live in "${this.M.name}": switch it off there or press PANIC, then try again` };
    if (st === "shutdown") return { refuse: `the stinger ("${name}") is stuck in shutdown in "${this.M.name}": press PANIC (it switches the stinger off), then try again` };
    return { use: true };
  }
  async stingerIn() {
    this.stingerWant = true;
    clearTimeout(this.stingerTimer);
    clearTimeout(this.stingerCheck);
    await this.M.api.get(`/documents/${this.M.id}/layers/${this.M.stingerId}/setLive`);
  }
  // After the commit: off stingerOffMs later, so the cut is always under full cover; post-hooks wait
  // for its reveal (stingerClearAt).
  stingerOff() {
    const off = CFG.stingerOffMs ?? 120;
    this.stingerClearAt = Date.now() + off + (this.M.stingerAnimMs || 400);
    clearTimeout(this.stingerTimer);
    this.stingerTimer = setTimeout(() => this.stingerSetOff(), off);
  }
  // setOff, then read back (a setOff right after a setLive can stick the layer in shutdown, as TALLY does).
  stingerSetOff() {
    const id = this.M.stingerId;
    if (!id) return;
    this.stingerWant = false;
    const path = `/documents/${this.M.id}/layers/${id}`;
    this.M.api.get(`${path}/setOff`).catch((e) => this.note(`stinger off failed: ${e.message}`));
    clearTimeout(this.stingerCheck);
    this.stingerCheck = setTimeout(async () => {
      if (this.stingerWant !== false) return;
      try {
        const st = attr((await this.M.api.get(path)).data)["live-state"];
        if (st !== "off") { this.note(`stinger reads "${st}" after setOff; sending setOff again`); await this.M.api.get(`${path}/setOff`); }
      } catch {}
    }, (this.M.stingerAnimMs || 400) + 400);
  }
  setStinger(on) {
    this.stingerOn = !!on;
    if (!on) this.stingerWarning = null;
    this.note(`stinger ${on ? "on" : "off"}${on && !this.M.stingerId ? ` (no "${CFG.stingerLayerName || "STINGER"}" layer found at start)` : ""}`);
    return { ok: true, stinger: this.stingerOn };
  }

  // PUSH (a forum user's idea): Preview's look recalled on Program, live. With kind "steps", one step.
  async pushInner(opts = {}) {
    const kind = opts.kind ?? "push";
    const K = kind.toUpperCase();
    const now = Date.now();
    if (now < this.busyUntil) return { ok: false, error: `busy: transition in progress (${this.busyUntil - now} ms left)` };
    if (this.steps.running && !opts.step) return { ok: false, error: "steps are being pushed: wait for them, or press PANIC" };
    if (!this.pgm) return { ok: false, error: "PGM unknown" };
    if (this.inSafe) return { ok: false, error: `${K} is refused while ${this.safeWhat()}: TAKE or CUT to ${this.pvw} first` };
    const s = await this.readSwitcher();
    if (s.inFlight) return { ok: false, error: "busy: the switcher is mid-transition" };
    const refuse = (why) => { this.setError(why); this.note(`REFUSED ${K}: ${why}`); return { ok: false, error: why }; };
    const seq0 = this.takeSeq;
    const pgm = this.pgm;
    const doc = this.doc(pgm);
    // Preview's active Layer Set as it reads now: a remembered look is not what Preview shows.
    const name = opts.step ?? (await this.doc(this.pvw).activeLayerSetName().catch(() => null));
    if (!name) return refuse(`Preview (${this.pvw}) has no active Layer Set to push`);
    const sets = (await doc.api.get(`/documents/${doc.id}/layer-sets`)).data;
    const set = sets.find((x) => attr(x).name === name);
    if (!set) return refuse(`Program (${pgm}, "${doc.name}") has no Layer Set named "${name}"`);
    const from = await this.look(pgm);
    const hooks = this.hooksFor(from, name);
    const sting = opts.noStinger ? { use: false } : await this.stingerReady();
    if (sting.refuse) return refuse(sting.refuse);
    if (!opts.noStinger) this.stingerWarning = sting.warn ?? null;
    const settle = CFG.settleMs ?? 250;
    const cover = sting.use ? (CFG.stingerCoverMs ?? 500) : 0;
    this.busyUntil = now + (hooks.pre.length ? hooks.waitMs + 1000 : 0) + cover + settle;
    this.busyKind = "push"; // Program stays Program: the page keeps the roles on the tiles
    this.progress = { start: now, ms: (hooks.pre.length ? hooks.waitMs : 0) + (sting.use ? cover + (CFG.stingerOffMs ?? 120) + (this.M.stingerAnimMs || 400) : settle), kind: "push" };
    this.note(`${K} "${name}" → Program ${pgm}${sting.use ? " (under the stinger)" : ""}`);
    this.cancelHooks("a new commit");
    this.hookWarning = null;
    const yieldToPanic = (when) => { const m = `${K} not completed: /panic arrived ${when}`; this.note(m); return { ok: false, error: m }; };
    if (hooks.pre.length) {
      this.note(`hooks before (${hooks.key}): ${hooks.pre.map((a) => this.chip(a, "pre")).join(", ")}`);
      await this.runPre(hooks.pre, doc, seq0);
      await sleep(hooks.waitMs);
      if (this.takeSeq !== seq0) return yieldToPanic("during the pre-hooks; nothing recalled");
    }
    if (sting.use) {
      await this.stingerIn();
      await sleep(cover);
      if (this.takeSeq !== seq0) return yieldToPanic("under the stinger; nothing recalled");
    }
    try {
      await doc.api.get(`/documents/${doc.id}/layer-sets/${set.id}/recall`);
    } catch (e) {
      if (sting.use) this.stingerOff();
      this.busyUntil = 0;
      return refuse(`${K} failed: ${e.message}`);
    }
    if (this.takeSeq !== seq0) return yieldToPanic("while the recall was in flight");
    if (sting.use) this.stingerOff();
    this.busyUntil = Math.max(Date.now() + settle, sting.use ? this.stingerClearAt : 0);
    const land = this.commitLand({ role: pgm, from, to: name, kind, hooks, push: true });
    this.undoable = null;
    this.undoWhy = `${kind === "steps" ? "a steps push" : "a PUSH"} changed Program since the TAKE`;
    this.lastTake = { kind, target: pgm, ts: now, transition: sting.use ? "stinger" : "recall", ms: cover, look: name };
    this.setError(null);
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.verifyPush(name, land, seq0).catch(() => {}), settle);
    return { ok: true, pgm, look: name, transition: sting.use ? "stinger" : "recall", ms: cover };
  }
  // A PUSH has landed when Program reads the pushed set as active (up to 4 reads, 150 ms apart).
  async verifyPush(name, land, seq0) {
    for (let i = 0; i < 4; i++) {
      if (this.takeSeq !== seq0 || this.pendingLand?.id !== land) return;
      const live = await this.doc(this.pendingLand.role).activeLayerSetName().catch(() => null);
      if (live === name) return this.landed(land);
      await sleep(150);
    }
    if (this.pendingLand?.id !== land) return;
    this.hookWarning = `PUSH of "${name}" sent, but Program does not read it as active: post-hooks not run`;
    this.note(`WARNING ${this.hookWarning}`);
    this.logHistory(this.pendingLand); // the recall was sent; history logs it, the hooks wait for proof
    this.pendingLand = null;
  }

  // Steps (a forum user's idea): a list of looks pushed onto Program in order.
  stepsAdd(name) {
    if (!name) return { ok: false, error: `Preview (${this.pvw}) has no active Layer Set to add` };
    this.steps.list.push({ name, at: Date.now() });
    return { ok: true, steps: this.steps.list.map((x) => x.name) };
  }
  async stepsPush(pace) {
    pace = pace === "original" ? "original" : "instant";
    const list = this.steps.list.slice();
    if (!list.length) return { ok: false, error: "no steps: add some first" };
    if (this.steps.running) return { ok: false, error: "steps are already being pushed" };
    if (this.rehearsal) return { ok: false, error: this.rehearsalBusy() };
    if (Date.now() < this.busyUntil) return { ok: false, error: "busy: transition in progress" };
    if (!this.pgm) return { ok: false, error: "PGM unknown" };
    if (this.inSafe) return { ok: false, error: `steps push is refused while ${this.safeWhat()}: TAKE or CUT to ${this.pvw} first` };
    const doc = this.doc(this.pgm);
    const have = (await doc.api.get(`/documents/${doc.id}/layer-sets`)).data.map((x) => attr(x).name);
    const missing = [...new Set(list.map((x) => x.name).filter((n) => !have.includes(n)))];
    if (missing.length) return { ok: false, error: `Program (${this.pgm}, "${doc.name}") has no Layer Set named ${missing.map((n) => `"${n}"`).join(", ")}` };
    const run = { i: 0, n: list.length, pace, startedAt: Date.now() };
    this.steps.running = run;
    this.note(`STEPS push: ${list.length} step(s), pace ${pace}: ${list.map((x) => x.name).join(" → ")}`);
    // A step starts once the one before it has landed and its post-hooks have run; the run counts as
    // running until its last step has too.
    const settled = async () => { const t0 = Date.now(); while (this.steps.running === run && (Date.now() < this.busyUntil || this.pendingLand || this.postTimers.length || this.hooksRunning) && Date.now() - t0 < 15000) await sleep(50); };
    // Ruling 2026-11-11: with the stinger on, an instant run goes under ONE stinger (pushCovered); at the
    // original pace the stinger covers the first step only and later steps land bare with their own hooks.
    if (pace === "instant" && this.stingerOn && list.length > 1) {
      (async () => {
        await settled();
        if (this.steps.running !== run) return;
        const r = await this.gate(() => this.pushCoveredInner(list.map((x) => x.name), run));
        if (r.fallback) return this.stepsPushEach(list, run, pace, settled); // no usable stinger: step by step
        if (!r.ok && this.steps.running === run) { this.setError(`steps stopped: ${r.error}`); this.note(this.lastError); }
        await settled();
        if (this.steps.running === run) { this.steps.running = null; this.note(`STEPS push done under one stinger (${run.i} of ${run.n})`); }
      })().catch((e) => { this.steps.running = null; this.setError(`steps push failed: ${e.message}`); });
      return { ok: true, steps: list.length, pace, stinger: "one cover" };
    }
    this.stepsPushEach(list, run, pace, settled);
    return { ok: true, steps: list.length, pace };
  }
  stepsPushEach(list, run, pace, settled) {
    this.steps.running = run;
    (async () => {
      let lastStart = 0;
      for (let i = 0; i <= list.length; i++) {
        if (i === list.length) { await settled(); break; }
        if (this.steps.running !== run) return;
        if (i > 0 && pace === "original") {
          const gap = Math.min(10000, Math.max(0, list[i].at - list[i - 1].at));
          await sleep(Math.max(0, lastStart + gap - Date.now()));
        }
        await settled();
        if (this.steps.running !== run) return;
        lastStart = Date.now();
        const r = await this.push({ step: list[i].name, kind: "steps", noStinger: pace === "original" && i > 0 });
        if (this.steps.running !== run) return;
        if (!r.ok) { this.setError(`steps stopped at step ${i + 1} of ${list.length} ("${list[i].name}"): ${r.error}`); this.note(this.lastError); break; }
        run.i = i + 1;
      }
      if (this.steps.running === run) { this.steps.running = null; this.note(`STEPS push done (${run.i} of ${run.n})`); }
    })().catch((e) => { this.steps.running = null; this.setError(`steps push failed: ${e.message}`); });
  }
  // An instant steps run under one stinger: the first step's pre-hooks, stinger in, every recall in order
  // under it, stinger off, then only the last step's post-hooks after the reveal. Each step is logged.
  // { fallback: true } when the stinger cannot be used (missing layer): the run goes step by step.
  async pushCoveredInner(names, run) {
    const now = Date.now();
    if (now < this.busyUntil) return { ok: false, error: "busy: transition in progress" };
    if (!this.pgm) return { ok: false, error: "PGM unknown" };
    if (this.inSafe) return { ok: false, error: `steps push is refused while ${this.safeWhat()}` };
    const sw = await this.readSwitcher();
    if (sw.inFlight) return { ok: false, error: "busy: the switcher is mid-transition" };
    const sting = await this.stingerReady();
    if (sting.refuse) return { ok: false, error: sting.refuse };
    if (!sting.use) { this.stingerWarning = sting.warn ?? null; return { fallback: true }; }
    this.stingerWarning = null;
    const seq0 = this.takeSeq, pgm = this.pgm, doc = this.doc(pgm);
    const sets = (await doc.api.get(`/documents/${doc.id}/layer-sets`)).data;
    const ids = names.map((n) => sets.find((x) => attr(x).name === n)?.id);
    if (ids.some((x) => !x)) return { ok: false, error: `Program (${pgm}) is missing a step's Layer Set` };
    const from = await this.look(pgm);
    const first = this.hooksFor(from, names[0]);
    const last = this.hooksFor(names.length > 1 ? names[names.length - 2] : from, names[names.length - 1]);
    const settle = CFG.settleMs ?? 250, cover = CFG.stingerCoverMs ?? 500;
    this.busyUntil = now + (first.pre.length ? first.waitMs + 1000 : 0) + cover + 300 * names.length + settle;
    this.busyKind = "push";
    this.note(`STEPS under one stinger → Program ${pgm}: ${names.join(" → ")}`);
    this.cancelHooks("a new commit");
    this.hookWarning = null;
    const yieldToPanic = (when) => { const m = `steps push not completed: /panic arrived ${when}`; this.note(m); return { ok: false, error: m }; };
    if (first.pre.length) {
      await this.runPre(first.pre, doc, seq0);
      await sleep(first.waitMs);
      if (this.takeSeq !== seq0) return yieldToPanic("during the pre-hooks; nothing recalled");
    }
    await this.stingerIn();
    await sleep(cover);
    if (this.takeSeq !== seq0) return yieldToPanic("under the stinger; nothing recalled");
    let prev = from;
    for (let i = 0; i < names.length; i++) {
      try { await doc.api.get(`/documents/${doc.id}/layer-sets/${ids[i]}/recall`); }
      catch (e) { this.stingerOff(); this.busyUntil = 0; return { ok: false, error: `step ${i + 1} ("${names[i]}") failed: ${e.message}` }; }
      if (this.takeSeq !== seq0) return yieldToPanic(`under the stinger after step ${i + 1}`);
      if (i < names.length - 1) this.logHistory({ from: prev, to: names[i], kind: "steps" });
      prev = names[i];
      run.i = i + 1;
    }
    this.stingerOff();
    this.busyUntil = Math.max(Date.now() + settle, this.stingerClearAt);
    const lastName = names[names.length - 1];
    const land = this.commitLand({ role: pgm, from: names.length > 1 ? names[names.length - 2] : from, to: lastName, kind: "steps", hooks: { post: last.post, key: last.key }, push: true });
    this.undoable = null;
    this.undoWhy = "a steps push changed Program since the TAKE";
    this.lastTake = { kind: "steps", target: pgm, ts: now, transition: "stinger", ms: cover, look: lastName };
    this.setError(null);
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.verifyPush(lastName, land, seq0).catch(() => {}), settle);
    return { ok: true, pgm, steps: names.length };
  }
  async stepsSave(name) {
    if (!name) return { ok: false, error: "name the list: /steps/save?name=…" };
    if (!this.steps.list.length) return { ok: false, error: "no steps to save" };
    this.stepLists[name] = this.steps.list.slice();
    await this.M.writeStore("abswitch-steps", { lists: this.stepLists });
    return { ok: true, saved: name, lists: Object.keys(this.stepLists) };
  }
  stepsLoad(name) {
    const l = this.stepLists[name];
    if (!l) return { ok: false, error: `no saved list named "${name}"` };
    this.steps.list = l.slice();
    return { ok: true, loaded: name, steps: l.map((x) => x.name) };
  }
  async stepsDelete(name) {
    if (!this.stepLists[name]) return { ok: false, error: `no saved list named "${name}"` };
    delete this.stepLists[name];
    await this.M.writeStore("abswitch-steps", { lists: this.stepLists });
    return { ok: true, deleted: name, lists: Object.keys(this.stepLists) };
  }

  // History (a forum user's idea): every confirmed Program change, kept in MASTER's datastore.
  logHistory(p) {
    if (!this.historyLoaded) return;
    if (p.kind === "undo") { const last = this.history[this.history.length - 1]; if (last && last.kind !== "undo") last.undone = true; }
    this.history.push({ from: p.from ?? null, to: p.to ?? null, kind: p.kind, ...(p.safe ? { safe: true } : {}), ts: Date.now() });
    this.onAirSince = Date.now();
    if (this.history.length > 1000) this.history.splice(0, this.history.length - 1000);
    this.M.writeStore("abswitch-history", { events: this.history });
  }
  // Emphasis only: which looks have followed Program's current look, once it has been left 3 times
  // (UNDOs and the takes they undid do not count).
  historyView() {
    const from = this.activeLook[this.pgm] ?? null;
    const rows = from ? this.history.filter((h) => h.from === from && h.to && h.to !== from && h.kind !== "undo" && h.kind !== "panic" && !h.safe && !h.undone) : [];
    const follow = {};
    for (const h of rows) follow[h.to] = (follow[h.to] ?? 0) + 1;
    const max = Math.max(0, ...Object.values(follow));
    return { from, left: rows.length, events: this.history.length, follow: rows.length >= 3 ? follow : {}, top: rows.length >= 3 ? Object.keys(follow).filter((k) => follow[k] === max) : [] };
  }
  async historyReset() {
    const n = this.history.length;
    this.history = [];
    await this.M.writeStore("abswitch-history", { events: [] });
    this.note(`history reset (${n} entries cleared)`);
    return { ok: true, cleared: n };
  }

  // While SAFE (or OTHER) is on air: which document a TAKE goes to (and Preview shows).
  setSafeTarget(doc) {
    if (!this.inSafe) return { ok: false, error: "the TAKE target can be chosen only while SAFE (or something else) is on air" };
    if (!isDocRole(doc)) return { ok: false, error: "doc must be A or B" };
    if (this.preparing || Date.now() < this.busyUntil) return { ok: false, error: "busy: transition in progress" };
    if (this.rehearsal) return { ok: false, error: this.rehearsalBusy() };
    this.safeTarget = doc;
    this.note(`SAFE: TAKE target → ${doc}`);
    this.M.writeState({ pgm: this.pgm, pvw: this.pvw, ts: Date.now(), by: "takectl" }).catch(() => {});
    return { ok: true, pgm: this.pgm, pvw: doc };
  }

  // UNDO (the pen's call): back to the previous look, only while Preview is as the TAKE left it.
  undoState() {
    const no = (why) => ({ available: false, why, short: shortWhy(why) });
    if (this.inSafe) return no(this.safeWhat());
    if (!this.undoable) return no(this.undoWhy ?? "nothing to undo");
    if (this.pvwTouched) return no(`Preview changed since the TAKE: ${this.pvwTouched}`);
    if (this.steps.running) return no("steps are being pushed");
    return { available: true, why: null, kind: this.undoable.kind };
  }
  async undo() {
    const u = this.undoState();
    if (!u.available) return { ok: false, error: `UNDO not available: ${u.why}` };
    return this.transition(this.undoable.kind, { undo: true });
  }

  // ---- Round 3: rate, transition selector, FTB, downstream keys, thumbnails

  // Every second: the three documents' live state (a stopped show keeps serving its last frame, so the
  // page's STALE needs it) and MASTER's recording / streaming outputs (header lamps, display only).
  async refreshLive() {
    const hosts = new Map();
    for (const d of [this.A, this.B, this.M]) (hosts.get(d.host) ?? hosts.set(d.host, []).get(d.host)).push(d);
    await Promise.all([...hosts.values()].map(async (ds) => {
      const list = (await ds[0].api.get("/documents")).data;
      for (const d of ds) { const hit = list.find((x) => x.id === d.id); if (hit) d.liveState = attr(hit)["live-state"]; }
    }));
    const outs = (await this.M.api.get(`/documents/${this.M.id}/output-destinations`)).data;
    const of = (type) => { const o = outs.filter((x) => attr(x)["output-destination-type"] === type); return o.length ? o.some((x) => attr(x)["live-state"] === "live") : null; };
    this.outputs = { rec: of("com.boinx.mimoLive.outputDestination.fileRecording"), stream: of("com.boinx.mimoLive.outputDestination.liveStreaming") };
  }
  async refreshTop() {
    this.top = await this.M.readTopLayers();
    await Promise.all([this.A.refreshDoc(), this.B.refreshDoc(), this.M.refreshDoc()]).catch(() => {});
    const secs = await this.M.readDuration().catch(() => null);
    if (secs != null) this.rateS = secs;
  }
  // The rate control: the switcher's own dissolve length. Not a commit; refused only mid-transition.
  async setRate(s) {
    const v = Number(s);
    if (!Number.isFinite(v)) return { ok: false, error: "rate must be a number of seconds" };
    if (Date.now() < this.busyUntil) return { ok: false, error: "busy: a transition is in progress" };
    const secs = Math.round(Math.min(RATE_MAX_S, Math.max(RATE_MIN_S, v)) * 10) / 10;
    await this.M.api.put(`/documents/${this.M.id}/layers/${this.M.switcherId}`, { "input-values": { [DURATION_KEY]: secs } });
    const back = await this.M.readDuration();
    this.rateS = back;
    if (back !== secs) return { ok: false, error: `the switcher kept ${back} s (wrote ${secs} s)` };
    this.note(`RATE: dissolve ${secs} s`);
    return { ok: true, seconds: secs };
  }
  setTransition(mode) {
    if (!["mix", "stinger"].includes(mode)) return { ok: false, error: "mode must be mix or stinger" };
    this.stingerOn = mode === "stinger";
    if (!this.stingerOn) this.stingerWarning = null;
    this.note(`TRANSITION: ${mode.toUpperCase()}${this.stingerOn && !this.M.stingerId ? ` (no "${CFG.stingerLayerName || "STINGER"}" layer found)` : ""}`);
    return { ok: true, mode };
  }
  // FTB and the downstream keys are not commits: no gate, they work mid-transition and in SAFE, and they
  // are not logged in history. PANIC leaves them as they are.
  async setFtb(on) {
    await this.refreshTop();
    const f = this.top.ftb;
    if (!f) return { ok: false, error: `MASTER has no "${CFG.ftbLayerName || "FTB"}" layer (run documents/build-documents.mjs)` };
    const want = on ?? !f.on;
    await this.M.api.get(`/documents/${this.M.id}/layers/${f.id}/${want ? "setLive" : "setOff"}`);
    f.on = want;
    this.note(`FTB ${want ? "on: fading to black" : "off"}`);
    return { ok: true, ftb: want };
  }
  async setDsk(label, on) {
    await this.refreshTop();
    const k = this.top.dsk.find((x) => x.label.toLowerCase() === String(label).toLowerCase());
    if (!k) return { ok: false, error: `no downstream key "${label}" (MASTER layers named "DSK <label>" above the switcher: ${this.top.dsk.map((x) => x.label).join(", ") || "none"})` };
    const want = on ?? !k.on;
    await this.M.api.get(`/documents/${this.M.id}/layers/${k.id}/${want ? "setLive" : "setOff"}`);
    k.on = want;
    this.note(`DSK ${k.label} ${want ? "on" : "off"}`);
    return { ok: true, label: k.label, on: want };
  }
  // ~1 s after takectl recalls a look in Preview, a still of Preview becomes that look's key thumbnail.
  scheduleThumb(role, name) {
    clearTimeout(this.thumbTimer);
    this.thumbTimer = setTimeout(async () => {
      if (this.pvw !== role || this.lookMem[role] !== name) return; // Preview moved on
      await this.takeThumb(role, name);
    }, CFG.thumbDelayMs ?? 1000);
  }
  // A still of Preview becomes the look's thumbnail (round 4 also calls this once Preview, changed by hand, settles).
  async takeThumb(role, name) {
    try {
      const d = this.doc(role);
      const r = await fetch(`${d.api.base}/documents/${d.id}/programOut?format=jpeg&width=320`, { headers: pwHeader(), signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const file = thumbFile(name);
      mkdirSync(thumbsDir(), { recursive: true });
      writeFileSync(join(thumbsDir(), file), Buffer.from(await r.arrayBuffer()));
      this.thumbs[name] = { file, ts: Date.now() };
      writeFileSync(join(thumbsDir(), "index.json"), JSON.stringify(this.thumbs, null, 2));
    } catch (e) { this.note(`thumbnail for "${name}" not taken: ${e.message}`); }
  }
  // The line under LAST: what happened, or in SAFE where the next TAKE goes.
  lastLine() {
    if (this.pgm === "SAFE") return `PANIC: SAFE on air. Next TAKE goes to document ${this.pvw}`;
    if (this.pgm === "OTHER") return `Switcher slot ${this.otherSlot} on air. Next TAKE goes to document ${this.pvw}`;
    const t = this.lastTake;
    if (!t) return null;
    const k = t.kind === "steps" ? "STEPS" : t.kind.toUpperCase();
    return t.kind === "push" || t.kind === "steps" ? `${k} "${t.look}" onto document ${t.target}` : `${k} to document ${t.target}${t.transition === "stinger" ? " (stinger)" : ""}`;
  }

  pushState() {
    const look = this.pvw ? this.liveLook[this.pvw] : null;
    const inPgm = (this.layerSetsAll ?? []).find((x) => x.name === look)?.[this.pgm === "A" ? "inA" : "inB"];
    const why = !this.pgm ? "PGM unknown" : this.inSafe ? `refused while ${this.safeWhat()}` : this.rehearsal ? "rehearsing hooks" : this.steps.running ? "steps are being pushed" : Date.now() < this.busyUntil ? "a transition is in progress"
      : !look ? `Preview (${this.pvw}) has no active Layer Set` : !inPgm ? `Program (${this.pgm}) has no Layer Set named "${look}"` : null;
    return { available: !why, why, short: shortWhy(why), look };
  }
  // Chips for each look's button: what a take to it from Program's look would do.
  hookChips() {
    const from = this.activeLook[this.pgm] ?? null;
    const out = {};
    for (const { name } of this.layerSetsAll ?? []) {
      const h = this.hooksFor(from, name);
      if (h.pre.length || h.post.length) out[name] = { key: h.key, chips: [...h.pre.map((a) => this.chip(a, "pre")), ...h.post.map((a) => this.chip(a, "post"))] };
    }
    return { from, chips: out, rehearse: this.pvw ? (this.hooksFor(from, this.activeLook[this.pvw]).post.length > 0) : false };
  }

  // Visible-only conditions, never decisions: the fallback, an unreliable tally, Layer Sets in one
  // document, a stalled transition, the witness.
  warnings() {
    return [
      ...this.watch.warnings(), // round 4: CHANGED IN MIMOLIVE / NOT WATCHED first
      this.M.hasSlotTruth === false ? "running on source tally: this mimoLive does not expose the switcher's live slot (see /doctor)" : null,
      this.tallyUnreliable ? "source tally unreliable: showing last commanded state" : null,
      this.layerSetWarning ?? null,
      this.stalled ? `transition stalled (${Date.now() - this.inFlightSince} ms)` : null,
      this.warning,
      this.pgm === "OTHER" ? `something else is on air: switcher slot ${this.otherSlot}${Number(this.otherSlot) === SLOT_BELOW ? " (no source: an empty slot was selected)" : ""}; commands behave as in SAFE` : null,
      this.M.safeProblem ? `safe source not usable (${this.M.safeProblem}): PANIC cuts to A` : null,
      (this.layerSetsAll ?? []).length > LOOK_SLOTS ? `${this.layerSetsAll.length} Layer Sets: the keys show the first ${LOOK_SLOTS} (A's order)` : null,
      this.top.dskBelow.length ? `${this.top.dskBelow.map((x) => `"${x.name}"`).join(", ")} ${this.top.dskBelow.length > 1 ? "are" : "is"} below the switcher, so not a downstream key` : null,
      this.stingerWarning,
      this.hookWarning,
      this.hookIndex().errors.length ? `hooks: ${this.hookIndex().errors.length} invalid entr${this.hookIndex().errors.length === 1 ? "y" : "ies"} ignored (${this.hookIndex().errors[0]}${this.hookIndex().errors.length > 1 ? "; …" : ""}); see /hooks` : null,
    ].filter(Boolean);
  }
  state() {
    return {
      ready: true,
      mode: "running",
      pgm: this.pgm,
      pvw: this.pvw,
      busy: Date.now() < this.busyUntil,
      busyKind: Date.now() < this.busyUntil ? this.busyKind ?? "take" : null, // "push": Program is not changing documents
      switcher: this.switcherRaw ? { slot: this.switcherRaw.slot, codes: this.switcherRaw.codes, inFlight: this.switcherRaw.inFlight } : null,
      tally: this.tallyRaw ?? null,
      // Stall (in flight > STALL_MS), witness (source tally disagrees) and the hidden-key fallback
      // are all visible-only.
      warning: this.warnings().join("; ") || null,
      truth: this.M.hasSlotTruth === false ? "source tally" : "switcher live slot",
      lastTake: this.lastTake,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
      lastErrorAgeMs: this.lastErrorAt ? Date.now() - this.lastErrorAt : null, // takectl's clock, so the page needs none of its own
      layerSets: this.layerSets,
      layerSetsAll: this.layerSetsAll ?? [],
      // Round 3
      now: Date.now(), // takectl's clock, so the page can count time without trusting its own
      onAir: { look: this.inSafe ? this.pgm : this.activeLook[this.pgm] ?? null, since: this.onAirSince },
      outputs: this.outputs,
      transition: { mode: this.stingerOn ? "stinger" : "mix", rateS: this.rateS, rateMinS: RATE_MIN_S, rateMaxS: RATE_MAX_S,
        stingerMs: (CFG.stingerCoverMs ?? 500) + (CFG.stingerOffMs ?? 120) + (this.M.stingerAnimMs || 400), stingerLayer: !!this.M.stingerId },
      progress: Date.now() < this.busyUntil && this.progress ? { elapsedMs: Date.now() - this.progress.start, totalMs: this.progress.ms, kind: this.progress.kind } : null,
      ftb: this.top.ftb ? { on: this.top.ftb.on } : null,
      dsk: this.top.dsk.map(({ label, on }) => ({ label, on })),
      thumbs: Object.fromEntries(Object.entries(this.thumbs).map(([k, v]) => [k, v.ts])),
      lookSlots: LOOK_SLOTS,
      lastLine: this.lastLine(),
      nextHooks: (() => { const to = this.pvw ? this.liveLook[this.pvw] ?? this.activeLook[this.pvw] : null; const h = this.hooksFor(this.inSafe ? null : this.activeLook[this.pgm] ?? null, to); return { look: to, key: h.key, chips: [...h.pre.map((a) => this.chip(a, "pre")), ...h.post.map((a) => this.chip(a, "post"))] }; })(),
      // Safe source
      safe: { configured: !!this.M.slotSafe, source: this.M.srcSafe ? attr(this.M.srcSafe).name : null, slot: this.M.slotSafe ?? null, problem: this.M.safeProblem ?? null,
        onAir: this.inSafe, target: this.inSafe ? this.pvw : null, otherSlot: this.pgm === "OTHER" ? this.otherSlot : null, panicTo: this.M.slotSafe ? "SAFE" : "A" },
      // Round 2
      looks: { ...this.activeLook },
      push: this.pushState(),
      undo: this.undoState(),
      stinger: { on: this.stingerOn, layer: !!this.M.stingerId, layerName: CFG.stingerLayerName || "STINGER", coverMs: CFG.stingerCoverMs ?? 500, offMs: CFG.stingerOffMs ?? 120 },
      hooks: this.hookChips(),
      watch: this.watch.view(), // round 4
      rehearsal: this.rehearsal ? { pvw: this.rehearsal.pvw, restoresInMs: Math.max(0, (this.rehearsal.restoreAt ?? this.rehearsal.ends) - Date.now()) } : null,
      history: this.historyView(),
      steps: { list: this.steps.list.map((x) => x.name), recording: this.steps.recording, running: this.steps.running, lists: Object.keys(this.stepLists) },
      doctor: doctorSummary(),
      docs: {
        A: { id: this.A.id, name: this.A.name, host: this.A.host, live: this.A.liveState, ndi: this.A.ndiOutLive, tallyLayer: !!this.A.tallyLayerId },
        B: { id: this.B.id, name: this.B.name, host: this.B.host, live: this.B.liveState, ndi: this.B.ndiOutLive, tallyLayer: !!this.B.tallyLayerId },
        MASTER: { id: this.M.id, name: this.M.name, host: this.M.host, live: this.M.liveState, switcher: this.M.switcherName, slotA: this.M.slotA, slotB: this.M.slotB },
      },
      events: this.events.slice(0, 10),
    };
  }

  // Companion ≥3: custom variables via its HTTP API (enable in Companion → Settings → HTTP).
  async pushCompanion() {
    if (!CFG.companion?.host) return;
    const set = (name, value) =>
      fetch(`${CFG.companion.host.replace(/\/$/, "")}/api/custom-variable/${name}/value?value=${encodeURIComponent(value)}`, {
        method: "POST",
        signal: AbortSignal.timeout(1500),
      }).catch(() => {});
    await Promise.all([set("ab_pgm", this.pgm ?? ""), set("ab_pvw", this.pvw ?? ""), set("ab_error", this.lastError ?? "")]);
  }

  // One socket per mimoLive host (A, B and MASTER may be on different Macs). MASTER's source events wake
  // resync; every message also goes to the watcher (round 4).
  connectSocket() {
    if (typeof WebSocket === "undefined") {
      this.note("no global WebSocket in this Node; relying on polling, and changes made in mimoLive are not watched");
      return;
    }
    for (const host of new Set([this.M.host, this.A.host, this.B.host])) this.openSocket(host);
  }
  openSocket(host) {
    const url = api(host).base.replace(/^http/, "ws") + "/socket";
    const isMaster = host === this.M.host;
    let ws;
    const open = () => {
      if (this.stopped) return;
      ws = new WebSocket(url);
      this.sockets.set(host, ws);
      if (isMaster) this.ws = ws;
      let ping;
      ws.onopen = () => {
        this.note(`websocket connected ${isMaster ? url : "(document host)"}`);
        ping = setInterval(() => ws.send(JSON.stringify({ event: "ping" })), 5000);
        this.watch.up(host);
      };
      ws.onmessage = (m) => {
        let e;
        try { e = JSON.parse(m.data); } catch { return; }
        if (e.event === "pong") return;
        if (isMaster && e.type === "sources" && e.event === "changed" && e["document-id"] === this.M.id) {
          const id = e.id;
          if ([this.M.srcA, this.M.srcB, this.M.slotSafe ? this.M.srcSafe : null].some((x) => x && (x.id === id || x.id.endsWith(id)))) {
            if (Date.now() >= this.busyUntil) this.resync("socket").catch(() => {});
          }
        }
        if (e.type === "documents" && e.event === "removed" && [this.A, this.B, this.M].some((d) => d.host === host && d.id === e.id)) {
          this.lost(`document ${e.id} was closed`);
        }
        try { this.watch.handle(host, e); } catch (err) { this.note(`watch: message not read (${err.message})`); }
      };
      ws.onclose = () => {
        clearInterval(ping);
        this.watch.down(host);
        if (this.stopped) return;
        // mimoLive gone? check now and once more 1 s later; otherwise reconnect as before
        const probe = async (n) => { if (!(await this.healthy()) && n < 2 && !this.stopped) setTimeout(() => probe(n + 1), 1000); };
        setTimeout(() => probe(1), 1000);
        setTimeout(open, 2000);
      };
      ws.onerror = () => {};
    };
    open();
  }
}

// ---------------------------------------------------------------- doctor
// One list of checks behind `node takectl.mjs doctor`, the /doctor page and the operator page's
// status strip. Each check: { id, ok, label, fix }; fix is one sentence, present only when it fails.
// It reads mimoLive afresh every time and needs no running controller, so it can say why takectl
// cannot start.

async function doctorChecks() {
  const out = [];
  const add = (id, ok, label, fix) => out.push({ id, ok: !!ok, label, fix: ok ? null : fix });
  if (!CFG) {
    add("config", false, "takectl is set up", "Open /setup at this address and choose the three documents.");
    return out;
  }
  const roles = [["A", CFG.a], ["B", CFG.b], ["MASTER", CFG.master]];
  const listed = {};
  for (const host of [...new Set(roles.map(([, c]) => c.host))]) {
    try { listed[host] = (await api(host).get("/documents")).data; } catch { listed[host] = null; }
    add(`reach-${host}`, listed[host], `mimoLive answers at ${host}`,
      "Start mimoLive on that Mac and turn on Settings → Remote Control → Allow Remote Control Access.");
  }
  const docs = {};
  for (const [role, c] of roles) {
    if (!listed[c.host]) continue;
    const d = findDocByName(listed[c.host], c.documentName);
    add(`doc-${role}`, d, `${role} document "${c.documentName}" is open`,
      `Open "${c.documentName}" in mimoLive, or run setup again if it has another name now.`);
    if (!d) continue;
    const a = api(c.host);
    docs[role] = { a, id: d.id, name: attr(d).name, live: attr(d)["live-state"], layers: (await a.get(`/documents/${d.id}/layers`)).data };
    add(`live-${role}`, docs[role].live === "live", `${role} show is running`, `Press Start Show in "${docs[role].name}".`);
  }
  for (const role of ["A", "B"]) {
    const d = docs[role];
    if (!d) continue;
    const ndi = (await d.a.get(`/documents/${d.id}/output-destinations`)).data.find((o) => attr(o)["output-destination-type"] === NDI_OUT);
    add(`ndi-${role}`, ndi && attr(ndi)["live-state"] === "live", `${role} sends NDI`,
      ndi ? `Start the NDI output in "${d.name}" (tick Start with show so it starts with the show).`
          : `Add an NDI output to "${d.name}", video only, with Start with show ticked.`);
    const tallyName = CFG.tallyLayerName || "TALLY";
    add(`tally-${role}`, d.layers.some((l) => lname(l).toLowerCase() === tallyName.toLowerCase()), `${role} has a "${tallyName}" layer`,
      `Add a layer named exactly "${tallyName}" at the top of "${d.name}" (a red bar; takectl switches it).`);
    add(`counter-${role}`, !d.layers.some((l) => lname(l).toLowerCase() === COUNTER_LAYER.toLowerCase() && attr(l)["live-state"] === "live"),
      `No live ${COUNTER_LAYER} layer in ${role}`,
      `${role} has a live "${COUNTER_LAYER}" layer (bench stopwatch) — it would go to air; switch it off or delete it in "${d.name}"`);
  }
  const m = docs.MASTER;
  if (m) {
    const vs = findSwitcherLayer(m.layers, CFG.switcherLayerName);
    add("switcher", vs, "MASTER has a Video Switcher layer",
      `Add a Video Switcher layer to "${m.name}" named "${CFG.switcherLayerName}", or run setup again.`);
    if (vs) {
      const full = attr((await m.a.get(`/documents/${m.id}/layers/${vs.id}`)).data);
      const iv = full["input-values"] || {}, ov = full["output-values"] || {};
      const sources = (await m.a.get(`/documents/${m.id}/sources`)).data;
      const slots = {};
      for (const [k, want] of [["A", CFG.master.sourceNameA], ["B", CFG.master.sourceNameB]]) {
        const src = sources.find((x) => attr(x).name?.toLowerCase().includes(String(want).toLowerCase()));
        add(`src-${k}`, src, `MASTER has the source "${want}"`,
          `Add a Camera source in "${m.name}" that receives ${k}'s NDI, named "${want}", or run setup again.`);
        if (!src) continue;
        if (attr(src)["video-device-connected"] !== undefined)
          add(`ndilink-${k}`, attr(src)["video-device-connected"] === true, `MASTER receives ${k}'s NDI ("${want}")`,
            `"${want}" in "${m.name}" is not receiving ${k}'s NDI: check that ${k} sends NDI on this network (on 7.0b3, renaming its NDI output away and back restarts a sender that stopped).`);
        slots[k] = CFG.master[`slot${k}`] ?? slotOfSource(iv, src);
        add(`slot-${k}`, slots[k], `"${want}" is in a switcher slot`, `Choose "${want}" as one of the Video Switcher's sources in "${m.name}".`);
      }
      const safeName = CFG.master.sourceNameSafe;
      if (safeName) {
        const src = sources.find((x) => attr(x).name === safeName) ?? sources.find((x) => attr(x).name?.toLowerCase().includes(String(safeName).toLowerCase()));
        add("src-SAFE", src, `MASTER has the safe source "${safeName}"`,
          `Add a source named "${safeName}" to "${m.name}" (a wide camera wired straight into MASTER, or a holding slide), or choose another in setup.`);
        if (src) {
          const sl = CFG.master.slotSafe ?? slotOfSource(iv, src);
          const own = sl && ![slots.A, slots.B].map(String).includes(String(sl));
          add("slot-SAFE", own, `"${safeName}" is in a switcher slot of its own`,
            `Put "${safeName}" in a free slot of the Video Switcher in "${m.name}" (slot 3 on the bench): PANIC cuts to that slot.`);
          if (own) add("signal-SAFE", scanSignals(iv).cut[sl], `The switcher has a cut signal for the safe source's slot ${sl}`,
            "This mimoLive names the switcher's signals differently: right-click its Cut 3 button, copy the URL and report it (README, Run).");
        }
      }
      if (slots.A && slots.B) {
        const sig = scanSignals(iv);
        add("signals", (sig.cut[slots.A] || sig.dis[slots.A]) && (sig.cut[slots.B] || sig.dis[slots.B]),
          "The switcher has cut and dissolve signals for both slots",
          "This mimoLive names the switcher's signals differently: right-click its Cut 1 button, copy the URL and report it (README, Run).");
        add("liveslot", LIVE_SLOT_KEY in iv, "The switcher reports its live slot",
          `This mimoLive lacks ${LIVE_SLOT_KEY}, so takectl runs on source tally instead (weaker: CHANGES item 9); update mimoLive.`);
        add("slotcodes", slotCodeKey(slots.A) in ov && slotCodeKey(slots.B) in ov, "The switcher reports per-slot tally codes",
          `This mimoLive lacks ${slotCodeKey(slots.A)} / ${slotCodeKey(slots.B)}, so takectl runs on source tally instead; update mimoLive.`);
      }
    }
  }
  return out;
}

// Visible-only notes about the setup (not failures): shown on /doctor and by `takectl doctor`.
function doctorWarnings() {
  if (!CFG || CFG.master?.sourceNameSafe) return [];
  return ["No safe source: PANIC cuts to document A, whatever it holds. Choose one in setup: a wide camera wired straight into MASTER, or a holding slide (never a test pattern on air)."];
}

// ---------------------------------------------------------------- app: setup, starting, running

const app = { mode: CFG ? "starting" : "setup", sw: null, panicSw: null, startError: null, doctor: null, gen: 0 };
const examplePort = () => { try { return JSON.parse(readFileSync(examplePath, "utf8")).port; } catch { return null; } };
const PORT = CFG?.port ?? examplePort() ?? 8991;

function doctorSummary() {
  const c = app.doctor?.checks;
  if (!c) return null;
  const failing = c.filter((x) => !x.ok);
  return { ok: failing.length === 0, total: c.length, failing: failing.map((x) => x.label), at: new Date(app.doctor.at).toISOString() };
}
async function refreshDoctor() {
  try { app.doctor = { at: Date.now(), checks: await doctorChecks() }; } catch (e) { log(`doctor run failed: ${e.message}`); }
}
// With a config, start; if mimoLive or a document is not there yet, keep the pages up and try
// again every 3 s (the reason is on /doctor) instead of exiting.
async function boot() {
  if (!CFG) {
    app.mode = "setup";
    log(`no config at ${cfgPath}: setup mode. Open http://localhost:${PORT}/setup`);
    return;
  }
  app.mode = "starting";
  const gen = ++app.gen; // a later boot (or Start Over) ends this loop
  while (CFG && gen === app.gen) {
    const sw = new Switcher();
    try {
      await sw.start();
      if (gen !== app.gen) { sw.stop(); return; }
      sw.onLost = (reason) => {
        if (app.sw !== sw) return;
        log(`lost mimoLive: ${reason}; back to not-ready, retrying every 3 s`);
        app.sw = null; app.mode = "starting"; app.startError = reason;
        refreshDoctor();
        boot();
      };
      app.sw = sw; app.panicSw = null; app.mode = "running"; app.startError = null;
      log("running");
      refreshDoctor(); // the summary on the operator page must not lag the state change
      return;
    } catch (e) {
      sw.stop();
      if (e.message !== app.startError) log(`not ready yet: ${e.message} (retrying every 3 s; open /doctor)`);
      app.startError = e.message;
      // Ruling 2026-11-11: PANIC must not be disarmed when A or B is missing. If MASTER and its switcher
      // are there, keep a MASTER-only controller for /panic alone.
      const part = new Switcher();
      try { await part.M.discover(); app.panicSw = part; } catch { app.panicSw = null; }
      await sleep(3000);
    }
  }
}

// ---------------------------------------------------------------- /setup

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
// Suggestions are only pre-selections: the user picks in the dropdowns.
function suggestFor(sources, layers, aName, bName, aSender, bSender) {
  const base = (n) => String(n || "").replace(/\.tvshow$/i, "").toLowerCase();
  const pick = (docName, sender) =>
    (sender && sources.find((s) => s.device?.includes(`(${sender})`))) ||
    (docName && sources.find((s) => s.name.toLowerCase().includes(base(docName))));
  const switchers = layers.filter((l) => l.switcher);
  return {
    sourceNameA: pick(aName, aSender)?.name ?? null,
    sourceNameB: pick(bName, bSender)?.name ?? null,
    switcherLayerName: (switchers.find((l) => l.name === "AB Switcher") ?? (switchers.length === 1 ? switchers[0] : null))?.name ?? null,
  };
}
async function setupRoute(req, res, u, json) {
  const q = (k) => u.searchParams.get(k);
  if (u.pathname === "/setup/info") {
    return json(res, 200, { mode: app.mode, configured: !!CFG, local: isLoopback(req), configFile: cfgPath.split("/").pop(), startError: app.startError,
      config: CFG ? { a: CFG.a, b: CFG.b, master: CFG.master, switcherLayerName: CFG.switcherLayerName } : null, defaultHost: "http://localhost:8989" });
  }
  if (u.pathname === "/setup/documents") {
    try {
      const docs = (await api(q("host")).get("/documents")).data;
      return json(res, 200, { ok: true, documents: docs.map((d) => ({ id: d.id, name: attr(d).name, live: attr(d)["live-state"] })) });
    } catch (e) {
      return json(res, 200, { ok: false, error: `mimoLive does not answer at ${q("host")}: ${e.message}` });
    }
  }
  if (u.pathname === "/setup/master") {
    try {
      const a = api(q("host")), id = q("id");
      // mimoLive's own hidden helper sources ("Placeholder A"…) are left out of the lists.
      const rawSources = (await a.get(`/documents/${id}/sources`)).data.filter((s) => !attr(s)["is-hidden"]);
      const sources = rawSources.map((s) => ({ name: attr(s).name, device: attr(s)["video-device-id"] ?? null, slot: null }));
      const rawLayers = (await a.get(`/documents/${id}/layers`)).data;
      const layers = rawLayers.map((l) => ({ name: lname(l), switcher: /videoswitcher/i.test(attr(l)["composition-id"] || "") }));
      // The NDI sender a document advertises is its NDI output's title with hyphens stripped (7.0b3).
      const sender = async (host, docId) => {
        if (!host || !docId) return null;
        const o = (await api(host).get(`/documents/${docId}/output-destinations`)).data.find((x) => attr(x)["output-destination-type"] === NDI_OUT);
        return o ? String(attr(o).title ?? "").replace(/-/g, "") : null;
      };
      const [as, bs] = await Promise.all([sender(q("aHost"), q("aId")).catch(() => null), sender(q("bHost"), q("bId")).catch(() => null)]);
      const suggest = suggestFor(sources, layers, q("aName"), q("bName"), as, bs);
      // The safe source: any source may be chosen; pre-selected is one in a switcher slot of its own
      // (one named "safe" first). On the bench that is "SAFE Test Pattern" in slot 3.
      suggest.sourceNameSafe = null;
      const swl = rawLayers.find((l) => lname(l) === suggest.switcherLayerName);
      if (swl) {
        const iv = attr((await a.get(`/documents/${id}/layers/${swl.id}`)).data)["input-values"] || {};
        rawSources.forEach((src, i) => { sources[i].slot = slotOfSource(iv, src); });
        const third = sources.filter((x) => x.slot && x.name !== suggest.sourceNameA && x.name !== suggest.sourceNameB);
        suggest.sourceNameSafe = (third.find((x) => /safe/i.test(x.name)) ?? (third.length === 1 ? third[0] : null))?.name ?? null;
      }
      return json(res, 200, { ok: true, sources, layers, suggest });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  // Ruling 2026-11-11: saving and starting over work only from the Mac running takectl.
  if ((u.pathname === "/setup/save" || u.pathname === "/setup/start-over") && req.method === "POST" && !isLoopback(req))
    return json(res, 403, { ok: false, error: "Set up from the Mac running takectl: saving and starting over only work there." });
  if (u.pathname === "/setup/start-over" && req.method === "POST") {
    if (!CFG) return json(res, 409, { ok: false, error: "takectl is not set up yet: there is nothing to start over." });
    // Refused while MASTER's show is running. If MASTER cannot be reached at all, starting over is allowed:
    // nothing of takectl's can be on air through it.
    try {
      const d = findDocByName((await api(CFG.master.host).get("/documents")).data, CFG.master.documentName);
      if (d && attr(d)["live-state"] === "live") return json(res, 409, { ok: false, error: `Stop the show in "${attr(d).name}" first: Start Over is refused while MASTER is on air.` });
    } catch {}
    // The backup is named in this Mac's local time (ruling 2026-11-11), as the operator reads a clock.
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const backup = cfgPath.replace(/\.json$/, "") + `.backup-${stamp}.json`;
    renameSync(cfgPath, backup);
    try { for (const f of readdirSync(thumbsDir())) if (THUMB_FILE_RE.test(f) || f === "index.json") unlinkSync(join(thumbsDir(), f)); } catch {}
    app.gen++; // ends a retry loop that may be running
    app.sw?.stop(); app.panicSw = null; app.sw = null;
    CFG = null; app.mode = "setup"; app.startError = null;
    log(`start over: ${cfgPath} renamed to ${backup}; setup mode`);
    refreshDoctor();
    return json(res, 200, { ok: true, backup: backup.split("/").pop() });
  }
  if (u.pathname === "/setup/save" && req.method === "POST") {
    if (CFG) return json(res, 409, { ok: false, error: `takectl is already set up (${cfgPath.split("/").pop()}). To start over, stop takectl, delete that file and start it again.` });
    let b;
    try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: "bad request" }); }
    const need = [b?.a?.host, b?.a?.documentName, b?.b?.host, b?.b?.documentName, b?.master?.host, b?.master?.documentName, b?.master?.sourceNameA, b?.master?.sourceNameB, b?.switcherLayerName];
    if (need.some((x) => !x)) return json(res, 400, { ok: false, error: "Choose all three documents, both sources and the switcher layer." });
    const key = (x) => `${x.host}|${x.documentName}`;
    if (new Set([key(b.a), key(b.b), key(b.master)]).size !== 3) return json(res, 400, { ok: false, error: "A, B and MASTER must be three different documents." });
    if (b.master.sourceNameA === b.master.sourceNameB) return json(res, 400, { ok: false, error: "A and B need two different sources in MASTER." });
    const safe = b.master.sourceNameSafe || null;
    if (safe && [b.master.sourceNameA, b.master.sourceNameB].includes(safe)) return json(res, 400, { ok: false, error: "The safe source must be a third source, not A's or B's." });
    const example = JSON.parse(readFileSync(examplePath, "utf8"));
    const cfg = { ...example, a: { host: b.a.host, documentName: b.a.documentName }, b: { host: b.b.host, documentName: b.b.documentName },
      master: { ...example.master, host: b.master.host, documentName: b.master.documentName, sourceNameA: b.master.sourceNameA, sourceNameB: b.master.sourceNameB, slotA: null, slotB: null, sourceNameSafe: safe, slotSafe: null },
      switcherLayerName: b.switcherLayerName };
    // Refuse a choice takectl could never run on (documents, switcher, sources, slots); a show that
    // is not started yet is fine and shows on /doctor.
    CFG = cfg;
    const checks = await doctorChecks();
    const blocking = checks.filter((c) => !c.ok && /^(reach|doc|switcher|src|slot|signal-SAFE)-?/.test(c.id));
    if (blocking.length) {
      CFG = null;
      return json(res, 400, { ok: false, error: blocking.map((c) => `${c.label}: ${c.fix}`).join(" ") });
    }
    delete cfg._comment;
    writeFileSync(cfgPath, JSON.stringify({ _comment: example._comment, ...cfg }, null, 2) + "\n");
    log(`setup saved ${cfgPath}`);
    app.mode = "starting";
    refreshDoctor();
    boot();
    return json(res, 200, { ok: true, saved: cfgPath.split("/").pop() });
  }
  return json(res, 404, { ok: false, error: "unknown setup route" });
}

// ---------------------------------------------------------------- http api

function serve() {
  const json = (res, code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(obj, null, 2));
  };
  // Pages are self-contained files next to this one (inline CSS/JS, no CDN).
  const page = (res, file) => {
    const p = join(here, file);
    if (!existsSync(p)) return json(res, 404, { error: `${file} not found next to takectl.mjs (${here})` });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readFileSync(p));
  };
  const routes = (sw) => ({
    "/state": () => sw.state(),
    "/health": () => ({ ok: true, pgm: sw.pgm }),
    "/take": () => sw.transition("take"),
    "/cut": () => sw.transition("cut"),
    "/mirror": () => sw.mirror(),
    "/panic": () => sw.panic(),
    "/resync": async () => { await sw.resync("manual"); return sw.state(); },
    // Round 2
    "/push": () => sw.push(),
    "/safe/target": (u) => sw.setSafeTarget(u.searchParams.get("doc")),
    // The query form of /pvw/layer-set/<name>: any name, including "." and "..", which a URL path cannot carry.
    "/pvw/layer-set": (u) => (u.searchParams.has("name") ? sw.recallPvwLayerSet(u.searchParams.get("name")) : { ok: false, error: "name the look: /pvw/layer-set?name=…" }),
    "/undo": () => sw.undo(),
    "/stinger": (u) => sw.setStinger(u.searchParams.has("on") ? u.searchParams.get("on") !== "0" : !sw.stingerOn),
    "/transition": (u) => sw.setTransition(String(u.searchParams.get("mode") || "").toLowerCase()),
    "/rate": (u) => sw.setRate(u.searchParams.get("s")),
    "/ftb": (u) => sw.setFtb(u.searchParams.has("on") ? u.searchParams.get("on") !== "0" : null),
    "/steps": () => sw.state().steps,
    "/steps/add": async () => sw.stepsAdd(sw.pvw ? await sw.doc(sw.pvw).activeLayerSetName() : null),
    "/steps/clear": () => { sw.steps.list = []; return { ok: true, steps: [] }; },
    "/steps/record": (u) => { sw.steps.recording = u.searchParams.has("on") ? u.searchParams.get("on") !== "0" : !sw.steps.recording; return { ok: true, recording: sw.steps.recording }; },
    "/steps/push": (u) => sw.stepsPush(u.searchParams.get("pace")),
    "/steps/save": (u) => sw.stepsSave(u.searchParams.get("name")),
    "/steps/load": (u) => sw.stepsLoad(u.searchParams.get("name")),
    "/steps/delete": (u) => sw.stepsDelete(u.searchParams.get("name")),
    "/history": () => ({ ...sw.historyView(), log: sw.history.slice(-50) }),
    "/history/reset": (u) => (u.searchParams.get("confirm") === "1" ? sw.historyReset() : { ok: false, error: "add ?confirm=1 (the page asks first)" }),
    "/hooks": () => sw.hooksView(),
    "/hooks/rehearse": () => sw.rehearseHooks(),
    // Round 4: WATCH PGM (runtime only) and accepting a change made in mimoLive. Neither is a commit.
    "/watch": (u) => (u.searchParams.has("on") ? sw.watch.setOn(u.searchParams.get("on") !== "0") : sw.watch.view()),
    "/watch/dismiss": () => sw.watch.dismiss(),
  });
  createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const pathname = u.pathname;
    try {
      if (pathname === "/" || pathname === "/index.html") {
        if (app.mode === "setup") { res.writeHead(302, { Location: "/setup" }); return res.end(); }
        return page(res, "operator.html");
      }
      if (pathname === "/setup") return page(res, "setup.html");
      if (pathname.startsWith("/setup/")) return await setupRoute(req, res, u, json);
      if (pathname === "/doctor") return page(res, "doctor.html");
      if (pathname === "/doctor.json") {
        await refreshDoctor();
        return json(res, 200, { mode: app.mode, startError: app.startError, ...doctorSummary(), checks: app.doctor?.checks ?? [], warnings: [...doctorWarnings(), ...(app.sw?.warnings() ?? [])] });
      }
      const path = pathname.replace(/\/$/, "") || "/state";
      const sw = app.sw;
      if (!sw) {
        if (path === "/state" || path === "/health") return json(res, 200, { ready: false, mode: app.mode, startError: app.startError, doctor: doctorSummary(), panicArmed: !!app.panicSw });
        if (path === "/panic") {
          if (app.panicSw) return json(res, 200, { ...(await app.panicSw.panic()), notReady: app.startError });
          return json(res, 503, { ok: false, error: `cannot panic: MASTER is not reachable (${app.startError ?? "not set up"})` });
        }
        return json(res, 503, { ok: false, error: app.mode === "setup" ? "not set up yet: open /setup" : `not ready: ${app.startError ?? "starting"} (open /doctor)` });
      }
      // POST /hooks writes MASTER's hooks datastore: loopback only, like /setup/save.
      if (path === "/hooks" && req.method === "POST") {
        if (!isLoopback(req)) return json(res, 403, { ok: false, error: "hooks are saved from the Mac running takectl" });
        let body;
        try { body = JSON.parse((await readBody(req)) || "null"); } catch (e) { return json(res, 400, { ok: false, error: `not JSON: ${e.message}` }); }
        const r = await sw.saveHooks(body);
        return json(res, r.ok ? 200 : 400, r);
      }
      // /thumb?name=<look> (or /thumb/<look>): looked up in thumbs/index.json; the name never becomes a
      // path. The query form also reaches names a URL path cannot carry ("." and "..").
      const th = pathname === "/thumb" ? [null, null] : pathname.match(/^\/thumb\/(.+)$/);
      if (th) {
        let name; try { name = th[1] == null ? u.searchParams.get("name") ?? "" : decodeURIComponent(th[1]); } catch { return json(res, 400, { ok: false, error: "bad name" }); }
        const e = Object.prototype.hasOwnProperty.call(sw.thumbs, name) ? sw.thumbs[name] : null;
        if (!e || !THUMB_FILE_RE.test(e.file) || !existsSync(join(thumbsDir(), e.file))) return json(res, 404, { ok: false, error: "no thumbnail" });
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
        return res.end(readFileSync(join(thumbsDir(), e.file)));
      }
      const dk = path === "/dsk" ? [null, null] : path.match(/^\/dsk\/(.+)$/);
      if (dk) { let label; try { label = dk[1] == null ? u.searchParams.get("label") ?? "" : decodeURIComponent(dk[1]); } catch { return json(res, 400, { ok: false, error: "bad label" }); } return json(res, 200, await sw.setDsk(label, u.searchParams.has("on") ? u.searchParams.get("on") !== "0" : null)); }
      const lset = path.match(/^\/pvw\/layer-set\/(.+)$/);
      const fn = lset ? () => sw.recallPvwLayerSet(decodeURIComponent(lset[1])) : routes(sw)[path] ? () => routes(sw)[path](u) : null;
      if (!fn) return json(res, 404, { error: "unknown route", routes: ["/", "/setup", "/doctor", ...Object.keys(routes(sw)), "/pvw/layer-set/<name>"] });
      json(res, 200, await fn());
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  }).listen(PORT, () => log(`takectl listening on http://0.0.0.0:${PORT}  (GET / operator page, /setup, /doctor; /state /take /cut /push /undo /mirror /panic /resync /pvw/layer-set/<name>, /steps/*, /history, /hooks, /stinger)`));
}

// ---------------------------------------------------------------- main

const cmd = process.argv[2];
if (cmd === "doctor") {
  // One-shot diagnostics, no server: the controller's own view (when it can start), then the checklist.
  if (!CFG) {
    console.log(`No config at ${cfgPath}. Start takectl (or double-click start.command) and open /setup.`);
    process.exit(2);
  }
  const sw = new Switcher();
  try {
    await Promise.all([sw.A.discover(), sw.B.discover(), sw.M.discover()]);
    await sw.resync("doctor");
    // The witness needs two reads one settle period apart before it can warn; take the second one.
    if (sw.disagreeSince != null) {
      await sleep((CFG.settleMs ?? 250) + 50);
      await sw.resync("doctor");
    }
    console.log(JSON.stringify({ ...sw.state(), signals: sw.M.signals }, null, 2));
    if (sw.switcherRaw?.inFlight) console.log(`\nSWITCHER: mid-transition on every read (both slots at ${SLOT_EFFECT}); no PGM decided — run doctor again`);
    if (sw.warning) console.log(`\nWITNESS (not a preflight problem; takectl follows the switcher): ${sw.warning}`);
  } catch (e) {
    console.log(`takectl could not start: ${e.message}`);
  }
  const checks = await doctorChecks();
  console.log("\nCHECKS:");
  for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.label}${c.ok ? "" : `\n      → ${c.fix}`}`);
  const failing = checks.filter((c) => !c.ok);
  for (const w of doctorWarnings()) console.log(`\nWARNING (not a failure): ${w}`);
  console.log(failing.length ? `\nPROBLEMS:\n - ${failing.map((c) => `${c.label}: ${c.fix}`).join("\n - ")}` : "\nAll checks pass.");
  process.exit(failing.length ? 1 : 0);
} else {
  serve();
  refreshDoctor();
  setInterval(refreshDoctor, CFG?.pollMs ?? 5000);
  boot();
}
