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

## v0.2 round 1, 2026-11-11: setup a non-coder can do (branch v0.2, not released)

**Built:**
1. **Setup mode.** With no `takectl.config.json`, takectl starts anyway: `/` sends you to `/setup`,
   `/state` says `ready: false`, actions answer 503.
   - `/setup` lists the open documents per "mimoLive at" address, then MASTER's sources and layers.
   - Save checks the choice, writes the config (the example's defaults plus your choices) and
     starts running without a restart.
2. **Doctor.** One checklist, `doctorChecks()`, behind three surfaces: `node takectl.mjs doctor`,
   the `/doctor` page (green and red lights, one-sentence fix under each red one, refresh every
   5 s, data at `/doctor.json`), and `/state.doctor`, which turns the operator page's status strip
   red with an Open Doctor link. On the bench it has 22 checks.
3. **Layer Sets discovered.** `/state.layerSetsAll` lists every name in either document with
   `inA` and `inB`. The page builds its buttons from it; a name only one document has is greyed
   with "only in A" / "only in B".
4. **`start.command`**, double-clickable. It checks for Node 22+ and says what to install, starts
   takectl, and opens the page once takectl answers; if takectl is already running it just opens
   the page.
5. **Hidden-key guard.** Discovery records whether the switcher has the live-slot key and both
   per-slot codes. Without them doctor shows both red, and `switcherState()` falls back to source
   tally mapped onto the same codes, so verify, panic, stall and in-flight rules run unchanged.
   `/state.truth` says "source tally" and a permanent warning says why. It never refuses to start.

**Decisions made at the keyboard, flagged:**
- **No exit without mimoLive.** With a config but mimoLive or a document missing, takectl keeps its
  pages up and retries every 3 s (the reason is on `/doctor`) instead of exiting with "startup
  failed".
- **`/setup` with a config is read-only.** It shows the saved choices and says how to start over
  (stop, delete the config, start). It never rewrites the config of a takectl that may be on air.
- **Save refuses what can never run:** documents, switcher, sources or slots not found. A show not
  started yet is fine and shows on `/doctor`.
- **Setup mode has no password.** Anyone on the network can use it until Save (README says so).
- **Documents are pre-selected too** (names ending in A / B, or containing MASTER), not only the
  sources and switcher the brief named. Sources are matched first by the NDI sender each document
  advertises, then by name; `.tvshow` is ignored.
- **More doctor checks than before:** MASTER's show running, a TALLY layer in A and B, Layer Set
  names matching. A mismatched name counts as a failure.
- **Two colours only.** The witness and stall warnings stay in the Warning line, not the doctor
  list.
- **On source tally,** `effect` on either source, or `program` on both, counts as in flight (the
  v0.1 heuristics), and the witness is off: there is nothing independent to compare with.
- **Launcher details:** it adds `/opt/homebrew/bin` and `/usr/local/bin` to PATH to find Node. Two
  test hooks: `ABSWITCH_NO_DIALOG` (no macOS dialog, no keypress wait) and `ABSWITCH_EXTRA_PATH`.
- **The fallback is tested on the mock only** (`--no-slot-keys`), because no real build lacks the
  keys.
- **Greyed buttons:** a one-document name is greyed even when it exists in the current PVW, as the
  brief says, because it would not survive the next TAKE. Such names go after A's, in B's order.

**Tested:**

| Test | Result | Against v0.1.1 |
|---|---|---|
| `round1-check` (real mimoLive): setup lists the documents and suggests NDI PH-A / NDI PH-B / AB Switcher; Save writes a config equal to the hand-made one and takectl runs on the switcher's slot; doctor red with the shows stopped (each with its fix), 22/22 green with them running, CLI exit 0; an A-only Layer Set greyed, named by doctor, refused into PVW B, deleted (HTTP 204) | 6/6 PASS | 6/6 FAIL (`falsify/round1-check-v0.1.1.txt`) |
| `round1-offline-check` (mock): setup end to end incl. refusals and the second Save; doctor green, then red with mimoLive gone; tally fallback; launcher with no Node, Node 20, real Node, already running | 12/12 PASS | all FAIL (`falsify/round1-offline-check-v0.1.1.txt`): v0.1.1 exits without a config |
| Fallback against v0.1.1 with a config | — | no warning, then "verify failed … live slot undefined" on its first TAKE (`falsify/fallback-v0.1.1.txt`) |
| Real-app regressions: panic, error/mirror, in-flight, witness, bench 5, PVW Layer Sets, TALLY repair, stall; and `mock-smoke` | ALL PASS | — |
| Pages in the browser pane | setup pre-selected all six choices from `/`; Save landed on the operator page; Checks read "3 failing: A/B/MASTER show is running · Open Doctor" with the strip red; a temporary A-only set showed greyed "only in A" with the other buttons in place; `/doctor` read "4 of 22 checks failing" with fixes; `/setup` afterwards showed the saved choices | — |

- **Found in the walkthrough and fixed:** right after Save, the Checks row still showed the
  doctor's pre-setup result ("takectl is set up") until its 5 s refresh. Save and a successful
  start now refresh the doctor at once.
- **Finder:** the operator double-clicked `start.command` in Finder on the bench Mac (config
  present, mimoLive open): the operator page opened (2026-11-11).

## v0.2 round 1 amendments, 2026-11-11: the pen's ruling on round 1 (branch v0.2, not released)

**Built, as ruled:**
1. **Not ready.**
   - (a) `/panic` is exempt. When takectl cannot start but MASTER answers, a MASTER-only switcher
     keeps PANIC working; `/state` says `panicArmed: true` and the page keeps PANIC enabled. With
     MASTER unreachable `/panic` answers 503 "cannot panic: MASTER is not reachable (…)".
   - (b) Losing mimoLive or one of the three documents after a ready start drops back to not ready
     with the same 3 s retry. When it comes back, PGM is read from the switcher.
2. **`/setup/save` is loopback only**: 403 "Set up from the Mac running takectl" from anywhere else.
   **Start Over** (`/setup/start-over`): loopback only, refused (409) while MASTER's show runs, and
   renames the config to `<config>.backup-YYYYMMDD-HHMMSS.json`. A second Save still gets the 409.
3. **Source-tally fallback.**
   - "In flight" longer than 6 s → the last commanded state, a permanent warning "source tally
     unreliable: showing last commanded state", and TALLY follows it.
   - `/panic` then answers `ok: false, sent: true`, "cut to A sent, cannot confirm (N rounds; why)".
     Never `ok: true` unconfirmed, never a hang.
   - Mock flag `--stick-program=A|B`. The README says the fallback is tested on the mock only.
4. **A Layer Set name in one document is a warning, not a doctor failure** (it supersedes "A
   mismatched name counts as a failure" in round 1).
5. **Proposals applied:**
   - 1, NDI link: the key was probed first; `video-device-connected` exists on MASTER's NDI
     sources. Preflight refuses a TAKE whose target's source reads `false`; doctor has
     `ndilink-A/B`.
   - 3, mock tally values: now 7.0b3's (`in-use`, `effect`).
   - 4, password header on the datastore calls.
   - 5, `activeLayerSetName()` skips empty sets.
   - 7, README corrections.
   - 9 stays open.

**Decisions made at the keyboard, flagged:**
- **NDI link, target only.** Preflight checks the source of the document the TAKE goes to, not
  both. Requiring both would refuse a TAKE away from a dead on-air source, the one TAKE the
  operator then needs.
- **What `video-device-connected` catches:** it drops about 5.6 s after the 7.0b3 same-title NDI
  fault. It does **not** drop when the sender's NDI output is merely switched off (20 s observed);
  the existing "NDI output is not live" check covers that.
- **mimoLive crashed while staging the NDI fault on the bench**: SIGSEGV in
  `-[BXMONDIWriter appendSampleBuffer:]` (report `mimoLive-2026-11-11-165713.ips`). It happened
  on the second same-title PATCH plus rename-away-and-back, on the document that was on air.
  - The real-app part (`amend-check` L) is now opt-in, `AMEND_NDI_LINK=1`; its evidence up to the
    crash is `test/amend-check-run1-crash.txt` (L1 passed).
  - The mock's `--disconnected=A|B` covers the logic.
- **Start Over is allowed when MASTER cannot be reached** (nothing can be on air through takectl
  then).
- **"Unreliable" is sticky until takectl restarts.** Every later fallback read shows the
  commanded state. A source stuck at `program` must never let PANIC count A as landed.
- **`sent: true` on every unconfirmed PANIC**, not only in the fallback.
- **Extras:** `/doctor.json` carries the warnings; `/state.panicArmed`; the mock's test-only
  route `/mock/state`. The two config files were read-only (an artifact of the package's trip);
  made writable.

**Tested:**

| Test | Result | Against the build before the ruling |
|---|---|---|
| `amend-offline-check` (mock): W1–2 loopback Save / Start Over; N1–2 PANIC while not ready; X1 lost and back with PGM from the switcher; E1–2 fallback with A stuck at program; P1 password header; D1–2 NDI link | 10/10 PASS | 9 FAIL; D2 (the non-regression) passes (`falsify/amend-offline-check-before-ruling.txt`) |
| `amend-check` (real mimoLive): N, X, W | 3/3 PASS | 3/3 FAIL (`falsify/amend-check-before-ruling.txt`) |
| Round 1 checks rerun: `round1-offline-check`, `round1-check` (R3a now expects the warning) | 12/12, 6/6 PASS | — |

## v0.2 round 2, 2026-11-11: PUSH, steps, history, stinger, hooks, UNDO (branch v0.2, not released)

PUSH, steps and history are a forum user's ideas. The stinger and the hooks are Jourdan's. UNDO is
the pen's.

**Built:**
- **One commit path.** TAKE, CUT, PUSH, each step of a steps push, and UNDO all go through the same
  sequence:
  1. pre-hooks, then their `waitMs`;
  2. stinger in, wait `stingerCoverMs`;
  3. commit (the switcher's signal, or for a PUSH the Layer Set recall);
  4. stinger off `stingerOffMs` later;
  5. confirm (verify, or for a PUSH Program reading the set active);
  6. history entry, then post-hooks, never before the stinger's reveal is over.

  PANIC cancels whatever has not happened yet.
- **6 PUSH:**
  - `GET /push` recalls Preview's active Layer Set on Program, live.
  - Refused while busy or mid-transition, when Preview has no active set, or when Program lacks
    that name.
  - Amber button beside TAKE, key **P**.
- **7 steps:**
  - `/steps/add` adds Preview's active set; `/steps/clear`;
    `/steps/push?pace=instant|original` (gaps capped at 10 s).
  - A record toggle (`/steps/record`): every Preview recall adds a step.
  - Named lists: `/steps/save|load|delete?name=`, kept in MASTER's `abswitch-steps` datastore.
- **8 history:**
  - Every confirmed Program change goes to MASTER's `abswitch-history` datastore as
    `{from, to, kind, ts}`.
  - The page shows emphasis only: a count on each look that has followed Program's current look,
    a brighter border on the most frequent. Nothing until that look has been left 3 times.
  - One RESET HISTORY button, which asks first.
- **9 stinger:**
  - MASTER's STINGER layer, above the switcher, built by `documents/build-documents.mjs`.
  - **The default stinger** (ruled 2026-11-11; built first as a placeholder until there was media):
    a slate box pushing in from the left and out to the right, 0.4 s. It is a plain mimoLive layer
    with built-in animations, so it needs no video file. The measured 500 / 120 ms are its
    defaults. Anyone swapping in their own media must re-run `stinger-cover`.
  - `test/stinger-cover.mjs` measured it on program out: fully covered from about 416 ms after
    "on" until it is switched off; the reveal starts within a frame of "off" and is clear by about
    383 ms. Config: `stingerCoverMs` 500, `stingerOffMs` 120.
  - Refused if the layer is live or stuck in shutdown. If it is missing: commit without it, with
    a warning.
- **9b hooks:**
  - `pre` (outgoing Program document, before the signal, then `waitMs`) and `post` (after the
    commit is confirmed or the stinger has cleared, optional `delayMs`).
  - Keyed per Layer Set name, or per `"From -> To"` pair. Held in the config `hooks` and MASTER's
    `abswitch-hooks` datastore.
  - Actions: layer `setLive`/`setOff` by name, or a Layer Set recall, in the Program document or
    in MASTER.
  - Hook chips on each look's button ("then: Lower Third in"); a REHEARSE HOOKS button.
- **10 UNDO:**
  - `GET /undo` takes back to the previous look, only while Preview is untouched since the last
    TAKE. Otherwise it is disabled and says why, on the button.
  - Key **U**.
- **Documents:** `build-documents.mjs` adds STINGER and FTB (black, 0.5 s dissolve, video only)
  to MASTER, both off. MASTER's stack is now FTB > STINGER > Program Audio > AB Switcher. FTB is
  not wired yet (round 3, item 14). `saved-docs-check.py` asserts both exist, are saved off, and
  sit above the switcher in that order.
  - **ALL PASS on the 17:47 saves** (2026-11-11, `test/saved-docs-check-v02.txt`). The same check
    failed on the earlier save, which had neither layer.
  - The saves also dropped the eight placeholder sources from A and B (three sources each now).
  - MASTER saved its `abswitch-state`, `abswitch-history` and `abswitch-steps` datastores, the
    last two empty.

**Decisions made at the keyboard, flagged:**
- *Hooks*
  - **A name key means "a take TO this look".** The pair wins outright over the name; matching
    ignores case; `→` works as well as `->`.
  - **`"in": "master"` is allowed on pre-hooks too** (the brief named it for actions generally).
    Pre-hooks run in order and wait for each one.
  - **Post-hooks wait for the stinger's reveal:** off time + the layer's own animation duration,
    read from MASTER. On the bench the reveal ended at about 1.10 s after the press, and the hook
    fired at 1.117 s.
  - **Each new commit cancels the last one's post-hooks not yet run, and any rehearsal.** A failed
    verify drops them, logged as "post-hooks skipped".
  - **A hook failure warns until the next commit** (`/state.warning`, "hook failed (…)"). The take
    stands.
  - **Invalid hook entries are dropped** and counted in a warning.
  - **Extra routes:** `GET /hooks` (config, datastore, what is in use, errors) and `POST /hooks`
    (writes the datastore; loopback only, like Save; 400 when invalid). The datastore wins over
    the config, key by key.
  - **Rehearse:**
    - It runs the post-hooks of a take to Preview's look, in Preview, with their delays.
    - MASTER actions are skipped, since MASTER is on air.
    - It counts as touching Preview, so UNDO goes off.
    - It leaves Preview as the hooks left it: recall the look to reset.
- *Looks*
  - **Look identity.** The bench's four Layer Sets each record all four layers, so a hook that
    lights Cam PiP makes "Speaker Wide" stop reading active. For hooks and history, a document's
    look is its active set, else the last set it read active or takectl recalled there. PUSH and
    `/steps/add` use only the set Preview reads active now.
- *PUSH and steps*
  - **A PUSH has landed when Program reads the pushed set as active** (up to 4 reads, 150 ms
    apart). If it never does: logged in history, warning, no post-hooks. On the bench it read
    active at once (logged about 800 ms after the press, with the 500 ms stinger cover).
  - **One gate for every commit.** TAKE, CUT, UNDO, PUSH and steps pass one gate. A second command
    arriving while one is still being prepared (its reads before it marks itself busy) is refused
    "busy". PANIC never waits at it.
    - Found by the new P5: without it, a TAKE and a PUSH sent at the same instant both ran: the
      PUSH recalled a look on the document on air, then the dissolve went
      (`falsify/round2-offline-check-before-gate.txt`).
  - **PUSH refusals set the Error line,** as TAKE's preflight does; "busy" does not. During a PUSH
    the tiles keep PGM/PVW (`/state.busyKind: "push"`) instead of showing TRANSITION.
  - **Steps:**
    - Each step is a PUSH, with its own stinger and hooks. One stinger covering a whole instant
      run would be the alternative.
    - A step starts only after the last one has landed and its post-hooks have run, so
      "instant" means no extra gap.
    - Every name is checked against Program before the first step.
    - TAKE, CUT, PUSH and UNDO are refused while steps run; Preview recalls are not.
    - The run reads as running until its last step lands.
    - Recording also takes MIRROR's recall.
    - The working list lives in memory only; named lists persist.
- *History*
  - **Logged at confirmation, not at the signal.** A failed TAKE leaves no entry. Neither does a
    commit still unconfirmed when the next one starts (only possible after a verify that ended in
    flight).
  - **A look never "follows" itself** (pushing the same look again is excluded).
  - **UNDOs, and the takes they undid, do not count** (both stay in the log, marked).
  - **Counts on every follower, the brighter border on the most frequent (ties: all).**
  - **Reset asks by a second tap within 3 s**, like PANIC, not a dialog.
  - **Datastore cap:** keeps the last 1000 events.
- *Stinger*
  - **A stinger commit is always a cut under cover,** never a dissolve.
  - **The stinger option is a runtime toggle** (`/stinger?on=1|0`, a page button), defaulting to
    the config's `stinger`. It is not written back to the config.
  - **Checked fresh before every commit, by name.** A layer still clearing from the last commit is
    waited out; one in shutdown after that is "stuck".
  - **PANIC always switches STINGER off**, option on or not, and reads it back. Its refusal
    message says to press PANIC.
  - **Read-back after every stinger off:** setOff again if it is not off ~800 ms later, as TALLY
    does.
    - Found by the smoke test: one read-back switched off the next step's stinger. A new stinger
      in now cancels it.
  - **Busy lasts until the stinger's reveal ends** (about 520 ms after the commit).
- *UNDO*
  - **Hooks and transition:** UNDO runs no hooks and uses the undone take's kind: dissolve for a
    TAKE, cut for a CUT, the stinger if on.
  - **Who switches it off:** Program changes, by PUSH or steps, PANIC, or outside takectl; a
    failed verify; using it (no redo).
  - **"Touched" means a controller command to Preview:** a Layer Set recall, MIRROR, a rehearsal,
    or pre-hooks on the outgoing document (which becomes Preview). Changes made in mimoLive's own
    UI are not seen yet (round 4 probes them).
- *Page*
  - **Keys:** P = PUSH, U = UNDO; typing a list name does not trigger keys.
  - **Fixed sizes:** look buttons are 210 × 70 px. The tools row's columns depend only on the
    screen width.
- *Bench*
  - **A lower-third stand-in:** the bench documents have no lower third, and adding one would
    change them. `round2-check` uses Cam PiP, held off in Preview.
  - **MASTER now holds `abswitch-history` and `abswitch-steps` datastores** (emptied by the test).
    They are saved with the document.
- *Mock*
  - STINGER and "Lower Third" layers; a layer told `setOff` passes through `shutdown` for its
    animation.
  - Test routes `/mock/log`, `/mock/set-layer`, `/mock/set-active`, `/mock/add-set`.
  - Flags `--no-stinger` and `--dissolve-ms=`.

**Tested:**

| Test | Result | Against v0.1.1 and the round 1 build |
|---|---|---|
| `round2-offline-check` (mock; order and spacing read from the mock's own log): P1–4 PUSH refusals and landing, P5 TAKE and PUSH sent together; S1–5 stinger timing on TAKE, CUT, PUSH, refusals, missing layer; H1–8 hooks (pre/post timing, pair wins, failure warns, rehearse, POST /hooks, PANIC at 200 ms with and without the stinger and at 700 ms, never in flight); T1–7 steps; Y1–2 history; U1–3 UNDO | 30/30 PASS | P5 fails on the build before the gate; 28 of the other 29 FAIL each (`falsify/round2-offline-check-*.txt`); H4 passes on both, a negative check that means something only beside H1 (no hooks there, so none can fire) |
| `round2-check` (real mimoLive, stinger on, hook "Speaker Wide" → Cam PiP in) | 8/8 PASS | 5 FAIL each (`falsify/round2-check-*.txt`). R3b passes: no hooks, so none can fire. R5b is not reached |
| R1 stinger TAKE, recorded from MASTER's program out at 30 fps (`round2-stinger-frames.txt`) | wipe in over ~390 ms, full cover ~230 ms, cut under it, reveal ~350 ms; **0 frames show A and B at once; B first appears after a fully covered frame** | the round 1 build dissolves: 4 frames show A and B at once, and there is no cover (`falsify/round2-stinger-frames-round1-build.txt`) |
| R2 hook: B's Cam PiP, held off in Preview, comes in on Program | live 1117 ms after the press; the stinger started clearing at 720 ms | never (no hooks) |
| R3 PANIC 200 ms after TAKE: under the stinger (signal never sent), and mid-dissolve | no post-hook in 3 s; PANIC ok in 272 ms and 1101 ms | — |
| R4 PUSH under the stinger; R5 steps "Two Shot" → "Slides PiP" onto Program; TAKE then UNDO | PASS | routes missing |
| Regressions: `mock-smoke`, `round1-offline-check`, `amend-offline-check` | ALL PASS | — |
| Page in the browser pane against the mock | 11 state changes (TAKE, record, recall, add, stinger on, PUSH, four TAKEs, steps push): **no button moved** (bounding boxes compared in the page) | — |

- **Found by the tests and fixed:**
  - After a steps push, the next one was refused as busy (the run ended before its last step
    landed). It now ends after.
  - Both tiles read TRANSITION during a PUSH.

## After the ruling on round 2, 2026-11-11 (branch v0.2, not released)

**The slate wipe is the default stinger, not a placeholder** (ruling): README and the round 2 entry
say so. `stingerCoverMs` 500 and `stingerOffMs` 120 stay as its defaults. The README says to re-run
`stinger-cover` after swapping in other media, or after any change of network (ruling, change 3).

**Stinger timing (ruling, change 3): confirmed, no change.** `stingerCoverMs` starts once the
`setLive` call has returned (`await stingerIn()`, then `sleep(cover)`), not when it is sent.
`test/stinger-cover.mjs` measures cover-in from the moment it *sends* `setLive`, so takectl's
real margin is larger than the measured one by one API round trip.

**Found while confirming it, and fixed:**
- TAKE and CUT set the stinger live with a direct call, not through `stingerIn()`. So decision 36
  ("the next stinger-in cancels the read-back") held only for PUSH and steps.
- On a second stinger TAKE as soon as the first allowed it, the first one's read-back switched the
  new stinger off **125 ms before its cut**. The cut would have been seen on air.
- TAKE and CUT now go through `stingerIn()`. New check `round2-offline-check` S6: 31/31 PASS. On
  the build before the fix S6 fails, off at 396 ms, cut at 521 ms
  (`falsify/round2-offline-check-before-stingerin.txt`).

**The mimoLive crash:** a draft bug report (exact steps, build, crash signature) and a copy of the
crash log are on Jourdan's Desktop, outside the package. The staging is not re-run.

**Safe source, probe only, no code (`test/safe-source-probe.mjs` → `safe-source-probe.txt`):**
- **Slot 3:** it exists. Source Count is "4 Sources". It was empty (`tvIn_VideoSourceCImage` null)
  and has its own code key `tvOut_tvIn_VideoSourceCImageTallyState`. `Cut_3` and `Dis_3` exist.
- **The slate:** a "Video Output Test" source (`com.boinx.boinxtv.layer.videooutputtest`). Its Test
  Image 0 is "Philips PM5544". The probe created it in MASTER as "SAFE Test Pattern" and put it in
  slot 3 with a flat PUT; both read back. It has no `video-device-connected`. Left in place,
  unsaved.
- **Behaviour:** it behaves like A and B.
  - Cuts land at once; a dissolve flips the slot at ~567 ms, with codes 30/30 on both ends meanwhile.
  - Its source tally goes `program` / `effect` / `in-use`.
  - The WebSocket sends `sources changed` for it at every cut and both ends of a dissolve.
- **MASTER's program on slot 3** shows the PM5544 pattern (`evidence/master-pgm-safe.png`).
- **Today's takectl with slot 3 filled:** discovery and doctor are unchanged (A = 1, B = 2).

## Safe source for PANIC, 2026-11-11: as ruled (branch v0.2, not released)

**Built:**
- **Config:** `master.sourceNameSafe` (optional) and `master.slotSafe` (null = read from the
  switcher), as for A and B. Setup has a "safe source" dropdown listing every source in MASTER,
  with "None".
- **PANIC:** with a safe source it cuts to that source's slot instead of A, with the same
  three-round confirm loop. With the safe source already on air and nothing of takectl's in
  progress, it confirms and answers `already: true` without a cut. It only clears the stinger and
  leaves FTB as it is.
- **SAFE** (`/state.pgm: "SAFE"`):
  - both TALLYs are off;
  - the TAKE target is Preview (`/state.pvw`), by default the document that was Preview when PANIC
    was pressed; `/safe/target?doc=A|B` changes it;
  - TAKE and CUT go to the target, run MASTER pre-hooks only, then post-hooks as usual, and offer
    no UNDO;
  - PUSH, steps push, UNDO and MIRROR are refused; Layer Set buttons recall into the target.
- **SAFE selected in mimoLive** puts takectl into SAFE. **Any other live slot** gives
  `/state.pgm: "OTHER"`, a warning naming the slot, and SAFE's behaviour; PANIC still goes to the
  safe source (or A).
- **History:** panics (`kind: "panic"`) and takes out of SAFE (`safe: true`) are logged, and
  never counted in the likely-next emphasis.
- **Doctor:** with a safe source, three checks (it exists, it has a switcher slot of its own,
  there is a cut signal for that slot). Without one, a warning on `/doctor` and `takectl doctor`:
  "No safe source: PANIC cuts to document A, whatever it holds".
- **Operator page:** a SAFE ON AIR bar (SLOT 9 ON AIR for OTHER) over the tiles with the A/B
  target selector. The target tile is green PVW, the other dimmed IDLE.
- **Bench slate:** `build-documents.mjs` adds "SAFE Test Pattern" (Video Output Test, Philips
  PM5544) to MASTER and puts it in switcher slot 3. `saved-docs-check.py` asserts it is saved
  there. The README says a show uses a wide camera wired straight into MASTER, or a holding slide,
  never the test pattern.
  - **ALL PASS on the 18:29 save of PH-MASTER** (`test/saved-docs-check-safe.txt`): SAFE Test
    Pattern in slot 3, STINGER and FTB saved off. The same check failed on the 17:47 save, which
    had no safe source.

**Probed on the real app before building** (`safe-source-probe.txt`, `slot4-probe.txt`):
- Slot 3 behaves like slots 1 and 2.
- **Cutting to the empty slot 4 makes the live slot read 9** (the switcher's "Below").
- A dissolve into or out of an empty slot reads 30 on the filled slot only. On the way back from
  9, the slot can read 1 while its code still reads 30 for about 60 ms.

**Decisions made at the keyboard, flagged** ([ROUTE] / [CONFIG] / [AIR] as before):
1. **[AIR] In flight now means any slot at 30, not A's and B's both at 30.** A dissolve to or from
   an empty slot has only one 30, and the old rule would have read it as settled. Every read the
   old rule called in flight still is, so this only adds reads it holds as "come back later".
2. **[AIR] "Preview when PANIC was pressed" is takectl's Preview at the moment PANIC arrives.**
   - Before a TAKE's signal goes, that is the TAKE's target (PANIC at 0 ms → target B).
   - After the signal, roles have flipped, so it is the document that just left air (PANIC at 200
     or 600 ms → target A).
3. **[AIR] No cut when already on SAFE** only if no TAKE, CUT or PUSH is being prepared, nothing is
   busy, and a fresh read shows the safe slot at 40 with nothing in flight. Otherwise PANIC cuts as
   usual, so a TAKE out of SAFE that is just starting cannot slip past it.
4. **[AIR] A configured safe source that is missing, shares A's or B's slot, or has no cut signal**
   leaves PANIC on A, with a warning and red doctor checks. takectl still starts.
5. **[ROUTE]** `/state.safe` = `{configured, source, slot, problem, onAir, target, otherSlot,
   panicTo}`. `/panic` answers `pgm: "SAFE"`, or `already: true`. `/doctor.json` warnings include
   the no-safe-source note; the operator page's Warning line does not.
6. **[CONFIG]** The safe source is matched by exact name first, then by "contains", as A's and B's
   are. The example config has `null`. So does this bench's own config, so the older
   checks (PANIC → A) run unchanged; the safe checks name "SAFE Test Pattern" themselves.
7. **Setup:**
   - The pre-selected safe source is one in a switcher slot of its own, a name containing "safe"
     first.
   - A's or B's source as safe → 400. A safe source doctor finds broken blocks Save, as for the
     other sources.
   - mimoLive's own hidden helper sources ("Placeholder A"…, `is-hidden`) are no longer listed in
     any setup dropdown.
8. **[AIR] SAFE entered from mimoLive's UI:** the target is the document that was Preview. At a
   start with SAFE already on air: the Preview recorded in MASTER's state, else A.
9. **History:** a panic is logged as `{from: Program's look, to: "SAFE" (or A's look), kind:
   "panic"}`. A MASTER-only PANIC controller (takectl not ready) logs nothing: it never loaded the
   history, so writing would overwrite it.
10. **Mock:**
    - "SAFE Test Pattern" in slot 3, slot 4 empty (reads 9), one-sided dissolves.
    - `--slow-read=<ms>` (a switcher read answered later with the state from when it was asked).
11. **`build-documents.mjs` stops MASTER's Recording after it starts the shows.** Found today:
    every build, and every probe that starts the shows, left a short recording in `~/Movies`.

**Found by the tests and fixed:**
- **[AIR] A stale read could undo PANIC** (`safe-check`, one TAKE out of SAFE went from A).
  - The 5 s poll (or any wake-up) sent its switcher read just before PANIC. The read came back
    while PANIC was running and set the roles back to A, so `/state` said A with SAFE on air.
  - `resync()` checked "busy" only before its read. The same window existed for a TAKE: a stale
    read flipped the roles back until the next poll.
  - Now a read sent before a TAKE, PANIC or commit started (or while one is being prepared) is
    dropped, and PANIC re-asserts its role when the switcher confirms it.
  - Reproduced on the mock with `--slow-read=300` (`safe-offline-check` W): the build before the
    fix ends with `pgm: A`, slot 3 (`falsify/safe-offline-check-before-stale-read-fix.txt`).

**Tested:**

| Test | Result | Against the build before the safe source |
|---|---|---|
| `safe-offline-check` (mock): P PANIC to SAFE at 0/200/600 ms, under the stinger, during an outside dissolve; T TAKE and CUT out of SAFE to each document; R refusals and the target; H slots 3 and 4 selected outside takectl; A PANIC with SAFE on air; Y history; K hooks; N no safe source, and not ready; S setup and doctor; W a stale read | 20/20 PASS | 19/19 FAIL (`falsify/safe-offline-check-before-safe.txt`); W fails on the build before the stale-read fix |
| `safe-check` (real mimoLive) | 13/13 PASS: PANIC to slot 3 at 0/200/600 ms (B never live at 0 ms), under the stinger (B never live), during an outside dissolve; TAKE and CUT out of SAFE to A and B; slots 3 and 4 selected by signal outside takectl; PANIC with SAFE on air sends no cut; no safe source → A | 12 FAIL; N (no safe source → A) passes on both, as it must (`falsify/safe-check-before-safe.txt`) |
| By hand in mimoLive's UI (`safe-hand-watch.txt`) | PASS: Jourdan clicked slot 3, the empty slot 4, then slot 1 in PH-MASTER's AB Switcher. takectl followed each within the 100 ms watch: SAFE (both TALLYs off) → OTHER, slot 9 from the UI too, with the warning → A (A's TALLY lit). The operator page showed the SAFE ON AIR bar with the A/B selector. Seen only in the narrow browser pane: the bar can cover a tile's role label (Round 3's panel replaces it) | — |

## Round 2 changes and the owed real-app coverage, 2026-11-11 (ruling; branch v0.2, not released)

**Built, as ruled:**
1. **Rehearse puts Preview back** (decision 15, proposal 3).
   - Before a rehearsal, takectl records the live state of every layer its hooks will touch. If a
     hook recalls a Layer Set, that means every layer except TALLY.
   - 2 s after the last hook has run, each layer is put back.
   - On the real app: B's Lower Third came in at 54 ms and was put back off 2 s after. The next
     TAKE brought it in on Program at 820 ms.
2. **Steps and the stinger** (decision 21, proposal 5).
   - **Instant pace, stinger on:** one stinger covers the whole run. Every recall happens under it,
     and only the last step's post-hooks run, after the reveal.
   - **Original pace:** the stinger, if on, covers the first step only. Later steps land bare, each
     with its own hooks.
3. **Start Over's backup is named in local time** (proposal 2): `backup-20261111-183344`, not the
   UTC `20261112-…`.
4. **A real Lower Third in PH-A and PH-B** (proposal 4).
   - It is mimoLive's basic "Lower Third" layer, set to Manual, directly under TALLY, in no Layer
     Set, off. It needs no licence.
   - `build-documents.mjs` builds it (index 1 inserts directly under the top layer, probed), and
     `saved-docs-check.py` asserts it.
   - The hook tests moved onto it (`round2-check`).
   - **Saved:** Jourdan saved all three documents at 18:37, after the build. `saved-docs-check.py`:
     ALL PASS, with the Lower Third saved off, under TALLY and in no Layer Set
     (`test/saved-docs-check-lower-third.txt`). The same check failed on the 17:47 saves of PH-A
     and PH-B, which had no Lower Third.
5. **Stinger timing** (change 3): confirmed earlier; the README says to re-run `stinger-cover`
   after a change of media or network.

**Decisions made at the keyboard, flagged:**
- **[AIR] While a rehearsal runs, commands wait.** TAKE, CUT, UNDO, PUSH, steps, MIRROR, Layer
  Set buttons and the SAFE target are refused, saying "busy: rehearsing hooks in Preview B; it is
  put back N s from now". On the page, REHEARSE reads "PUT BACK IN N s". A TAKE that went ahead
  would put the rehearsed layers on air, then have the put-back pull them off on air.
- **[AIR] PANIC ends a rehearsal.**
  - It puts Preview back at once, unless the rehearsed document is the one PANIC puts on air (A,
    with no safe source configured).
  - In that case it leaves the layers alone, with a warning, rather than animate them out on air.
- **The rehearsal restores in Preview only;** MASTER actions are skipped, as before. A rehearsal
  whose post-hooks all act in MASTER is refused: nothing to rehearse.
- **[AIR] Under one stinger, the first step's pre-hooks still run before the stinger,** as for a
  PUSH. The steps in between run no hooks. Every step is logged in history. The run counts as
  landed when Program reads the last step's set as active.
- **[AIR] Instant pace with the stinger off is unchanged,** step by step, each with its hooks.
  With the stinger on but its layer missing, the run falls back to step by step, with the usual
  warning.
- **Lower Third text:** "Lower Third" / "abswitch bench" (no person's name), and no logo. The
  layer's default logo kept one of mimoLive's placeholder sources alive.
- **The documents README says hook layers must be "No Action" in every Layer Set,** like TALLY.
- **Recording found running after `amend-check`.** Its Start Over test stops MASTER's show, and
  the restore restarted it, which starts Recording, and never stopped it. That left a 6.6 MB
  recording (18:47–18:50) in `~/Movies`. Fixed: the restore stops Recording.

**Real-app coverage owed from round 2 (`round2-coverage-check.mjs`), all on the real mimoLive:**

| Check | Result | Round 1 build | Build before these changes |
|---|---|---|---|
| C1 a pre-hook on the outgoing document: A's Lower Third, live on air, goes off before the switcher moves; the signal waits `waitMs` 600 | **PASS**: off at 118 ms, switcher left slot 1 at 1216 ms | FAIL: never went off (no hooks) | PASS |
| C2 PANIC 700 ms into a steps run (original pace, 1.5 s gaps) | **PASS**: one step reached Program ("Two Shot"), no more; run stopped; A on air | FAIL | PASS |
| C3 CUT under the stinger, recorded at 30 fps | **PASS**: 0 of 75 frames show A and B at once; B first after a fully covered frame (`round2-coverage-cut-frames.txt`) | FAIL: a plain cut, B at 171 ms with no cover | PASS |
| C4 the stuck-stinger refusal: STINGER live → refused; STINGER **stuck in shutdown** → refused; PANIC cures it | **PASS**: live → refused; stuck reproduced on the real app (the 7.0b3 setOff-15-ms-after-setLive quirk, after 20 tries) → refused; PANIC → off; TAKE → stinger | FAIL: no refusal, and PANIC left the stinger stuck | PASS |
| C5 a failing hook (a layer that does not exist) | **PASS**: warning "hook failed (then: No Such Layer in)…"; the take stood (B on air) | FAIL | PASS |
| C6 rehearse, then TAKE (ruling, change 1) | **PASS**: in Preview at 54 ms, put back off; TAKE meanwhile refused; TAKE after → in on Program at 820 ms | FAIL | **FAIL**: Preview kept the layer, so the TAKE had nothing to bring in |

**Tested:**
- `round2-offline-check` adds H3b (put back after 2 s; TAKE refused meanwhile; the next TAKE brings
  the layer in), T8 (instant run of 3 under one stinger: 1 stinger in, 3 recalls under it, the last
  step's post-hook only, 401 ms after off) and T9 (original pace: stinger on the first step only,
  each step its own hook). 34/34 PASS.
  - On the build before these changes, H3, H3b, T8 and T9 fail. The old build ran three stingers and
    three post-hooks for an instant run, and never put Preview back
    (`falsify/round2-offline-check-before-r2-changes.txt`).
- `amend-offline-check` W2 checks the backup's name is local time: PASS. It fails on the build
  before (`falsify/amend-offline-check-before-local-time.txt`).
- `safe-offline-check` W2, the ordinary-TAKE case of the stale read, passes. On the build before
  the fix it fails too: `/state` named B while A was on air
  (`falsify/safe-offline-check-before-stale-read-fix.txt`).
- Regressions, real app: `round2-check` (now on the Lower Third), `safe-check`, `panic-check`,
  `amend-check` all pass. On the mock, all suites pass.

## v0.2 round 3, 2026-11-11: the operator page is a switcher panel (branch v0.2, not released)

**Probed first** (`test/round3-probe.txt`; ruled the same day):
- **Stills:** `programOut?format=jpeg&width=320` returns one 320×180 JPEG in 6–17 ms.
- **Dissolve length:** `tvIn_TransitionDuration` (0–5 s) is a plain write. A dissolve settles about
  60 ms after the value; written above 5 it still runs 5 s.
- **FTB:** fades program to black and back in about 0.5 s, and a cut underneath it lands.
- **MASTER's stack:** "every layer above the switcher" would include Program Audio, hence the `DSK `
  naming.

**Built, as ruled:**
- **The panel** (`operator.html`), from the spec and mock-up:
  - Header lamps and a status line, with REC and STREAM.
  - Program monitor left in red, Preview right in green; never swapped.
  - PGM lamps and PVW keys: 8 fixed slots, thumbnails, NEXT.
  - A steps strip, and a utility row with the downstream keys.
  - A transition block: MIX/STINGER, RATE, CUT, TAKE with its progress bar, PUSH, FTB, PANIC.
  - A readout.
  - SAFE and OTHER, with the TAKE target beside TAKE and LAST reading "PANIC: SAFE on air. Next TAKE
    goes to document X".
  - Keys Space, C, P, M, U and 1–8; full screen; a view-only mode at `/?view=monitor`.
- **Rate control:** the switcher's duration is read at every TAKE. Timing is the value + 60 ms +
  `settleMs`; `dissolveMs` is the fallback only when the key cannot be read. `/rate` writes it,
  clamped to 0.1–5 s.
- **MIX / STINGER selector**, with the config's `stinger` choosing at start.
- **CUT is always a bare cut**: it never fires the stinger, its hooks still run, and UNDO of a CUT is
  bare too. On the real app with STINGER selected, the STINGER layer stayed off throughout a CUT.
  - This changes round 2's "stinger CUT" check (S2) and the coverage check's CUT case (C3); both now
    assert a bare CUT.
- **FTB** toggle (video only), and **downstream keys** from MASTER layers named `DSK <label>` above the
  switcher. Neither goes through the commit gate; both work mid-transition and in SAFE, and neither is
  logged. PANIC leaves both as they are.
- **Thumbnails:**
  - Stored under a hash of the look name, with an index; a look name never becomes a path.
  - A name with `/`, `\` or `..` reads and writes nothing outside `thumbs/`.
  - Start Over clears the folder.
- **8 look slots,** with a warning beyond 8. **NEXT goes on every tied look.**
- **Additions from the second note** (same day):
  - STALE monitors.
  - REC and STREAM lamps (display only).
  - Keys 1–8.
  - View-only mode.
  - Time on the current look.
  - The README's Auto-Lock note.
- **Bench layers:** `DSK Bug` and `DSK Clock` in PH-MASTER, saved off. `saved-docs-check.py` asserts
  them: ALL PASS on the 18:59 save (`test/saved-docs-check-dsk.txt`); it failed on the 18:37 save,
  which had neither.

**Decisions made at the keyboard, flagged** ([ROUTE] / [CONFIG] / [AIR]):
1. **[AIR] STALE also comes from the document's show state, not only from frame arrival.**
   - The ruled test ("stop a document's show") would not trip on arrival time: with a show stopped,
     mimoLive keeps serving the same last frame, both as stills (identical bytes) and as MJPEG
     (probed).
   - takectl reads the three documents' live state every second. A monitor is STALE after 1 s with no
     new frame, or while its document's show is not running.
   - On the real app, stopping B's show marked Preview STALE in 940 ms, and it cleared when the show
     restarted.
2. **The monitors are stills, not MJPEG,** so the page knows each frame's arrival. They are two `<img>`s
   shown in turn, about 10 a second, sized to the monitor (≤ 960 px wide). A still that has not arrived
   after 1.5 s is asked for again; a hung request had kept a monitor STALE for good.
3. **[ROUTE] Query forms** `/pvw/layer-set?name=`, `/thumb?name=` and `/dsk?label=`.
   - A URL path cannot carry a look named `.` or `..`: browsers and Node collapse it, even written as
     `%2E%2E`.
   - The page uses the query forms; the path forms stay for Companion.
4. **[AIR] PANIC is hold only (0.7 s)**, as the spec's "dashed guard border that needs a hold". The
   round 1 "or tap twice" is gone.
5. **[AIR] In SAFE the Program monitor stays red**, following the spec's rule that Program is always
   red. Not followed: an earlier note's "both monitors green". The SAFE state shows in the status
   (green "SAFE ON AIR"), "PROGRAM · SAFE ON AIR", and "PREVIEW · DOCUMENT X · NEXT TAKE".
6. **Rate:** −/+ in 0.1 s steps, refused mid-transition. With STINGER selected it is greyed and shows
   the stinger's own length: cover + off + reveal, about 1.0 s.
7. **[CONFIG] Optional keys:** `ftbLayerName` ("FTB"), `thumbDelayMs` (1000), `livePollMs` (1000).
8. **[ROUTE] `/state` additions:** `now`, `onAir`, `outputs`, `transition`, `progress`, `ftb`, `dsk`,
   `thumbs`, `lookSlots`, `lastLine`, `nextHooks`, and `docs.MASTER.live`.
9. **[AIR] The bench DSK layers sit under FTB and above STINGER,** as an ATEM's downstream keys sit
   above its transitions: a bug stays up through a wipe. The README says to measure a stinger with them
   off.
10. **Downstream key order:** stack order, top first. The label is the name after `DSK `.
11. **Thumbnails:**
    - The file is the first 40 hex digits of SHA-256(name). The index is a prototype-free object, so a
      look named `__proto__` or `constructor` reaches nothing. Stills are served `no-store`.
    - Only takectl's own Preview recalls (look keys, MIRROR) refresh them, including in SAFE, where
      the still is of the TAKE target.
12. **Time on look:**
    - Set from the last history entry at start, and reset by each logged Program change or a change
      made outside takectl.
    - Counted against takectl's clock, so an iPad's own clock never matters.
13. **REC / STREAM:** lit if any output of that type reads `live`.
14. **View-only:** the PVW row is lamps, full screen is hidden, and there is no keyboard. It is not
    access control: the routes stay open to anyone on the network, as the README says.
15. **Keys 1–8** follow slot order and skip disabled or empty keys.
16. **Steps strip extras:** REC keeps a constant label and only lights, so it never changes size. AS
    RECORDED is a page toggle on each device. Lists load and save (the name is asked for).
17. **Readout buttons:** REHEARSE HOOKS and RESET HISTORY (two taps) are pinned to the readout's bottom
    edge.
    - RESET HISTORY had been left out of the first panel build; it is back, as round 2 requires.
18. **Layout:**
    - 1 rem = 16 px at 1440×900, scaled to the screen, with a 44 px floor on every control.
    - Narrow (≤ 1120 px) and short (≤ 840 px) screens get their own sizes. Positions depend on the
      screen only, never on state.
    - Monitor headers are one fixed-height line, and the utility and transport keys have fixed heights.
19. **Header lamps:** A/B LIVE means the show and its NDI output are live; MASTER LIVE means its show
    is live.

**Later** (corrected 2026-11-12: this note first said v0.3; the plan is in **Next**, below): a **second bank
of look keys** (v0.2 has 8 slots, with a doctor warning), and a **program audio meter**, which would make
"FTB leaves audio live" visible. Both are v0.4.

**Tested:**

| Test | Result | Against the build before round 3 |
|---|---|---|
| `round3-offline-check` (mock + headless Chrome): C bare CUT, UNDO bare; R rate read at every TAKE incl. one changed outside, clamping; M selector; F/D FTB and DSK mid-transition and in SAFE, not logged, PANIC leaves FTB, unknown label, DSK below the switcher; T thumbnails with `/`, `\`, `..` names, traversal attempts, Start Over; S 8 slots, NEXT ties, time on look, REC/STREAM, live state within ~1 s, LAST in SAFE; P STALE for a stopped show and a stalled picture, keys 1–8, view-only | 22/22 PASS | 16 FAIL. C3 (a stinger TAKE), T3 and T4 (nothing to serve or clear) and S2 (round 2 already listed ties) pass; the page checks were not reached (`falsify/round3-offline-check-before-round3.txt`) |
| `round3-check` (real mimoLive + Chrome): CUT with STINGER selected; rate 1 s and 2 s (changed outside takectl) timed on the switcher; FTB to black, TAKE underneath, PANIC leaves it; DSKs mid-transition and in SAFE; a 320×180 thumbnail; REC/STREAM; STALE when B's show stops | 9/9 PASS | — |
| `panel-chrome` (real app): one screen, nothing cut off, every control ≥ 44 px, live pictures | PASS at 1440×900, 1180×820 @2x and `/?view=monitor` (0 buttons); on the mock also 1133×744 and 1024×768 | — |
| No key moved across 19 state changes (TAKE, record, recall, add, STINGER, PUSH, TAKEs, FTB, a DSK, MIX, steps push, PANIC to SAFE, the SAFE target, TAKE out of SAFE), real app | PASS at 1440×900 and at 1180×820 | — |
| `demo-run` (real app, 1 s pauses) | 20 steps, none refused (`test/demo-run.txt`) | — |
| Bench 5 and PANIC to SAFE watched from a second device | PASS. Jourdan watched on an iPad on the LAN. Bench 5 passed 5/5: the switcher's outside changes were followed 38–91 ms later, and after a restart takectl came back on B. Then he held PANIC on the iPad: SAFE was on air in about 0.3 s. He chose Doc A and pressed TAKE, and A was back on air. The page showed each state as specified (`test/second-device-watch.txt`) | — |

**Found by the tests and fixed:**
- The grid sized to its content, so the right-hand blocks ran off a 1440-wide screen.
- The narrow-screen rules sat before the rules they meant to override.
- The readout's text set the monitor row's height.
- REHEARSE, REC, UNDO and the monitor headers each moved a key when their text changed.
- A hung still kept a monitor STALE for good.
- A look named `..` could not be recalled.

## Panel polish, 2026-11-11 (the pen's six items, with round 4; branch v0.2, not released)

**Built, as ruled:**
1. **CAPTURE** replaces the steps strip's REC, lit while capturing; the header's REC stays MASTER's
   recording lamp.
2. **UNDO's reason is never truncated.**
   - The key shows a short form ("Preview changed", "PUSH since", "came from SAFE" …).
   - The readout shows the whole reason under "UNDO · NOT OFFERED", and the tooltip has it too.
   - PUSH got the same treatment: it had been cut as "refused while SAFE is on" in SAFE.
3. **Look-key labels and slot numbers sit on dark bands.** The worst measured contrast, over a white
   thumbnail, is 5.9:1: the small line on a selected key's green band. The other labels measure 8.6 to
   9.1:1. (Corrected in round 4, when the state run began reporting its worst figure.)
4. **Taller PVW keys:** the bus row takes the spare height. CUT and TAKE fill their block.
5. **PACE** is a labelled control with two values, INSTANT and AS RECORDED.
6. **The header subtitle is never truncated:** it is hidden, its space kept, when the whole line does
   not fit (as at 1440 with all the lamps).

**Decisions made at the keyboard, flagged:**
- **The row above CUT and TAKE now says where the next TAKE goes** ("NEXT TAKE → DOCUMENT B "Slides
  PiP" · MIX 0.5 s"). In SAFE the TAKE GOES TO selector replaces it in the same row. The row has to
  stay so that the selector appearing never moves a key, and this way it is useful the rest of the time.
- **Readout order:** ON AIR FOR, LAST, UNDO · NOT OFFERED, WARNING, ERROR, then HOOKS, LIKELY NEXT,
  RULE.
  - The readout clips at its pinned buttons. On a short screen with a long UNDO reason, the hooks,
    likely-next and rule lines are what get cut, never the reasons.
  - The panel check enforces it: LAST, UNDO, WARNING and ERROR must be wholly visible.
- **Key names are sized to the key** (a container query) and break only between words. At 1180 px they
  had broken mid-word ("Spea ker").
- **Empty slots show no band.**

**Tested** (`panel-chrome`, new checks: reasons whole on their keys and in the readout, subtitle whole
or hidden, look-key labels ≥ 4.5:1 over a white or black thumbnail):

| Size | Result |
|---|---|
| 1440×900, 1180×820, 1133×744, 1024×768: the mock, and again on the real app | ALL PASS |
| 1440×900 and 1180×820 on the real app, through 19 state changes | ALL PASS: no key moved; reasons whole and labels readable in every state |
| Self-test: the same page broken on purpose (bands removed, a long reason forced onto UNDO) | the checks catch both: contrast 1:1, and the reason flagged as cut |

Both README screenshots are retaken (`operator-panel.png`, `operator-panel-ipad.png`).

## v0.2 round 4, 2026-11-11: watching A and B over mimoLive's socket (branch v0.2, not released)

**The probe, reported before building** (`test/round4-probe.mjs`, `test/round4-probe-*.txt`):
- Every change made in mimoLive's window to the on-air document reached `/api/v1/socket` within
  milliseconds, naming its document: a layer on and off, a setting edited (one message per keystroke,
  about every 300 ms), a variant added, switched and deleted, a Layer Set recalled.
- A message never says who made the change: the title written back over the API afterwards reads
  exactly like the edits made in the window.
- A Layer Set's `active` is derived from the layers: during one of takectl's recalls a different set
  read active for 300 ms.
- Idle, the socket carries only live values: audio levels (5/s), each document's running time (1/s),
  a clock's time string (1/s). takectl's reads cause no messages.

**Built, as ruled:**
1. **The rule.** Watched: the on-air document (A or B; MASTER is not watched). A layer, variant or
   Layer Set added or removed, or changed in on/off, settings or name, on any layer but TALLY. Each
   message is compared with the last known version (read at start, kept current from the messages).
   Ignored: a Layer Set's `active` entirely; values that move by themselves (output values, audio
   levels); layers named in the new config list **`watchIgnoreLayers`**; a layer a hook switched on,
   until it next reads `off`, however long that takes.
2. **takectl's own writes**: the layers it named, until they settle plus 0.5 s, 3 s at most.
3. **Clearing**: TAKE, CUT, UNDO, PANIC; not PUSH. **Dismiss**: a tap on the warning accepts it and
   reads the document again as the new baseline.
4. **Display**: in Program's header strip, never over the picture: amber, **CHANGED IN MIMOLIVE** and
   what changed; the same on the readout's WARNING line. No key moves; it never blocks a command.
5. **NOT WATCHED** on the same strip while the socket is down; on reconnect both documents are read
   again and what changed meanwhile is flagged ("…, while not watched").
6. **Preview**: no warning, but a change made outside takectl is "Preview touched": UNDO goes off with
   that reason, and about 1 s after Preview settles, the look it then reads as active gets a new
   thumbnail.
7. **The mock's socket** sends the layer, variant and Layer Set events 7.0b3 sends, in its shapes, plus a
   running show's live values. No dependencies.
8. **WATCH PGM**, a panel toggle, on at every start, runtime only.

**Decisions made at the keyboard, flagged:**
- **[ROUTE]** New: `/watch` (the watch state; `?on=0|1` is WATCH PGM) and `/watch/dismiss`. `/state`
  gains `watch: { on, watched, ignore, change }`.
- **[CONFIG]** `watchIgnoreLayers: []` in the example config. A value that is not a list is ignored,
  with a warning; a name that matches no layer in A or B is a warning.
- **[AIR]** None. Round 4 sends nothing to air: takectl's writes are unchanged, and the watch only reads.
- **What counts as "a layer a hook switches on"** includes the layers a hook's `layerSet` action
  switches on (those its Layer Set lists as on), as well as a hook's `layer` action.
- **One change, not many.**
  - A variant's own on/off and name are not counted: the layer's messages say on/off, and a variant's
    name follows its settings (it changed with every keystroke of the title in the probe). A variant
    switched shows up as the layer's settings changing.
  - The inputs a layer flickers in the same message as it switches (a source name to "None" and back)
    are not changes of their own.
  - Messages about one layer within 600 ms are one change: typing a title is one change, not one per key.
- **The words.** The strip names the first change and counts the rest ("Lower Third on +2 more"). The
  WARNING line reads "CHANGED IN MIMOLIVE: Lower Third on (+2 more)", kept short so it fits whole on an
  iPad; when it began and the whole list are in the strip's tooltip and takectl's log.
- **A warning about a document that is no longer on air** (an outside cut in MASTER, SAFE) is dropped.
- **The strip keeps "PROGRAM · A" on red at its left**: the panel's rule that red always comes with the
  word PROGRAM. Beside it, **two lines**: CHANGED IN MIMOLIVE small on top, what changed under it across the
  rest of the strip. On one line, an iPad left room for "Ca…" of "Cam PiP on".
- **Both monitor header strips are now at least 44 px tall**: the strip is a tap target, and the two
  headers stay aligned.
- **WATCH PGM is a lamp-style toggle in the header**, beside DOCTOR (the readout's button row has no
  room at 1024 px). Lamp: green while watching, red while the socket is down, grey when off.
- **Under 1300 px wide the full-screen key shows only its symbol**: WATCH PGM needed the room at 1180.
- **The readout on short screens (840 px tall or less)** has less padding and a tighter line height, and on
  narrow screens (1120 px wide or less) it is 15rem wide instead of 13.5rem, so LAST, UNDO and a
  WARNING all fit whole at 1024×768 with a two-line UNDO reason.
- **ON AIR FOR is one line** (the label beside the time), at every size. The line it frees keeps a WARNING
  whole at 1024×768 under a two-line LAST and a three-line UNDO reason.
- **Up to 1150 px wide, the downstream keys get a row of their own**, as they already did up to 1120. This
  fixes a polish-round defect: at 1133×744 (an iPad mini) in SAFE, the short reasons "no Program look"
  (MIRROR) and "came from SAFE" (UNDO) were cut on their 68-px keys. The polish round's state runs were at
  1440 and 1180 only; the first state run at 1133 found it, and the build before round 4 fails the same way.
  The keys are 110 px now.
- **Dismiss and WATCH PGM skip the panel's busy lock**, so neither ever holds up TAKE.
- **One socket per mimoLive host** (A, B and MASTER may be on three Macs). Before, only MASTER's host
  had one.
- **takectl's own writes are known from its HTTP client**: every setLive, setOff, recall and PUT to A or
  B is reported to the watch before it is sent, so no call site can be missed.
- **Preview's new thumbnail** goes to the Layer Set mimoLive reads as active; a Preview composed by hand
  that matches no Layer Set gets none.
- **Input changes in the 600 ms after a layer switches are not counted** (the flicker, below). A real edit in
  that moment is not flagged.

**Found on the real app, not the mock: the switch flicker.**
- When a layer is switched on, mimoLive sets its source names to "None" in that message and puts them back
  about 300 ms later in a message of its own (the probe shows it on Two Shot, Cam Wide and Slides). The
  first real run read "CHANGED IN MIMOLIVE: Slides on, AName" ("AName" is mimoLive's own label for that
  input), and two checks failed.
- Fixed:
  - A message that switches a layer, or its variant (they arrive in either order), keeps the input values
    from before.
  - Input changes on that layer for 600 ms after it switched are not changes.
  - A re-read (accept, reconnect) does the same for a layer it finds switched or that has just switched.
- The mock now flickers in the same way. With it, the build before the fix fails D3, C4 and G3 offline:
  the checks that switch a layer *on* by hand.
- The re-read had a second problem, found while chasing the first: a message arriving while the re-read
  was in flight could be overwritten by the older read. A re-read now keeps whatever a message updated while
  it was reading. No check isolates this guard: it closes a race the suite does not reproduce.

**Limits, as ruled:** a change by hand to one of the layers takectl is writing, inside its settle window,
is not flagged; nor is a change to a hook's layer before it next reads off.

**Correction to the panel polish section:** it said the worst label contrast is 8.6:1. That was the
reading at rest. Across the state run it is 5.9:1, the `.sub` line on a selected key's green band. The
state run now reports its worst figure.

**Tested.** Offline against the mock, and on the real mimoLive 7.0b3 (PH-A, PH-B, PH-MASTER). A change
"by hand" is made straight through mimoLive's API, which the socket carries exactly as it carries a change
made in mimoLive's window (the probe: the title written back at 20:17:29).

| Suite | Result |
|---|---|
| `round4-offline-check` (mock): live values, a Layer Set's `active`, TALLY; hand changes in Program; takectl's own writes (PUSH, a hook, the settle window); `watchIgnoreLayers`; dismiss; TAKE, CUT, UNDO, PANIC clear, PUSH does not; Preview by hand; WATCH PGM; the socket lost and back | 37/37 |
| `round4-check` (real app): idle; a hand change in Program (in `/state` within 20–22 ms); PUSH and a hook do not warn, and the hook's Lower Third is watched again once off; a hand change 60 ms into a PUSH warns; Cam PiP on the ignore list does not; dismiss; TAKE, CUT, UNDO clear; Preview by hand (UNDO off within 19 ms, thumbnail retaken ~1 s after it settles) | 19/19 |
| `panel-chrome --states` (real app) at 1440×900, 1180×820, 1133×744, 1024×768: 25 state changes, including a hand change, a click on the strip, another hand change, TAKE, WATCH PGM off and on | all pass at all four: no key moved; reasons, the strip and the WARNING line whole in every state; worst label contrast 5.9:1 |
| view-only (`?view=monitor`) with a warning up | the strip shows, 0 buttons |
| Every earlier offline suite with the new mock and takectl: mock-smoke, round 1, amendments, round 2, safe source, round 3 | 8, 12, 10, 34, 21 and 23: all pass |

**Falsified** (`test/falsify/round4-*`):
- **The build before round 4**, offline: 21 of 37 checks fail. On the real app: 10 of 19 fail (every check that
  needs a warning, an acceptance or a Preview reaction).
- **The checks that pass there pass vacuously**: that build watches nothing. So each mechanism was broken on
  its own in a copy of the round 4 build (`round4-offline-check-mutants.txt`, with each mutation). Every
  mutant fails the check named for it:

| Mutant (one mechanism removed) | Fails |
|---|---|
| M1 takectl's own writes not recognised | C1 O1 O5 O6; on the real app R2a R2b R3 |
| M2 a hook's layer not held until it reads off | O3 O4; on the real app R2c R2d |
| M3 TALLY not excluded | L4 (and W1 W2 after it) |
| M4 audio levels not filtered | L1 and everything after it; on the real app none (corrected 2026-11-12: its R3 failure was a stuck Lower Third, see Release fixes) |
| M5 a Layer Set's `active` counted | L2 C1 O1 O5 O6 |
| M6 no burst merge | W3 (typing counted per key) |
| M7 TAKE / CUT / UNDO do not clear | O2 O3 O4: the warning comes back when its document returns to air |
| M8 PUSH clears | C1 |
| M9 no Preview thumbnail | P3 |
| M10 dismiss does not clear | D1 D2 D3, O5 O6, N2 N3 |
| M11 the switch flicker taken as it comes | C4 C5 N3 |
| M12 a re-read takes the flicker | N3 |

- **Weak spots, said plainly.**
  - On the real app, R0b (5 s idle) did not catch M4: those 5 s happened to carry no audio-level input in
    A or B. The offline L1 is what proves the filter. (Corrected 2026-11-12: no real-app check caught M4.)
  - C2 and C3 ("cleared") would also pass without the clear: the warning is hidden once its document
    leaves the air. M7 shows the clear is needed when the document comes back. **Tightened 2026-11-12**
    (Release fixes, below), and C4 and C5 with them: they had the same weakness, not named here.
  - N2 (nothing is seen while not watched) has nothing of its own to catch: with the socket down there is
    nothing to see. It failed under M10 only because an earlier warning was still up.
  - The re-read guard has no check of its own.

## Release fixes, 2026-11-12: look keys, monitors, the clear checks (branch v0.2, not released)

**Ruling, 2026-11-12:** Round 4 approved: all twelve decisions, the two routes and `watchIgnoreLayers`;
the flicker fix and the re-read race fix as made. Before the release commit: the look keys, the
monitors, the clear checks, the v0.3 note and the README status block, below.

**Look keys** (the polish round's taller keys cropped each still to a slice of its middle: Two Shot showed
half of each letter):
1. Each PVW key is the whole 16:9 still on top, fitted, never cropped, and the look's name in a band of its
   own underneath, not over the picture. The slot number stays on the picture's top-left corner, on its dark
   chip. Key width is as before; the height is the picture plus the band: 110 px at 1440×900, where the
   polish keys were 196.
2. The selected key keeps its green border and band, NEXT keeps its white ring. An empty slot is the same
   size, unlit.
3. Nothing is stretched into the freed height: the steps strip and the utility row keep their heights and
   their places, and the space opens between the look keys and the steps strip.

**Monitors:** each picture box is exactly 16:9. On a wide, short screen (the height cap, 37 % of the screen,
or 33 % under 840 px tall, binds first), a monitor is no wider than its picture, and the readout takes the
width left over. Before, the monitors kept their column's width and the picture sat between black bars:
12 px a side at 1512×860.

**Decisions made at the keyboard, flagged:**
- **[ROUTE]** `/state` and `/watch` gain `watch.offAir`: a change kept for a document that is no longer on
  air (an outside cut took it off), which would show again if that document came back on air the same
  way. TAKE, CUT, UNDO and PANIC clear it. It is what the tightened checks read.
- **[CONFIG]** None.
- **[AIR]** None.
- **The band is one height on every key**: room for two lines of name and the hooks line, whatever a key
  holds, so no key is taller than another. A one-line name sits centred in it.
- **The bands are opaque now** (they no longer sit over a picture): dark grey, and dark green when
  selected. Worst label contrast 11.9:1 (was 5.9:1).
- **NEXT's white ring is drawn over the picture and the band** (the old ring sat under the key's
  contents and would be hidden by the opaque picture and band).
- **The freed height sits above the steps strip**, so the steps strip and the utility row stay where they
  were, level with the transition block's bottom rows.
- **The monitors' freed width goes to the readout**, not to space between the monitors.
- **Packaging:** `thumbs/` (the look keys' stills, taken from the running show) and Start Over's
  `takectl.config.backup-*.json` are now kept out of git (`.gitignore`) and out of the zip (`pack.sh`).
  Neither is part of the package; the stills from this morning's session were about to be committed.

**The clear checks, tightened.** The warning is hidden once its document leaves the air, so a check reading
only "not shown" passes without the clear. C2 (TAKE), C3 (CUT), C4 (UNDO) and C5 (PANIC) offline, and
R6a–c (TAKE, CUT, UNDO) on the real app, now read the watch at the moment the command returns: nothing shown
and nothing kept for the document that left the air (`watch.offAir`). The round 4 report named C2 and C3;
C4 and C5 had the same weakness. No mutant broke PANIC's own clear, so there is a new one, M13.

**NEXT and the count, off the picture** (asked for a ruling: on an iPad the two covered most of the NEXT key's
60×34 px picture; ruled 2026-11-12). Only the slot number stays on the picture. The white ring alone marks
the likely-next key. The count is in the band, right-aligned. The word NEXT is in the band beside the name
when it fits whole, and is dropped, never cut, when it doesn't. The readout's LIKELY NEXT line is unchanged.
- **The count sits on the band's bottom line**, right-aligned after the hooks, so it never narrows the name
  (beside the name on an iPad it would cut "Speaker"). The hooks text gives way to it, with an ellipsis as
  before ("the… ×2").
- **Ruling, 2026-11-12:** approved, including the count on the bottom line; v0.2.1 replaces a cut hooks hint
  with a marker (Next).
- **NEXT fits** when the name is whole in its two lines and the tag fits whole to the right of the name's
  widest line, without touching it. It is then centred on the name. With the bench's look names that never
  happens at the four sizes (no room beside "Two Shot" even at 1440), so the ring carries NEXT there.

**Tested** (real mimoLive 7.0b3 unless marked):

| Suite | Result |
|---|---|
| `panel-chrome --states` at 1440×900, 1180×820, 1133×744, 1024×768 (`panel-chrome-next-final-*.txt`, with NEXT and the count in the band) | all pass at all four. Keys 97×110 / 64×83 / 58×80 / 63×82 px, every picture 16:9 with the 320×180 stills whole, band underneath, slot number on the picture, all 8 keys one size; monitors 16:9 with 0 px bars; NEXT's ring white all the way round in every state that had a NEXT key (18–23 of 25); no key moved across 25 state changes; worst label contrast 8:1 |
| `panel-chrome` at 1512×860 (a wide, short window) | monitors 566×319, 0 px bars; keys pass |
| `panel-chrome --selftest` | tall keys with `cover` and a non-16:9 monitor, forced by a style sheet, are caught ("cropped (cover): 47% shown"); on the NEXT key, the page's own fitting shows the word whole beside a short name ("Cam") and drops it beside a long one |
| NEXT and the count, in every state of the four state runs | the count and NEXT (where shown) whole in the band, never on the picture; NEXT never over the name; never dropped where it would fit |
| `round4-check` (tightened R6a–c) | 19/19 |
| `round4-offline-check` (tightened C2–C5) | 37/37 |
| Every earlier offline suite: mock-smoke, round 1, amendments, round 2, safe source, round 3 | 8, 12, 10, 34, 21 and 23: all pass |
| PANIC on Jourdan's own config, with `sourceNameSafe: "SAFE Test Pattern"` set | `/state` `safe.panicTo` "SAFE" (slot 3); the panel reads HOLD · CUT TO SAFE |

The rows below the keys keep their heights (steps strip 58 px, utility keys 58 or 50 px, the same as before).
The first state runs failed the slot-number check at the three iPad sizes: it asked for the chip inside the
picture's top-left quarter, and on a 34-px picture the chip is taller than that. The check now asks for what
was ruled, the chip on the picture at its corner.

**Falsified:**
- **The panel checks, against the build before this fix** (`falsify/panel-keys-before-fix.txt`), on the real
  app at the four sizes and 1512×860: the keys fail everywhere (each still cropped to 19–40 % of itself, 19 % on
  an iPad; the band over the picture); the monitors fail at 1512×860 (12 px bars a side); and NEXT's ring fails
  everywhere: **the polish build's band already hid the bottom of the ring.** A copy of the fixed build without
  the ring overlay fails it all the way round.
- **The tightened checks, against mutants** (`falsify/round4-offline-check-mutants.txt`, rebuilt from the final
  build, now 13): M7 (TAKE, CUT, UNDO do not clear) fails C2, C3 and C4 directly, and O2–O4 as before; the new
  M13 (PANIC does not clear) fails C5. On the real app M7 fails R6a, R6b and R6c, and nothing else
  (`falsify/round4-check-before-round4-and-mutants.txt`). Every other mutant still fails the check named for
  it; M5 also failed D1 this time, a knock-on of its extra warnings.
- **Correction:** the round 4 report said M4 (audio levels not filtered) fails R3 on the real app. It does not:
  in that run the Lower Third was stuck in `shutdown` (7.0b3) and no warning came at all. No real-app check
  catches M4; the offline L1 does. The same stuck layer failed R3 in a first M7 run here, so M7 was run again.
- **NEXT and the count** (`falsify/panel-next-before-fix.txt`, real app, 1440 and 1180): the build before the
  ruling fails ("×3 sits on the picture", "NEXT sits on the picture"); a copy that always shows NEXT fails
  ("NEXT shown where it does not fit", "NEXT over the name") and its selftest; a copy that never shows it
  passes every rest-state check, since the bench's names leave no room, and fails only the selftest. That
  selftest is what proves the "when it fits" half.

**Bench:** three test copies of takectl were left running on the bench for a while (a stop command that never
matched); only page reads ran in that time, after the state runs and the screenshots. The bench is back as
Jourdan left it: A on air with Speaker Wide, B on Full Slides, takectl stopped.

## Next

**v0.2.1:** when a key's hooks text does not fit whole beside the count, show a small hook marker instead of
truncated text ("the…" says nothing; the readout shows the hooks in full).

**v0.3:**
1. Probe whether the Preview document lights NDI camera tally red.
2. Multiview from source previews, with click-to-assign a camera into Preview.
3. **STORE:** save Preview's current state as a named Layer Set in both documents.
4. ISO recorders per camera, started together, plus a cut list exported from the history log.
5. One button to start all three shows in order.

**v0.4:** a second bank of look keys, a program audio meter, look-ahead preview, clean feed, aux buses, the
DSK TIE button, and an agent seat.

## Proposals (not applied — outside the five drift points)

1. **Preflight should check the NDI link, not just the output's state.** **CLOSED 2026-11-11 (v0.2 round 1 amendments):** applied, read as target only.
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
     starts against it again (`test/mock-smoke.txt`). **Tally values DONE 2026-11-11 (v0.2 round 1 amendments):** `in-use` off air, `effect` mid-dissolve. CLOSED.
4. **Datastore calls ignore `apiPasswordSha256`.** **CLOSED 2026-11-11 (v0.2 round 1 amendments):** they send the header; tested against the mock's `--require-password`. `readState`/`writeState` use bare `fetch`
   without the password header. With a password set, state persistence would fail silently.
   Route them through `api()`.
5. **`/mirror` and empty Layer Sets.** A new, empty Layer Set reports `active: true`, so until
   the sets are recorded, `activeLayerSetName()` returns whichever comes first.
   - **Re-tested 2026-11-09 with the sets recorded: PASS** (`test/layersets-check.txt`, `test/takectl-mirror.log`).
     - Exactly one set reads active after each recall, including in a document whose TALLY is lit.
     - `/mirror` copied Slides PiP, Two Shot and Full Slides from A to B.
   - **Remaining risk:** a set left empty would still read active and could win. Optional hardening:
     have `activeLayerSetName()` skip sets whose `layers` list is empty. **CLOSED 2026-11-11 (v0.2 round 1 amendments):** done; PUSH, MIRROR and history use it.
6. **Stale `lastError`.** **CLOSED 2026-11-09 (v0.1.1):** ruled and built, see "v0.1.1" above. A refused preflight leaves `lastError` set until the next successful
   verify (seen as a lingering "B document is not live" in `test/bench2-watch.txt`). Consider
   clearing it on the next successful transition request.
   - **Now on screen:** the operator page's ERROR line keeps a COUNTER refusal after COUNTER is
     switched off, until the next TAKE lands.
7. **README corrections for 7.0b3:** **CLOSED 2026-11-11 (v0.2 round 1 amendments):** in the README.
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
