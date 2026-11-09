#!/usr/bin/env node
// Minimal mimoLive 7 API impersonator for exercising takectl without the real app.
// Models: /documents, /layers (+by id, signals, setLive/setOff), /sources (tally-state),
// /output-destinations, /layer-sets (+recall), /datastores, and the WebSocket at /api/v1/socket.
// The Video Switcher follows 7.0b3 as probed 2026-11-09 (test/switcher-probe*.txt): live slot in
// input-values tvGroup_Hidden_Inputs__currentLiveSource, flipping at the END of a dissolve; per-slot
// codes in output-values tvOut_tvIn_VideoSource{A,B}ImageTallyState (40 program, 30 effect,
// 10 in-use), both 30 for the length of a dissolve; a cut sent during a dissolve is overridden by it.
// Source tally still uses the old hand-typed values (preview / program+program): CHANGES.md, proposal 3.
// Run: node test/mock-mimolive.mjs [port]
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.argv[2] || 8989);
const DISSOLVE_MS = 500;

const uuid = (s) => s.toUpperCase().padEnd(8, "0").slice(0, 8) + "-0000-4000-8000-000000000000";
const docs = {};
function mkDoc(id, name, layers, sources, outs, sets) {
  docs[id] = { id, name, live: "live", layers, sources, outs, sets, stores: {} };
}
const tallyLayer = { id: uuid("TALLY"), name: "TALLY", comp: "com.boinx.layer.box", live: "off", iv: {} };
mkDoc("111", "PH-A.tvshow", [structuredClone(tallyLayer)], [], [{ id: uuid("NDIOUT"), type: "com.boinx.mimoLive.outputDestination.ndi", live: "live" }],
  [{ id: uuid("SET1"), name: "Speaker Wide", active: true }, { id: uuid("SET2"), name: "Slides PiP", active: false }]);
mkDoc("222", "PH-B.tvshow", [structuredClone(tallyLayer)], [], [{ id: uuid("NDIOUT"), type: "com.boinx.mimoLive.outputDestination.ndi", live: "live" }],
  [{ id: uuid("SET1"), name: "Speaker Wide", active: false }, { id: uuid("SET2"), name: "Slides PiP", active: true }]);
const srcA = { id: "333-" + uuid("SRCA"), name: "NDI PH-A", tally: "program" };
const srcB = { id: "333-" + uuid("SRCB"), name: "NDI PH-B", tally: "preview" };
mkDoc("333", "PH-MASTER.tvshow", [{
  id: uuid("SWITCH"), name: "AB Switcher", comp: "com.boinx.mimoLive.layer.videoswitcher", live: "live",
  iv: {
    "tvGroup_Content__Source_1": uuid("SRCA"), "tvGroup_Content__Source_2": uuid("SRCB"),
    "tvGroup_Control__Cut_1_TypeSignal": 0, "tvGroup_Control__Cut_2_TypeSignal": 0,
    "tvGroup_Control__Dis_1_TypeSignal": 0, "tvGroup_Control__Dis_2_TypeSignal": 0,
    "tvGroup_Control__Transition_Duration": 0.5,
    "tvGroup_Hidden_Inputs__currentLiveSource": 1,
  },
  ov: { tvOut_tvIn_VideoSourceAImageTallyState: 40, tvOut_tvIn_VideoSourceBImageTallyState: 10 },
}], [srcA, srcB], [{ id: uuid("REC"), type: "com.boinx.mimoLive.outputDestination.fileRecording", live: "live" }], []);

// ---- websocket (bare minimum: handshake, text frames out, ping in)
const clients = new Set();
function broadcast(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  for (const s of clients) s.write(Buffer.concat([head, payload]));
}
function srcObj(d, s) {
  return { type: "sources", id: s.id, attributes: { name: s.name, "tally-state": s.tally, "source-type": "com.boinx.mimoLive.sources.ffmpegSource" } };
}
function setTally(a, b) {
  srcA.tally = a; srcB.tally = b;
  for (const s of [srcA, srcB]) broadcast({ type: "sources", event: "changed", id: s.id, "document-id": "333", ts: Date.now(), data: srcObj(docs["333"], s) });
}

const layerObj = (l) => ({ type: "layers", id: l.id, attributes: { name: l.name, "composition-id": l.comp, "live-state": l.live, "input-values": l.iv, "output-values": { tvOut_SettingName: l.name, ...l.ov } } });
const json = (res, code, obj, ct = "application/vnd.api+json") => { res.writeHead(code, { "Content-Type": ct }); res.end(obj === null ? "" : typeof obj === "string" ? obj : JSON.stringify(obj)); };

const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname.replace(/^\/api\/v1/, "");
  const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks).toString();
  let m;
  if (p === "/documents") return json(res, 200, { data: Object.values(docs).map((d) => ({ type: "documents", id: d.id, attributes: { name: d.name, "live-state": d.live } })) });
  if ((m = p.match(/^\/documents\/(\d+)$/))) { const d = docs[m[1]]; return d ? json(res, 200, { data: { type: "documents", id: d.id, attributes: { name: d.name, "live-state": d.live } } }) : json(res, 404, {}); }
  if ((m = p.match(/^\/documents\/(\d+)\/layers$/))) return json(res, 200, { data: docs[m[1]].layers.map(layerObj) });
  if ((m = p.match(/^\/documents\/(\d+)\/layers\/([^/]+)\/(setLive|setOff)$/))) {
    const l = docs[m[1]].layers.find((x) => x.id === m[2]); l.live = m[3] === "setLive" ? "live" : "off";
    console.log(`[${docs[m[1]].name}] ${l.name} → ${l.live}`); return json(res, 200, { data: layerObj(l) });
  }
  if ((m = p.match(/^\/documents\/(\d+)\/layers\/([^/]+)\/signals\/(.+)$/))) {
    const key = m[3]; const slot = key.match(/([12])_TypeSignal/)?.[1]; const dis = /Dis_/.test(key);
    const sw = docs[m[1]].layers[0];
    const codes = (a, b) => { sw.ov = { tvOut_tvIn_VideoSourceAImageTallyState: a, tvOut_tvIn_VideoSourceBImageTallyState: b }; };
    const land = () => {
      sw.iv.tvGroup_Hidden_Inputs__currentLiveSource = Number(slot);
      codes(slot === "1" ? 40 : 10, slot === "2" ? 40 : 10);
      setTally(slot === "1" ? "program" : "preview", slot === "2" ? "program" : "preview");
    };
    if (sw.dissolving) {
      // 7.0b3: a cut sent mid-dissolve is overridden; the dissolve still lands on its target.
      // (A dissolve sent mid-dissolve was not probed; it is ignored here too.)
      console.log(`[MASTER] signal ${key} IGNORED: a dissolve is in flight`);
      return json(res, 200, { data: layerObj(sw) });
    }
    console.log(`[MASTER] signal ${key} (${dis ? "dissolve" : "cut"} → slot ${slot})`);
    if (dis) {
      sw.dissolving = true;
      codes(30, 30);
      setTally("program", "program");
      setTimeout(() => { sw.dissolving = false; land(); }, DISSOLVE_MS);
    } else land();
    return json(res, 200, { data: layerObj(sw) });
  }
  if ((m = p.match(/^\/documents\/(\d+)\/layers\/([^/]+)$/))) { const l = docs[m[1]].layers.find((x) => x.id === m[2]); return l ? json(res, 200, { data: layerObj(l) }) : json(res, 404, {}); }
  if ((m = p.match(/^\/documents\/(\d+)\/sources$/))) return json(res, 200, { data: docs[m[1]].sources.map((s) => srcObj(docs[m[1]], s)) });
  if ((m = p.match(/^\/documents\/(\d+)\/sources\/(.+)$/))) { const s = docs[m[1]].sources.find((x) => x.id === m[2]); return s ? json(res, 200, { data: srcObj(docs[m[1]], s) }) : json(res, 404, {}); }
  if ((m = p.match(/^\/documents\/(\d+)\/output-destinations$/))) return json(res, 200, { data: docs[m[1]].outs.map((o) => ({ type: "output-destinations", id: o.id, attributes: { "output-destination-type": o.type, "live-state": o.live } })) });
  if ((m = p.match(/^\/documents\/(\d+)\/output-destinations\/(.+)$/))) { const o = docs[m[1]].outs.find((x) => x.id === m[2]); return json(res, 200, { data: { type: "output-destinations", id: o.id, attributes: { "output-destination-type": o.type, "live-state": o.live } } }); }
  if ((m = p.match(/^\/documents\/(\d+)\/layer-sets$/))) return json(res, 200, { data: docs[m[1]].sets.map((s) => ({ type: "layer-sets", id: s.id, attributes: { name: s.name, active: s.active } })) });
  if ((m = p.match(/^\/documents\/(\d+)\/layer-sets\/([^/]+)\/recall$/))) { const d = docs[m[1]]; for (const s of d.sets) s.active = s.id === m[2]; console.log(`[${d.name}] recall ${d.sets.find((s) => s.active).name}`); return json(res, 200, { data: {} }); }
  if ((m = p.match(/^\/documents\/(\d+)\/datastores\/(.+)$/))) {
    const d = docs[m[1]];
    if (req.method === "PUT") { d.stores[m[2]] = body; console.log(`[MASTER] datastore ${m[2]} = ${body}`); return json(res, 200, "", "text/plain"); }
    return m[2] in d.stores ? json(res, 200, d.stores[m[2]], "application/json") : json(res, 404, {});
  }
  json(res, 404, { error: "mock: no route " + p });
});
server.on("upgrade", (req, socket) => {
  if (!req.url.endsWith("/api/v1/socket")) return socket.destroy();
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
