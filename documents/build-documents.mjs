#!/usr/bin/env node
// build-documents.mjs — builds PH-A, PH-B, PH-MASTER inside a running mimoLive 7.0b3
// through its HTTP API. The three documents must already be open (blank) with those
// names; this script never creates or saves documents. Re-runnable: it finds things
// by name and only creates what is missing.
//
// Every write is read back. On 7.0b3 a wrongly-shaped write returns HTTP 200 and
// changes nothing, so a status code proves nothing — only the read-back does.
// Writes that do not land are collected and printed as MANUAL steps at the end.
//
//   node documents/build-documents.mjs            # build + start shows
//   MIMO=http://other-mac.local:8989 node ...     # another host
//   BENCH_COUNTER=1 node documents/build-documents.mjs
//                                                 # also add the bench stopwatch COUNTER to A and B
//                                                 # (bench test 3 only; takectl refuses every TAKE
//                                                 # while it is live, and the release has none)
//
// Recipes this relies on (probed on 7.0b3 build 30982):
//   POST  .../layers               {"layer-identifier": id, "name": n}         flat body
//   POST  .../sources              {"source-type": id, "name": n}              flat body
//   POST  .../output-destinations  {"output-destination-type": id}             flat body
//   POST  .../layer-sets           {}                                          (name ignored)
//   PUT   .../layers/{id}          {"input-values": {...}}                      flat — PATCH is a silent no-op
//   PUT   .../sources/{id}         {"video-device-id": ...} / {"input-values"}  flat
//   PATCH .../layer-sets|output-destinations/{id}  {"data":{"attributes":{...}}} wrapped — flat is a no-op
//   PUT   .../sources/{id}/filters/{f} {"input-values": {...}}                flat; POST .../filters is 404 (can't add)

import { hostname } from "node:os";

const BASE = (process.env.MIMO || "http://localhost:8989").replace(/\/$/, "") + "/api/v1";
const NAMES = { A: "PH-A", B: "PH-B", M: "PH-MASTER" };
const W = 1920, H = 1080;
const BENCH_COUNTER = process.env.BENCH_COUNTER === "1";
const TALLY_PX = 24; // README: 24-px bar. MASTER must crop >= this (see documents/README.md).

const manual = [];
const log = (...a) => console.log(...a);

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const get = (p) => req("GET", p);
const attrs = (o) => o?.attributes ?? {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Colours come back colour-managed (1,0,0 reads as 0.986,0,0.027), so object members get a
// looser tolerance than plain numbers. "" is how a source slot is cleared (null is ignored).
function same(want, got, tol = 1e-4) {
  if (want === "" || want === null) return got === null || got === undefined || got === "";
  if (typeof want === "number") return typeof got === "number" && Math.abs(want - got) < tol;
  if (want && typeof want === "object") return got && typeof got === "object" && Object.keys(want).every((k) => same(want[k], got[k], 0.05));
  return want === got;
}

// New layers auto-create "Placeholder X" sources for every empty slot. Clear the slots we
// don't use (with ""), then delete placeholders nothing references.
async function removeAutoPlaceholders(doc, label) {
  const list = (await get(`/documents/${doc}/sources`)).data;
  let n = 0;
  for (const s of list.filter((x) => /^Placeholder [A-Z]$/.test(attrs(x).name))) {
    await req("DELETE", `/documents/${doc}/sources/${s.id}`).then(() => n++).catch(() => {});
  }
  if (n) log(`  - removed ${n} auto-created placeholder sources`);
}

// ------------------------------------------------------------------ documents

async function findDoc(name) {
  const docs = (await get("/documents")).data;
  const d = docs.find((x) => attrs(x).name.replace(/\.tvshow$/, "") === name);
  if (!d) throw new Error(`document "${name}" is not open in mimoLive`);
  return d.id;
}

async function ensureSize(doc, label) {
  const m = () => get(`/documents/${doc}`).then((d) => attrs(d.data).metadata);
  let cur = await m();
  if (cur.width === W && cur.height === H) return;
  await req("PUT", `/documents/${doc}`, { metadata: { width: W, height: H } }).catch(() => {});
  cur = await m();
  if (cur.width === W && cur.height === H) return log(`  ${label}: size set to ${W}x${H}`);
  manual.push(`In ${label}, open Show Settings and set the video size to ${W}×${H} at 30 fps (the API accepted the change but did not apply it; currently ${cur.width}×${cur.height}).`);
}

// ------------------------------------------------------------------ sources

async function ensureSource(doc, name, type) {
  const list = (await get(`/documents/${doc}/sources`)).data;
  const hit = list.find((s) => attrs(s).name === name);
  if (hit) return hit.id;
  const r = await req("POST", `/documents/${doc}/sources`, { "source-type": type, name });
  log(`  + source ${name} (${type.split(".").pop()})`);
  return r.data.id;
}

async function setSource(doc, id, body, check, what) {
  await req("PUT", `/documents/${doc}/sources/${id}`, body);
  await sleep(150);
  const a = attrs((await get(`/documents/${doc}/sources/${id}`)).data);
  if (!check(a)) { manual.push(what); return false; }
  return true;
}

// ------------------------------------------------------------------ layers

async function ensureLayer(doc, name, layerType, index = 0) {
  const list = (await get(`/documents/${doc}/layers`)).data;
  const hit = list.find((l) => attrs(l).name === name);
  if (hit) return hit.id;
  // index 0 = TOP of the stack. Without it a new layer lands at the bottom, and the API
  // cannot reorder afterwards (index writes are silent no-ops). Callers create bottom-to-top;
  // index 1 inserts directly under the top layer (probed 2026-11-11).
  const r = await req("POST", `/documents/${doc}/layers`, { "layer-identifier": `com.boinx.boinxtv.layer.${layerType}`, name, index });
  log(`  + layer ${name} (${layerType})`);
  return r.data.id;
}

async function setInputs(doc, layerId, iv, label) {
  await req("PUT", `/documents/${doc}/layers/${layerId}`, { "input-values": iv });
  await sleep(150);
  const got = attrs((await get(`/documents/${doc}/layers/${layerId}`)).data)["input-values"] || {};
  const missed = Object.keys(iv).filter((k) => !same(iv[k], got[k]));
  if (missed.length) manual.push(`In ${label}, set ${missed.map((k) => `${k}=${JSON.stringify(iv[k])}`).join(", ")} (API write did not land).`);
}

async function setLayerLive(doc, layerId, on) {
  await get(`/documents/${doc}/layers/${layerId}/${on ? "setLive" : "setOff"}`);
}

// ------------------------------------------------------------------ outputs / layer sets

async function ensureOutput(doc, type, title, label) {
  const list = (await get(`/documents/${doc}/output-destinations`)).data;
  let o = list.find((x) => attrs(x)["output-destination-type"] === type && attrs(x).title === title);
  if (!o) {
    const r = await req("POST", `/documents/${doc}/output-destinations`, { "output-destination-type": type });
    o = r.data;
    log(`  + output ${title} (${type.split(".").pop()})`);
  }
  // PATCH only what differs. 7.0b3 bug: re-PATCHing an NDI output with the title it
  // already has stops the sender advertising while the output still reports "live"
  // (MASTER's source then shows video-device-connected=false). Renaming away and back cures it.
  const cur = attrs(o);
  const want = {};
  if (cur.title !== title) want.title = title;
  if (cur["starts-with-show"] !== true) want["starts-with-show"] = true;
  if (Object.keys(want).length) await req("PATCH", `/documents/${doc}/output-destinations/${o.id}`, { data: { attributes: want } });
  const a = attrs((await get(`/documents/${doc}/output-destinations/${o.id}`)).data);
  if (a.title !== title) manual.push(`In ${label}, rename the ${attrs(o).type} output to "${title}".`);
  if (a["starts-with-show"] !== true) manual.push(`In ${label}, tick "Start with show" on output "${title}".`);
  return o.id;
}

async function ensureLayerSet(doc, name, label) {
  const list = (await get(`/documents/${doc}/layer-sets`)).data;
  if (list.some((s) => attrs(s).name === name)) return;
  const r = await req("POST", `/documents/${doc}/layer-sets`, {});
  await req("PATCH", `/documents/${doc}/layer-sets/${r.data.id}`, { data: { attributes: { name } } });
  const a = attrs((await get(`/documents/${doc}/layer-sets/${r.data.id}`)).data);
  if (a.name !== name) manual.push(`In ${label}, rename layer set "${a.name}" to "${name}".`);
  else log(`  + layer set ${name}`);
}

// ------------------------------------------------------------------ build

const RED = { red: 1, green: 0, blue: 0, alpha: 1 };

async function buildComposition(role) {
  const label = NAMES[role];
  log(`\n${label}`);
  const doc = await findDoc(label);
  await ensureSize(doc, label);

  // Camera stand-ins. Placeholder letters differ per document so A and B are distinguishable:
  // PH-A shows A/C, PH-B shows B/D. SLIDES is a test chart, different per document.
  const keys = role === "A" ? [0, 2] : [1, 3]; // Placeholder key enum: 0=A 1=B 2=C 3=D
  const cam1 = await ensureSource(doc, "CAM 1", "com.boinx.boinxtv.source.placeholder");
  const cam2 = await ensureSource(doc, "CAM 2", "com.boinx.boinxtv.source.placeholder");
  const slides = await ensureSource(doc, "SLIDES", "com.boinx.boinxtv.layer.videooutputtest");
  for (const [id, k, n] of [[cam1, keys[0], "CAM 1"], [cam2, keys[1], "CAM 2"]])
    await setSource(doc, id, { "input-values": { tvGroup_Content__Key: k } }, (a) => a["input-values"]?.tvGroup_Content__Key === k,
      `In ${label}, set source ${n}'s placeholder letter to ${"ABCD"[k]}.`);
  const chart = role === "A" ? 1 : 0; // 1=SMPTE Color Bars, 0=Philips PM5544
  await setSource(doc, slides, { "input-values": { tvGroup_Content__Test_Image: chart } }, (a) => a["input-values"]?.tvGroup_Content__Test_Image === chart,
    `In ${label}, set source SLIDES's test image to ${chart ? "SMPTE Color Bars" : "Philips PM5544"}.`);

  // Layer stack, created bottom to top (new layers land on top of the stack).
  const L = {};
  L.slides = await ensureLayer(doc, "Slides", "singlevideo");
  await setInputs(doc, L.slides, { tvIn_VideoSourceAImage: slides }, `${label} layer Slides`);
  L.wide = await ensureLayer(doc, "Cam Wide", "singlevideo");
  await setInputs(doc, L.wide, { tvIn_VideoSourceAImage: cam1 }, `${label} layer Cam Wide`);
  L.two = await ensureLayer(doc, "Two Shot", "splitscreen");
  const unusedTwo = Object.fromEntries("CDEFGHIJ".split("").map((c) => [`tvIn_VideoSource${c}Image`, ""]));
  // Layout's value-list starts ["Custom", "-", "2 x 1", "3 x 1", …]; the "-" separator is NOT an
  // index, so 2 x 1 is 1 (2 gave 3 x 1). Source_Count's list has no separator: 1 = "2".
  await setInputs(doc, L.two, { tvGroup_Control__Layout: 1, tvGroup_Control__Source_Count: 1, tvIn_VideoSourceAImage: cam1, tvIn_VideoSourceBImage: cam2, ...unusedTwo }, `${label} layer Two Shot`);
  L.pip = await ensureLayer(doc, "Cam PiP", "pipwindow");
  await setInputs(doc, L.pip, { tvIn_VideoSourceAImage: cam1 }, `${label} layer Cam PiP`);
  // The bench stopwatch COUNTER is not part of the release: only with BENCH_COUNTER=1 (bench test 3).
  if (BENCH_COUNTER) {
    L.counter = await ensureLayer(doc, "COUNTER", "stopwatch");
    await setInputs(doc, L.counter, {
      tvGroup_Control__Counting_Mode: 0, tvGroup_Control__Start_on_Live: true,
      tvGroup_Appearance__Precision_Min: 0, tvGroup_Appearance__Font_Time_TypeFontBoinxSize: 0.12,
    }, `${label} layer COUNTER`);
  }
  L.tally = await ensureLayer(doc, "TALLY", "simplebox");
  await setInputs(doc, L.tally, {
    tvGroup_Appearance__Type: 0, tvGroup_Appearance__Color: RED, tvGroup_Appearance__Drop_Shadow: false,
    tvGroup_Animation__Incoming: 0, tvGroup_Animation__Outgoing: 1,
    tvGroup_Geometry__Top_Margin_TypeBoinxY: 0, tvGroup_Geometry__Left_Margin_TypeBoinxX: 0,
    // Box margins are in BoinxY units where the full frame height is 2.0 (measured: a bottom
    // margin of 0.978 gave a bar 51 % of the frame tall), so a 24-px bar is 2*(1-24/1080).
    tvGroup_Geometry__Right_Margin_TypeBoinxX: 0, tvGroup_Geometry__Bottom_Margin_TypeBoinxY: 2 * (1 - TALLY_PX / H),
  }, `${label} layer TALLY`);

  // v0.2: a real Lower Third (mimoLive's basic "Lower Third" layer), directly under TALLY and in no Layer
  // Set: takectl's hooks bring it in and out, so a Layer Set recall never fights them. Manual, not the
  // layer's default Automatic (which takes itself off after 6 s); no logo (that would keep a placeholder
  // source alive).
  L.lower = await ensureLayer(doc, "Lower Third", "lowerthirds", 1);
  await setInputs(doc, L.lower, { tvGroup_Control__Type: 0, tvGroup_Content__Title: "Lower Third", tvGroup_Content__Subtitle: "abswitch bench", tvGroup_Logo__Image: "" },
    `${label} layer Lower Third`);

  // Starting look: Cam Wide live (+ COUNTER on a bench build), everything else off, TALLY off (takectl owns it).
  for (const [k, on] of [["slides", false], ["wide", true], ["two", false], ["pip", false], ["counter", true], ["tally", false], ["lower", false]])
    if (L[k]) await setLayerLive(doc, L[k], on);

  await removeAutoPlaceholders(doc, label);
  for (const s of ["Speaker Wide", "Two Shot", "Slides PiP", "Full Slides"]) await ensureLayerSet(doc, s, label);

  // Video-only NDI output named after the document. No audio sources exist in A/B,
  // so the program mix it would carry is silent.
  await ensureOutput(doc, "com.boinx.mimoLive.outputDestination.ndi", label, label);
  return { doc, L };
}

async function ndiDeviceIdFor(masterDoc, srcId, title) {
  // NDI advertises "<HOST> (<title>)" with hyphens stripped from the title on 7.0b3
  // ("PH-A" -> "PHA"). Try both spellings; the read-back's video-device-connected decides.
  const host = hostname().toUpperCase().replace(/\.LOCAL$/, "") + ".LOCAL";
  const now = attrs((await get(`/documents/${masterDoc}/sources/${srcId}`)).data);
  if (now["video-device-connected"] && now["video-device-id"]?.startsWith(host)) return now["video-device-id"];
  for (const cand of [`${host} (${title.replace(/-/g, "")})`, `${host} (${title})`]) {
    await req("PUT", `/documents/${masterDoc}/sources/${srcId}`, { "video-device-id": cand });
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const a = attrs((await get(`/documents/${masterDoc}/sources/${srcId}`)).data);
      if (a["video-device-id"] === cand && a["video-device-connected"]) return cand;
    }
  }
  return null;
}

async function buildMaster(a, b) {
  const label = NAMES.M;
  log(`\n${label}`);
  const doc = await findDoc(label);
  await ensureSize(doc, label);

  const srcA = await ensureSource(doc, "NDI PH-A", "com.boinx.mimoLive.sources.deviceVideoSource");
  const srcB = await ensureSource(doc, "NDI PH-B", "com.boinx.mimoLive.sources.deviceVideoSource");
  const audio = await ensureSource(doc, "Audio In", "com.boinx.mimoLive.sources.deviceAudioSource");
  // The safe source PANIC cuts to (v0.2): on the bench, mimoLive's "Video Output Test" source showing the
  // Philips PM5544 pattern (Test Image 0), in switcher slot 3. A BENCH slate only: for a show, put a wide
  // camera wired straight into MASTER, or a holding slide, in that slot and choose it in setup.
  const safe = await ensureSource(doc, "SAFE Test Pattern", "com.boinx.boinxtv.layer.videooutputtest");
  await req("PUT", `/documents/${doc}/sources/${safe}`, { "input-values": { tvGroup_Content__Test_Image: 0 } });
  if (attrs((await get(`/documents/${doc}/sources/${safe}`)).data)["input-values"]?.tvGroup_Content__Test_Image !== 0)
    manual.push(`In ${label}, open source "SAFE Test Pattern" and choose Test Image "Philips PM5544".`);
  // A new Audio source has NO device. audio-device-id is the CoreAudio device UID; the
  // built-in mic is "BuiltInMicrophoneDevice". For the show, set AUDIO_DEVICE_ID to the
  // interface's UID or pick the interface on "Audio In" in the UI.
  const devId = process.env.AUDIO_DEVICE_ID || "BuiltInMicrophoneDevice";
  await setSource(doc, audio, { "audio-device-id": devId }, (a) => a["audio-device-id"] === devId && !!a["audio-device-name"],
    `In ${label}, open source "Audio In" and choose the audio input device (UID "${devId}" was not accepted).`);

  // A and B shows + their NDI outputs must be up before MASTER can bind to them.
  for (const d of [a.doc, b.doc]) await get(`/documents/${d}/setLive`);
  await sleep(1500);
  for (const [src, t] of [[srcA, "PH-A"], [srcB, "PH-B"]]) {
    const id = await ndiDeviceIdFor(doc, src, t);
    if (id) log(`  NDI ${t} -> "${id}"`);
    else manual.push(`In ${label}, open source "NDI ${t}" and pick the NDI sender for ${t} from the device list.`);
  }

  const sw = await ensureLayer(doc, "AB Switcher", "videoswitcher");
  // Source Count enum on 7.0b3 is ["9 Sources","4 Sources"]; 2 is not offered, so 4.
  // Slot 3 holds the safe source; slots 4..8 are cleared: a new switcher auto-fills them, and a
  // stray copy of an NDI source id there would confuse takectl's slot detection.
  const clear = Object.fromEntries("DEFGH".split("").map((c) => [`tvIn_VideoSource${c}Image`, ""]));
  await setInputs(doc, sw, {
    tvGroup_Control__Source_Count: 1, tvIn_TransitionDuration: 0.5,
    tvIn_VideoSourceAImage: srcA, tvIn_VideoSourceBImage: srcB, tvIn_VideoSourceCImage: safe, ...clear,
  }, `${label} layer AB Switcher`);
  // No audio on the switcher. On 7.0b3 the Video Switcher has no audio-follow-video input and
  // reports volume=null (no audio path), unlike Placer/PIP layers which report volume=1.
  const vol = attrs((await get(`/documents/${doc}/layers/${sw}`)).data).volume;
  if (vol === null || vol === undefined) log(`  AB Switcher reports no audio path (volume=${vol})`);
  else {
    await req("PUT", `/documents/${doc}/layers/${sw}`, { volume: 0 });
    const v2 = attrs((await get(`/documents/${doc}/layers/${sw}`)).data).volume;
    if (v2 !== 0) manual.push(`In ${label}, set the AB Switcher layer's volume to 0 (currently ${v2}).`);
  }

  await removeAutoPlaceholders(doc, label);
  const ao = await ensureLayer(doc, "Program Audio", "audioonly");
  await setInputs(doc, ao, { tvGroup_Source__Audio_TypeAudio: audio }, `${label} layer Program Audio`);
  await setLayerLive(doc, sw, true);
  await setLayerLive(doc, ao, true);

  // v0.2: STINGER (the default stinger: a slate wipe, no media needed) and FTB, both full-frame Boxes
  // above everything else and saved OFF. Created in this order so FTB ends up at the very top.
  const full = { tvGroup_Geometry__Top_Margin_TypeBoinxY: 0, tvGroup_Geometry__Bottom_Margin_TypeBoinxY: 0,
    tvGroup_Geometry__Left_Margin_TypeBoinxX: 0, tvGroup_Geometry__Right_Margin_TypeBoinxX: 0,
    tvGroup_Appearance__Type: 0, tvGroup_Appearance__Drop_Shadow: false };
  // Animation enums on 7.0b3 (no "-" separator): Incoming ["Cut","Dissolve","Push from Top","Push from
  // Bottom","Push from Left","Push from Right"]; Outgoing ["Same as Incoming","Cut","Dissolve","Push to
  // Top","Push to Bottom","Push to Left","Push to Right"].
  const stinger = await ensureLayer(doc, "STINGER", "simplebox");
  await setInputs(doc, stinger, { ...full, tvGroup_Appearance__Color: { red: 0.13, green: 0.15, blue: 0.2, alpha: 1 },
    tvGroup_Animation__Incoming: 4, tvGroup_Animation__Outgoing: 6, tvGroup_Animation__Duration_TypeDuration: 0.4 }, `${label} layer STINGER`);
  const ftb = await ensureLayer(doc, "FTB", "simplebox");
  await setInputs(doc, ftb, { ...full, tvGroup_Appearance__Color: { red: 0, green: 0, blue: 0, alpha: 1 },
    tvGroup_Animation__Incoming: 1, tvGroup_Animation__Outgoing: 0, tvGroup_Animation__Duration_TypeDuration: 0.5 }, `${label} layer FTB`);
  await setLayerLive(doc, stinger, false);
  await setLayerLive(doc, ftb, false);
  // v0.2 round 3: downstream keys. takectl turns every MASTER layer named "DSK <label>" above the switcher
  // into a toggle labelled <label>. Two on the bench, both off: a bug (mimoLive's Station Logo, top
  // right) and a clock (Date and Time, top left, time only). Inserted at index 1: under FTB, above the
  // stinger (as an ATEM's downstream keys sit above its transitions), so a bug stays up through a wipe.
  const bug = await ensureLayer(doc, "DSK Bug", "logo", 1);
  await setInputs(doc, bug, { tvGroup_Geometry__Anchor: 1 }, `${label} layer DSK Bug`);
  const clock = await ensureLayer(doc, "DSK Clock", "datentime", 1);
  await setInputs(doc, clock, { tvGroup_Geometry__Anchor: 0, tvGroup_Content__Date_Format_TypeMultiline: "%H:%M:%S" }, `${label} layer DSK Clock`);
  await setLayerLive(doc, bug, false);
  await setLayerLive(doc, clock, false);

  await ensureOutput(doc, "com.boinx.mimoLive.outputDestination.fileRecording", "Recording", label);
  for (const [src, name] of [[srcA, "NDI PH-A"], [srcB, "NDI PH-B"]]) await ensureCrop(doc, src, name, label);
  return { doc, sw };
}

// The TALLY bar must never reach air, so each NDI source in MASTER gets a Scale & Transform
// filter zoomed to 105 % (crops ~27 px top and bottom, ~48 px each side). The Video Switcher has
// no zoom input on 7.0b3. The API cannot ADD a filter (POST .../filters is 404), but a flat PUT
// sets the values of one that exists. Measured on MASTER's recording with A on air and TALLY
// lit: zoom 100 = 24 red rows, zoom 105 = none (test/evidence/master-pgm-A-zoom*.png).
// Mode must be Custom (0): the "1080p" preset hides Zoom. Its value-list includes a "-"
// separator that is NOT an index, so 1080p is 5, not 6.
const CROP_ZOOM = 105;
async function ensureCrop(doc, src, name, label) {
  const filters = (await get(`/documents/${doc}/sources/${src}/filters`)).data;
  const f = filters.find((x) => attrs(x)["composition-id"] === "com.boinx.boinxtv.filter.transform");
  if (!f) {
    manual.push(`In ${label}, add a "Scale & Transform" filter to source "${name}" and set Width 1920, Height 1080, Zoom ${CROP_ZOOM} (or add it with any settings and re-run this script, which sets them).`);
    return;
  }
  const iv = {
    tvGroup_Geometry__Mode: 0, tvGroup_Geometry__Width: W, tvGroup_Geometry__Height: H, tvGroup_Geometry__Zoom: CROP_ZOOM,
    tvGroup_Geometry__Crop_Top: 0, tvGroup_Geometry__Crop_Left: 0, tvGroup_Geometry__Crop_Bottom: 0, tvGroup_Geometry__Crop_Right: 0,
    tvGroup_Geometry__Position_X_TypeBoinxX: 0, tvGroup_Geometry__Position_Y_TypeBoinxY: 0, tvGroup_Geometry__Rotation: 0,
    tvGroup_Geometry__Mask_Top_TypeBoinxY: 0, tvGroup_Geometry__Mask_Left_TypeBoinxX: 0,
    tvGroup_Geometry__Mask_Bottom_TypeBoinxY: 0, tvGroup_Geometry__Mask_Right_TypeBoinxX: 0,
  };
  const path = `/documents/${doc}/sources/${src}/filters/${f.id}`;
  await req("PUT", path, { "input-values": iv });
  await sleep(300);
  const back = attrs((await get(path)).data);
  const missed = Object.keys(iv).filter((k) => !same(iv[k], back["input-values"]?.[k]));
  const out = `${back["output-values"]?.tvOut_FilterResultWidth}x${back["output-values"]?.tvOut_FilterResultHeight}`;
  if (missed.length || out !== `${W}x${H}`)
    manual.push(`In ${label}, set the Scale & Transform filter on "${name}" to Mode Custom, Width ${W}, Height ${H}, Zoom ${CROP_ZOOM}, everything else 0 (API write did not land: ${missed.join(", ") || "result " + out}).`);
  else log(`  ${name}: Scale & Transform zoom ${CROP_ZOOM} % (crops the ${TALLY_PX}-px TALLY bar)`);
}

const a = await buildComposition("A");
const b = await buildComposition("B");
const m = await buildMaster(a, b);
await get(`/documents/${m.doc}/setLive`);
// MASTER's Recording output starts with the show; a build is not a show, so stop it at once (otherwise
// every build leaves a recording in ~/Movies).
const recOut = (await get(`/documents/${m.doc}/output-destinations`)).data.find((o) => attrs(o).title === "Recording");
if (recOut) await get(`/documents/${m.doc}/output-destinations/${recOut.id}/setOff`);
log(`\nShows started: ${NAMES.A}, ${NAMES.B}, ${NAMES.M} (MASTER's Recording stopped).`);
// The API cannot record Layer Set contents. Ask for them only where a set is still empty (an
// empty set's `layers` list is []); recorded sets are left alone.
const emptySets = [];
for (const [r, label] of [[a, NAMES.A], [b, NAMES.B]]) for (const s of (await get(`/documents/${r.doc}/layer-sets`)).data) if (!attrs(s).layers?.length) emptySets.push(`${label}/${attrs(s).name}`);
if (!emptySets.length) log(`Layer Sets: all recorded (${NAMES.A}, ${NAMES.B}).`);
else manual.push(`Empty Layer Sets: ${emptySets.join(", ")}. In ${NAMES.A} and ${NAMES.B}, record each Layer Set with TALLY (and COUNTER, on a bench build) NOT AFFECTED (not recorded as off) and the other four layers explicitly on or off: Speaker Wide = Cam Wide on; Two Shot = Two Shot on; Slides PiP = Slides + Cam PiP on; Full Slides = Slides on; every other content layer off.`);
log(`\nMANUAL STEPS (${manual.length}):`);
manual.forEach((s, i) => log(`  ${i + 1}. ${s}`));
