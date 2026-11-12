#!/usr/bin/env node
// panel-chrome: the operator panel (round 3) in a real browser: the Mac's Google Chrome, headless, with a
// throwaway profile. takectl must be running.
//   node test/panel-chrome.mjs <page url> <out.png> [width height scale] [--states] [--name <label>]
// Checks, at the given viewport (default 1440×900 @1x):
//   - one screen: the page does not scroll either way;
//   - every visible control is at least 44 × 44 px;
//   - both monitors show a picture that decoded in the page, and neither reads STALE;
//   - with --states, the same state changes as round 2 plus SAFE, FTB and a downstream key, driven through
//     takectl's routes, with every button's box compared after each: no key may move. Round 4 adds: a layer
//     ("Slides", or --hand <name>) switched straight through mimoLive's API in Program, as its window would
//     (CHANGED IN MIMOLIVE must show, whole, on the header strip), a real click on the strip (it clears), the
//     same layer put back (it shows again), a TAKE (it clears), and WATCH PGM clicked off and on.
// Look keys and monitors (release fix, 2026-11-12), at rest and after every state change: each look key is the
// whole 16:9 picture (fitted, never cropped) with its name in a band underneath, not over it; the slot number on
// the picture's top-left; every key the same size, empty or not; a key no taller than its picture plus its band;
// the NEXT key's white ring drawn all the way round (read from the pixels); each monitor's picture box exactly
// 16:9, and no bars beside a 16:9 frame in it.
// Writes test/panel-chrome-<label>.txt and the screenshot.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const STATES = args.includes("--states"); if (STATES) args.splice(args.indexOf("--states"), 1);
// --selftest: after the checks, break the page on purpose (no label band, a long reason on UNDO) and make
// sure the text checks catch it: a check that cannot fail proves nothing.
const SELFTEST = args.includes("--selftest"); if (SELFTEST) args.splice(args.indexOf("--selftest"), 1);
const LABEL = flag("--name") || "default";
const HAND = flag("--hand") || "Slides";
const [url, png, w = "1440", h = "900", scale = "1"] = args;
const T = new URL(url).origin;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };
const prof = mkdtempSync(join(tmpdir(), "abswitch-panel-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", "--mute-audio", "about:blank"], { stdio: "ignore" });
let target = null;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => null); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
const g = (p) => fetch(T + p).then((r) => r.json()).catch(() => ({}));
// Text checks (round 3 polish), run at rest and after every state change: a key's reason is never cut
// off; the subtitle is whole or hidden; the look keys' labels keep ≥ 4.5:1 contrast over the worst
// thumbnail (white, and black) under their band.
const TEXT = `(() => {
  const cut = (el) => el && el.offsetParent && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
  const reasons = ["undoWhy", "pushWhy", "mirrorWhy"].filter((id) => cut(document.getElementById(id))).map((id) => id + ": " + document.getElementById(id).textContent);
  const sub = document.querySelector("header .sub");
  const subBad = getComputedStyle(sub).visibility !== "hidden" && sub.scrollWidth > sub.clientWidth + 1;
  const rgba = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  let worst = 99, where = "";
  for (const key of document.querySelectorAll("#pvwBus .pvwkey:not([data-empty='1'])")) {
    for (const sel of [".nm", ".sub", ".num", ".cnt", ".next"]) {
      const el = key.querySelector(sel);
      if (!el || !el.textContent.trim() || !el.offsetParent) continue;
      let band = el; while (band !== key && (rgba(getComputedStyle(band).backgroundColor)[3] ?? 1) === 0) band = band.parentElement;
      const fg = rgba(getComputedStyle(el).color), bg = rgba(getComputedStyle(band).backgroundColor), a = bg[3] ?? 1;
      for (const under of [255, 0]) {
        const eff = [0, 1, 2].map((i) => a * bg[i] + (1 - a) * under);
        const r = ratio(fg, eff);
        if (r < worst) { worst = r; where = key.dataset.name + " " + sel + " over " + (under ? "white" : "black"); }
      }
    }
  }
  // the readout's LAST, UNDO, WARNING and ERROR lines are fully inside the visible part (RULE may give way)
  const box = document.querySelector(".readout .rtext")?.getBoundingClientRect();
  for (const id of ["rLast", "rUndo", "rWarn", "rErr"]) { const el = document.getElementById(id); if (box && el && !el.hidden && el.offsetParent && el.getBoundingClientRect().bottom > box.bottom + 1) reasons.push(id + " cut off in the readout: " + el.textContent); }
  // round 4: the strip over Program's header shows "CHANGED IN MIMOLIVE" / "NOT WATCHED" whole
  const strip = [...document.querySelectorAll(".wstrip")].find((x) => !x.hidden && x.offsetParent);
  if (strip) { const b = strip.querySelector("b"), sr = strip.getBoundingClientRect(), br = b.getBoundingClientRect(); if (br.right > sr.right + 1 || b.scrollWidth > b.clientWidth + 1) reasons.push("header strip cut: " + b.textContent); }
  return { reasons, subBad, worst: Math.round(worst * 10) / 10, where, strip: strip ? strip.id + ": " + strip.textContent.replace(/\\s+/g, " ").trim() : "" };
})()`;
// The picture of a key is its ".pic" (the release fix) or, in a build without one, the key itself.
const KEYS = `(async () => {
  const bad = [], note = [];
  const keys = [...document.querySelectorAll("#pvwBus .pvwkey")];
  const sizes = [...new Set(keys.map((k) => { const r = k.getBoundingClientRect(); return Math.round(r.width) + "x" + Math.round(r.height); }))];
  if (sizes.length > 1) bad.push("keys differ in size: " + sizes.join(" "));
  let thumbs = 0, keyH = 0, picWH = ""; const nexts = [];
  for (const [i, k] of keys.entries()) {
    const name = k.dataset.name || "slot " + (i + 1);
    const pic = k.querySelector(".pic") || k, band = k.querySelector(".band"), num = k.querySelector(".num");
    const kr = k.getBoundingClientRect(), p = pic.getBoundingClientRect(), cs = getComputedStyle(k);
    keyH = Math.round(kr.height); picWH = Math.round(p.width) + "x" + Math.round(p.height);
    if (Math.abs(p.width * 9 / 16 - p.height) > 1) bad.push(name + ": picture " + p.width.toFixed(1) + "x" + p.height.toFixed(1) + " is not 16:9");
    if (!band || getComputedStyle(band).display === "none") { if (k.dataset.empty !== "1") bad.push(name + ": no name band"); }
    else {
      const b = band.getBoundingClientRect();
      if (b.top < p.bottom - 0.5 && b.bottom > p.top + 0.5) bad.push(name + ": the name band covers the picture (" + Math.round(p.bottom - b.top) + " px)");
      const bw = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      if (pic !== k && kr.height > p.height + b.height + bw + 1) bad.push(name + ": key stretched to " + Math.round(kr.height) + " px, picture + band are " + Math.round(p.height + b.height + bw));
    }
    // ruling 2026-11-12: only the slot number on the picture; the count and NEXT in the band, whole
    for (const sel of [".cnt", ".next"]) {
      const t = k.querySelector(sel);
      if (!t || t.hidden || !t.offsetParent || !t.textContent.trim()) continue;
      const tr = t.getBoundingClientRect(), b = band.getBoundingClientRect();
      if (tr.bottom > p.top + 0.5 && tr.top < p.bottom - 0.5 && tr.right > p.left + 0.5 && tr.left < p.right - 0.5) bad.push(name + ": " + t.textContent + " sits on the picture");
      else if (tr.left < b.left - 0.5 || tr.right > b.right + 0.5 || tr.top < b.top - 0.5 || tr.bottom > b.bottom + 0.5 || t.scrollWidth > t.clientWidth + 1) bad.push(name + ": " + t.textContent + " not whole in the band");
    }
    const nx = k.querySelector(".next"), nmEl = k.querySelector(".nm");
    if (k.dataset.next === "1" && nx && nmEl && band) {
      const wasHidden = nx.hidden; nx.hidden = false;
      const tr = nx.getBoundingClientRect(), b = band.getBoundingClientRect(), pr = parseFloat(getComputedStyle(band).paddingRight);
      const rg = document.createRange(); rg.selectNodeContents(nmEl);
      const lines = [...rg.getClientRects()].filter((r) => r.width > 0);
      const fits = lines.length > 0 && nmEl.scrollHeight <= nmEl.clientHeight + 1 && Math.max(...lines.map((r) => r.right)) + 0.3 * parseFloat(getComputedStyle(document.documentElement).fontSize) + nx.offsetWidth <= b.right - pr + 0.5;
      nx.hidden = wasHidden;
      if (wasHidden && fits) bad.push(name + ": NEXT dropped though it fits beside the name");
      if (!wasHidden) {
        if (!fits) bad.push(name + ": NEXT shown where it does not fit beside the name");
        if (lines.some((r) => r.right > tr.left - 0.5 && r.left < tr.right + 0.5 && r.bottom > tr.top + 0.5 && r.top < tr.bottom - 0.5)) bad.push(name + ": NEXT over the name");
      }
      nexts.push(name + (wasHidden ? " (ring; the word dropped: no room)" : " (ring and the word)"));
    }
    const nr = num.getBoundingClientRect();
    // on the picture, at its top-left corner (on an iPad the picture is ~34 px tall: the chip is a third of it)
    if (nr.left < p.left - 0.5 || nr.top < p.top - 0.5 || nr.right > p.right + 0.5 || nr.bottom > p.bottom + 0.5 || nr.left - p.left > 8 || nr.top - p.top > 8) bad.push(name + ": slot number not on the picture's top-left corner");
    const bg = getComputedStyle(pic).backgroundImage;
    if (bg && bg !== "none") {
      thumbs++;
      const im = new Image(); im.src = bg.slice(5, -2); await im.decode().catch(() => {});
      const fit = getComputedStyle(pic).backgroundSize, ar = im.naturalWidth / im.naturalHeight, box = p.width / p.height;
      if (!im.naturalWidth) bad.push(name + ": thumbnail did not decode");
      else if (fit !== "contain") {
        const shown = fit === "cover" ? Math.min(ar, box) / Math.max(ar, box) : 1; // the part of the picture left showing
        if (fit !== "cover" || shown < 0.99) bad.push(name + ": thumbnail " + im.naturalWidth + "x" + im.naturalHeight + " cropped (" + fit + "): " + Math.round(shown * 100) + "% shown");
      } else if (Math.abs(ar - 16 / 9) > 0.02) note.push(name + ": thumbnail " + im.naturalWidth + "x" + im.naturalHeight + " is not 16:9 (shown whole, with bars)");
    }
  }
  // the monitors: the picture box is 16:9, and a 16:9 frame fills it (no bars beside it)
  const mons = ["pgm", "pvw"].map((m) => {
    const pic = document.querySelector("#" + m + "Mon .pic"), r = pic.getBoundingClientRect();
    const img = [0, 1].map((i) => document.getElementById(m + i)).find((x) => !x.hidden);
    const nat = img && img.naturalWidth > 16 ? img.naturalWidth / img.naturalHeight : null;
    const bars = nat ? Math.max(0, r.width - r.height * nat) / 2 : null;
    if (Math.abs(r.width * 9 / 16 - r.height) > 1) bad.push(m + " monitor: picture box " + r.width.toFixed(1) + "x" + r.height.toFixed(1) + " is not 16:9");
    if (bars !== null && bars > 1) bad.push(m + " monitor: bars of " + bars.toFixed(1) + " px beside the picture");
    return m + " " + Math.round(r.width) + "x" + Math.round(r.height) + (bars === null ? " (frame not measured)" : " bars " + bars.toFixed(1));
  });
  const steps = document.querySelector(".steps")?.getBoundingClientRect(), util = document.querySelector(".util > button")?.getBoundingClientRect();
  const lastKey = keys[keys.length - 1]?.getBoundingClientRect();
  if (steps && lastKey && lastKey.bottom > steps.top + 0.5) bad.push("look keys run into the steps strip");
  return { bad, note, thumbs, nexts, keys: keys.length, size: sizes.join(" "), pic: picWH, keyH, mons,
    gap: steps && lastKey ? Math.round(steps.top - lastKey.bottom) : null, below: steps && util ? Math.round(steps.height) + "/" + Math.round(util.height) : "" };
})()`;
// The NEXT key's white ring, read from a screenshot of the key: white at the middle of each edge, over the
// picture and over the name band.
const ring = async () => {
  const r = await evalJs(`(() => { const k = document.querySelector('#pvwBus .pvwkey[data-next="1"]'); if (!k) return null; const b = k.getBoundingClientRect(); return { name: k.dataset.name, x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
  if (!r) return null;
  const shot = await cdp("Page.captureScreenshot", { format: "png", clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } });
  const pts = [["top", r.w / 2, 3.5], ["bottom", r.w / 2, r.h - 3.5], ["left over the picture", 3.5, r.h * 0.3], ["right over the picture", r.w - 3.5, r.h * 0.3], ["left over the band", 3.5, r.h * 0.85], ["right over the band", r.w - 3.5, r.h * 0.85]];
  const px = await evalJs(`(async () => { const im = new Image(); im.src = "data:image/png;base64,${shot.result.data}"; await im.decode();
    const c = document.createElement("canvas"); c.width = im.width; c.height = im.height; const x = c.getContext("2d"); x.drawImage(im, 0, 0); const k = im.width / ${r.w};
    return ${JSON.stringify(pts)}.map(([w, px, py]) => [w, [...x.getImageData(Math.round(px * k), Math.round(py * k), 1, 1).data].slice(0, 3)]); })()`);
  const dark = px.filter(([, c]) => Math.min(...c) < 200);
  return { name: r.name, ok: !dark.length, dark: dark.map(([w, c]) => `${w} rgb(${c.join(",")})`) };
};
const RECTS = `(() => Object.fromEntries([...document.querySelectorAll("button")].filter(b => b.offsetParent).map((b, i) => [b.id || (b.dataset.name !== undefined ? "key" + [...b.parentNode.children].indexOf(b) : b.dataset.label ? "dsk:" + b.dataset.label : "b" + i), (r => [r.x, r.y, r.width, r.height].map(Math.round).join(","))(b.getBoundingClientRect())])))()`;
try {
  await cdp("Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: Number(scale), mobile: false });
  await cdp("Page.enable");
  await cdp("Page.navigate", { url });
  await sleep(4000);
  say(`page ${url} at ${w}×${h} @${scale}x in ${(await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json())).Browser}`);
  const v = await evalJs(`(() => ({
    conn: document.body.dataset.conn, view: document.body.dataset.view || "",
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight, innerWidth, innerHeight],
    small: [...document.querySelectorAll("button, a.lamp, select")].filter(b => b.offsetParent && getComputedStyle(b).visibility !== "hidden").map(b => [b.id || b.textContent.trim().slice(0, 16), Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]).filter(([, bw, bh]) => bw < 44 || bh < 44),
    buttons: [...document.querySelectorAll("button")].filter(b => b.offsetParent).length,
    outside: [...document.querySelectorAll("button, a.lamp, select, #status, .mon, .readout, .block")].filter(b => b.offsetParent && getComputedStyle(b).visibility !== "hidden").map(b => [b.id || b.className || b.textContent.trim().slice(0, 16), b.getBoundingClientRect()]).filter(([, r]) => r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5).map(([k, r]) => [k, Math.round(r.right), Math.round(r.bottom)]),
    pics: ["pgm", "pvw"].map(p => { const imgs = [0, 1].map(i => document.getElementById(p + i)); const shown = imgs.find(i => !i.hidden) || imgs[0]; return { mon: p, picture: shown.naturalWidth + "x" + shown.naturalHeight, stale: document.getElementById(p + "Mon").dataset.stale || "" }; }),
    headers: [document.getElementById("pgmHdr").textContent, document.getElementById("pvwHdr").textContent],
    status: document.getElementById("status").textContent,
  }))()`);
  say(JSON.stringify(v));
  check(v.conn === "ok", `takectl answered (conn ${v.conn})`);
  check(v.scroll[0] <= v.scroll[2] && v.scroll[1] <= v.scroll[3], `one screen: page ${v.scroll[0]}×${v.scroll[1]} in a ${v.scroll[2]}×${v.scroll[3]} viewport`);
  check(!v.outside.length, `nothing is cut off at the edges${v.outside.length ? `: ${JSON.stringify(v.outside)}` : ""}`);
  check(!v.small.length, `every visible control ≥ 44 px (${v.buttons} buttons)${v.small.length ? `; too small: ${JSON.stringify(v.small)}` : ""}`);
  const tx = await evalJs(TEXT);
  check(!tx.reasons.length && !tx.subBad, `reasons whole on their keys, subtitle whole or hidden${tx.reasons.length || tx.subBad ? `: ${JSON.stringify(tx)}` : ""}`);
  check(tx.worst >= 4.5, `look-key labels ≥ 4.5:1 over any thumbnail: worst ${tx.worst}:1 (${tx.where})`);
  check(v.pics.every((p) => !p.picture.startsWith("0x") && !p.stale), `both monitors show a live picture: ${v.pics.map((p) => `${p.mon} ${p.picture}${p.stale ? " STALE" : ""}`).join(", ")}`);
  const ky = await evalJs(KEYS);
  check(!ky.bad.length, `look keys: ${ky.keys} keys, all ${ky.size}, picture ${ky.pic} (16:9, ${ky.thumbs} with a thumbnail, fitted, never cropped), name band underneath, slot number on the picture, keys not stretched${ky.bad.length ? ": " + ky.bad.slice(0, 6).join("; ") : ""}`);
  check(!ky.bad.some((b) => /monitor/.test(b)), `monitors exactly 16:9, no bars beside the picture: ${ky.mons.join(", ")}`);
  say(`   rows below the keys: ${ky.gap} px left free above the steps strip; steps strip / utility key heights ${ky.below} px${ky.note.length ? "; " + ky.note.join("; ") : ""}`);
  const rg = await ring();
  if (rg) check(rg.ok, `the NEXT key ("${rg.name}") has its white ring all the way round${rg.ok ? "" : ": dark at " + rg.dark.join(", ")}; ${ky.nexts.join(", ")}`);
  else say("   no NEXT key at rest");
  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(png, Buffer.from(shot.result.data, "base64"));
  say(`screenshot: ${png.split("/").pop()}`); // the file name only: a full path would name this Mac's user

  if (SELFTEST) {
    const broken = await evalJs(`(() => { const st = document.createElement("style"); st.textContent = ".pvwkey .band, .pvwkey .num, .pvwkey .cnt { background: transparent !important; }"; document.head.append(st);
      const u = document.getElementById("undoWhy"); u.textContent = "Preview changed since the TAKE: Layer Set \\"Slides PiP\\" recalled"; return ${TEXT}; })()`);
    check(broken.worst < 4.5 && broken.reasons.length > 0, `selftest: with the band removed the contrast check reads ${broken.worst}:1 (${broken.where}); a long reason on UNDO is caught: ${JSON.stringify(broken.reasons)}`);
    const fit = await evalJs(`(() => { const k = document.querySelector('#pvwBus .pvwkey[data-next="1"]'); if (!k || typeof fitNext !== "function") return null;
      const nm = k.querySelector(".nm"), was = nm.textContent, tag = k.querySelector(".next"), out = {};
      nm.textContent = "Cam"; fitNext(k); out.short = !tag.hidden && tag.scrollWidth <= tag.clientWidth + 1 && tag.getBoundingClientRect().right <= k.querySelector(".band").getBoundingClientRect().right;
      nm.textContent = "Speaker Wide Angle Left Camera"; fitNext(k); out.long = tag.hidden;
      nm.textContent = was; fitNext(k); return out; })()`);
    if (fit) check(fit.short && fit.long, `selftest: NEXT shows whole beside a short name ("Cam": ${fit.short}) and is dropped beside a long one (${fit.long})`);
    else say("   selftest: no NEXT key (or no fitNext) to try the word NEXT on");
    const crop = await evalJs(`(async () => { const st = document.createElement("style"); st.textContent = ".pvwkey .pic { background-size: cover !important; aspect-ratio: auto !important; height: 7rem !important; } .mon .pic { aspect-ratio: auto !important; height: 30vh !important; }"; document.head.append(st); return ${KEYS}; })()`);
    check(crop.bad.some((b) => /cropped|not 16:9/.test(b)) && crop.bad.some((b) => /monitor/.test(b)), `selftest: tall cropped keys and a non-16:9 monitor are caught: ${crop.bad.slice(0, 3).join("; ")}`);
    await cdp("Page.reload"); await sleep(3000);
  }
  if (STATES) {
    const base = await evalJs(RECTS);
    // Round 4 steps: "hand" switches HAND straight through mimoLive's API in Program's document (flips it);
    // "tap:<id>" is a real mouse click on that element's centre.
    const hand = async () => {
      const st = await g("/state"), d = st.docs?.[st.pgm];
      if (!d) return { ok: false, error: "no document on air" };
      const api = `${d.host.replace(/\/$/, "")}/api/v1/documents/${d.id}`;
      const l = (await fetch(`${api}/layers`).then((r) => r.json())).data.find((x) => x.attributes.name === HAND);
      if (!l) return { ok: false, error: `no layer "${HAND}"` };
      const on = !["live", "startup"].includes(l.attributes["live-state"]);
      await fetch(`${api}/layers/${l.id}/${on ? "setLive" : "setOff"}`);
      return { ok: true, did: `${HAND} ${on ? "on" : "off"}` };
    };
    const tap = async (id) => {
      const c = await evalJs(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e || e.hidden || !e.offsetParent) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      if (!c) return { ok: false, error: `#${id} not shown` };
      for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: c[0], y: c[1], button: "left", clickCount: 1 });
      return { ok: true };
    };
    const strip = () => evalJs(`(() => { const a = document.getElementById("pgmAck"); return a && !a.hidden && a.offsetParent ? a.textContent.replace(/\\s+/g, " ").trim() : ""; })()`);
    const lampOn = () => evalJs(`document.getElementById("watchPgm").dataset.on`);
    const steps = [["/take", 1500], ["/steps/record?on=1", 300], ["/pvw/layer-set/Slides%20PiP", 1600], ["/steps/add", 300], ["/transition?mode=stinger", 300], ["/push", 1800],
      ["/take", 1800], ["/take", 1800], ["/ftb?on=1", 1200], ["/dsk/Bug?on=1", 500], ["/ftb?on=0", 1200], ["/dsk/Bug?on=0", 500], ["/transition?mode=mix", 300], ["/steps/push?pace=instant", 2500],
      ["/panic", 1500], ["/safe/target?doc=A", 600], ["/take", 1500], ["/steps/clear", 300], ["/steps/record?on=0", 300],
      // round 4
      ["hand", 2000, async () => /CHANGED IN MIMOLIVE/i.test(await strip())], ["tap:pgmAck", 1500, async () => !(await strip())],
      ["hand", 2000, async () => /CHANGED IN MIMOLIVE/i.test(await strip())], ["/take", 1800, async () => !(await strip())],
      ["tap:watchPgm", 1200, async () => (await lampOn()) === "0"], ["tap:watchPgm", 1200, async () => (await lampOn()) === "1"]];
    const moved = [], textBad = [], expectBad = [], keyBad = [], ringBad = []; let rings = 0;
    let worstAll = 99, worstWhere = "";
    for (const [r, ms, expect] of steps) {
      const res = r === "hand" ? await hand() : r.startsWith("tap:") ? await tap(r.slice(4)) : await g(r);
      await sleep(ms);
      const now = await evalJs(RECTS);
      for (const k of Object.keys(base)) if (now[k] !== undefined && now[k] !== base[k]) moved.push(`${r}: ${k} ${base[k]} → ${now[k]}`);
      const tt = await evalJs(TEXT);
      if (tt.worst < worstAll) { worstAll = tt.worst; worstWhere = `${tt.where}, after ${r}`; }
      if (tt.reasons.length || tt.subBad || tt.worst < 4.5) textBad.push(`${r}: ${JSON.stringify(tt)}`);
      const kk = await evalJs(KEYS);
      if (kk.bad.length) keyBad.push(`${r}: ${kk.bad.slice(0, 3).join("; ")}`);
      const rr = await ring(); if (rr) { rings++; if (!rr.ok) ringBad.push(`${r}: ${rr.name} dark at ${rr.dark.join(", ")}`); }
      if (expect && !(await expect())) expectBad.push(`${r}${res.did ? ` (${res.did})` : ""}: strip "${tt.strip}", WATCH PGM ${await lampOn()}`);
      say(`   ${r}${res.did ? ` (${res.did})` : ""} → ${res.ok === false ? "refused: " + res.error : "ok"}${tt.strip ? `   [${tt.strip}]` : ""}`);
    }
    check(!textBad.length, `reasons whole, header strip whole and labels readable in every state; worst label contrast across them ${worstAll}:1 (${worstWhere})${textBad.length ? ": " + textBad.slice(0, 4).join("; ") : ""}`);
    check(!expectBad.length, `round 4 on the panel: a hand change in Program shows CHANGED IN MIMOLIVE on the header strip, a click on it clears it, the next hand change shows it again, TAKE clears it, WATCH PGM clicks off and on${expectBad.length ? ": " + expectBad.join("; ") : ""}`);
    check(!keyBad.length, `look keys and monitors as at rest in every state (whole 16:9 pictures, band underneath, same size, monitors 16:9 without bars)${keyBad.length ? ": " + keyBad.slice(0, 4).join("; ") : ""}`);
    check(!ringBad.length, `the NEXT ring is white all the way round in every state that had a NEXT key (${rings} of ${steps.length})${ringBad.length ? ": " + ringBad.slice(0, 3).join("; ") : ""}`);
    check(!moved.length, `no key moved across ${steps.length} state changes (TAKE, record, recall, add, STINGER, PUSH, TAKEs, FTB on/off, a DSK on/off, MIX, steps push, PANIC, SAFE target, TAKE out of SAFE, a hand change in Program, a click on the strip, another hand change, TAKE, WATCH PGM off/on)${moved.length ? ": " + moved.slice(0, 6).join("; ") : ""}`);
  }
} finally {
  ws.close(); chrome.kill();
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(HERE, `panel-chrome-${LABEL}.txt`), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
