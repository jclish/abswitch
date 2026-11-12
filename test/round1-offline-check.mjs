#!/usr/bin/env node
// round1-offline-check: v0.2 round 1 against test/mock-mimolive.mjs, offline (no mimoLive needed).
//   node test/round1-offline-check.mjs          (nothing else on :8991 or :18989)
// S. setup mode: no config → / redirects to /setup, /state says not ready, actions refused; /setup
//    lists the mock's documents and suggests the sources and switcher; Save refuses bad choices,
//    writes the config for good ones, and takectl starts running; a second Save is refused.
// D. doctor: every check green on the mock; mimoLive gone → red with a fix, the summary in /state
//    turns failing, and `takectl doctor` exits 1.
// F. hidden-key fallback: the mock without the live-slot key and per-slot codes → takectl still
//    starts, says it runs on source tally (permanent warning), doctor shows both keys red, and
//    TAKE and PANIC still land.
// L. start.command: no Node → says what to install; Node 20 → says so; real Node → starts takectl
//    and opens the page; already running → just opens the page.
// The mock is evidence about takectl's own logic only; the real-app checks are round1-check.mjs.
// TAKECTL_DIR=<dir> runs another takectl.mjs (used to run the same checks against v0.1.1).
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const OUT = process.env.TAKECTL_DIR ? join(ROOT, "out") : HERE;
mkdirSync(OUT, { recursive: true });
const MP = 18989, MOCK = `http://localhost:${MP}`, T = "http://localhost:8991";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u, o) => fetch(u, o).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.text() })).catch((e) => ({ status: 0, body: String(e) }));
const json = async (u, o) => { const r = await get(u, o); try { return { status: r.status, ...JSON.parse(r.body) }; } catch { return { status: r.status, raw: r.body }; } };
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; };

const dir = mkdtempSync(join(tmpdir(), "abswitch-r1-"));
const cfgFile = join(dir, "takectl.config.json");
const procs = [];
const startMock = (...flags) => { const p = spawn("node", [join(HERE, "mock-mimolive.mjs"), String(MP), ...flags], { stdio: "ignore" }); procs.push(p); return p; };
const startTk = () => { const p = spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: cfgFile }, stdio: ["ignore", "pipe", "pipe"] }); let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d)); p.log = () => log; procs.push(p); return p; };
const stop = async (p) => { if (p && p.exitCode === null && p.signalCode === null) { const gone = new Promise((r) => p.once("exit", r)); p.kill(); await gone; } };

try {
  // ---- S: setup mode
  let mock = startMock();
  await sleep(500);
  let tk = startTk();
  await until(async () => (await get(`${T}/state`)).status, 6000);
  const root = await get(`${T}/`, { redirect: "manual" });
  const st0 = await json(`${T}/state`), take0 = await json(`${T}/take`);
  check(root.status === 302 && root.headers?.get("location") === "/setup" && st0.ready === false && st0.mode === "setup" && take0.status === 503,
    `S1. no config: / → ${root.status} ${root.headers?.get?.("location")}, /state ready=${st0.ready} mode=${st0.mode}, /take → ${take0.status} ${JSON.stringify(take0.error ?? "")}${tk.exitCode !== null ? ` (takectl exited: ${tk.log().trim().slice(0, 120)})` : ""}`);
  const page = await get(`${T}/setup`);
  const docs = await json(`${T}/setup/documents?host=${encodeURIComponent(MOCK)}`);
  check(page.status === 200 && /abswitch setup/.test(page.body) && docs.ok && docs.documents?.map((d) => d.name).join(",") === "PH-A.tvshow,PH-B.tvshow,PH-MASTER.tvshow",
    `S2. /setup page ${page.status}; documents on the mock: ${JSON.stringify(docs.documents?.map((d) => d.name))}`);
  const id = (n) => docs.documents?.find((d) => d.name.startsWith(n))?.id;
  const q = new URLSearchParams({ host: MOCK, id: id("PH-MASTER") ?? "", aHost: MOCK, aId: id("PH-A") ?? "", aName: "PH-A.tvshow", bHost: MOCK, bId: id("PH-B") ?? "", bName: "PH-B.tvshow" });
  const m = await json(`${T}/setup/master?${q}`);
  check(m.ok && m.suggest?.sourceNameA === "NDI PH-A" && m.suggest?.sourceNameB === "NDI PH-B" && m.suggest?.switcherLayerName === "AB Switcher",
    `S3. suggestions: ${JSON.stringify(m.suggest)}`);
  const body = (o = {}) => JSON.stringify({ a: { host: MOCK, documentName: "PH-A.tvshow" }, b: { host: MOCK, documentName: "PH-B.tvshow" },
    master: { host: MOCK, documentName: "PH-MASTER.tvshow", sourceNameA: "NDI PH-A", sourceNameB: "NDI PH-B" }, switcherLayerName: "AB Switcher", ...o });
  const post = (b) => json(`${T}/setup/save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: b });
  const same = await post(body({ b: { host: MOCK, documentName: "PH-A.tvshow" } }));
  const badSrc = await post(body({ master: { host: MOCK, documentName: "PH-MASTER.tvshow", sourceNameA: "NDI NOPE", sourceNameB: "NDI PH-B" } }));
  check(same.status === 400 && badSrc.status === 400 && /NDI NOPE/.test(badSrc.error ?? "") && !existsSync(cfgFile),
    `S4. refused: A=B → ${same.status} ${JSON.stringify(same.error)}; unknown source → ${badSrc.status} ${JSON.stringify((badSrc.error ?? "").slice(0, 90))}; no config written`);
  const good = await post(body());
  const ready = await until(async () => { const s = await json(`${T}/state`); return s.ready !== false && s.pgm ? s : null; }, 8000);
  const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : null;
  check(good.ok && cfg?.a?.documentName === "PH-A.tvshow" && cfg?.master?.sourceNameB === "NDI PH-B" && cfg?.switcherLayerName === "AB Switcher" && cfg?.master?.host === MOCK && ready?.pgm === "A",
    `S5. saved ${good.saved}: a=${cfg?.a?.documentName} master=${cfg?.master?.documentName} sources=${cfg?.master?.sourceNameA}/${cfg?.master?.sourceNameB} switcher=${cfg?.switcherLayerName}; running, pgm=${ready?.pgm}`);
  const again = await post(body());
  const info = await json(`${T}/setup/info`);
  check(again.status === 409 && info.configured === true, `S6. second Save → ${again.status} ${JSON.stringify((again.error ?? "").slice(0, 70))}; /setup shows the saved setup`);

  // ---- D: doctor
  let d = await json(`${T}/doctor.json`);
  check(d.ok === true && d.checks?.length >= 15 && d.checks.every((c) => c.ok), `D1. /doctor.json on the mock: ${d.checks?.filter((c) => c.ok).length}/${d.checks?.length} green`);
  const dpage = await get(`${T}/doctor`);
  await stop(mock);
  d = await json(`${T}/doctor.json`);
  const red = d.checks?.filter((c) => !c.ok) ?? [];
  const st1 = await json(`${T}/state`);
  const cli = spawnSync("node", [join(ROOT, "takectl.mjs"), "doctor"], { env: { ...process.env, TAKECTL_CONFIG: cfgFile }, encoding: "utf8" });
  check(dpage.status === 200 && red.length >= 1 && red.every((c) => c.fix) && /mimoLive answers at/.test(red[0]?.label) && st1.doctor?.ok === false && cli.status === 1 && /✗ mimoLive answers at/.test(cli.stdout),
    `D2. mock stopped: ${red.length} red, first "${red[0]?.label}" → "${red[0]?.fix}"; /state.doctor.ok=${st1.doctor?.ok}; CLI exit ${cli.status}`);
  await stop(tk);

  // ---- F: hidden-key fallback
  mock = startMock("--no-slot-keys");
  await sleep(500);
  tk = startTk();
  const fs = await until(async () => { const s = await json(`${T}/state`); return s.ready !== false && s.pgm ? s : null; }, 8000);
  d = await json(`${T}/doctor.json`);
  const keysRed = ["liveslot", "slotcodes"].every((k) => d.checks?.find((c) => c.id === k)?.ok === false);
  check(fs?.truth === "source tally" && /running on source tally/.test(fs?.warning ?? "") && keysRed,
    `F1. keys absent: started (pgm=${fs?.pgm}), truth="${fs?.truth}", warning=${JSON.stringify(fs?.warning)}, doctor live-slot/codes red=${keysRed}`);
  const tk1 = await json(`${T}/take`);
  await sleep(1500);
  const after = await json(`${T}/state`);
  const p = await json(`${T}/panic`);
  const afterP = await json(`${T}/state`);
  check(tk1.ok && after.pgm === "B" && !after.lastError && p.ok && afterP.pgm === "A",
    `F2. on source tally: /take → pgm ${after.pgm}, lastError ${JSON.stringify(after.lastError)}; /panic → ${JSON.stringify({ ok: p.ok, rounds: p.rounds })}, pgm ${afterP.pgm}`);
  await stop(tk);
  await stop(mock);

  // ---- L: start.command
  const sc = join(ROOT, "start.command");
  const stub = join(dir, "bin"); mkdirSync(stub);
  writeFileSync(join(stub, "open"), `#!/bin/bash\necho "$@" >> "${join(dir, "opened.txt")}"\n`); chmodSync(join(stub, "open"), 0o755);
  const old = join(dir, "old"); mkdirSync(old);
  writeFileSync(join(old, "node"), `#!/bin/bash\n[ "$1" = "-p" ] && echo 20\n[ "$1" = "-v" ] && echo v20.11.0\nexit 0\n`); chmodSync(join(old, "node"), 0o755);
  const run = (path) => spawnSync("bash", [sc], { env: { ...process.env, PATH: path, ABSWITCH_NO_DIALOG: "1", ABSWITCH_EXTRA_PATH: "", TAKECTL_CONFIG: cfgFile }, encoding: "utf8", timeout: 15000 });
  const none = run("/usr/bin:/bin"), v20 = run(`${old}:/usr/bin:/bin`);
  check(existsSync(sc) && none.status === 1 && /needs Node\.js 22 or later/.test(none.stdout) && /nodejs\.org/.test(none.stdout) && v20.status === 1 && /this Mac has v20\.11\.0/.test(v20.stdout),
    `L1. no Node → exit ${none.status}: ${JSON.stringify(none.stdout.trim().slice(0, 80))}; Node 20 → exit ${v20.status}: ${JSON.stringify(v20.stdout.trim().slice(0, 70))}`);
  mock = startMock();
  await sleep(400);
  const nodeDir = dirname(process.execPath);
  const launched = spawn("bash", [sc], { env: { ...process.env, PATH: `${stub}:${nodeDir}:/usr/bin:/bin`, ABSWITCH_NO_DIALOG: "1", ABSWITCH_EXTRA_PATH: "", TAKECTL_CONFIG: cfgFile }, stdio: "ignore" });
  procs.push(launched);
  const opened = await until(async () => existsSync(join(dir, "opened.txt")) && readFileSync(join(dir, "opened.txt"), "utf8"), 12000);
  const up = await json(`${T}/state`);
  const second = spawnSync("bash", [sc], { env: { ...process.env, PATH: `${stub}:${nodeDir}:/usr/bin:/bin`, ABSWITCH_NO_DIALOG: "1", ABSWITCH_EXTRA_PATH: "", TAKECTL_CONFIG: cfgFile }, encoding: "utf8", timeout: 10000 });
  const openedNow = readFileSync(join(dir, "opened.txt"), "utf8").trim().split("\n");
  check(/^http:\/\/localhost:8991\/$/m.test(opened || "") && up.ready !== false && second.status === 0 && /already running/.test(second.stdout) && openedNow.length === 2,
    `L2. real Node: takectl started (ready=${up.ready !== false}), page opened at ${JSON.stringify((opened || "").trim())}; second double-click → exit ${second.status} "${second.stdout.trim()}", opens: ${openedNow.length}`);
} finally {
  for (const p of procs.reverse()) await stop(p);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "round1-offline-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
