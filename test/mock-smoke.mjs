#!/usr/bin/env node
// mock-smoke: takectl against test/mock-mimolive.mjs, offline. No mimoLive needed.
//   node test/mock-smoke.mjs
// Starts the mock on :18989 and takectl on :18991 (a temporary config copied from
// takectl.config.example.json with those ports), then: takectl starts and reads PGM from the mock's
// switcher; GET / serves operator.html; /take and back; /panic 200 ms into a /take; /take and /panic together; /panic 200 ms
// into a dissolve fired at the mock directly. Every case must end with the mock's live slot on A.
// This proves takectl runs against the mock and that the mock models the switcher's in-flight
// window. It is NOT evidence about mimoLive: that is panic-check / witness-check on the real app.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = dirname(HERE);
const MP = 18989, TP = 18991, B = `http://localhost:${MP}/api/v1`, T = `http://localhost:${TP}`;
const j = (u) => fetch(u).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };

const cfg = JSON.parse(readFileSync(join(ROOT, "takectl.config.example.json"), "utf8"));
for (const k of ["a", "b", "master"]) cfg[k].host = `http://localhost:${MP}`;
Object.assign(cfg, { port: TP, companion: { host: null }, pollMs: 5000 });
const dir = mkdtempSync(join(tmpdir(), "abswitch-mock-"));
writeFileSync(join(dir, "takectl.config.json"), JSON.stringify(cfg, null, 2));

const mock = spawn("node", [join(HERE, "mock-mimolive.mjs"), String(MP)], { stdio: "ignore" });
await sleep(500);
const tkLog = [];
const tk = spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: join(dir, "takectl.config.json") } });
tk.stdout.on("data", (d) => tkLog.push(String(d))); tk.stderr.on("data", (d) => tkLog.push(String(d)));
let st = null;
for (let i = 0; i < 40 && !st; i++) { await sleep(250); st = await j(`${T}/state`).catch(() => null); }

const sw = (await j(`${B}/documents/333/layers`)).data.find((l) => l.attributes.name === "AB Switcher").id;
const slot = async () => (await j(`${B}/documents/333/layers/${sw}`)).data.attributes["input-values"].tvGroup_Hidden_Inputs__currentLiveSource;
try {
  check(st?.pgm === "A" && st?.switcher?.slot === 1, `takectl started against the mock: pgm=${st?.pgm}, switcher ${JSON.stringify(st?.switcher)}`);
  const page = await fetch(`${T}/`);
  const html = await page.text();
  check(page.status === 200 && /text\/html/.test(page.headers.get("content-type")) && html === readFileSync(join(ROOT, "operator.html"), "utf8"),
    `GET / serves operator.html: HTTP ${page.status}, ${page.headers.get("content-type")}, ${html.length} bytes, identical to the file: ${html === readFileSync(join(ROOT, "operator.html"), "utf8")}`);
  let r = await j(`${T}/take`); await sleep(1200);
  check(r.ok && (await slot()) === 2 && (await j(`${T}/state`)).pgm === "B", `/take → B: mock slot ${await slot()}, pgm ${(await j(`${T}/state`)).pgm}`);
  r = await j(`${T}/take`); await sleep(1200);
  check(r.ok && (await slot()) === 1, `/take → A: mock slot ${await slot()}`);

  await j(`${T}/take`); const m1 = await j(`${T}/mirror`); await sleep(1200);
  await j(`${B}/documents/333/layers/${sw}/signals/tvGroup_Control__Dis_1_TypeSignal`); await sleep(150);
  const m2 = await j(`${T}/mirror`); await sleep(1000);
  const m3 = await j(`${T}/mirror`);
  check(m1.ok === false && /^busy/.test(m1.error) && m2.ok === false && /^busy/.test(m2.error) && m3.ok === true,
    `/mirror refused mid-TAKE (${m1.error}) and mid outside dissolve (${m2.error}); allowed once landed: ${JSON.stringify(m3)}`);

  await j(`${T}/take`); await sleep(200);
  let p = await j(`${T}/panic`);
  check(p.ok && p.rounds >= 2 && (await slot()) === 1, `/panic 200 ms into a /take: ${JSON.stringify(p)}, mock slot ${await slot()}`);
  await sleep(500);

  const [t2, p2] = await Promise.all([j(`${T}/take`), sleep(5).then(() => j(`${T}/panic`))]);
  await sleep(1200);
  check(!t2.ok && p2.ok && (await slot()) === 1, `/take and /panic together: take ${JSON.stringify(t2)}, panic ${JSON.stringify(p2)}, mock slot ${await slot()}`);

  await j(`${B}/documents/333/layers/${sw}/signals/tvGroup_Control__Dis_2_TypeSignal`); await sleep(200);
  p = await j(`${T}/panic`); await sleep(300);
  check(p.ok && p.rounds >= 2 && (await slot()) === 1, `/panic 200 ms into a dissolve fired at the mock: ${JSON.stringify(p)}, mock slot ${await slot()}`);
} finally {
  tk.kill(); mock.kill();
  say("takectl log:\n" + tkLog.join("").trim().split("\n").map((l) => "    " + l).join("\n"));
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(HERE, "mock-smoke.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
