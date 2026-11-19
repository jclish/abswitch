// offline-ports: the offline suites' own ports, and the guards that keep them off an operator's takectl.
//
// Ruled 2026-11-14: each offline suite runs on an isolated port and owns the processes it starts; it never
// talks to, or stops, an operator's takectl. The pattern is surfaces/wingman/offline_check.py's.
//   - MP and TP are the suites' own mock and takectl ports, never takectl's (8991, in
//     takectl.config.example.json) or mimoLive's (8989).
//   - refuseIfTaken() runs before anything starts. Anything already listening on MP or TP would answer in
//     place of the suite's own mock or takectl, which then could not start, and every request would go to it.
//     So the suite stops there, with nothing sent and its last results kept.
//   - ownCopy() is where a suite's takectl runs from: takectl.mjs, its pages and start.command, copied to a
//     folder of the suite's own, with the example config's port set to TP. takectl takes its port from the
//     example when it has no config (setup mode), and Save copies the example into the config it writes;
//     start.command reads the port from the folder it is in. Run from the copy, none of them can land on
//     8991, and none can read an operator's takectl.config.json.
//   - ownUp() waits until the process the suite started is the one listening on its port, before a single
//     request goes to that port.
// Two suites cannot run at once: they share these ports, and the second refuses.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MP = 18989, TP = 18991;

const answers = (port, host) => new Promise((done) => {
  const s = createConnection({ port, host });
  const end = (v) => { s.destroy(); done(v); };
  s.setTimeout(1000, () => end(false));
  s.once("connect", () => end(true));
  s.once("error", () => end(false));
});

// Anything listening on the port, on either loopback address (takectl's own server is dual-stack).
export const listening = async (port) => (await answers(port, "127.0.0.1")) || (await answers(port, "::1"));

export async function refuseIfTaken(name) {
  const taken = [];
  for (const p of [MP, TP]) if (await listening(p)) taken.push(`:${p}`);
  if (!taken.length) return;
  console.log(`REFUSED: something is already listening on ${taken.join(" and ")} (another offline check?).\n` +
    `${name} starts its own mock and takectl there; stop the other one first. Nothing was sent; the last results are kept.`);
  process.exit(2);
}

export function ownCopy(root) {
  const dir = mkdtempSync(join(tmpdir(), "abswitch-own-"));
  for (const f of readdirSync(root)) if (f === "takectl.mjs" || f === "start.command" || f.endsWith(".html")) copyFileSync(join(root, f), join(dir, f));
  const example = JSON.parse(readFileSync(join(root, "takectl.config.example.json"), "utf8"));
  writeFileSync(join(dir, "takectl.config.example.json"), JSON.stringify({ ...example, port: TP }, null, 2) + "\n");
  return dir;
}

// The processes listening on a port, from the kernel's own table (lsof): nothing is sent to the port to find out.
const listeners = (port) => {
  try { return execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number); } catch { return []; }
};

export async function ownUp(proc, port, what = "takectl", ms = 9000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`the ${what} this check started exited before it listened on :${port}; nothing was sent to :${port}`);
    const pids = listeners(port);
    if (pids.includes(proc.pid)) return proc;
    if (pids.length) throw new Error(`:${port} is held by pid ${pids.join(", ")}, not by the ${what} this check started (pid ${proc.pid}); nothing was sent to :${port}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the ${what} this check started (pid ${proc.pid}) is not listening on :${port} after ${ms / 1000} s; nothing was sent to it`);
}
