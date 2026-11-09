#!/usr/bin/env node
// takectl — A/B composition switcher controller for mimoLive 7
//
// Three mimoLive documents:
//   A, B      composition documents, each publishing NDI (video only)
//   MASTER    Video Switcher layer (slot 1 = NDI-A, slot 2 = NDI-B) + program audio
//
// takectl holds the PGM/PVW role state, performs TAKE/CUT through the Video
// Switcher's own signal endpoints, verifies the result from mimoLive's source
// tally, flips tally layers in A/B, persists state in MASTER's data store, and
// exposes a tiny HTTP API for Bitfocus Companion / Stream Deck.
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
    await this.api.get(`/documents/${this.id}/layers/${this.tallyLayerId}/${on ? "setLive" : "setOff"}`).catch((e) =>
      log(`[${this.role}] tally ${on ? "on" : "off"} failed: ${e.message}`)
    );
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
    const slotOf = (src) => {
      const uuid = src.id.split("-").slice(1).join("-");
      for (const [k, v] of Object.entries(iv)) {
        if (typeof v !== "string") continue;
        if (v === src.id || v === uuid || v.endsWith(uuid)) {
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
    this.events = [];
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
    setInterval(() => this.resync("poll").catch(() => {}), CFG.pollMs ?? 5000);
    this.pushCompanion().catch(() => {});
  }

  // Ground truth = MASTER's NDI source tally. Role state follows it.
  async resync(reason) {
    const t = await this.M.tally();
    let pgm = null;
    if (t.A === "program" && t.B !== "program") pgm = "A";
    else if (t.B === "program" && t.A !== "program") pgm = "B";
    else if (t.A === "program" && t.B === "program") pgm = this.pgm; // mid-dissolve; keep
    if (pgm == null) {
      const saved = await this.M.readState();
      pgm = saved?.pgm ?? "A";
      if (reason !== "poll") this.note(`tally inconclusive (${JSON.stringify(t)}); using saved/default PGM=${pgm}`);
    }
    if (pgm !== this.pgm) {
      const prev = this.pgm;
      this.pgm = pgm;
      if (prev !== null) this.note(`PGM changed outside takectl (${reason}): ${prev} → ${pgm}; re-syncing tally`);
      await this.applyRoles();
    }
    this.tallyRaw = t;
  }

  async applyRoles() {
    await Promise.all([this.doc(this.pgm).setTally(true), this.doc(this.pvw).setTally(false)]);
    await this.M.writeState({ pgm: this.pgm, pvw: this.pvw, ts: Date.now(), by: "takectl" });
    await this.pushCompanion();
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
    return problems;
  }

  async transition(kind) {
    const now = Date.now();
    if (now < this.busyUntil) return { ok: false, error: `busy: transition in progress (${this.busyUntil - now} ms left)` };
    if (!this.pgm) await this.resync("pre-take");
    const target = this.pvw;
    if (CFG.preflight !== false) {
      const problems = await this.preflight(target);
      if (problems.length) {
        this.lastError = problems.join("; ");
        this.note(`REFUSED ${kind.toUpperCase()} → ${target}: ${this.lastError}`);
        return { ok: false, error: this.lastError };
      }
    }
    const slot = this.slot(target);
    const useDis = kind === "take" && this.M.signals.dis[slot];
    const url = this.M.signalUrl(useDis ? "dis" : "cut", slot);
    const dur = useDis ? (CFG.dissolveMs ?? 500) : 0;
    this.busyUntil = now + dur + (CFG.settleMs ?? 250);
    this.note(`${kind.toUpperCase()} → ${target} (slot ${slot}, ${useDis ? "dissolve" : "cut"})`);
    try {
      await this.M.api.get(url);
    } catch (e) {
      this.busyUntil = 0;
      this.lastError = e.message;
      this.note(`transition failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
    // Flip roles optimistically so the operator can start composing in the new PVW immediately,
    // then verify against tally once the dissolve has settled.
    this.pgm = target;
    this.lastTake = { kind, target, ts: now };
    await this.applyRoles();
    setTimeout(() => this.verify(target).catch(() => {}), dur + (CFG.settleMs ?? 250));
    return { ok: true, pgm: this.pgm, pvw: this.pvw, transition: useDis ? "dissolve" : "cut", ms: dur };
  }

  async verify(expected) {
    const t = await this.M.tally();
    this.tallyRaw = t;
    const onAir = t[expected];
    if (onAir !== "program") {
      this.lastError = `verify failed: expected ${expected} on program, tally=${JSON.stringify(t)}`;
      this.note(this.lastError);
      await this.resync("verify");
    } else {
      this.lastError = null;
    }
  }

  // Copy the PGM doc's active Layer Set to the PVW doc (same name in both documents).
  async mirror() {
    const name = await this.doc(this.pgm).activeLayerSetName();
    if (!name) return { ok: false, error: `no active layer set in ${this.pgm}` };
    await this.doc(this.pvw).recallLayerSetByName(name);
    this.note(`MIRROR: ${this.pgm} "${name}" → ${this.pvw}`);
    return { ok: true, layerSet: name, pvw: this.pvw };
  }

  async panic() {
    const slot = this.slot("A");
    await this.M.api.get(this.M.signalUrl("cut", slot));
    this.pgm = "A";
    this.busyUntil = 0;
    await this.applyRoles();
    this.note("PANIC: cut to A");
    return { ok: true, pgm: "A" };
  }

  state() {
    return {
      pgm: this.pgm,
      pvw: this.pvw,
      busy: Date.now() < this.busyUntil,
      tally: this.tallyRaw ?? null,
      lastTake: this.lastTake,
      lastError: this.lastError,
      docs: {
        A: { name: this.A.name, host: this.A.host, live: this.A.liveState, ndi: this.A.ndiOutLive, tallyLayer: !!this.A.tallyLayerId },
        B: { name: this.B.name, host: this.B.host, live: this.B.liveState, ndi: this.B.ndiOutLive, tallyLayer: !!this.B.tallyLayerId },
        MASTER: { name: this.M.name, host: this.M.host, switcher: this.M.switcherName, slotA: this.M.slotA, slotB: this.M.slotB },
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
    const path = new URL(req.url, "http://x").pathname.replace(/\/$/, "") || "/state";
    const fn = routes[path];
    if (!fn) return json(res, 404, { error: "unknown route", routes: Object.keys(routes) });
    try {
      json(res, 200, await fn());
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  }).listen(port, () => log(`takectl listening on http://0.0.0.0:${port}  (GET /state /take /cut /mirror /panic /resync)`));
}

// ---------------------------------------------------------------- main

const sw = new Switcher();
const cmd = process.argv[2];
if (cmd === "doctor") {
  // One-shot diagnostics, no server.
  try {
    await Promise.all([sw.A.discover(), sw.B.discover(), sw.M.discover()]);
    await sw.resync("doctor");
    const s = sw.state();
    console.log(JSON.stringify({ ...s, signals: sw.M.signals }, null, 2));
    const problems = [...(await sw.preflight("A")), ...(await sw.preflight("B"))];
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
