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
// Zero dependencies. Node 22+ (global fetch + WebSocket). Run: node takectl.mjs
// Config: takectl.config.json next to this file (see README).

import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = process.env.TAKECTL_CONFIG || join(here, "takectl.config.json");
if (!existsSync(cfgPath)) {
  console.error(`No config at ${cfgPath}. Copy takectl.config.example.json → takectl.config.json`);
  process.exit(2);
}
const CFG = JSON.parse(readFileSync(cfgPath, "utf8"));

// ---------------------------------------------------------------- helpers

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(host) {
  const base = host.replace(/\/$/, "") + "/api/v1";
  const headers = { "Content-Type": "application/vnd.api+json" };
  if (CFG.apiPasswordSha256) headers["X-MimoLive-Password-SHA256"] = CFG.apiPasswordSha256;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(CFG.httpTimeoutMs ?? 3000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`${method} ${path} → ${res.status} ${t.slice(0, 200)}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (res.status === 204) return null;
    return ct.includes("json") ? res.json() : res.text();
  };
  return {
    base,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    put: (p, b) => call("PUT", p, b),
    patch: (p, b) => call("PATCH", p, b),
    raw: call,
  };
}

const attr = (obj) => obj?.attributes ?? {};
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
    const sets = (await this.api.get(`/documents/${this.id}/layer-sets`)).data;
    return sets.find((s) => attr(s).active)?.attributes?.name ?? null;
  }
  async recallLayerSetByName(name) {
    const sets = (await this.api.get(`/documents/${this.id}/layer-sets`)).data;
    const s = sets.find((x) => attr(x).name === name);
    if (!s) throw new Error(`[${this.role}] no layer set named "${name}"`);
    await this.api.get(`/documents/${this.id}/layer-sets/${s.id}/recall`);
  }
}

class Master extends Doc {
  async discover() {
    await super.discover();
    // Video Switcher layer
    const vs =
      this.layers.find((l) => lname(l).toLowerCase() === (CFG.switcherLayerName || "").toLowerCase()) ||
      this.layers.find((l) => /videoswitcher/i.test(attr(l)["composition-id"] || "")) ||
      this.layers.find((l) => /video switcher/i.test(lname(l)));
    if (!vs) throw new Error(`[MASTER] no Video Switcher layer found`);
    this.switcherId = vs.id;
    this.switcherName = lname(vs);
    const iv = attr(vs)["input-values"] || {};
    // Signal keys look like tvGroup_Control__Cut_1_TypeSignal / tvGroup_Control__Dis_2_TypeSignal
    this.signals = { cut: {}, dis: {} };
    for (const k of Object.keys(iv)) {
      if (!k.endsWith("_TypeSignal")) continue;
      let m;
      if ((m = k.match(/cut[^0-9]*([1-9])/i))) this.signals.cut[m[1]] = k;
      else if ((m = k.match(/dis(?:solve)?[^0-9]*([1-9])/i))) this.signals.dis[m[1]] = k;
    }
    // Which switcher slot holds which NDI source — by source name in MASTER.
    const sources = (await this.api.get(`/documents/${this.id}/sources`)).data;
    const byName = (needle) => sources.find((s) => attr(s).name?.toLowerCase().includes(needle.toLowerCase()));
    this.srcA = byName(CFG.master.sourceNameA);
    this.srcB = byName(CFG.master.sourceNameB);
    if (!this.srcA || !this.srcB) throw new Error(`[MASTER] NDI sources "${CFG.master.sourceNameA}" / "${CFG.master.sourceNameB}" not found`);
    // Slot detection: scan input-values for a value equal to a source id (or its uuid tail)
    // [drift 3] 7.0b3 names the slot inputs by LETTER: tvIn_VideoSourceAImage = slot 1 …
    // tvIn_VideoSourceHImage = slot 8 (the ninth, "Below", has no image input). The digit
    // rule below never matched them, so detection silently fell back to the "1"/"2" defaults.
    const slotOf = (src) => {
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
    };
    this.slotA = CFG.master.slotA ?? slotOf(this.srcA) ?? "1";
    this.slotB = CFG.master.slotB ?? slotOf(this.srcB) ?? "2";
    return this;
  }
  signalUrl(kind, slot) {
    const key = this.signals[kind][slot];
    if (!key) throw new Error(`[MASTER] no ${kind} signal for slot ${slot}; found: ${JSON.stringify(this.signals)}`);
    return `/documents/${this.id}/layers/${this.switcherId}/signals/${key}`;
  }
  async tally() {
    const [a, b] = await Promise.all([
      this.api.get(`/documents/${this.id}/sources/${this.srcA.id}`),
      this.api.get(`/documents/${this.id}/sources/${this.srcB.id}`),
    ]);
    return { A: attr(a.data)["tally-state"], B: attr(b.data)["tally-state"] };
  }
  // Ground truth for PGM: the switcher's own live slot (input-values currentLiveSource, 1-based) and
  // its per-slot tally codes, read from one response. The slot flips at the END of a dissolve; for
  // the length of it both slots read 30. The switcher sends no WebSocket event of its own when it
  // switches (probed 2026-11-09), so this is read on wake-ups, never pushed.
  async switcherState() {
    const l = await this.api.get(`/documents/${this.id}/layers/${this.switcherId}`);
    const iv = attr(l.data)["input-values"] || {};
    const ov = attr(l.data)["output-values"] || {};
    const slot = iv.tvGroup_Hidden_Inputs__currentLiveSource;
    const code = (s) => ov[`tvOut_tvIn_VideoSource${String.fromCharCode(64 + Number(s))}ImageTallyState`];
    const codes = { A: code(this.slotA), B: code(this.slotB) };
    const pgm = String(slot) === String(this.slotA) ? "A" : String(slot) === String(this.slotB) ? "B" : null;
    return { slot, pgm, codes, inFlight: codes.A === SLOT_EFFECT && codes.B === SLOT_EFFECT };
  }
  async readState() {
    try {
      const r = await fetch(`${this.api.base}/documents/${this.id}/datastores/${CFG.stateStoreId || "abswitch-state"}`);
      if (r.ok) return await r.json();
    } catch {}
    return null;
  }
  async writeState(state) {
    await fetch(`${this.api.base}/documents/${this.id}/datastores/${CFG.stateStoreId || "abswitch-state"}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    }).catch((e) => log(`state persist failed: ${e.message}`));
  }
}

// ---------------------------------------------------------------- controller

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
  }

  // Every switcher read goes through here, so the stall indicator sees all of them.
  async readSwitcher() {
    const s = await this.M.switcherState();
    this.observe(s);
    return s;
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
    const names = async (d) => (await d.api.get(`/documents/${d.id}/layer-sets`)).data.map((s) => attr(s).name);
    const [a, b] = await Promise.all([names(this.A), names(this.B)]);
    this.layerSets = a.filter((n) => b.includes(n));
  }
  get pvw() {
    return this.pgm === "A" ? "B" : this.pgm === "B" ? "A" : null;
  }
  doc(role) {
    return role === "A" ? this.A : this.B;
  }
  slot(role) {
    return role === "A" ? this.M.slotA : this.M.slotB;
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
    this.connectSocket();
    await this.refreshLayerSets().catch((e) => this.note(`layer sets not read: ${e.message}`));
    setInterval(() => {
      this.resync("poll").catch(() => {});
      this.refreshLayerSets().catch(() => {});
    }, CFG.pollMs ?? 5000);
    this.pushCompanion().catch(() => {});
  }

  // Truth = the Video Switcher's live slot. Wake = WebSocket "sources changed" for the two NDI
  // sources, and the poll: they only cause this read, they are never facts. Witness = the two
  // sources' tally-state, read alongside and compared, never acted on (see witness()).
  async resync(reason) {
    if (Date.now() < this.busyUntil && !RESYNC_WHILE_BUSY.has(reason)) return;
    let s, t;
    for (let i = 0; ; i++) {
      [s, t] = await Promise.all([this.readSwitcher(), this.M.tally()]);
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
    if (pgm !== this.pgm || this.settlePending) {
      const prev = this.pgm;
      this.pgm = pgm;
      if (prev !== null && prev !== pgm) this.note(`PGM changed outside takectl (${reason}): ${prev} → ${pgm}; re-syncing tally`);
      if (this.settlePending) this.note(`transition settled on a later read (${reason}): PGM=${pgm}`);
      this.settlePending = false;
      await this.applyRoles();
    }
  }

  // Source tally is a witness. Agreement: the switcher's PGM source reads "program" and the other one
  // does not ("effect" on either is a transition and counts as agreement). A disagreement that
  // outlasts one settle period is logged once per episode, with the switcher's per-slot codes from
  // the same read, and shown as /state.warning. It never changes roles or TALLY.
  witness(s, t) {
    const settle = CFG.settleMs ?? 250;
    const other = s.pgm === "A" ? "B" : "A";
    const agrees = !s.pgm || t.A === "effect" || t.B === "effect" || (t[s.pgm] === "program" && t[other] !== "program");
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
      this.warning = `source tally disagrees with switcher (A=${t.A}, B=${t.B}, slot=${s.slot})`;
      this.note(`WARNING ${this.warning}; switcher per-slot codes in the same read A=${s.codes.A} B=${s.codes.B} (40 program, 30 effect, 10 in-use); disagreeing since ${new Date(this.disagreeSince).toISOString()}`);
    }
  }

  // Immediate: PGM's TALLY on and PVW's off together. Startup, resync and panic use this.
  async applyRoles() {
    await Promise.all([this.applyIncoming(), this.releaseOutgoing()]);
  }
  // Transition, first half: the incoming (new PGM) TALLY lights and the roles are persisted at once.
  async applyIncoming() {
    await this.doc(this.pgm).setTally(true);
    await this.M.writeState({ pgm: this.pgm, pvw: this.pvw, ts: Date.now(), by: "takectl" });
    await this.pushCompanion();
  }
  // Transition, second half: the outgoing TALLY goes off only once verify() has confirmed the new
  // PGM, so both are lit through the dissolve and the document still on air never reads dark.
  async releaseOutgoing() {
    await this.doc(this.pvw).setTally(false);
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
    // Both documents, not just the target: the outgoing one stays on air through the dissolve.
    for (const role of ["A", "B"]) {
      const doc = this.doc(role);
      const layers = (await doc.api.get(`/documents/${doc.id}/layers`)).data;
      if (layers.some((l) => lname(l).toLowerCase() === COUNTER_LAYER.toLowerCase() && attr(l)["live-state"] === "live"))
        problems.push(`${role} has a live "${COUNTER_LAYER}" layer (bench stopwatch) — it would go to air; switch it off or delete it in "${doc.name}"`);
    }
    return problems;
  }

  async transition(kind) {
    const now = Date.now();
    if (now < this.busyUntil) return { ok: false, error: `busy: transition in progress (${this.busyUntil - now} ms left)` };
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
    if (CFG.preflight !== false) {
      const problems = await this.preflight(target);
      if (problems.length) {
        this.setError(problems.join("; "));
        this.note(`REFUSED ${kind.toUpperCase()} → ${target}: ${this.lastError}`);
        return { ok: false, error: this.lastError };
      }
    }
    if (this.takeSeq !== seq0) return yieldToPanic("during preflight; signal not sent");
    const slot = this.slot(target);
    const useDis = kind === "take" && this.M.signals.dis[slot];
    const url = this.M.signalUrl(useDis ? "dis" : "cut", slot);
    const dur = useDis ? (CFG.dissolveMs ?? 500) : 0;
    this.busyUntil = now + dur + (CFG.settleMs ?? 250);
    this.takeEndsAt = this.busyUntil;
    this.note(`${kind.toUpperCase()} → ${target} (slot ${slot}, ${useDis ? "dissolve" : "cut"})`);
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
    this.pgm = target;
    this.lastTake = { kind, target, ts: now, transition: useDis ? "dissolve" : "cut", ms: dur };
    this.setError(null); // ruling 6: a successful TAKE/CUT clears the last error (verify may set a new one)
    const seq = ++this.takeSeq;
    await this.applyIncoming(); // outgoing TALLY stays lit until verify() confirms
    this.verifyTimer = setTimeout(() => this.verify(target, seq).catch(() => {}), dur + (CFG.settleMs ?? 250));
    return { ok: true, pgm: this.pgm, pvw: this.pvw, transition: useDis ? "dissolve" : "cut", ms: dur };
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

  async verify(expected, seq) {
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
      await this.resync("verify");
      await this.applyRoles(); // both TALLYs are lit at this point; settle them to the resynced PGM
    } else {
      this.setError(null);
      this.witness(s, t);
      await this.releaseOutgoing();
    }
  }

  // Copy the PGM doc's active Layer Set to the PVW doc (same name in both documents).
  async mirror() {
    // Ruling 13: mid-transition, "which document is PVW" is the question takectl has decided not to
    // answer, so mirroring into it would be a guess. Refused while busy or in flight.
    if (Date.now() < this.busyUntil) return { ok: false, error: "busy: a transition is in progress; MIRROR would have to guess which document is PVW" };
    const sw = await this.readSwitcher();
    if (sw.inFlight) return { ok: false, error: "busy: the switcher is mid-transition; MIRROR would have to guess which document is PVW" };
    const name = await this.doc(this.pgm).activeLayerSetName();
    if (!name) return { ok: false, error: `no active layer set in ${this.pgm}` };
    await this.doc(this.pvw).recallLayerSetByName(name);
    this.note(`MIRROR: ${this.pgm} "${name}" → ${this.pvw}`);
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
    const s = await this.readSwitcher();
    if (s.inFlight) return refuse("the switcher is mid-transition; wait for it to land");
    if (s.pgm === this.pvw) return refuse(`${this.pvw} is on air (switcher slot ${s.slot}); roles are being resynced`);
    const pvw = this.pvw;
    const doc = this.doc(pvw);
    const sets = (await doc.api.get(`/documents/${doc.id}/layer-sets`)).data;
    const set = sets.find((x) => attr(x).name === name);
    if (!set) return refuse(`no Layer Set named "${name}" in ${pvw} ("${doc.name}")`);
    await doc.api.get(`/documents/${doc.id}/layer-sets/${set.id}/recall`);
    this.note(`PVW LAYER SET: "${name}" recalled in ${pvw}`);
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
    const seq = ++this.takeSeq; // a TAKE in preflight or awaiting its signal yields; a pending verify() stands down
    clearTimeout(this.verifyTimer); // cancel it outright; the seq guard covers one already running
    const mine = () => seq === this.takeSeq;
    const superseded = { ok: true, pgm: "A", superseded: true }; // a later /panic took over
    const settle = CFG.settleMs ?? 250;
    const hint = this.takeEndsAt;
    this.busyUntil = Number.MAX_SAFE_INTEGER; // TAKE/CUT refused and wake-ups stand aside until panic reports
    this.settlePending = false;
    const t0 = Date.now();
    const onA = (s) => s.pgm === "A" && s.codes.A === SLOT_PROGRAM && s.codes.B !== SLOT_EFFECT;
    const cutA = () => this.M.api.get(this.M.signalUrl("cut", this.slot("A")));
    try {
      this.pgm = "A";
      let s = null;
      let round = 0;
      while (round < 3) {
        round++;
        await cutA();
        if (round === 1) {
          this.note("PANIC: cut to A");
          await this.applyRoles();
        }
        await sleep(settle);
        if (!mine()) return superseded;
        s = await this.readSwitcher();
        if (onA(s) || round === 3) break;
        const wait = s.inFlight ? Math.max(settle, hint + settle - Date.now()) : 0;
        this.note(`PANIC: round ${round} read slot ${s.slot}, codes ${s.codes.A}/${s.codes.B}${s.inFlight ? " (in flight: the cut was overridden)" : ""}; cutting to A again in ${wait} ms`);
        await sleep(wait);
        if (!mine()) return superseded;
      }
      this.switcherRaw = s;
      const ms = Date.now() - t0;
      if (onA(s)) {
        this.setError(null);
        this.note(`PANIC: A confirmed on air (slot ${s.slot}, codes ${s.codes.A}/${s.codes.B}) after ${round} round(s), ${ms} ms`);
        return { ok: true, pgm: "A", rounds: round, ms };
      }
      this.setError(`panic: A not confirmed after ${round} rounds (switcher slot ${s.slot}, codes A=${s.codes.A} B=${s.codes.B})`);
      this.note(this.lastError);
      await this.resync("panic"); // report the truth; an in-flight read decides nothing here either
      return { ok: false, error: this.lastError, pgm: this.pgm, rounds: round, ms };
    } finally {
      if (mine()) this.busyUntil = 0;
    }
  }

  state() {
    return {
      pgm: this.pgm,
      pvw: this.pvw,
      busy: Date.now() < this.busyUntil,
      switcher: this.switcherRaw ? { slot: this.switcherRaw.slot, codes: this.switcherRaw.codes, inFlight: this.switcherRaw.inFlight } : null,
      tally: this.tallyRaw ?? null,
      // Stall (in flight > STALL_MS) and witness (source tally disagrees) are both visible-only.
      warning: [this.stalled ? `transition stalled (${Date.now() - this.inFlightSince} ms)` : null, this.warning].filter(Boolean).join("; ") || null,
      lastTake: this.lastTake,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
      lastErrorAgeMs: this.lastErrorAt ? Date.now() - this.lastErrorAt : null, // takectl's clock, so the page needs none of its own
      layerSets: this.layerSets,
      docs: {
        A: { id: this.A.id, name: this.A.name, host: this.A.host, live: this.A.liveState, ndi: this.A.ndiOutLive, tallyLayer: !!this.A.tallyLayerId },
        B: { id: this.B.id, name: this.B.name, host: this.B.host, live: this.B.liveState, ndi: this.B.ndiOutLive, tallyLayer: !!this.B.tallyLayerId },
        MASTER: { id: this.M.id, name: this.M.name, host: this.M.host, switcher: this.M.switcherName, slotA: this.M.slotA, slotB: this.M.slotB },
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

  connectSocket() {
    if (typeof WebSocket === "undefined") {
      this.note("no global WebSocket in this Node; relying on polling");
      return;
    }
    const url = this.M.api.base.replace(/^http/, "ws") + "/socket";
    let ws;
    const open = () => {
      ws = new WebSocket(url);
      let ping;
      ws.onopen = () => {
        this.note(`websocket connected ${url}`);
        ping = setInterval(() => ws.send(JSON.stringify({ event: "ping" })), 5000);
      };
      ws.onmessage = (m) => {
        let e;
        try { e = JSON.parse(m.data); } catch { return; }
        if (e.event === "pong") return;
        if (e.type === "sources" && e.event === "changed" && e["document-id"] === this.M.id) {
          const id = e.id;
          if (id === this.M.srcA.id || id === this.M.srcB.id || this.M.srcA.id.endsWith(id) || this.M.srcB.id.endsWith(id)) {
            if (Date.now() >= this.busyUntil) this.resync("socket").catch(() => {});
          }
        }
        if (e.type === "documents" && e.event === "removed") {
          this.note(`document ${e.id} closed — re-discovery needed`);
        }
      };
      ws.onclose = () => { clearInterval(ping); setTimeout(open, 2000); };
      ws.onerror = () => {};
    };
    open();
  }
}

// ---------------------------------------------------------------- http api

function serve(sw) {
  const port = CFG.port ?? 8991;
  const json = (res, code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(obj, null, 2));
  };
  const routes = {
    "/state": () => sw.state(),
    "/health": () => ({ ok: true, pgm: sw.pgm }),
    "/take": () => sw.transition("take"),
    "/cut": () => sw.transition("cut"),
    "/mirror": () => sw.mirror(),
    "/panic": () => sw.panic(),
    "/resync": async () => { await sw.resync("manual"); return sw.state(); },
  };
  createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    // The operator page: operator.html next to this file, self-contained (inline CSS/JS, no CDN).
    if (pathname === "/" || pathname === "/index.html") {
      const page = join(here, "operator.html");
      if (!existsSync(page)) return json(res, 404, { error: `operator.html not found next to takectl.mjs (${here})` });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(readFileSync(page));
    }
    const path = pathname.replace(/\/$/, "") || "/state";
    const lset = path.match(/^\/pvw\/layer-set\/(.+)$/);
    const fn = lset ? () => sw.recallPvwLayerSet(decodeURIComponent(lset[1])) : routes[path];
    if (!fn) return json(res, 404, { error: "unknown route", routes: ["/", ...Object.keys(routes), "/pvw/layer-set/<name>"] });
    try {
      json(res, 200, await fn());
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  }).listen(port, () => log(`takectl listening on http://0.0.0.0:${port}  (GET / operator page; /state /take /cut /mirror /panic /resync /pvw/layer-set/<name>)`));
}

// ---------------------------------------------------------------- main

const sw = new Switcher();
const cmd = process.argv[2];
if (cmd === "doctor") {
  // One-shot diagnostics, no server.
  try {
    await Promise.all([sw.A.discover(), sw.B.discover(), sw.M.discover()]);
    await sw.resync("doctor");
    // The witness needs two reads one settle period apart before it can warn; take the second one.
    if (sw.disagreeSince != null) {
      await sleep((CFG.settleMs ?? 250) + 50);
      await sw.resync("doctor");
    }
    const s = sw.state();
    console.log(JSON.stringify({ ...s, signals: sw.M.signals }, null, 2));
    // preflight() checks COUNTER in both documents on every call; de-duplicate for the report.
    const problems = [...new Set([...(await sw.preflight("A")), ...(await sw.preflight("B"))])];
    if (sw.switcherRaw?.inFlight) console.log(`\nSWITCHER: mid-transition on every read (both slots at ${SLOT_EFFECT}); no PGM decided — run doctor again`);
    if (sw.warning) console.log(`\nWITNESS (not a preflight problem; takectl follows the switcher): ${sw.warning}`);
    console.log(problems.length ? `\nPROBLEMS:\n - ${problems.join("\n - ")}` : "\nAll preflight checks pass.");
    process.exit(problems.length ? 1 : 0);
  } catch (e) {
    console.error("doctor:", e.message);
    process.exit(1);
  }
} else {
  sw.start().then(() => serve(sw)).catch((e) => {
    console.error("startup failed:", e.message);
    process.exit(1);
  });
}
