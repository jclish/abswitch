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
// O, R and U start processes, so they run only once every S check passes: a broken copy could put a takectl
// on takectl's own port. OFFLINE_PORTS_TEST_DIR=<dir> checks the suites and offline-ports.mjs in <dir> instead.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MP as OWN_MP, TP as OWN_TP, refuseIfTaken as ownRefusal } from "./offline-ports.mjs";

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

// A suite run in its own process group, so whatever it starts can be stopped with it if it has to be.
function runSuite(file, ms, stopOnHit) {
  return new Promise((done) => {
    const p = spawn("node", [file], { cwd: dirname(dirname(file)), detached: true, stdio: ["ignore", "pipe", "pipe"] });
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

// ---------------------------------------------------------------- the mutants (--falsify)
const MUTANTS = [
  ["M1 the refusal refuses nothing", (t) => edit(join(t, "offline-ports.mjs"), "  if (!taken.length) return;", "  return;")],
  ["M2 the refusal looks only at the takectl port", (t) => edit(join(t, "offline-ports.mjs"), "for (const p of [MP, TP])", "for (const p of [TP])")],
  ["M3 ownUp() trusts at once", (t) => edit(join(t, "offline-ports.mjs"), "  const t = Date.now();\n  while", "  return proc;\n  const t = Date.now();\n  while")],
  ["M4 ownUp() takes any listener for its own", (t) => edit(join(t, "offline-ports.mjs"), "if (pids.includes(proc.pid)) return proc;", "if (pids.length) return proc;")],
  ["M5 ownCopy() keeps the example's port", (t) => edit(join(t, "offline-ports.mjs"), "{ ...example, port: TP }", "{ ...example }")],
  ["M6 ownCopy() takes the operator's takectl.config.json along", (t) => edit(join(t, "offline-ports.mjs"), 'f === "takectl.mjs" || f === "start.command"', 'f === "takectl.mjs" || f === "takectl.config.json" || f === "start.command"')],
  ["M7 the suites' takectl port is takectl's own", (t) => edit(join(t, "offline-ports.mjs"), "TP = 18991", "TP = 8991")],
  ["M8 a suite talks to takectl's own port again", (t) => edit(join(t, "round4-offline-check.mjs"), "T = `http://localhost:${TP}`", 'T = "http://localhost:8991"')],
  ["M9 a suite starts takectl from the real folder", (t) => edit(join(t, "round2-offline-check.mjs"), 'tk = spawn("node", [join(RUN, "takectl.mjs")]', 'tk = spawn("node", [join(ROOT, "takectl.mjs")]')],
  ["M10 a suite runs start.command from the real folder", (t) => edit(join(t, "round1-offline-check.mjs"), 'join(RUN, "start.command")', 'join(ROOT, "start.command")')],
  ["M11 a suite without the refusal", (t) => edit(join(t, "safe-offline-check.mjs"), 'await refuseIfTaken("safe-offline-check");\n', "")],
  ["M12 a suite asks takectl before ownUp()", (t) => edit(join(t, "round3-offline-check.mjs"), "  procs.push(tk);\n  await ownUp(tk, TP);\n", "  procs.push(tk);\n")],
  ["M13 mock-smoke asks takectl before ownUp()", (t) => edit(join(t, "mock-smoke.mjs"), "  await ownUp(tk, TP);\n", "")],
  ["M14 a suite's takectl start that does not wait for ownUp()", (t) => edit(join(t, "amend-offline-check.mjs"), "procs.push(p); return ownUp(p, TP); };", "procs.push(p); return p; };")],
];

async function falsify() {
  const lines = [`offline-ports-check --falsify, ${new Date().toISOString()}: each mutant on a copy, the check with fail-fast`];
  let missed = 0;
  for (const [name, change] of MUTANTS) {
    const test = copyTree(change);
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
  lines.push(missed ? `${missed} NOT CAUGHT` : "every mutant caught");
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
  if (theirs.includes(OWN_MP) || theirs.includes(OWN_TP)) {
    console.log(`STOP: offline-ports.mjs beside this check uses :${OWN_MP} and :${OWN_TP}; takectl and mimoLive use :${theirs.join(" and :")}. Nothing was started.`);
    process.exit(2);
  }
}
await ownRefusal("offline-ports-check");
if (process.argv.includes("--falsify")) await falsify();
try {
  say(`offline-ports-check, ${new Date().toISOString()}: ${SUITES.length} suites [${SUITES.join(", ")}]`);
  const guards = await staticChecks();
  if (fails) say("S failed: nothing was started (O, R and U not run)");
  else {
    await ownUpChecks(guards);
    await refusalChecks(guards);
    await ownershipChecks(guards);
  }
} catch (e) {
  if (!(FAIL_FAST && fails)) { fails++; say(`FAIL  the check stopped: ${e.message}`); }
} finally {
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(DIR, "offline-ports-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
