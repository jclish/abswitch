#!/usr/bin/env node
// demo-run: plays abswitch's main moves in a fixed order, with a pause between each, so a screen recording
// of the operator panel shows them one after another. Not a pass/fail test: each step prints what it did
// and what takectl answered.
//   node test/demo-run.mjs [pause seconds, default 3]
// takectl must be running with the bench documents (PH-A, PH-B, PH-MASTER live, Recording off). The run
// starts on A with MIX at 0.5 s and leaves everything as it found it: MIX, 0.5 s, downstream keys and FTB
// off, Lower Thirds off, steps cleared, A on air.
// For the hook steps, start takectl with the config hook  "Speaker Wide": { "post": [ { "layer": "Lower Third" } ] }
// and a safe source set up (setup's "safe source"), or those steps say they had nothing to show.
const T = process.env.TAKECTL || "http://localhost:8991";
const PAUSE = (Number(process.argv[2]) || 3) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const g = async (p) => { try { return await (await fetch(T + p)).json(); } catch (e) { return { ok: false, error: String(e) }; } };
const look = (n) => g(`/pvw/layer-set?name=${encodeURIComponent(n)}`);
let n = 0;
// Each step waits for takectl to be idle first (no transition, steps run or rehearsal), so a short pause
// never makes the next step "busy".
const idle = async () => { for (let i = 0; i < 80; i++) { const x = await g("/state"); if (!x.busy && !x.switcher?.inFlight && !x.steps?.running && !x.rehearsal) return; await sleep(100); } };
const step = async (caption, fn, pause = PAUSE) => {
  n++;
  await idle();
  const r = await fn();
  const said = r && r.ok === false ? `refused: ${r.error}` : r && (r.transition || r.look || r.pgm || r.mode || r.seconds || r.label) ? JSON.stringify({ pgm: r.pgm, transition: r.transition, look: r.look, mode: r.mode, seconds: r.seconds, label: r.label, on: r.on ?? r.ftb }) : "ok";
  console.log(`${String(n).padStart(2)}. ${caption.padEnd(58)} → ${said}`);
  await sleep(pause);
};
const s0 = await g("/state");
if (s0.ready === false || !s0.pgm) { console.error(`takectl is not ready: ${s0.startError ?? s0.error ?? "no answer"}`); process.exit(2); }
if (s0.pgm !== "A") { await g("/safe/target?doc=A"); await g("/cut"); await sleep(1000); }
await g("/transition?mode=mix"); await g("/rate?s=0.5"); await g("/steps/clear");
console.log(`demo-run: ${PAUSE / 1000} s between steps, against ${T}`);

await step("Compose in Preview: Two Shot (key 2)", () => look("Two Shot"));
await step("TAKE — a 0.5 s MIX", () => g("/take"));
await step("Rate to 1.5 s, Preview: Slides PiP", async () => { await g("/rate?s=1.5"); return look("Slides PiP"); }, 1500);
await step("TAKE — a 1.5 s MIX", () => g("/take"));
await step("STINGER selected, Preview: Speaker Wide", async () => { await g("/transition?mode=stinger"); return look("Speaker Wide"); }, 1500);
await step("TAKE — under the stinger; then the Lower Third hook", () => g("/take"), PAUSE + 1000);
await step("CUT — always bare, even with STINGER selected", () => g("/cut"));
await step("UNDO — back to the previous look", () => g("/undo"));
await step("Preview: Full Slides, then PUSH it onto Program", async () => { await look("Full Slides"); await sleep(1200); return g("/push"); });
await step("Steps: Two Shot, then Speaker Wide, queued", async () => { await look("Two Shot"); await g("/steps/add"); await look("Speaker Wide"); return g("/steps/add"); }, 1500);
await step("PUSH STEPS — instant, under one stinger", () => g("/steps/push?pace=instant"), PAUSE + 1500);
await step("Downstream: Bug on", () => g("/dsk?label=Bug&on=1"));
await step("Downstream: Clock on", () => g("/dsk?label=Clock&on=1"));
await step("FTB — fade to black (video only)", () => g("/ftb?on=1"));
await step("TAKE underneath FTB", async () => { await g("/transition?mode=mix"); return g("/take"); });
await step("FTB off", () => g("/ftb?on=0"));
await step("PANIC — cut to the safe source", () => g("/panic"), PAUSE + 1000);
await step("SAFE: choose document A as the TAKE target", () => g("/safe/target?doc=A"));
await step("TAKE out of SAFE to A", () => g("/take"));
await step("Downstream keys off, steps cleared", async () => { await g("/dsk?label=Bug&on=0"); await g("/dsk?label=Clock&on=0"); return g("/steps/clear"); }, 1000);
await g("/rate?s=0.5");
const s1 = await g("/state");
console.log(`done: ${s1.pgm} on air, ${s1.transition?.mode} ${s1.transition?.rateS} s, FTB ${s1.ftb?.on ? "on" : "off"}, DSKs ${(s1.dsk ?? []).map((d) => `${d.label} ${d.on ? "on" : "off"}`).join(", ")}`);
console.log("(Lower Thirds a hook brought in stay as the hooks left them: switch them off in mimoLive, or recall a look.)");
process.exit(0);
