#!/usr/bin/env node
// offline-ports-check: the guards in offline-ports.mjs, and every offline suite's use of them. Ruled 2026-11-14:
// an isolated port, and a test that owns the process it starts and never talks to, or stops, an operator's takectl.
//   node test/offline-ports-check.mjs              (needs :18989 and :18991 free; refuses otherwise)
//   node test/offline-ports-check.mjs --falsify    (each mutant below, on a copy: every one must be caught)
// S  Read from the files as they are. The suites' ports are neither takectl's own (the example config's) nor
//    mimoLive's. Every offline suite imports the guards, refuses before it starts anything, starts takectl and
//    start.command only from its own copy, and never names takectl's port. The copy is takectl's files byte for
//    byte, with the example's port set to the suites' own and no takectl.config.json.
// O  ownUp() resolves for the process that is listening; it rejects, with nothing sent, when another process
//    holds the port, when the process exits, and when it never listens. takectl run from the copy with no
//    config (setup mode) listens on the suites' port.
// R  Every suite, with a decoy answering like a ready takectl on :18991, then on :18989: REFUSED, exit 2, no
//    request reached the decoy, and the suite's last results are unchanged.
// U  Every suite again, from a copy with the refusal switched off and the decoy on :18991: the suite stops at its
//    first takectl start, and no request reaches the decoy (ownUp comes before the first request).
// The real-app checks, as ruled 2026-11-19 (no check may ever drive a takectl it didn't start; bench-guard.mjs):
// S4-S6 Read from the files. Their own port is none of the others. Their config and copy carry it, even when
//    asked otherwise. Every check that runs against the real mimoLive imports the guard, refuses before it
//    awaits anything else, never names takectl's port, and starts takectl only through startBenchTakectl().
// B  A real takectl, on the mock, behind a recording proxy on takectl's own port. Every real-app check exits 2,
//    REFUSED, naming it, and no command reaches it: at most the one read of /state that recognises it. Its
//    mimoLive (the mock) sees no change. Then --beside-takectl lets a probe run, and its use is logged; without
//    the flag the probe refuses. Then each check with its own port held: REFUSED, no request. And
//    startBenchTakectl() rejects, sending nothing, when another process holds the port. B needs takectl's own
//    port free; with an operator's takectl up it says NOT RUN.
// O, R, U and B start processes, so they run only once every S check passes: a broken copy could put a takectl
// on takectl's own port. OFFLINE_PORTS_TEST_DIR=<dir> checks the suites and offline-ports.mjs in <dir> instead.
// --falsify runs the real-app checks' mutants only while nothing listens on mimoLive's port: a mutant that does
// not refuse would go on to drive the real documents.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MP as OWN_MP, TP as OWN_TP, listening as ownListening, refuseIfTaken as ownRefusal } from "./offline-ports.mjs";
import { RP as OWN_RP } from "./bench-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = process.env.OFFLINE_PORTS_TEST_DIR || HERE, ROOT = dirname(DIR);
const FAIL_FAST = !!process.env.OFFLINE_PORTS_FAIL_FAST;
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok && FAIL_FAST) throw new Error("stopped at the first failure"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => (existsSync(f) ? readFileSync(f) : null);
const same = (a, b) => (a === null ? b === null : b !== null && a.equals(b));

const SUITES = readdirSync(DIR).filter((f) => f.endsWith("-offline-check.mjs") || f === "mock-smoke.mjs").sort();
const resultOf = (s) => join(DIR, s.replace(/\.mjs$/, ".txt"));
const isComment = (l) => /^\s*\/\//.test(l);
// The real-app checks: every other script that starts takectl, or imports the guard to.
const HELPERS = ["offline-ports.mjs", "bench-guard.mjs", "offline-ports-check.mjs", "mock-mimolive.mjs"];
const BENCH = readdirSync(DIR).filter((f) => f.endsWith(".mjs") && !SUITES.includes(f) && !HELPERS.includes(f)).filter((f) => {
  const t = readFileSync(join(DIR, f), "utf8");
  return /from "\.\/bench-guard\.mjs"/.test(t) || t.split("\n").some((l) => !isComment(l) && /takectl\.mjs/.test(l));
}).sort();
let benchNotRun = false;

// A copy of the tree under test (the suites, the mock, offline-ports.mjs, takectl's files), to change safely.
// It gets a stand-in takectl.config.json, as an operator's folder has, so a copy that takes it along is seen.
function copyTree(change = (t) => t) {
  const top = mkdtempSync(join(tmpdir(), "abswitch-ports-")), test = join(top, "test");
  mkdirSync(test);
  for (const f of readdirSync(ROOT)) if (f === "takectl.mjs" || f === "start.command" || f === "takectl.config.example.json" || f.endsWith(".html")) copyFileSync(join(ROOT, f), join(top, f));
  for (const f of readdirSync(DIR)) if (f.endsWith(".mjs")) copyFileSync(join(DIR, f), join(test, f));
  writeFileSync(join(top, "takectl.config.json"), JSON.stringify({ _comment: "a stand-in for an operator's own config", port: 1 }));
  change(test, top);
  return test;
}
const edit = (file, old, now) => {
  const t = readFileSync(file, "utf8");
  if (t.split(old).length !== 2) throw new Error(`${basename(file)}: expected one ${JSON.stringify(old.slice(0, 60))}`);
  writeFileSync(file, t.replace(old, now));
};

// A decoy that answers like a ready takectl, and records every request that reaches it.
function decoy(port) {
  const hits = [];
  let onHit = () => {};
  const server = createServer((q, r) => {
    hits.push(`${q.method} ${q.url}`);
    onHit();
    r.writeHead(200, { "Content-Type": "application/json" });
    r.end(JSON.stringify(q.url.startsWith("/state") ? { ready: true, mode: "running", pgm: "A", pvw: "B", status: "ok" } : { ok: true }));
  });
  return new Promise((ok) => server.listen(port, () => ok({ hits, close: () => new Promise((d) => { server.closeAllConnections(); server.close(d); }), hit: (f) => (onHit = f) })));
}

// A takectl's stand-in that is a real one: every request is recorded, then passed to the takectl behind it.
function recordingProxy(port, target) {
  const hits = [];
  let onHit = () => {};
  const server = createServer((q, r) => {
    const what = `${q.method} ${q.url}`;
    hits.push(what);
    onHit(what);
    const chunks = [];
    q.on("data", (c) => chunks.push(c));
    q.on("end", async () => {
      try {
        const res = await fetch(target + q.url, { method: q.method, body: ["GET", "HEAD"].includes(q.method) ? undefined : Buffer.concat(chunks), signal: AbortSignal.timeout(5000) });
        r.writeHead(res.status, { "Content-Type": res.headers.get("content-type") ?? "application/json" });
        r.end(Buffer.from(await res.arrayBuffer()));
      } catch (e) { r.writeHead(502); r.end(String(e)); }
    });
  });
  return new Promise((ok) => server.listen(port, () => ok({ hits, close: () => new Promise((d) => { server.closeAllConnections(); server.close(d); }), hit: (f) => (onHit = f) })));
}
const isStateRead = (what) => /^GET \/state(\?|$)/.test(what);

// A suite run in its own process group, so whatever it starts can be stopped with it if it has to be.
function runSuite(file, ms, stopOnHit, args = []) {
  return new Promise((done) => {
    const p = spawn("node", [file, ...args], { cwd: dirname(dirname(file)), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    p.stdout.on("data", (d) => (text += d)); p.stderr.on("data", (d) => (text += d));
    const kill = (why) => { if (p.exitCode === null) { text += `\n[${why}: stopped by the check]`; try { process.kill(-p.pid, "SIGKILL"); } catch {} } };
    const timer = setTimeout(() => kill(`over ${ms / 1000} s`), ms);
    if (stopOnHit) stopOnHit(() => kill("a request reached the decoy"));
    p.on("exit", (code) => { clearTimeout(timer); done({ code, text }); });
  });
}

async function staticChecks() {
  const guards = await import(pathToFileURL(join(DIR, "offline-ports.mjs")).href + `?${Date.now()}`);
  const example = JSON.parse(readFileSync(join(ROOT, "takectl.config.example.json"), "utf8"));
  const takectlPort = example.port, mimoPort = Number(new URL(example.a.host).port);
  const { MP, TP } = guards;
  check(Number.isInteger(MP) && Number.isInteger(TP) && MP !== TP && ![takectlPort, mimoPort].includes(MP) && ![takectlPort, mimoPort].includes(TP),
    `S1. the suites' ports: mock :${MP}, takectl :${TP}; takectl's own :${takectlPort} and mimoLive's :${mimoPort} (from takectl.config.example.json) are neither`);
  const portRe = new RegExp(`(?<![0-9])${takectlPort}(?![0-9])`);
  for (const s of SUITES) {
    const t = readFileSync(join(DIR, s), "utf8");
    const imports = /^import \{[^}]*\brefuseIfTaken\b[^}]*\} from "\.\/offline-ports\.mjs";$/m.test(t) && /\bownUp\b/.test(t) && /\bownCopy\(ROOT\)/.test(t);
    const refuse = t.indexOf("await refuseIfTaken("), firstSpawn = t.search(/\bspawn\(/);
    const named = t.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => portRe.test(l)).map(([n]) => n);
    const from = [...t.matchAll(/join\((\w+), "(takectl\.mjs|start\.command)"\)/g)].map((m) => m[1]);
    check(imports && refuse >= 0 && firstSpawn > refuse && !named.length && from.length > 0 && from.every((v) => v === "RUN"),
      `S2. ${s}: guards imported ${imports}; refuses before its first spawn ${refuse >= 0 && firstSpawn > refuse}; takectl's port named on lines [${named}]; takectl/start.command started from [${[...new Set(from)]}]`);
  }
  const copy = guards.ownCopy(ROOT);
  const files = readdirSync(copy).sort();
  const want = readdirSync(ROOT).filter((f) => f === "takectl.mjs" || f === "start.command" || f === "takectl.config.example.json" || f.endsWith(".html")).sort();
  const identical = want.filter((f) => f !== "takectl.config.example.json").every((f) => same(read(join(ROOT, f)), read(join(copy, f))));
  const cex = JSON.parse(readFileSync(join(copy, "takectl.config.example.json"), "utf8"));
  const { port: _p, ...rest } = cex, { port: _q, ...restRoot } = example;
  check(JSON.stringify(files) === JSON.stringify(want) && identical && cex.port === TP && JSON.stringify(rest) === JSON.stringify(restRoot) && !files.includes("takectl.config.json"),
    `S3. ownCopy(): ${files.length} files [${files.join(", ")}], takectl's byte for byte ${identical}; the example's port ${cex.port}, the rest unchanged ${JSON.stringify(rest) === JSON.stringify(restRoot)}; no takectl.config.json ${!files.includes("takectl.config.json")}`);
  return guards;
}

async function ownUpChecks({ ownUp, ownCopy, TP }) {
  const listen = (port) => spawn("node", ["-e", `require("net").createServer().listen(${port})`], { stdio: "ignore" });
  const outcome = (p) => p.then(() => "resolved", (e) => `rejected: ${e.message}`);
  let p = listen(TP);
  const o1 = await outcome(ownUp(p, TP, "listener", 5000));
  p.kill(); await sleep(300);
  check(o1 === "resolved", `O1. the process listening on :${TP} is its own: ${o1}`);
  const d = await decoy(TP);
  p = listen(TP);
  const o2 = await outcome(ownUp(p, TP, "listener", 5000));
  p.kill(); await d.close();
  check(o2.startsWith("rejected") && d.hits.length === 0, `O2. :${TP} held by another process: ${o2}; requests to that process ${d.hits.length}`);
  p = spawn("node", ["-e", "setTimeout(() => {}, 4000)"], { stdio: "ignore" });
  const o3 = await outcome(ownUp(p, TP, "idler", 1500));
  p.kill();
  check(o3.startsWith("rejected"), `O3. a process that never listens: ${o3}`);
  p = spawn("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
  const o4 = await outcome(ownUp(p, TP, "quitter", 3000));
  check(o4.startsWith("rejected"), `O4. a process that exits: ${o4}`);
  const tk = spawn("node", [join(ownCopy(ROOT), "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: join(mkdtempSync(join(tmpdir(), "abswitch-noconfig-")), "none.json") }, stdio: "ignore" });
  const o5 = await outcome(ownUp(tk, TP, "takectl", 9000));
  tk.kill(); await sleep(300);
  check(o5 === "resolved", `O5. takectl from the copy, with no config (setup mode), listens on :${TP}: ${o5}`);
}

async function refusalChecks({ MP, TP }) {
  for (const port of [TP, MP]) {
    for (const s of SUITES) {
      const before = read(resultOf(s));
      const d = await decoy(port);
      const r = await runSuite(join(DIR, s), 20000, d.hit);
      await d.close();
      check(r.code === 2 && /^REFUSED: something is already listening on/m.test(r.text) && d.hits.length === 0 && same(before, read(resultOf(s))),
        `R. ${s}, :${port} taken: exit ${r.code}, ${/^REFUSED/m.test(r.text) ? "REFUSED" : JSON.stringify(r.text.trim().slice(0, 80))}; requests to the decoy ${d.hits.length}; last results unchanged ${same(before, read(resultOf(s)))}`);
    }
  }
}

async function ownershipChecks({ TP }) {
  const test = copyTree((t) => edit(join(t, "offline-ports.mjs"), "export async function refuseIfTaken(name) {", "export async function refuseIfTaken(name) { return; // switched off by offline-ports-check (U)"));
  for (const s of SUITES) {
    const d = await decoy(TP);
    const r = await runSuite(join(test, s), 30000, d.hit);
    await d.close();
    const stopped = /not by the (takectl|listener)[^;]* this check started|exited before it listened/.test(r.text);
    check(r.code !== 0 && stopped && d.hits.length === 0,
      `U. ${s}, refusal off, :${TP} held: exit ${r.code}; ${stopped ? "stopped at its first takectl start" : JSON.stringify(r.text.trim().split("\n").pop()?.slice(0, 100))}; requests to the decoy ${d.hits.length}${d.hits.length ? ` (${d.hits.slice(0, 3).join(", ")})` : ""}`);
  }
}

// ---------------------------------------------------------------- the real-app checks (ruling 2026-11-19)
async function benchStaticChecks({ MP, TP }) {
  const bg = await import(pathToFileURL(join(DIR, "bench-guard.mjs")).href + `?${Date.now()}`);
  const example = JSON.parse(readFileSync(join(ROOT, "takectl.config.example.json"), "utf8"));
  const takectlPort = example.port, mimoPort = Number(new URL(example.a.host).port);
  check(bg.TAKECTL_PORT === takectlPort && Number.isInteger(bg.RP) && ![takectlPort, mimoPort, MP, TP].includes(bg.RP),
    `S4. the real-app checks' takectl port :${bg.RP}; the takectl port they refuse beside :${bg.TAKECTL_PORT} (the example's: :${takectlPort}); not mimoLive's or the offline suites'`);
  const src = join(mkdtempSync(join(tmpdir(), "abswitch-benchcfg-")), "takectl.config.json");
  writeFileSync(src, JSON.stringify({ ...example, port: takectlPort, stinger: false }));
  const c = bg.benchConfig(src), fc = JSON.parse(readFileSync(bg.benchConfigFile(src, { stinger: true, port: takectlPort }), "utf8"));
  const copy = bg.benchCopy(ROOT), cex = JSON.parse(readFileSync(join(copy, "takectl.config.example.json"), "utf8"));
  check(c.port === bg.RP && c.master?.documentName === example.master.documentName && fc.port === bg.RP && fc.stinger === true && cex.port === bg.RP && !existsSync(join(copy, "takectl.config.json")),
    `S5. benchConfig(): port ${c.port}, documents kept; benchConfigFile(): port ${fc.port} though asked for ${takectlPort}, other settings kept; benchCopy(): example port ${cex.port}, no takectl.config.json`);
  const portRe = new RegExp(`(?<![0-9])${takectlPort}(?![0-9])`);
  for (const s of BENCH) {
    const t = readFileSync(join(DIR, s), "utf8"), lines = t.split("\n").map((l, i) => [i + 1, l]);
    const code = lines.filter(([, l]) => !isComment(l) && !/^import /.test(l));
    const imports = /^import \{[^}]*\brefuseUnlessClear\b[^}]*\bstartBenchTakectl\b[^}]*\} from "\.\/bench-guard\.mjs";$/m.test(t);
    const first = code.find(([, l]) => /\bawait\b/.test(l));
    const refusesFirst = !!first && /^await refuseUnlessClear\(/.test(first[1].trim());
    const named = lines.filter(([, l]) => portRe.test(l)).map(([n]) => n);
    const direct = code.filter(([, l]) => /takectl\.mjs/.test(l) && !(/spawnSync\(/.test(l) && /TAKECTL_CONFIG/.test(l) && /\bRUN\b/.test(l))).map(([n]) => n);
    const starts = code.some(([, l]) => /\bstartBenchTakectl\(/.test(l));
    check(imports && refusesFirst && !named.length && !direct.length && starts,
      `S6. ${s}: guard imported ${imports}; refuses before anything else it awaits ${refusesFirst}${refusesFirst ? "" : ` (first await, line ${first?.[0]})`}; takectl's port named on lines [${named}]; takectl started other than through startBenchTakectl() on lines [${direct}]`);
  }
  return bg;
}

async function benchChecks({ MP, TP, ownCopy, ownUp, listening }, bg) {
  if (await listening(bg.TAKECTL_PORT)) {
    benchNotRun = true;
    say(`NOT RUN  B: something is listening on :${bg.TAKECTL_PORT} (an operator's takectl?). B puts a takectl of its own there; stop that one to prove the real-app checks' refusal.`);
    return;
  }
  const MOCK = `http://localhost:${MP}`, TK = `http://localhost:${TP}`, get = async (u) => (await fetch(u, { signal: AbortSignal.timeout(5000) })).json();
  const example = JSON.parse(readFileSync(join(ROOT, "takectl.config.example.json"), "utf8"));
  const cfg = { ...example, a: { ...example.a, host: MOCK, documentName: "PH-A" }, b: { ...example.b, host: MOCK, documentName: "PH-B" },
    master: { ...example.master, host: MOCK, documentName: "PH-MASTER", sourceNameSafe: "SAFE Test Pattern" }, companion: { host: null }, port: TP };
  const cfgFile = join(mkdtempSync(join(tmpdir(), "abswitch-b-")), "takectl.config.json");
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const mock = spawn("node", [join(DIR, "mock-mimolive.mjs"), String(MP)], { stdio: "ignore" });
  let tk = null, px = null;
  try {
    await ownUp(mock, MP, "mock");
    tk = spawn("node", [join(ownCopy(ROOT), "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: cfgFile }, stdio: "ignore" });
    await ownUp(tk, TP);
    let up = null;
    for (let i = 0; i < 45 && !up; i++) { await sleep(200); up = await get(`${TK}/state`).then((s) => (s.ready && s.pgm ? s : null)).catch(() => null); }
    await sleep(1500);
    px = await recordingProxy(bg.TAKECTL_PORT, TK);
    const snap = async () => ({ mock: JSON.stringify((await get(`${MOCK}/api/v1/mock/log`)).log ?? []), st: JSON.stringify((({ pgm, pvw, lastTake, looks }) => ({ pgm, pvw, lastTake, looks }))(await get(`${TK}/state`))) });
    const before = await snap();
    check(!!up && px.hits.length === 0, `B0. a real takectl on the mock, ready (pgm ${up?.pgm}), behind a recording proxy on :${bg.TAKECTL_PORT}`);
    for (const s of BENCH) {
      const n0 = px.hits.length;
      const r = await runSuite(join(DIR, s), 20000, (kill) => px.hit((w) => { if (!isStateRead(w)) kill(); }));
      const mine = px.hits.slice(n0), commands = mine.filter((w) => !isStateRead(w));
      const named = new RegExp(`^REFUSED: a takectl answering on :${bg.TAKECTL_PORT} \\(pid \\d+`, "m").test(r.text);
      check(r.code === 2 && named && commands.length === 0 && mine.length <= 1 && !(await listening(bg.RP)),
        `B1. ${s}: exit ${r.code}; ${named ? "REFUSED, naming the takectl and its pid" : JSON.stringify(r.text.trim().split("\n")[0]?.slice(0, 90))}; requests to it [${mine.join(", ")}]; :${bg.RP} never opened`);
    }
    const after = await snap();
    check(after.mock === before.mock && after.st === before.st, `B1. after all ${BENCH.length}: the takectl on :${bg.TAKECTL_PORT} unchanged (${after.st === before.st}), its mimoLive (the mock) saw no change (${after.mock === before.mock})`);
    // The override, on a probe in a copy (so its log entry lands there, not in this tree).
    const t = copyTree();
    writeFileSync(join(t, "override-probe.mjs"), 'import { refuseUnlessClear } from "./bench-guard.mjs";\nawait refuseUnlessClear("override-probe");\nconsole.log("RETURNED");\n');
    const log = join(t, "override-log.txt"), n1 = px.hits.length;
    const plain = await runSuite(join(t, "override-probe.mjs"), 15000);
    const beside = await runSuite(join(t, "override-probe.mjs"), 15000, null, [bg.OVERRIDE]);
    const logged = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    const probeHits = px.hits.slice(n1);
    check(plain.code === 2 && /^REFUSED: a takectl answering/m.test(plain.text) && beside.code === 0 && /RETURNED/.test(beside.text) && /^OVERRIDE/m.test(beside.text) &&
      logged.length === 1 && new RegExp(`override-probe ${bg.OVERRIDE}: ran beside a takectl answering on :${bg.TAKECTL_PORT}`).test(logged[0]) && probeHits.every(isStateRead),
      `B3. without ${bg.OVERRIDE}: exit ${plain.code}, REFUSED; with it: exit ${beside.code}, ran, logged ${logged.length} line ${JSON.stringify((logged[0] ?? "").slice(25, 120))}; requests to the takectl [${probeHits.join(", ")}]`);
  } finally {
    if (px) await px.close();
    tk?.kill(); mock.kill();
    await sleep(400);
  }
  for (const s of BENCH) {
    const d = await decoy(bg.RP);
    const r = await runSuite(join(DIR, s), 20000, d.hit);
    await d.close();
    const named = new RegExp(`^REFUSED: something is already listening on :${bg.RP} \\(pid \\d+`, "m").test(r.text);
    check(r.code === 2 && named && d.hits.length === 0, `B2. ${s}, :${bg.RP} held: exit ${r.code}; ${named ? "REFUSED, naming the pid" : JSON.stringify(r.text.trim().split("\n")[0]?.slice(0, 90))}; requests to the holder ${d.hits.length}`);
  }
  const d = await decoy(bg.RP);
  const src = join(mkdtempSync(join(tmpdir(), "abswitch-b4-")), "takectl.config.json");
  writeFileSync(src, JSON.stringify({ ...cfg, port: undefined })); // the mock's hosts (stopped by now), never the real mimoLive
  const o = await bg.startBenchTakectl(bg.benchCopy(ROOT), bg.benchConfigFile(src)).then((p) => { p.kill(); return "resolved"; }, (e) => `rejected: ${e.message}`);
  await d.close();
  check(o.startsWith("rejected") && d.hits.length === 0, `B4. startBenchTakectl() with :${bg.RP} held by another process: ${o.slice(0, 140)}; requests to it ${d.hits.length}`);
}

// ---------------------------------------------------------------- the mutants (--falsify)
const MUTANTS = [
  ["M1 the refusal refuses nothing", (t) => edit(join(t, "offline-ports.mjs"), "  if (!taken.length) return;", "  return;")],
  ["M2 the refusal looks only at the takectl port", (t) => edit(join(t, "offline-ports.mjs"), "for (const p of [MP, TP])", "for (const p of [TP])")],
  ["M3 ownUp() trusts at once", (t) => edit(join(t, "offline-ports.mjs"), "  const t = Date.now();\n  while", "  return proc;\n  const t = Date.now();\n  while")],
  ["M4 ownUp() takes any listener for its own", (t) => edit(join(t, "offline-ports.mjs"), "if (pids.includes(proc.pid)) return proc;", "if (pids.length) return proc;")],
  ["M5 ownCopy() keeps the example's port", (t) => edit(join(t, "offline-ports.mjs"), "{ ...example, port }", "{ ...example }")],
  ["M6 ownCopy() takes the operator's takectl.config.json along", (t) => edit(join(t, "offline-ports.mjs"), 'f === "takectl.mjs" || f === "start.command"', 'f === "takectl.mjs" || f === "takectl.config.json" || f === "start.command"')],
  ["M7 the suites' takectl port is takectl's own", (t) => edit(join(t, "offline-ports.mjs"), "TP = 18991", "TP = 8991")],
  ["M8 a suite talks to takectl's own port again", (t) => edit(join(t, "round4-offline-check.mjs"), "T = `http://localhost:${TP}`", 'T = "http://localhost:8991"')],
  ["M9 a suite starts takectl from the real folder", (t) => edit(join(t, "round2-offline-check.mjs"), 'tk = spawn("node", [join(RUN, "takectl.mjs")]', 'tk = spawn("node", [join(ROOT, "takectl.mjs")]')],
  ["M10 a suite runs start.command from the real folder", (t) => edit(join(t, "round1-offline-check.mjs"), 'join(RUN, "start.command")', 'join(ROOT, "start.command")')],
  ["M11 a suite without the refusal", (t) => edit(join(t, "safe-offline-check.mjs"), 'await refuseIfTaken("safe-offline-check");\n', "")],
  ["M12 a suite asks takectl before ownUp()", (t) => edit(join(t, "round3-offline-check.mjs"), "  procs.push(tk);\n  await ownUp(tk, TP);\n", "  procs.push(tk);\n")],
  ["M13 mock-smoke asks takectl before ownUp()", (t) => edit(join(t, "mock-smoke.mjs"), "  await ownUp(tk, TP);\n", "")],
  ["M14 a suite's takectl start that does not wait for ownUp()", (t) => edit(join(t, "amend-offline-check.mjs"), "procs.push(p); return ownUp(p, TP); };", "procs.push(p); return p; };")],
  // The real-app checks (ruling 2026-11-19). true: run only while nothing listens on mimoLive's port.
  ["M15 the guard does not look for a takectl on takectl's own port", (t) => edit(join(t, "bench-guard.mjs"), "  const s = await takectlOn(TAKECTL_PORT);\n", "  const s = null;\n"), true],
  ["M16 the guard does not look at its own port", (t) => edit(join(t, "bench-guard.mjs"), "  if (await listening(RP)) {", "  if (false) {"), true],
  ["M17 the override needs no flag", (t) => edit(join(t, "bench-guard.mjs"), "  if (!process.argv.includes(OVERRIDE)) {", "  if (false) {"), true],
  ["M18 the override is not logged", (t) => edit(join(t, "bench-guard.mjs"), '  appendFileSync(OVERRIDE_LOG, line + "\\n");\n', "")],
  ["M19 a real-app check without the refusal", (t) => edit(join(t, "panic-check.mjs"), 'await refuseUnlessClear("panic-check");\n', "")],
  ["M20 a real-app check talks to takectl's own port again", (t) => edit(join(t, "witness-check.mjs"), "T = `http://localhost:${RP}`", 'T = "http://localhost:8991"')],
  ["M21 a real-app check starts takectl itself, from the real folder", (t) => edit(join(t, "stall-check.mjs"), "await startBenchTakectl(RUN, OWN_CFG, {", 'spawn("node", ["takectl.mjs"], { cwd: ROOT,')],
  ["M22 benchConfigFile() lets the caller choose the port", (t) => edit(join(t, "bench-guard.mjs"), "{ ...benchConfig(file), ...over, port: RP }", "{ ...benchConfig(file), ...over }")],
  ["M23 startBenchTakectl() does not wait for ownUp()", (t) => edit(join(t, "bench-guard.mjs"), "    await ownUp(p, RP);\n", "")],
  ["M24 benchCopy() keeps the offline suites' port", (t) => edit(join(t, "bench-guard.mjs"), "ownCopy(root, RP)", "ownCopy(root)")],
];

async function falsify() {
  const lines = [`offline-ports-check --falsify, ${new Date().toISOString()}: each mutant on a copy, the check with fail-fast`];
  let missed = 0, notRun = 0;
  const mimoPort = Number(new URL(JSON.parse(readFileSync(join(dirname(HERE), "takectl.config.example.json"), "utf8")).a.host).port);
  for (const [name, change, needsMimoDown] of MUTANTS) {
    if (needsMimoDown && (await ownListening(mimoPort))) {
      notRun++;
      lines.push(`${name}: NOT RUN (something is listening on :${mimoPort}, mimoLive?): a copy that does not refuse would drive the real documents`);
      console.log(lines.at(-1));
      continue;
    }
    let test;
    try { test = copyTree(change); } catch (e) {
      missed++;
      lines.push(`${name}: COULD NOT BE APPLIED (${e.message}): the code it breaks has moved`);
      console.log(lines.at(-1));
      continue;
    }
    const run = await new Promise((done) => {
      const p = spawn("node", [join(HERE, "offline-ports-check.mjs")], { env: { ...process.env, OFFLINE_PORTS_TEST_DIR: test, OFFLINE_PORTS_FAIL_FAST: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let text = ""; p.stdout.on("data", (d) => (text += d)); p.stderr.on("data", (d) => (text += d));
      p.on("exit", (code) => done({ code, text }));
    });
    const caught = run.code !== 0 && /^FAIL/m.test(run.text);
    if (!caught) missed++;
    const by = run.text.split("\n").find((l) => l.startsWith("FAIL"));
    lines.push(`${name}: ${caught ? `caught (${by?.slice(6, 150)})` : `NOT CAUGHT (exit ${run.code})`}`);
    console.log(lines.at(-1));
  }
  lines.push(missed ? `${missed} NOT CAUGHT` : notRun ? `every mutant run was caught; ${notRun} NOT RUN` : "every mutant caught");
  console.log(lines.at(-1));
  writeFileSync(join(HERE, "offline-ports-falsify.txt"), lines.join("\n") + "\n");
  process.exit(missed ? 1 : 0);
}

// ---------------------------------------------------------------- run
// The check's own guard is offline-ports.mjs beside it, never the copy under test. Before it probes anything,
// its ports must be neither takectl's nor mimoLive's (from the example config), so it never touches either.
{
  const ex = JSON.parse(readFileSync(join(dirname(HERE), "takectl.config.example.json"), "utf8"));
  const theirs = [ex.port, Number(new URL(ex.a.host).port)];
  if (theirs.includes(OWN_MP) || theirs.includes(OWN_TP) || theirs.includes(OWN_RP)) {
    console.log(`STOP: the guards beside this check use :${OWN_MP}, :${OWN_TP} and :${OWN_RP}; takectl and mimoLive use :${theirs.join(" and :")}. Nothing was started.`);
    process.exit(2);
  }
}
await ownRefusal("offline-ports-check");
if (await ownListening(OWN_RP)) {
  console.log(`REFUSED: something is already listening on :${OWN_RP} (a real-app check?). This check holds that port in B; stop the other one first. Nothing was sent.`);
  process.exit(2);
}
if (process.argv.includes("--falsify")) await falsify();
try {
  say(`offline-ports-check, ${new Date().toISOString()}: ${SUITES.length} suites [${SUITES.join(", ")}]`);
  const guards = await staticChecks();
  say(`real-app checks: ${BENCH.length} [${BENCH.join(", ")}]`);
  const bench = await benchStaticChecks(guards);
  if (fails) say("S failed: nothing was started (O, R, U and B not run)");
  else {
    await ownUpChecks(guards);
    await refusalChecks(guards);
    await ownershipChecks(guards);
    await benchChecks(guards, bench);
  }
} catch (e) {
  if (!(FAIL_FAST && fails)) { fails++; say(`FAIL  the check stopped: ${e.message}`); }
} finally {
  say(fails ? `${fails} FAIL(S)` : benchNotRun ? "ALL PASS, but B NOT RUN (takectl's own port was in use)" : "ALL PASS");
  writeFileSync(join(DIR, "offline-ports-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
