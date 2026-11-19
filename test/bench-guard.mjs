// bench-guard: the real-app checks' own takectl, and the refusals that keep them off an operator's.
//
// Ruled 2026-11-19: no check may ever drive a takectl it didn't start. Each check that runs against the
// real mimoLive starts its own takectl on RP, never on takectl's own port (8991, from
// takectl.config.example.json), from a copy of its own (offline-ports.mjs, ownCopy) and with a config of
// its own: a copy of the bench's takectl.config.json with the port set to RP.
//   - refuseUnlessClear() runs before the check touches anything. If anything is listening on RP, it would
//     answer in place of the check's own takectl, so the check stops. If a takectl answers on takectl's
//     own port, an operator's controller is up on the same three documents; a second controller is the
//     hazard, so the check stops. Either way it names what it found and how to proceed, and sends nothing.
//   - --beside-takectl is the one override, for a deliberate run beside that takectl. Every use is logged
//     in test/override-log.txt. It never overrides RP being taken.
//   - startBenchTakectl() starts the check's takectl from its copy with its config, and waits until the
//     process listening on RP is that one (ownUp) before a single request goes to it.
// The offline suites use :18989 and :18991, so a real-app check can run beside one; two real-app checks
// cannot run at once (the second refuses).
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listening, ownCopy, ownUp } from "./offline-ports.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RP = 18992;
// takectl's own port, where an operator's takectl runs: read from the example config, never restated here.
export const TAKECTL_PORT = JSON.parse(readFileSync(join(dirname(HERE), "takectl.config.example.json"), "utf8")).port;
export const OVERRIDE = "--beside-takectl";
export const OVERRIDE_LOG = join(HERE, "override-log.txt");

// Who is listening on a port, from the kernel's table (lsof) and ps: nothing is sent to the port to find out.
const who = (port) => {
  let pids = [];
  try { pids = execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean); } catch {}
  if (!pids.length) return "pid not visible";
  return pids.map((p) => { let c = "?"; try { c = execFileSync("ps", ["-o", "command=", "-p", p], { encoding: "utf8" }).trim(); } catch {} return `pid ${p}, ${c}`; }).join("; ");
};

// Whether what answers on the port is a takectl: one read of /state, the only request ever sent there.
async function takectlOn(port) {
  try {
    const s = await (await fetch(`http://localhost:${port}/state`, { signal: AbortSignal.timeout(1500) })).json();
    return s && typeof s === "object" && typeof s.ready === "boolean" && typeof s.mode === "string" ? s : null;
  } catch { return null; }
}

export async function refuseUnlessClear(name) {
  if (await listening(RP)) {
    console.log(`REFUSED: something is already listening on :${RP} (${who(RP)}).\n` +
      `${name} starts its own takectl there, and every request would go to whatever answers. Stop it first (another real-app check?), ` +
      `then run this again. Nothing was sent. ${OVERRIDE} does not override this.`);
    process.exit(2);
  }
  if (!(await listening(TAKECTL_PORT))) return;
  const s = await takectlOn(TAKECTL_PORT);
  if (!s) return;
  const found = `a takectl answering on :${TAKECTL_PORT} (${who(TAKECTL_PORT)}; mode ${s.mode}, ${s.ready ? "ready" : "not ready"})`;
  if (!process.argv.includes(OVERRIDE)) {
    console.log(`REFUSED: ${found}.\n` +
      `${name} would start a second controller on the same three documents, the hazard this refusal exists for. Nothing was sent to it.\n` +
      `To proceed: stop that takectl (Ctrl-C in its window), then run this again. To run beside it on purpose, add ${OVERRIDE}; every use is logged in test/override-log.txt.`);
    process.exit(2);
  }
  const line = `${new Date().toISOString()} ${name} ${OVERRIDE}: ran beside ${found}`;
  appendFileSync(OVERRIDE_LOG, line + "\n");
  console.log(`OVERRIDE (${OVERRIDE}): running beside ${found}. Logged in test/override-log.txt. Nothing is sent to it.`);
}

export const benchCopy = (root) => ownCopy(root, RP);

// The bench's config with this check's own port: its documents, sources and switcher, never its port.
export const benchConfig = (file) => ({ ...JSON.parse(readFileSync(file, "utf8")), port: RP });

export function benchConfigFile(file, over = {}) {
  const f = join(mkdtempSync(join(tmpdir(), "abswitch-bench-")), "takectl.config.json");
  writeFileSync(f, JSON.stringify({ ...benchConfig(file), ...over, port: RP }, null, 2));
  return f;
}

export async function startBenchTakectl(run, cfgFile, opts = {}) {
  const p = spawn("node", [join(run, "takectl.mjs")], { cwd: run, ...opts, env: { ...process.env, ...(opts.env ?? {}), TAKECTL_CONFIG: cfgFile } });
  try {
    await ownUp(p, RP);
  } catch (e) {
    p.kill();
    throw e;
  }
  return p;
}
