# CHANGES — takectl against mimoLive 7.0b3 (build 30982), 2026-11-08

Bench: one Mac (all three documents in one mimoLive), Node 22.23.2. Every claim below
comes from a live API response; the raw responses are in `test/captures/`.
Untouched originals are in `original/`.

## Changed in `takectl.mjs`

Edits stay within the five allowed drift points. HTTP routes and config schema are unchanged.

### Drift 2 — `tally-state` values (`resync()`, `verify()`)

**Observed.** On 7.0b3 a source's `tally-state` is `program` (on air), `in-use` (in the
switcher, off air) or `off`. During a dissolve **both** NDI sources report **`effect`** for the
length of the transition (~450–500 ms), then settle to `program` / `in-use`. A cut goes straight
from one settled state to the next. Evidence: `test/captures/websocket-events.json`,
`test/bench2-watch.txt`.

**Before.** `resync()` only recognised `program`, with `program`+`program` as the mid-dissolve case.
An `effect`/`effect` read fell through to "tally inconclusive" and fell back to the datastore
(or the default `A`). This happened on **every** outside dissolve. The original takectl,
run against two outside dissolves, logged it twice per dissolve
(`test/takectl-original-falsify.log`). It reached the right answer only because the datastore was
correct at the time.

**After.**
- `effect` on either source is treated as mid-dissolve: keep the current PGM.
- `verify()` re-reads once after `settleMs` if it still sees `effect`, rather than declaring a failed take.
- With the fix, outside dissolves produce no "inconclusive" path (`test/bench5a-watch.txt`).

### Drift 3 — slot detection (`slotOf()` in `Master.discover()`)

**Observed.** The Video Switcher's slot inputs are named by **letter**: `tvIn_VideoSourceAImage`
(slot 1) … `tvIn_VideoSourceHImage` (slot 8). Each holds a source id of the form `{docId}-{UUID}`.
The ninth slot ("Below") has signals but no image input.

**Before.** `slotOf()` looked for a digit in the key, so it never matched. It returned `null`
silently, and the slots fell back to `"1"`/`"2"`. This was invisible as long as the slots really
were 1 and 2.

**After.** `^tvIn_VideoSource([A-H])Image$` maps the letter to its 1-based slot. The digit rule is
kept as a fallback.

**Falsified live.** With NDI PH-B moved into slot A and NDI PH-A into slot B, the original reported
`slotA "1" / slotB "2"` (wrong) and the fixed one reported `"2" / "1"`. The slots were restored afterwards.

### No change needed (verified live)

| Drift point | What 7.0b3 actually does |
|---|---|
| 1. Signal-key regex | Keys are `tvGroup_Control__Cut_{1..8}_TypeSignal`, `tvGroup_Control__Dis_{1..8}_TypeSignal`, plus `Cut_Below` / `Dis_Below`. The existing regex finds 1–8 and ignores `Below`. `GET …/layers/{id}/signals/{key}` fires them (HTTP 200). |
| 4. Datastore | `PUT …/datastores/{id}` with `Content-Type: application/json` stores the body verbatim. `GET` returns it verbatim as `application/json`, unwrapped. A missing store returns 404, which `readState()` already treats as null. |
| 5. WebSocket | `ws://host:8989/api/v1/socket` works. Events look like `{type:"sources", event:"changed", id:"<full source id>", "document-id":"<docId>", data:{…attributes incl. tally-state}}`, which is exactly what `connectSocket()` matches. `{event:"ping"}` gets `{"event":"pong"}`. Expect heavy noise: `documents changed` arrives every second per document, plus `variants`/`layers` `values-changed`. |

`doctor` passes against the real documents (`test/doctor-real.txt`).

## Changed on the brief of 2026-11-09 (outside the five drift points, authorized)

HTTP routes and config schema are still unchanged. Evidence: `test/guard-tally-check.mjs` →
`test/guard-tally-check.txt`, `test/tally-overlap-watch.txt`, `test/takectl-guard.log`.

### Split TALLY on a transition (`applyRoles()` → `applyIncoming()` + `releaseOutgoing()`)

**Before.** `transition()` called `applyRoles()`, which lit the incoming TALLY and turned the
outgoing one off at the same moment, about 100 ms before the dissolve even started.

**After.**
- `transition()` calls `applyIncoming()`: the incoming TALLY lights and the roles are persisted at once.
- `verify()` calls `releaseOutgoing()` only once tally confirms the new PGM.
- If `verify()` fails, it resyncs and then calls `applyRoles()`, which settles both TALLYs to the
  resynced PGM. Otherwise both would stay lit.
- `applyRoles()` keeps the old immediate behaviour for startup, resync and `/panic`.
- A sequence number (`takeSeq`, bumped by every transition and `/panic`) stops a stale `verify()`
  from touching TALLY after a newer transition or a panic.

**Measured** (40 ms watcher, `test/tally-overlap-watch.txt`):

| Transition | Both TALLYs lit | Outgoing goes off |
|---|---|---|
| Dissolve | ~770 ms | ~250 ms after the switch completes |
| Cut | ~250 ms | after `settleMs` |

**Stale-verify guard, falsified.**
- **Test:** `/take` to B, then `/panic` at +620 ms, after the dissolve lands but before `verify()`
  runs at +750 ms.
- **With the guard:** `lastError` stays null.
- **On a copy of takectl with the two `stale()` returns removed:** the same run leaves
  `verify failed: expected B on program` in `lastError`. So the test discriminates.

### COUNTER guard (`preflight()`, `doctor`)

`preflight()` now refuses if a layer named `COUNTER` is live in **A or B**, not just the target,
because the outgoing document stays on air through the dissolve. The message names the document:

```
A has a live "COUNTER" layer (bench stopwatch) — it would go to air; switch it off or delete it in "PH-A"
```

- `doctor` gets the check through `preflight()` and de-duplicates the messages.
- **COUNTER live:** `doctor` exits 1 (`test/doctor-counter-live.txt`); `/take` is refused and
  MASTER's live slot does not move.
- **COUNTER off:** `doctor` exits 0 (`test/doctor-real.txt`, regenerated 2026-11-09).
- **Note:** the bench documents as saved have COUNTER live, so `doctor` fails on them until it is
  switched off. That is intended.
- The layer name is a constant (`COUNTER_LAYER`), not a config key, so the schema is unchanged.
  `"preflight": false` still disables every preflight check, this one included.

## Changed on the ruling of 2026-11-09: switcher truth, panic (authorized)

HTTP routes and config schema are unchanged; `/state` gains two fields (`switcher`, `warning`).
mimoLive 7.0b3, build 30982.

### Probe first (`test/switcher-probe.mjs`, `test/switcher-probe-2.mjs` → `.txt`)

- **The key:** `input-values.tvGroup_Hidden_Inputs__currentLiveSource`, the 1-based live slot, is
  mirrored as `output-values.tvSet_tvGroup_Hidden_Inputs__currentLiveSource`. Across one cut the
  only other keys that change are the switcher's per-slot tally codes,
  `output-values.tvOut_tvIn_VideoSource{A..H}ImageTallyState`: 40 program, 30 effect, 10 in-use.
- **Timing:** the slot flips at the **end** of a dissolve (~567 ms after `Dis_n`); for its length
  both slots read 30.
- **No switcher event:** over 8.8 s with three dissolves and two cuts the WebSocket sent nothing for
  the switcher layer (neither `changed` nor `values-changed`) after the burst on connecting.
  `sources changed` fires for both NDI sources at every cut and at both ends of every dissolve.
- **Mid-dissolve cut:** `Cut_1` sent 202 ms into `Dis_2` is overridden (ends on slot 2 at 541 ms);
  a second `Cut_1` after the dissolve lands within 15 ms.

### Truth, wake, witness (`resync()`, `Master.switcherState()`, `witness()`)

- **Truth:** `resync()` takes PGM from the switcher's live slot (slot → A/B via `slotA`/`slotB`).
  Both per-slot codes at 30 = a transition is in flight: the read is "busy, come back" and roles are
  kept. This replaces the tally heuristics ("both `program` → keep" and the [drift 2] "`effect` →
  keep"). At startup, with no roles yet, it waits the transition out (up to 10 × 150 ms).
- **Wake:** the WebSocket subscription (`sources changed` for the two NDI sources) and the poll are
  unchanged; they only cause the read. PGM is never derived from `tally-state` any more.
- **Witness:** both sources' `tally-state` is read with every resync. Agreement = the switcher's PGM
  source reads `program` and the other does not (`effect` counts as agreement). A disagreement that
  outlasts one settle period sets `/state.warning`
  (`source tally disagrees with switcher (A=…, B=…, slot=…)`) and logs **one** `WARNING` line per
  episode, carrying the per-slot codes from the same read: the pair item 9 needs. When it ends, one
  "agrees … again" line. It never changes roles or TALLY.
- **Addition, flagged:** while takectl's own transition is busy, the poll and the witness re-check
  now stand aside, as the socket wake-up already did. A read in the first ~90 ms of a takectl
  dissolve still shows the old slot with codes 40/10, so it would have flipped the roles back.
- **`doctor`:** if the first read disagrees, it reads again one settle period later so the witness
  can speak, and prints a `WITNESS` line. Not a preflight problem: the exit code is unchanged.

### `verify()` and `panic()`

*Superseded by the second ruling below (an in-flight read never decides; panic loops on the switcher's live state). Kept as the record of the first build.*

- **`verify()`:** first read at `dissolveMs + settleMs` as before. If the slot is not the expected
  one and both codes are 30, re-read up to 3 × at 150 ms (`confirmSlot()`); only then fail.
- **`panic()`:**
  - cut to A now; cancel the pending `verify()` timer (the `takeSeq` guard still covers one already
    running);
  - if `busyUntil` is in the future, a second `Cut_1` at `busyUntil + settleMs`, holding TAKE/CUT
    off until it lands;
  - then the same completion loop, first read at `settleMs` after the last cut (a cut's
    `dissolveMs` is 0).
- **Why the settle wait:** the first run read the switcher the instant the second cut returned. It
  still showed slot 2, and a cut has no in-flight state to retry on. So `/panic` answered "did not
  land on A" at +1031 ms, while the test's own sampler had already seen MASTER on slot 1 at +1027 ms
  (`test/panic-check-run1-early-read.txt`).
- `/panic` now answers once A is confirmed (~0.3 s, or ~1.2 s mid-TAKE) with `cuts` and `ms`.

### Tested on this bench (all against the real mimoLive)

| Test | Result | Falsified against takectl as it was before this ruling |
|---|---|---|
| `panic-check`: `/take`, `/panic` at 0 / 200 / 600 ms | 3/3 PASS: A on air, pgm A, TALLY A lit, no error | 0 and 200 ms **FAIL**: B on air while `/panic` answered `ok:true`; 600 ms passes (`test/falsify/`) |
| `witness-check`: slot 1 pointed at NDI PH-B, so the switcher says A while tally says B | PASS: warning after ~420 ms, one log line, roles stay A, cleared after ~107 ms when restored | **FAIL**: it handed PGM to B on the tally (`test/falsify/`) |
| `guard-tally-check`: COUNTER guard, `doctor` both ways, TALLY handover trace, stale `verify()` | ALL PASS. Its old FINDING, `/panic` 150 ms into a dissolve, now ends on A | (run before, 2026-11-09) |
| `bench5-check`: desync recovery | PASS: outside cut/dissolve followed 0–41 ms after the slot moved; restart came up on B from the switcher while the datastore said A | — |

## Changed on the second ruling of 2026-11-09: panic wins, in-flight never decides (authorized)

Closes proposals 11 and 12. Routes and config schema unchanged; `/panic` now answers `rounds`
instead of `cuts`.

- **11, panic always wins a race with TAKE.**
  - `transition()` notes `takeSeq` on entry. If a `/panic` bumped it during preflight, it sends
    nothing and answers `ok:false` ("/panic arrived during preflight; signal not sent").
  - *Part of 11, flagged:* the same check runs again right after the TAKE's own signal returns. A
    panic that lands during that HTTP call owns MASTER, and the TAKE must not take the roles back;
    panic's loop deals with the transition the TAKE has just started.
- **12a, an in-flight read is never a decision**, whatever the slot or caller:
  - `resync()` already returned without deciding.
  - `confirmSlot()` now re-reads while both slots read 30, whatever the slot. The old condition,
    "slot ≠ expected and both 30", let a read of the dissolve's *source* pass.
  - *`verify()`, flagged as the direct consequence:* still in flight after its 3 retries, it now
    decides nothing (before: "verify failed"). Both TALLYs stay lit, and the next settled read (the
    sources' event at the transition's end, or the poll) decides and settles them, logging
    "transition settled on a later read".
  - `doctor`, mid-transition on every read, decides no PGM and says so (`SWITCHER: mid-transition …`).
  - Panic's loop: below.
- **12b, panic loops on live state:**
  - cut to A; read one settle period later;
  - if the read is not A on 40 with B not 30, wait and cut again; at most 3 rounds, then report;
  - an in-flight read waits `settleMs`, or until takectl's own TAKE should have landed
    (`takeEndsAt + settleMs`) if that is later; a settled read showing B cuts again at once;
  - `busyUntil` is no longer the authority. *Flagged:* the hint has its own field, `takeEndsAt`,
    because panic now holds `busyUntil` itself while it runs, to refuse TAKE/CUT and keep wake-ups
    out. A second `/panic` would otherwise read the first one's hold as a "hint".
- **Mock:** `test/mock-mimolive.mjs` serves the switcher by ID, with `currentLiveSource`, per-slot
  codes, and a 30/30 window for the length of a mock dissolve.
  - *Flagged addition:* a cut sent during a mock dissolve is overridden, as on 7.0b3. Without it a
    panic test could never fail offline.
  - takectl starts against it again; `test/mock-smoke.mjs` runs the panic cases offline (ALL PASS).

**Tested on the real mimoLive** (falsification copy = takectl as it stood after the first ruling):

| Test | Result | Falsified |
|---|---|---|
| `panic-check`: `/panic` 0 / 200 / 600 ms after `/take` | 3/3 PASS: 2, 2 and 1 rounds | (passed before too) |
| `panic-check` 11: `/take` and `/panic` together | PASS: TAKE answered `ok:false`, nothing sent; A on air, 1 round | **FAIL**: ended on B |
| `panic-check` 12: outside `Dis_2`, `/panic` 200 ms later | PASS: A on air after 2 rounds, 793 ms | **FAIL**: ended on B |
| `inflight-check` V: switcher transition 2.0 s, config 0.5 s | PASS: verify decided nothing; settled to B on the next read, TALLY right, `lastError` null | **FAIL**: "verify failed … still mid-transition" |
| `inflight-check` D: `doctor` 200 ms into a 4 s dissolve | PASS: no PGM, says mid-transition | Fails only for the missing message: the old `doctor` also decided no PGM, so this does not falsify the rule itself |
| `guard-tally-check`, `witness-check`, `bench5-check` (regression) | ALL PASS | — |

## Changed on the UI brief of 2026-11-09: operator page, PVW Layer Sets, stall warning (authorized)

Existing routes and config schema unchanged. New: `GET /` and `GET /pvw/layer-set/<name>`; `/state`
gains `switcher.inFlight`, `layerSets`, document `id`s, and `lastTake.transition` / `lastTake.ms`.

- **Stall warning.**
  - Every switcher read goes through one observer. In flight (both slots 30) for more than 5 s,
    `/state.warning` reads `transition stalled (N ms)` (N counts up) and the log gets one line.
  - It decides nothing. The next settled read clears it, with a "no longer stalled" line.
  - `warning` now joins the stall and the witness with "; " when both apply.
  - *Flagged:* `TAKECTL_STALL_MS` is a test hook (an environment variable, not a config key).
    7.0b3 caps a real dissolve at 5 s: a 6 s setting ran ~5.0 s in flight. So the bench lowers the
    threshold to 2 s to watch the warning on the real app.
- **`GET /pvw/layer-set/<name>`** recalls the set in whichever document is PVW. Refused if PVW has
  no set of that name (the message names the document).
  - *Flagged additions:* also refused while a transition is busy or in flight, and when a fresh
    switcher read says PVW is on air. During a TAKE, "PVW" is already the outgoing document, and it
    is still on air until the dissolve lands.
- **`GET /`, the operator page** (`operator.html`, served from next to `takectl.mjs`), as briefed.
  *Flagged:*
  - **Its own file**, read on each request, rather than a string inside `takectl.mjs`. Easier to
    edit; one more file to keep next to the controller (README, Files).
  - **`localhost` rewrite:** a document host of `localhost` is rewritten to the host the page came
    from. Otherwise an iPad would ask itself for the pictures.
  - **More buttons wait for transitions:** MIRROR and the Layer Set buttons are disabled while busy
    or in flight, like TAKE and CUT, for the same reason as the route's refusal.
  - **Layer Set names come from the documents:** the sets present in both A and B, refreshed with
    the 5 s poll. They are not typed into the page.
  - **Focus:** a pressed button gives up keyboard focus, so Space always means TAKE.
- **Keyboard decision 5, flagged: TALLY read-back and repair** (`Doc.setTally()` → `repairTally()`).
  - **The fault (7.0b3):** a TALLY layer told `setOff` ~15 ms after `setLive` can stay in
    `shutdown`, and in that state it ignores `setLive` until it gets another `setOff`.
  - **Proof it is mimoLive's:** reproduced with no takectl running. It fires at random (first try in
    one probe, sixth in another). The bar is not visible while stuck.
  - **Where it bit:** `/take` then `/panic` at once. After that, B's TALLY stayed dark on its next
    TAKE to air.
  - **The repair:** takectl now reads TALLY back 800 ms after each command. If it is not in the
    wanted state, it sends `setOff`, then `setLive` if live is wanted, and logs both.
  - Found by `panic-check` round 0, which failed 3/3 after the UI changes; it had passed 3/3 before
    by luck of timing (`test/panic-check-tally-shutdown-run.txt`).

**Tested on the real mimoLive** (falsification copy = takectl as it stood before this brief):

| Test | Result | Falsified |
|---|---|---|
| Operator page during bench 5 (browser pane, 40 ms sampler) | Both borders red for ~520 ms in each dissolve, then the right PGM/PVW; outside cuts followed; grey "takectl unreachable" when stopped; back with B from the switcher on restart (`operator-page-bench5-watch.txt`) | — |
| Operator page controls (`operator-page-controls.txt`) | Space / C / M sent TAKE / CUT / MIRROR; refusals as 28 px toasts; no key can panic; PANIC fires on a 0.7 s hold (715 ms) or two taps within 1 s, not on one tap, a 0.4 s hold, or taps 1.3 s apart; "Two Shot" changed only the green document | — |
| Pictures in a real browser (`operator-page-chrome.txt`, headless Chrome 157, page via the LAN address) | Both pictures decode inside the page at 960 × 540; screenshot `operator-page.png` | — |
| `pvw-layerset-check` | PGM A: only B changed; PGM B: only A changed; unknown name and mid-TAKE refused, nothing changed | Two-sided by construction (not run against a copy) |
| `stall-check` (hook 2 s, 4 s dissolve) | Warning at 2.2 s, PGM untouched while stalled, cleared and settled to B at 4.1 s | **FAIL**: no warning |
| `tally-repair-check` (stuck state forced, then TAKE to B) | B's TALLY repaired: `shutdown` → `off` (+839 ms) → `live` (+951 ms) | **FAIL**: B went on air with TALLY stuck in `shutdown` |
| `panic-check` ×3, `guard-tally-check`, `witness-check`, `inflight-check`, `bench5-check`, `mock-smoke` | ALL PASS | — |

**Second device:** the operator opened `http://192.0.2.10:8991/` on an iPad on the LAN
(2026-11-09): both pictures moving. Everything else above ran on this Mac, with the page loaded
by the LAN address in two browsers.

## v0.1.1, 2026-11-09: release housekeeping, rulings 6 and 13 (authorized)

**Housekeeping for publication:**
- **Logs redacted, not dropped.** The bench Mac's hostname now reads `Studio-Mac-Mini`, its home
  folder `~`, its LAN address `192.0.2.10` (a documentation address). The operator is "the
  operator". Every redacted JSON still parses; BENCH-RESULTS opens with a note on this.
- **The saved documents:** the hostname appears only in PH-MASTER, in the two NDI sources'
  stored name and ID. `pack.sh` overwrites it in the packaged copies with a placeholder of the same
  length (binary plist, so no offset moves and nothing else changes). The copies must still pass the
  saved-files check; the Desktop originals are untouched. Anyone else re-points those sources anyway
  (the build script does it).
- **`test/privacy-scan.py`:** reads this Mac's hostname, computer name, user name, home folder and
  LAN addresses when it runs (the script carries none of them), scans every file text or binary,
  and `pack.sh` refuses a package with any hit.
- **`LICENSE`:** MIT (copyright holder as named there).
- **README:** a status block at the top: v0.1.1, a working proof, 7.0b3 (30982), NDI test
  sources, bench tests 3, 4 and 7 not yet run.

**Ruling 6, `lastError`:**
- Every write goes through `setError()`, which records when it happened.
- A successful TAKE or CUT clears it the moment its signal is sent; before, it waited for verify,
  ~750 ms. A confirmed PANIC clears it, as before. Nothing expires it on time.
- `/state` adds `lastErrorAt` and `lastErrorAgeMs` (takectl's clock), and the operator page shows
  "· N s ago".

**Ruling 13, `/mirror`:** refused with `busy: …` while takectl's own transition is busy, or while a
fresh switcher read is in flight.

**Tested on the real mimoLive** (`error-mirror-check.txt`; falsification copy = takectl before
these rulings, `falsify/error-mirror-check-before-6-13.txt`):

| Check | Now | Before |
|---|---|---|
| 6a. refused (show stopped): error set, age grows, still set 3 s later | PASS | **FAIL**: no `lastErrorAt` / age |
| 6b. `/take` ok: error gone right after the answer | PASS | **FAIL**: still set until verify |
| 6c. `/cut` ok after a refusal: error gone | PASS | **FAIL** |
| 6d. `/panic` ok after a refusal: error gone | PASS | passed (unchanged) |
| 13e. `/mirror` during takectl's TAKE | refused, `busy` | **FAIL**: recalled into A, the outgoing document still on air |
| 13f. `/mirror` 0.8 s into a 4 s outside dissolve | refused, `busy` | **FAIL**: same |
| 13g. `/mirror` after it lands | works | works |

- **Operator page:** in the browser pane, a refused TAKE showed "B document is not live (show not
  started) · 1 s ago", counting up.
- **Offline:** `mock-smoke` also checks MIRROR refused mid-TAKE and mid outside dissolve.
- **Regression on the real app:** panic, in-flight, stall, TALLY repair, PVW Layer Sets, witness
  and bench 5 all pass. `guard-tally-check` needs the bench COUNTER, absent in the release, and stops
  with directions.

## Release prep, 2026-11-09: the documents ship in release state (v0.1 candidate)

- **Saved documents (12:04 saves):** no COUNTER in PH-A or PH-B, both TALLYs saved off, PH-MASTER
  saved on slot 1 with takectl's stored state "A on air". COUNTER was deleted through the API
  (HTTP 204); no Layer Set referred to it, and their contents were unchanged.
- **`test/saved-docs-check.py` now asserts the release state:** no layer named COUNTER, and TALLY
  present and saved off (a layer saved live carries `liveSetting`), in A and B. `pack.sh` runs it,
  so it cannot regress.
  - **Falsified:** on the 11:57 bench-state saves it failed with exactly the three problems
    (COUNTER in A, COUNTER in B, A's TALLY saved lit). On the 12:04 saves: ALL PASS.
- **COUNTER is a bench add-back.** It is a Stopwatch layer, not a Placer with a source.
  - `documents/build-documents.mjs` only creates it with `BENCH_COUNTER=1`, so a rebuild cannot
    bring it back.
  - The add-back step, by script or by hand, is in the README's bench protocol, test 3.
  - Tests that only switch COUNTER off around a TAKE now treat it as optional. The three that need
    the running stopwatch (`bench1-independence`, `guard-tally-check`, `record-take`) stop with
    directions instead of crashing.
- **`GET /` confirmed:** against the real documents it served `operator.html` byte-identical as
  `text/html`. `test/mock-smoke.mjs` now checks the same offline. The README shows
  `operator-page.png`.

**What "release" covers** (design review, 2026-11-09):
- **v0.1 for the FullHAUS operator:** yes, as of this package. Item 9 is a witness-only warning now.
- **Forum / Boinx:** the approach and the item-9 bug report, yes. The package itself waits until
  it has run one real show.
- **Not yet, either way:** bench tests 3, 4 and 7 with real cameras and real audio, on the
  FullHAUS rig.

## Proposals (not applied — outside the five drift points)

1. **Preflight should check the NDI link, not just the output's state.**
   - **Observed on 7.0b3:** re-PATCHing an NDI output with the title it already has stops the
     sender advertising, while the output keeps reporting `live-state: live`. takectl's preflight
     would pass and the TAKE would dissolve to a dead feed.
   - **What catches it:** MASTER's source attribute `video-device-connected` went `false` the moment it happened.
   - **Proposal:** in `preflight(target)`, also `GET` the target's MASTER source and refuse
     unless `video-device-connected === true`.
2. **TALLY reaches air unless MASTER crops it.** *(Superseded 2026-11-09: the brief chose
   "incoming immediately, outgoing after verify" — see above. That keeps **both** bars live through
   every dissolve, so the crop is still mandatory.)* `transition()` calls `applyRoles()` as soon as
   the signal returns. The incoming document's TALLY goes live about 100 ms *before* its dissolve
   starts (`test/bench2-watch.txt`), so the bar is dissolved onto air.
3. **Rebuild the mock from captures.** `test/mock-mimolive.mjs` has:
   - off-air tally as `preview` (real: `in-use`);
   - mid-dissolve as `program`/`program` (real: `effect`/`effect`);
   - no slot inputs at all, so `slotOf()` was never exercised.

   It passed on exactly the two behaviours this beta does differently. Feed it from
   `test/captures/` instead of hand-typed values.
   - **Switcher part DONE (second ruling, 2026-11-09):** the read-only bit was an artifact of how
     the package reached the Mac, not a rule. The mock now models the 7.0b3 switcher and takectl
     starts against it again (`test/mock-smoke.txt`). **Still open:** the source tally values above.
4. **Datastore calls ignore `apiPasswordSha256`.** `readState`/`writeState` use bare `fetch`
   without the password header. With a password set, state persistence would fail silently.
   Route them through `api()`.
5. **`/mirror` and empty Layer Sets.** A new, empty Layer Set reports `active: true`, so until
   the sets are recorded, `activeLayerSetName()` returns whichever comes first.
   - **Re-tested 2026-11-09 with the sets recorded: PASS** (`test/layersets-check.txt`, `test/takectl-mirror.log`).
     - Exactly one set reads active after each recall, including in a document whose TALLY is lit.
     - `/mirror` copied Slides PiP, Two Shot and Full Slides from A to B.
   - **Remaining risk:** a set left empty would still read active and could win. Optional hardening:
     have `activeLayerSetName()` skip sets whose `layers` list is empty.
6. **Stale `lastError`.** **CLOSED 2026-11-09 (v0.1.1):** ruled and built, see "v0.1.1" above. A refused preflight leaves `lastError` set until the next successful
   verify (seen as a lingering "B document is not live" in `test/bench2-watch.txt`). Consider
   clearing it on the next successful transition request.
   - **Now on screen:** the operator page's ERROR line keeps a COUNTER refusal after COUNTER is
     switched off, until the next TAKE lands.
7. **README corrections for 7.0b3:**
   - The Video Switcher has **no geometry/zoom input**, so crop with a "Scale & Transform" filter on the two NDI sources.
     Use Mode Custom, 1920 × 1080, Zoom 105. The filter's defaults (500 × 500, Zoom 50) squash the picture.
     Verified on MASTER's recording: zoom 105 leaves no TALLY rows (`test/evidence/master-pgm-A-zoom105.png`).
   - Source Count offers only 9 or 4 (no 2).
   - There is no audio-follow-video toggle: the switcher layer has no audio path (`volume: null`).
   - NDI sender names lose hyphens (`PH-A` advertises as `(PHA)`).
   - A 2.5 % zoom crops only ~13 px top/bottom, so it does **not** hide a 24-px bar. Use 105 %, or make the bar ≤ 12 px.
   - Leave TALLY and COUNTER *unaffected* by every Layer Set (not recorded as off), or a recall will fight takectl over tally and `/mirror` will never see the on-air set as active.
8. **`/panic` during a dissolve does not land** (pre-existing; seen 2026-11-09). **CLOSED 2026-11-09:** fixed as ruled, see "switcher truth, panic" above; `test/panic-check.txt`.
   - **What happens:** `/panic` 150 ms into a dissolve to B fires `Cut_1`, but the switcher finishes
     the dissolve anyway. MASTER ends on **B**, while takectl reports `pgm: A` and lights A's TALLY.
   - **Usually it would self-heal:** the next tally-driven resync would see B on program. On this
     bench it did not, because of finding 9.
   - **Proposal:** if `/panic` arrives while `busyUntil` is in the future, fire the cut again once
     the dissolve ends, then verify like a transition does.
9. **Tally: NDI PH-A reads `program` while B is on air** (mimoLive 7.0b3, build 30982; OPEN — cleared the same day, cause not found, it can come back).
   - **When (PST, 2026-11-09):** stuck before 08:56; stuck again at 09:12 once the new source had
     its filter (`test/tally-swap-check-fresh-source-with-filter.txt`); still stuck after the shows
     were restarted following the break; correct from about 10:36 (the first read after the
     screenshot), and on every read since.
   - **Harmless since the ruling:** takectl takes PGM from the switcher's live slot. A recurrence
     shows as `/state.warning` and one `WARNING` line in takectl's log.
   - **If it recurs, capture both reads in the same second.** Source `tally-state` and the
     switcher's per-slot codes `tvOut_tvIn_VideoSource{A,B}ImageTallyState` together are a complete
     bug report for Boinx. takectl's `WARNING` line already carries both.
   - **Observed:** after any switch to slot 2, MASTER reports `A=program B=program` indefinitely,
     whether the switch came from takectl or from a direct switcher cut. B never sticks.
     Yesterday's bench showed `A=in-use` at the same point.
   - **What it breaks:** takectl reads `program`/`program` as "mid-dissolve" and keeps its PGM. So
     `verify(A)` cannot fail, and an outside switch to B goes unnoticed.
   - **It is the source object itself** (`test/tally-swap-check.txt`, `test/tally-fresh-source-check.txt`):
     - **Senders swapped:** "NDI PH-A" receiving the PHB sender still sticks.
     - **Slots swapped:** "NDI PH-A" in slot 2 still sticks.
     - **Not in the switcher at all:** it still reads `program`.
     - **Fresh source:** a new Camera source on the same PHA sender, with no filter, put in slot 1,
       reports correctly (`in-use` while B is live).
     - **Survives a close and reopen of PH-MASTER.**
     - **Saved file:** its entry is identical to NDI PH-B's apart from IDs, filter values included.
     - **Not an open window:** the operator confirmed nothing was open on it.
   - **Replacing the source did not fix it** (2026-11-09):
     - The old source was deleted and the build created a fresh "NDI PH-A".
     - The fresh source, with no filter, reported correctly in all three swap configurations
       (`test/tally-swap-check-fresh-source.txt`).
     - The moment the operator added Scale & Transform to it in the UI, without opening its editor, it
       stuck at `program` again, following the source through the sender and slot swaps
       (`test/tally-swap-check-fresh-source-with-filter.txt`).
     - NDI PH-B carries the same filter and stays correct.
     - So the trigger is "a filter added in the UI on NDI PH-A". Some UI state seems to point at A,
       for example the selected source or a filter-inspector preview counting as program. This is
       not confirmed: the API exposes no UI state.
     - With all three shows stopped (2026-11-09, after a break), NDI PH-A still read `program`
       and NDI PH-B `in-use`, so A's `program` does not depend on anything being rendered. After
       restarting the shows and cutting to B, both read `program` again.
   - **Cleared, cause not found** (2026-11-09):
     - It cleared between the last stuck read (shows restarted, MASTER cut to B) and the operator's
       screenshot of the PH-MASTER window. The screenshot shows mimoLive's own tally dots right
       (NDI PH-B red, NDI PH-A grey), AB Switcher selected, no inspector open on a source.
     - Since then A and B track correctly, both ways (cuts 1, 2, 1, 2).
     - Not reproduced by selecting NDI PH-A in the Sources panel, nor its Scale & Transform row,
       each followed by selecting AB Switcher. B was on air throughout, tally polled every 150 ms
       (`test/tally-selection-watch-try2-source-click.txt`, `test/tally-selection-watch-try3-filter-click.txt`).
     - So both trigger and cure are unknown. Assume it can come back after any UI edit to MASTER's
       sources. Since proposal 10 was applied it is logged, not acted on.
     - Side finding: clicking a picture in the AB Switcher's preview (MASTER, top middle) cuts
       MASTER live (`test/tally-selection-watch-try1.txt`: slot 2 → 1 on a click meant for the
       Sources panel). takectl's outside-change resync covers it, but operators should know.
   - **The crop itself is fine** with the new filter: 24 red rows at zoom 100, none at 105, on
     MASTER's output (`test/evidence/master-pgm-A-zoom*.png`, regenerated).
   - **Before a show,** `/state.warning` must be null with A on air and with B on air (README, "Before a live show").
10. **Read the switcher's live slot, not only source tally.** **CLOSED 2026-11-09:** applied as ruled (truth / wake / witness), see "switcher truth, panic" above. The original proposal, kept for the record:
    - **Why:** finding 9 shows a source's `tally-state` can stick at `program` while it is off
      air. takectl's design trusts tally (README, "Why this shape").
    - **What to read instead:** the switcher's `tvGroup_Hidden_Inputs__currentLiveSource` was right
      on every read this session.
    - **Proposal:**
      - Use the live slot as ground truth for PGM in `resync()` and `verify()`.
      - Keep tally only to recognise a dissolve in progress (`effect`).
      - Log any disagreement between the two.
    - **Not applied:** this changes takectl's ground-truth design, which is outside this brief.
11. **`/take` and `/panic` pressed together: `/panic` loses** (`test/panic-check.txt`, FINDING). **CLOSED 2026-11-09:** fixed as ruled, see "second ruling" above.
    - **What happens:** `/panic` sent while `/take` is still in its preflight (~50–80 ms):
      - panic cuts to A (already on air) and starts its settle wait;
      - the TAKE's signal then goes out and dissolves to B;
      - the TAKE bumps `takeSeq`, so `/panic` answers `ok:true, superseded:true` with **B on air**.
    - **Proposal:** `transition()` notes `takeSeq` on entry and refuses to send its signal if it
      changed during preflight: a panic arrived, and panic wins.
12. **`/panic` during a dissolve started outside takectl** (MASTER's UI, or a direct signal) (`test/panic-check.txt`, FINDING). **CLOSED 2026-11-09:** fixed as ruled, (a) generalized, see "second ruling" above.
    - **What happens:**
      - `busyUntil` knows nothing of the dissolve, so panic cuts once, and the dissolve overrides it.
      - The completion read at +`settleMs` saw slot 1 (the dissolve's *source*) with both codes at
        30, and counted it as A confirmed. **`/panic` answered `ok:true`, then B landed** ~100 ms later.
      - takectl followed to B on the next wake-up.
    - **Proposal, two parts:**
      - (a) A read with both codes at 30 is "busy, come back" (the ruling's own words), so
        `confirmSlot()` should re-read while in flight **whatever the slot**. The ruled condition was
        "slot ≠ expected and both 30", which lets a read of the dissolve's source pass. That alone
        turns the false `ok` into an honest failure.
      - (b) For it to land: let panic decide on the second cut from the switcher's in-flight state,
        not only `busyUntil`. If the first read after its cut is in flight, wait the transition out
        and cut again.
13. **`/mirror` should refuse while a transition is busy or in flight**, like `/pvw/layer-set/<name>` does. **CLOSED 2026-11-09 (v0.1.1):** ruled and built, see "v0.1.1" above.
    - During a TAKE, "PVW" is already the outgoing document, still on air until the dissolve
      lands. A MIRROR from Companion in that window would change the picture on air.
    - The operator page already disables MIRROR then; the route itself does not refuse.
