#!/usr/bin/env node
// Minimal mimoLive 7 API impersonator for exercising takectl without the real app.
// Models: /documents, /layers (+by id, signals, setLive/setOff), /sources (tally-state),
// /output-destinations, /layer-sets (+recall), /datastores, and the WebSocket at /api/v1/socket.
// The Video Switcher follows 7.0b3 as probed 2026-11-09 (test/switcher-probe*.txt): live slot in
// input-values tvGroup_Hidden_Inputs__currentLiveSource, flipping at the END of a dissolve; per-slot
// codes in output-values tvOut_tvIn_VideoSource{A,B}ImageTallyState (40 program, 30 effect,
// 10 in-use), both 30 for the length of a dissolve; a cut sent during a dissolve is overridden by it.
// Source tally follows 7.0b3 too (proposal 3): "program" on air, "in-use" off air, "effect" on both mid-dissolve.
// Round 2: MASTER has a STINGER box layer (0.4 s animation) and A/B a "Lower Third" layer; a layer told
// setOff passes through "shutdown" for its animation before "off" (7.0b3). /mock/log lists every
// signal, layer switch and recall with its time, for ordering checks.
// Safe source (2026-11-11 probe): slot 3 holds "SAFE Test Pattern" (a Video Output Test source); slot 4 is
// empty, and cutting to an empty slot reads live slot 9 ("Below"); a dissolve into or out of an empty
// slot reads 30 on the filled slot only.
// Round 3: MASTER's stack is FTB, DSK Clock, DSK Bug, STINGER, AB Switcher (each layer carries its "index",
// 0 = top); the dissolve runs for the switcher's tvIn_TransitionDuration (capped at 5 s), which a flat PUT
// of input-values sets; programOut?format=jpeg answers a small JPEG (with "<doc …, look …>" after its end).
// Run: node test/mock-mimolive.mjs [port]
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || 8989);
// --no-slot-keys: a switcher without tvGroup_Hidden_Inputs__currentLiveSource and the per-slot tally
// codes, as a mimoLive build that lacks them would be (no real build does; this is how the fallback is tested).
const NO_SLOT_KEYS = process.argv.includes("--no-slot-keys");
// --stick-program=A|B: that source's tally-state reads "program" whatever happens (CHANGES item 9's fault).
const STICK = (process.argv.find((a) => a.startsWith("--stick-program=")) || "").split("=")[1] || null;
// --require-password=<sha256 hex>: every HTTP request without that X-MimoLive-Password-SHA256 header gets 401.
const REQUIRE_PW = (process.argv.find((a) => a.startsWith("--require-password=")) || "").split("=")[1] || null;
// --disconnected=A|B: MASTER's source for that document reports video-device-connected false (a dead NDI sender).
const DISCONNECTED = (process.argv.find((a) => a.startsWith("--disconnected=")) || "").split("=")[1] || null;
// --no-stinger: MASTER has no STINGER layer (the "missing layer" case).
const NO_STINGER = process.argv.includes("--no-stinger");
// --dissolve-ms=<n>: a dissolve's length (default 500), to keep one in flight past takectl's verify.
// --slow-read=<ms>: a GET of a switcher layer answers with the state as it was when asked, <ms> later
// (a read sent before a PANIC that comes back after it).
// --dsk-below: MASTER also has a "DSK Low" layer below the switcher (not a downstream key: a warning).
const DSK_BELOW = process.argv.includes("--dsk-below");
const stalled = new Set(); // documents whose programOut stills hang (/mock/stall?doc=&on=1)
const SLOW_READ = Number((process.argv.find((a) => a.startsWith("--slow-read=")) || "").split("=")[1]) || 0;
const DISSOLVE_MS = Number((process.argv.find((a) => a.startsWith("--dissolve-ms=")) || "").split("=")[1]) || 0; // 0: follow the switcher's duration
const mlog = [];
const ev = (what) => { mlog.push({ t: Date.now(), what }); if (mlog.length > 500) mlog.shift(); };

const uuid = (s) => s.toUpperCase().padEnd(8, "0").slice(0, 8) + "-0000-4000-8000-000000000000";
const docs = {};
function mkDoc(id, name, layers, sources, outs, sets) {
  docs[id] = { id, name, live: "live", layers, sources, outs, sets, stores: {} };
}
const tallyLayer = { id: uuid("TALLY"), name: "TALLY", comp: "com.boinx.layer.box", live: "off", iv: {} };
const lowerThird = { id: uuid("LOWER3"), name: "Lower Third", comp: "com.boinx.layer.box", live: "off", iv: { tvGroup_Animation__Duration_TypeDuration: 0.3, tvGroup_Content__Title: "Lower Third" } };
// Round 4: two look layers the default sets switch, so a recall changes layers (and the socket says so).
const camWide = { id: uuid("CAMWIDE"), name: "Cam Wide", comp: "com.boinx.boinxtv.layer.placer", live: "off", iv: { tvIn_VideoSourceAName: "CAM 1" } };
const slides = { id: uuid("SLIDES"), name: "Slides", comp: "com.boinx.boinxtv.layer.placer", live: "off", iv: { tvIn_VideoSourceAName: "SLIDES" } };
const setLayers = (wideOn) => [{ "layer-id": camWide.id, action: wideOn ? "live" : "off" }, { "layer-id": slides.id, action: wideOn ? "off" : "live" }];
const lookLayers = (wideOn) => [structuredClone(tallyLayer), structuredClone(lowerThird), { ...structuredClone(camWide), live: wideOn ? "live" : "off" }, { ...structuredClone(slides), live: wideOn ? "off" : "live" }];
mkDoc("111", "PH-A.tvshow", lookLayers(true), [], [{ id: uuid("NDIOUT"), type: "com.boinx.mimoLive.outputDestination.ndi", live: "live" }],
  [{ id: uuid("SET1"), name: "Speaker Wide", active: true, layers: setLayers(true) }, { id: uuid("SET2"), name: "Slides PiP", active: false, layers: setLayers(false) }]);
mkDoc("222", "PH-B.tvshow", lookLayers(false), [], [{ id: uuid("NDIOUT"), type: "com.boinx.mimoLive.outputDestination.ndi", live: "live" }],
  [{ id: uuid("SET1"), name: "Speaker Wide", active: false, layers: setLayers(true) }, { id: uuid("SET2"), name: "Slides PiP", active: true, layers: setLayers(false) }]);
const srcA = { id: "333-" + uuid("SRCA"), name: "NDI PH-A", tally: "program" };
const srcB = { id: "333-" + uuid("SRCB"), name: "NDI PH-B", tally: "in-use" };
const srcSafe = { id: "333-" + uuid("SAFE"), name: "SAFE Test Pattern", tally: "in-use", type: "com.boinx.boinxtv.layer.videooutputtest" };
const SLOT_SRC = { 1: srcA, 2: srcB, 3: srcSafe }; // slots 4–8 empty
mkDoc("333", "PH-MASTER.tvshow", [
  { id: uuid("FTB"), name: "FTB", comp: "com.boinx.boinxtv.layer.simplebox", live: "off", iv: { tvGroup_Animation__Duration_TypeDuration: 0.5 } },
  { id: uuid("DSKCLOCK"), name: "DSK Clock", comp: "com.boinx.boinxtv.layer.datentime", live: "off", iv: {} },
  { id: uuid("DSKBUG"), name: "DSK Bug", comp: "com.boinx.boinxtv.layer.logo", live: "off", iv: {} },
  ...(NO_STINGER ? [] : [{ id: uuid("STINGER"), name: "STINGER", comp: "com.boinx.boinxtv.layer.simplebox", live: "off", iv: { tvGroup_Animation__Duration_TypeDuration: 0.4 } }]),
  {
  id: uuid("SWITCH"), name: "AB Switcher", comp: "com.boinx.mimoLive.layer.videoswitcher", live: "live",
  iv: {
    "tvGroup_Content__Source_1": uuid("SRCA"), "tvGroup_Content__Source_2": uuid("SRCB"), "tvIn_VideoSourceCImage": srcSafe.id,
    ...Object.fromEntries([1, 2, 3, 4].flatMap((n) => [[`tvGroup_Control__Cut_${n}_TypeSignal`, 0], [`tvGroup_Control__Dis_${n}_TypeSignal`, 0]])),
    "tvIn_TransitionDuration": 0.5,
    "tvGroup_Hidden_Inputs__currentLiveSource": 1,
  },
  ov: { tvOut_tvIn_VideoSourceAImageTallyState: 40, tvOut_tvIn_VideoSourceBImageTallyState: 10, tvOut_tvIn_VideoSourceCImageTallyState: 10, tvOut_tvIn_VideoSourceDImageTallyState: 10 },
}],
  [srcA, srcB, srcSafe], [{ id: uuid("REC"), type: "com.boinx.mimoLive.outputDestination.fileRecording", title: "Recording", live: "live" }], []);
if (DSK_BELOW) docs["333"].layers.push({ id: uuid("DSKLOW"), name: "DSK Low", comp: "com.boinx.boinxtv.layer.logo", live: "off", iv: {} });

// ---- websocket (bare minimum: handshake, text frames out, ping in)
const clients = new Set();
let refuseSockets = false; // /mock/socket?refuse=1: new connections are closed at once (NOT WATCHED stays up)
function broadcast(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  for (const s of clients) s.write(Buffer.concat([head, payload]));
}
// Round 4: the events 7.0b3 sends for a document's layers, variants and Layer Sets (shapes from
// test/round4-probe-*.txt): a layer change as "layers changed" + "variants changed" for its one variant;
// an input edit as "variants changed" only; a recall as "layer-sets changed" + the layers it switches.
const docOfLayer = (l) => Object.values(docs).find((d) => d.layers.includes(l));
const variantId = (l) => l.id.slice(0, 9) + "1111" + l.id.slice(13);
const variantObj = (l) => ({ type: "variants", id: variantId(l), attributes: { name: `${l.iv.tvGroup_Content__Title ?? l.name}`, "live-state": l.live, "input-values": l.iv, "output-values": {} },
  relationships: { layer: { data: { type: "layers", id: l.id } } } });
const setObj = (s) => ({ type: "layer-sets", id: s.id, attributes: { name: s.name, active: s.active, layers: s.layers ?? [{ "layer-id": uuid("LOOK"), action: "live", variant: null }] } });
function emitLayer(l, { layer = true, variant = true } = {}) {
  const d = docOfLayer(l);
  if (!d) return;
  if (layer) broadcast({ type: "layers", event: "changed", id: l.id, "document-id": d.id, ts: Date.now(), data: layerObj(l) });
  if (variant) broadcast({ type: "variants", event: "changed", id: variantId(l), "layer-id": l.id, "document-id": d.id, ts: Date.now(), data: variantObj(l) });
}
// setLive / setOff: a layer with an out-animation passes through "shutdown" (7.0b3), each step on the socket.
// Switched on, 7.0b3 also flickers a layer's source names: "None" in the switching message, back ~300 ms later
// in a message of their own (test/round4-probe-ui-changes.txt: Two Shot, Cam Wide, Slides).
const NAME_KEY = /^tvIn_VideoSource[A-Z]Name$/;
function switchLayer(l, on) {
  clearTimeout(l.anim);
  const was = l.live;
  if (on) l.live = "live";
  else if (l.live === "off") l.live = "off";
  else { const ms = 1000 * (l.iv.tvGroup_Animation__Duration_TypeDuration ?? 0); l.live = ms ? "shutdown" : "off"; if (ms) l.anim = setTimeout(() => { l.live = "off"; emitLayer(l); }, ms); }
  if (l.live === was) return;
  const names = Object.keys(l.iv).filter((k) => NAME_KEY.test(k));
  if (l.live === "live" && names.length) {
    const back = Object.fromEntries(names.map((k) => [k, l.iv[k]]));
    for (const k of names) l.iv[k] = "None";
    emitLayer(l);
    clearTimeout(l.flicker);
    l.flicker = setTimeout(() => { Object.assign(l.iv, back); emitLayer(l); }, 300);
  } else emitLayer(l);
}
// Live values, once a second unless --quiet-socket: what a running show sends with nobody touching anything.
if (!process.argv.includes("--quiet-socket")) setInterval(() => {
  for (const d of Object.values(docs)) {
    broadcast({ type: "documents", event: "changed", id: d.id, ts: Date.now(), data: { type: "documents", id: d.id, attributes: { name: d.name, "live-state": d.live, duration: Date.now() / 1000 } } });
    const lt = d.layers.find((x) => x.name === "Lower Third"), cw = d.layers.find((x) => x.name === "Cam Wide");
    if (lt) broadcast({ type: "variants", event: "changed", id: variantId(lt), "layer-id": lt.id, "document-id": d.id, ts: Date.now(), data: { ...variantObj(lt), attributes: { ...variantObj(lt).attributes, "output-values": { tvOut_TimeRemaining: Math.random() } } } });
    if (cw) broadcast({ type: "layers", event: "values-changed", id: cw.id, "document-id": d.id, ts: Date.now(), data: { "input-values": { tvIn_VideoSourceAAudioLevel0Raw: -40 - 10 * Math.random() } } });
  }
}, 1000).unref();
function srcObj(d, s) {
  const tally = STICK && s === (STICK === "A" ? srcA : srcB) ? "program" : s.tally;
  const dead = DISCONNECTED && s === (DISCONNECTED === "A" ? srcA : srcB);
  if (s.type) return { type: "sources", id: s.id, attributes: { name: s.name, "tally-state": tally, "source-type": s.type } }; // no video device
  return { type: "sources", id: s.id, attributes: { name: s.name, "tally-state": tally, "video-device-connected": !dead, "source-type": "com.boinx.mimoLive.sources.deviceVideoSource" } };
}
// Source tally from the switcher: program on the live slot, effect on both ends of a dissolve, else in-use.
function setTally(live, from, to) {
  for (const [n, s] of Object.entries(SLOT_SRC)) {
    const t = from != null && (Number(n) === from || Number(n) === to) ? "effect" : Number(n) === live ? "program" : "in-use";
    if (s.tally === t) continue;
    s.tally = t;
    broadcast({ type: "sources", event: "changed", id: s.id, "document-id": "333", ts: Date.now(), data: srcObj(docs["333"], s) });
  }
}

const hideSlotKeys = (o = {}) => Object.fromEntries(Object.entries(o).filter(([k]) => !/currentLiveSource|ImageTallyState$/.test(k)));
for (const d of Object.values(docs)) d.layers.forEach((l, i) => { l.index = i; }); // 0 = top of the stack
const switcherOf = (d) => d.layers.find((x) => /videoswitcher/.test(x.comp));
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
const layerObj = (l) => ({ type: "layers", id: l.id, attributes: { name: l.name, index: l.index, "composition-id": l.comp, "live-state": l.live,
  "input-values": NO_SLOT_KEYS ? hideSlotKeys(l.iv) : l.iv, "output-values": { tvOut_SettingName: l.name, ...(NO_SLOT_KEYS ? hideSlotKeys(l.ov) : l.ov) } } });
const json = (res, code, obj, ct = "application/vnd.api+json") => { res.writeHead(code, { "Content-Type": ct }); res.end(obj === null ? "" : typeof obj === "string" ? obj : JSON.stringify(obj)); };

const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname.replace(/^\/api\/v1/, "");
  const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks).toString();
  let m;
  // Test-only: the mock's real state, even while --no-slot-keys hides it from the API.
  if (p === "/mock/state") return json(res, 200, { slot: switcherOf(docs["333"]).iv.tvGroup_Hidden_Inputs__currentLiveSource, tally: { A: srcA.tally, B: srcB.tally } });
  if (p === "/mock/stall") { const d = u.searchParams.get("doc"); u.searchParams.get("on") === "1" ? stalled.add(d) : stalled.delete(d); return json(res, 200, { ok: true, stalled: [...stalled] }); }
  if ((m = p.match(/^\/documents\/(\d+)\/output-destinations\/([^/]+)\/(setLive|setOff)$/))) { const o = docs[m[1]].outs.find((x) => x.id === m[2]); o.live = m[3] === "setLive" ? "live" : "preview"; return json(res, 200, { data: {} }); }
  if ((m = p.match(/^\/documents\/(\d+)\/programOut$/))) {
    const d = docs[m[1]];
    if (stalled.has(m[1])) return; // never answers: a stalled picture
    if (u.searchParams.get("format") !== "jpeg") return json(res, 404, { error: "mock: only format=jpeg stills" });
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    return res.end(Buffer.concat([JPEG, Buffer.from(`\n<doc ${d.id}, look ${d.sets.find((x) => x.active)?.name ?? "-"}>`)]));
  }
  if ((m = p.match(/^\/documents\/(\d+)\/layers\/([^/]+)$/)) && req.method === "PUT") {
    const l = docs[m[1]].layers.find((x) => x.id === m[2]);
    try { Object.assign(l.iv, JSON.parse(body)["input-values"] ?? {}); } catch {}
    emitLayer(l, { layer: false });
    return json(res, 200, { data: layerObj(l) });
  }
  if (p === "/mock/log") return json(res, 200, { now: Date.now(), log: mlog });
  // Test-only: put a layer in any live-state (e.g. STINGER stuck in "shutdown").
  // Test-only: make one Layer Set active (name=) or none (name empty); add a set to one document.
  if (p === "/mock/set-active") { const d = docs[u.searchParams.get("doc")]; for (const x of d.sets) { const was = x.active; x.active = x.name === u.searchParams.get("name"); if (was !== x.active) broadcast({ type: "layer-sets", event: "changed", id: x.id, "document-id": d.id, ts: Date.now(), data: setObj(x) }); } return json(res, 200, { ok: true }); }
  // Round 4 test controls: a variant added by hand; the socket dropped (and new ones refused while refuse=1).
  if (p === "/mock/add-variant") { const d = docs[u.searchParams.get("doc")]; const l = d.layers.find((x) => x.name === u.searchParams.get("name")); const id = l.id.slice(0, 9) + "2222" + l.id.slice(13);
    broadcast({ type: "variants", event: "added", id, "layer-id": l.id, "document-id": d.id, ts: Date.now(), data: { ...variantObj(l), id } }); return json(res, 200, { ok: true, id }); }
  if (p === "/mock/socket") { if (u.searchParams.has("refuse")) refuseSockets = u.searchParams.get("refuse") === "1"; if (u.searchParams.get("drop") === "1") for (const c of clients) c.destroy(); return json(res, 200, { ok: true, refuse: refuseSockets, clients: clients.size }); }
  if (p === "/mock/add-set") { const d = docs[u.searchParams.get("doc")]; const name = u.searchParams.get("name"); if (!d.sets.some((x) => x.name === name)) d.sets.push({ id: uuid("SET" + d.sets.length + 1), name, active: false }); if (u.searchParams.get("active") === "1") for (const x of d.sets) x.active = x.name === name; return json(res, 200, { ok: true }); }
  if (p === "/mock/set-layer") { const l = docs[u.searchParams.get("doc")].layers.find((x) => x.name === u.searchParams.get("name")); clearTimeout(l.anim); const was = l.live; l.live = u.searchParams.get("live"); if (was !== l.live) emitLayer(l); return json(res, 200, { ok: true, live: l.live }); }
  if (REQUIRE_PW && req.headers["x-mimolive-password-sha256"] !== REQUIRE_PW) return json(res, 401, { errors: [{ title: "password required" }] });
  if ((m = p.match(/^\/documents\/(\d+)\/(setLive|setOff)$/))) { const d = docs[m[1]]; d.live = m[2] === "setLive" ? "live" : "off"; return json(res, 200, { data: { type: "documents", id: d.id, attributes: { name: d.name, "live-state": d.live } } }); }
  if (p === "/documents") return json(res, 200, { data: Object.values(docs).map((d) => ({ type: "documents", id: d.id, attributes: { name: d.name, "live-state": d.live } })) });
  if ((m = p.match(/^\/documents\/(\d+)$/))) { const d = docs[m[1]]; return d ? json(res, 200, { data: { type: "documents", id: d.id, attributes: { name: d.name, "live-state": d.live } } }) : json(res, 404, {}); }
  if ((m = p.match(/^\/documents\/(\d+)\/layers$/))) return json(res, 200, { data: docs[m[1]].layers.map(layerObj) });
  if ((m = p.match(/^\/documents\/(\d+)\/layers\/([^/]+)\/(setLive|setOff)$/))) {
    const l = docs[m[1]].layers.find((x) => x.id === m[2]);
    switchLayer(l, m[3] === "setLive");
    ev(`${docs[m[1]].name.replace(/\.tvshow$/, "")} ${l.name} ${m[3]}`);
    console.log(`[${docs[m[1]].name}] ${l.name} → ${l.live}`); return json(res, 200, { data: layerObj(l) });
  }
  if ((m = p.match(/^\/documents\/(\d+)\/layers\/([^/]+)\/signals\/(.+)$/))) {
    const key = m[3]; const n = Number(key.match(/_([1-8])_TypeSignal/)?.[1] ?? 9); const dis = /Dis_/.test(key);
    const slot = String(n);
    const sw = docs[m[1]].layers.find((x) => x.id === m[2]);
    const target = SLOT_SRC[n] ? n : 9; // an empty slot shows nothing: the live slot reads 9 ("Below")
    const from = sw.iv.tvGroup_Hidden_Inputs__currentLiveSource;
    const codes = (f) => { sw.ov = Object.fromEntries([1, 2, 3, 4].map((k) => [`tvOut_tvIn_VideoSource${"ABCD"[k - 1]}ImageTallyState`, f(k)])); };
    const land = () => {
      sw.iv.tvGroup_Hidden_Inputs__currentLiveSource = target;
      codes((k) => (k === target ? 40 : 10));
      setTally(target);
    };
    if (sw.dissolving) {
      // 7.0b3: a cut sent mid-dissolve is overridden; the dissolve still lands on its target.
      // (A dissolve sent mid-dissolve was not probed; it is ignored here too.)
      console.log(`[MASTER] signal ${key} IGNORED: a dissolve is in flight`);
      return json(res, 200, { data: layerObj(sw) });
    }
    console.log(`[MASTER] signal ${key} (${dis ? "dissolve" : "cut"} → slot ${slot})`);
    ev(`MASTER ${dis ? "dissolve" : "cut"} ${slot}`);
    if (dis) {
      sw.dissolving = true;
      codes((k) => ((k === from || k === target) && SLOT_SRC[k] ? 30 : 10)); // only filled slots read 30
      setTally(null, from, target);
      setTimeout(() => { sw.dissolving = false; land(); }, DISSOLVE_MS || Math.min(5, sw.iv.tvIn_TransitionDuration ?? 0.5) * 1000);
    } else land();
    return json(res, 200, { data: layerObj(sw) });
  }
  if ((m = p.match(/^\/documents\/(\d+)\/layers\/([^/]+)$/))) {
    const l = docs[m[1]].layers.find((x) => x.id === m[2]);
    if (!l) return json(res, 404, {});
    const body = JSON.parse(JSON.stringify({ data: layerObj(l) }));
    if (SLOW_READ && /videoswitcher/.test(l.comp)) await new Promise((r) => setTimeout(r, SLOW_READ));
    return json(res, 200, body);
  }
  if ((m = p.match(/^\/documents\/(\d+)\/sources$/))) return json(res, 200, { data: docs[m[1]].sources.map((s) => srcObj(docs[m[1]], s)) });
  if ((m = p.match(/^\/documents\/(\d+)\/sources\/(.+)$/))) { const s = docs[m[1]].sources.find((x) => x.id === m[2]); return s ? json(res, 200, { data: srcObj(docs[m[1]], s) }) : json(res, 404, {}); }
  if ((m = p.match(/^\/documents\/(\d+)\/output-destinations$/))) return json(res, 200, { data: docs[m[1]].outs.map((o) => ({ type: "output-destinations", id: o.id, attributes: { "output-destination-type": o.type, title: o.title, "live-state": o.live } })) });
  if ((m = p.match(/^\/documents\/(\d+)\/output-destinations\/(.+)$/))) { const o = docs[m[1]].outs.find((x) => x.id === m[2]); return json(res, 200, { data: { type: "output-destinations", id: o.id, attributes: { "output-destination-type": o.type, title: o.title, "live-state": o.live } } }); }
  if ((m = p.match(/^\/documents\/(\d+)\/layer-sets$/))) return json(res, 200, { data: docs[m[1]].sets.map(setObj) }); // a recorded set lists its layers (7.0b3); an empty one reads active
  if ((m = p.match(/^\/documents\/(\d+)\/layer-sets\/([^/]+)\/recall$/))) {
    const d = docs[m[1]];
    for (const s of d.sets) { const was = s.active; s.active = s.id === m[2]; if (was !== s.active) broadcast({ type: "layer-sets", event: "changed", id: s.id, "document-id": d.id, ts: Date.now(), data: setObj(s) }); }
    const set = d.sets.find((s) => s.active);
    for (const e of set.layers ?? []) { const l = d.layers.find((x) => x.id === e["layer-id"]); if (l) switchLayer(l, e.action !== "off"); }
    console.log(`[${d.name}] recall ${set.name}`); ev(`${d.name.replace(/\.tvshow$/, "")} recall ${set.name}`); return json(res, 200, { data: {} });
  }
  if ((m = p.match(/^\/documents\/(\d+)\/layers\/([^/]+)\/variants$/))) { const l = docs[m[1]].layers.find((x) => x.id === m[2]); return l ? json(res, 200, { data: [variantObj(l)] }) : json(res, 404, {}); }
  if ((m = p.match(/^\/documents\/(\d+)\/datastores\/(.+)$/))) {
    const d = docs[m[1]];
    if (req.method === "PUT") { d.stores[m[2]] = body; console.log(`[MASTER] datastore ${m[2]} = ${body}`); return json(res, 200, "", "text/plain"); }
    return m[2] in d.stores ? json(res, 200, d.stores[m[2]], "application/json") : json(res, 404, {});
  }
  json(res, 404, { error: "mock: no route " + p });
});
server.on("upgrade", (req, socket) => {
  if (!req.url.endsWith("/api/v1/socket") || refuseSockets) return socket.destroy();
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(socket);
  socket.on("data", (buf) => { // decode a single masked text frame (client → server); answer JSON ping
    if ((buf[0] & 0x0f) !== 1) return;
    const len = buf[1] & 127; const mask = buf.subarray(2, 6); const data = buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]);
    try { if (JSON.parse(Buffer.from(data).toString()).event === "ping") { const pl = Buffer.from('{"event":"pong"}'); socket.write(Buffer.concat([Buffer.from([0x81, pl.length]), pl])); } } catch {}
  });
  socket.on("close", () => clients.delete(socket)); socket.on("error", () => clients.delete(socket));
});
server.listen(PORT, () => console.log(`mock mimoLive on http://localhost:${PORT}/api/v1  (A=111 B=222 MASTER=333, A on program)`));
