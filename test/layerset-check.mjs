// layerset-check: compare recorded Layer Sets in PH-A / PH-B with the intended table, then recall
// each set and confirm the layer states, that TALLY/COUNTER are untouched, and that exactly that
// set reads active. Ends by recalling Speaker Wide (the build's starting look).
// Use: node test/layerset-check.mjs   (shows may be off; it recalls sets and ends on Speaker Wide)
const B = "http://localhost:8989/api/v1";
const j = (p) => fetch(B + p).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WANT = {
  "Speaker Wide": { "Cam Wide": "live", "Two Shot": "off", "Cam PiP": "off", Slides: "off" },
  "Two Shot": { "Two Shot": "live", "Cam Wide": "off", "Cam PiP": "off", Slides: "off" },
  "Slides PiP": { Slides: "live", "Cam PiP": "live", "Cam Wide": "off", "Two Shot": "off" },
  "Full Slides": { Slides: "live", "Cam Wide": "off", "Two Shot": "off", "Cam PiP": "off" },
};
let fails = 0;
const fail = (m) => { fails++; console.log("  FAIL " + m); };
const docs = (await j("/documents")).data;
for (const name of ["PH-A", "PH-B"]) {
  const d = docs.find((x) => x.attributes.name.replace(/\.tvshow$/, "") === name).id;
  const layers = async () => Object.fromEntries((await j(`/documents/${d}/layers`)).data.map((l) => [l.attributes.name, { id: l.id, state: l.attributes["live-state"] }]));
  const L0 = await layers();
  const byId = Object.fromEntries(Object.entries(L0).map(([n, v]) => [v.id, n]));
  const sets = (await j(`/documents/${d}/layer-sets`)).data;
  console.log(`== ${name}`);
  for (const s of sets) {
    const got = Object.fromEntries(s.attributes.layers.map((e) => [byId[e["layer-id"]] ?? e["layer-id"], e.action]));
    const want = WANT[s.attributes.name];
    if (!want) { fail(`unexpected set ${s.attributes.name}`); continue; }
    const diff = [...new Set([...Object.keys(want), ...Object.keys(got)])].filter((k) => want[k] !== got[k]);
    console.log(`  ${s.attributes.name}: ${JSON.stringify(got)} ${diff.length ? "" : "= table"}`);
    for (const k of diff) fail(`${s.attributes.name}: ${k} is ${got[k] ?? "No Action"}, want ${want[k] ?? "No Action"}`);
  }
  // recall test
  const tc0 = { TALLY: L0.TALLY.state, COUNTER: L0.COUNTER?.state ?? "absent" };
  for (const sn of ["Two Shot", "Slides PiP", "Full Slides", "Speaker Wide"]) {
    const s = sets.find((x) => x.attributes.name === sn);
    await j(`/documents/${d}/layer-sets/${s.id}/recall`);
    await sleep(700);
    const L = await layers();
    const states = Object.fromEntries(Object.keys(WANT[sn]).map((k) => [k, L[k].state]));
    const wrong = Object.entries(WANT[sn]).filter(([k, v]) => (v === "live") !== (L[k].state === "live"));
    const active = (await j(`/documents/${d}/layer-sets`)).data.filter((x) => x.attributes.active).map((x) => x.attributes.name);
    const tc = { TALLY: L.TALLY.state, COUNTER: L.COUNTER?.state ?? "absent" };
    console.log(`  recall ${sn}: ${JSON.stringify(states)} active=${JSON.stringify(active)} TALLY/COUNTER=${tc.TALLY}/${tc.COUNTER}`);
    if (wrong.length) fail(`recall ${sn}: ${wrong.map(([k]) => k).join(", ")} not as set`);
    if (active.length !== 1 || active[0] !== sn) fail(`recall ${sn}: active sets ${JSON.stringify(active)}`);
    if (tc.TALLY !== tc0.TALLY || tc.COUNTER !== tc0.COUNTER) fail(`recall ${sn}: TALLY/COUNTER changed ${JSON.stringify(tc0)} -> ${JSON.stringify(tc)}`);
  }
}
console.log(fails ? `${fails} FAIL(S)` : "ALL PASS");
process.exit(fails ? 1 : 0);
