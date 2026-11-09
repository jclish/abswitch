// watch.mjs <ms> <outfile> [ctlPort] — polls MASTER switcher live slot, NDI tally, TALLY layers in A/B,
// and takectl /state every 40 ms; logs only transitions, with ms since start.
import { writeFileSync } from "node:fs";
const [,, ms, out, port = "8991"] = process.argv;
const B = "http://localhost:8989/api/v1";
const j = (p) => fetch(B + p).then((r) => r.json());
const docs = (await j("/documents")).data;
const id = (n) => docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n).id;
const A = id("PH-A"), Bd = id("PH-B"), M = id("PH-MASTER");
const lay = async (d, n) => (await j(`/documents/${d}/layers`)).data.find((l) => l.attributes.name === n).id;
const TA = await lay(A, "TALLY"), TB = await lay(Bd, "TALLY"), SW = await lay(M, "AB Switcher");
const srcs = (await j(`/documents/${M}/sources`)).data;
const SA = srcs.find((s) => s.attributes.name === "NDI PH-A").id, SB = srcs.find((s) => s.attributes.name === "NDI PH-B").id;
const t0 = Date.now(); const lines = []; let last = "";
const end = t0 + Number(ms);
while (Date.now() < end) {
  const [sw, ta, tb, sa, sb, st] = await Promise.all([
    j(`/documents/${M}/layers/${SW}`), j(`/documents/${A}/layers/${TA}`), j(`/documents/${Bd}/layers/${TB}`),
    j(`/documents/${M}/sources/${SA}`), j(`/documents/${M}/sources/${SB}`),
    fetch(`http://localhost:${port}/state`).then((r) => r.json()).catch(() => null),
  ]);
  const snap = `slot=${sw.data.attributes["input-values"].tvGroup_Hidden_Inputs__currentLiveSource} tally[A=${sa.data.attributes["tally-state"]} B=${sb.data.attributes["tally-state"]}] TALLY[A=${ta.data.attributes["live-state"]} B=${tb.data.attributes["live-state"]}] takectl[pgm=${st?.pgm ?? "-"} busy=${st?.busy ?? "-"} err=${st?.lastError ?? ""}]`;
  if (snap !== last) { lines.push(`${String(Date.now() - t0).padStart(6)}ms  ${snap}`); last = snap; }
  await new Promise((r) => setTimeout(r, 40));
}
writeFileSync(out, lines.join("\n") + "\n");
console.log(lines.join("\n"));
