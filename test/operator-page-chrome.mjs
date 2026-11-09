#!/usr/bin/env node
// operator-page-chrome: load the operator page in a real browser (the Mac's Google Chrome, headless,
// throwaway profile), check that both program-out pictures decode INSIDE the page, read the tiles'
// state, and save a screenshot at iPad-landscape size (1180 × 820 @2x).
//   node test/operator-page-chrome.mjs <page url> <out.png>      (takectl running)
// Writes the checks to test/operator-page-chrome.txt. The Claude app's browser pane cannot be used
// for the pictures: it refuses a page's sub-requests to a second origin (mimoLive's :8989).
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , url, png] = process.argv;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = mkdtempSync(join(tmpdir(), "abswitch-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", "--mute-audio", "about:blank"], { stdio: "ignore" });
let target = null;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => null); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const out = [];
const say = (s) => { out.push(s); console.log(s); };
try {
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1180, height: 820, deviceScaleFactor: 2, mobile: false });
  await cdp("Page.enable");
  await cdp("Page.navigate", { url });
  await sleep(5000); // the MJPEG <img>s never finish loading; give them a few frames
  const ev = await cdp("Runtime.evaluate", { returnByValue: true, expression: `(() => ({
    conn: document.body.dataset.conn,
    tiles: ["A","B"].map(x => { const i = document.getElementById("img"+x), t = document.getElementById("tile"+x);
      return { tile: x, border: t.dataset.border, role: document.getElementById("role"+x).textContent, feed: t.dataset.feed, picture: i.naturalWidth + "x" + i.naturalHeight, src: i.src.replace(/&t=\\d+/, "") }; }),
    layerSetButtons: [...document.querySelectorAll("#sets button")].map(b => b.textContent),
    status: { roles: document.getElementById("roles").textContent, last: document.getElementById("last").textContent, warning: document.getElementById("warning").textContent, error: document.getElementById("lastError").textContent }
  }))()` });
  const v = ev.result.result.value;
  say(`page ${url} in ${(await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json())).Browser} (headless, throwaway profile)`);
  say(JSON.stringify(v, null, 2));
  const ok = v.conn === "ok" && v.tiles.every((t) => t.feed === "ok" && !t.picture.startsWith("0x"));
  say(`${ok ? "PASS" : "FAIL"}  both program-out pictures decode inside the page (${v.tiles.map((t) => `${t.tile} ${t.picture}`).join(", ")})`);
  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(png, Buffer.from(shot.result.data, "base64"));
  say(`screenshot: ${png}`);
  writeFileSync(join(HERE, "operator-page-chrome.txt"), out.join("\n") + "\n");
  process.exitCode = ok ? 0 : 1;
} finally {
  ws.close(); chrome.kill();
}
