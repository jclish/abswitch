# Bench results — abswitch on mimoLive 7.0b3 (build 30982)

*Logs in this folder are redacted for publication: the bench Mac's hostname reads `Studio-Mac-Mini`, its home folder `~`, its LAN address `192.0.2.10` (a documentation address). `privacy-scan.py` checks the package for all three when `pack.sh` runs.*

2026-11-08 · one Mac ("Studio-Mac-Mini", Darwin 27), all three documents in one mimoLive ·
documents 1920×1080 @ 30 · Node 22.23.2 · controller = fixed `takectl.mjs` unless stated.
Logs and watcher output referenced below are in this folder; raw API responses in `captures/`.

| # | Test | Result |
|---|---|---|
| — | `node takectl.mjs doctor` | **PASS**: exit 0 with COUNTER off (`doctor-real.txt`), exit 1 naming COUNTER with it live (`doctor-counter-live.txt`); rerun 2026-11-09 on the switcher-truth takectl |
| 1 | Independence | **PASS, partial** — window not minimised (needs the UI) |
| 2 | Signal control | **PASS** |
| 3 | Frame-cleanliness | **PASS for one real TAKE** (2026-11-09) — the ten-take run is still the procedure below |
| 4 | Audio | **NOT RUN** — procedure below |
| 5 | Desync recovery | **PASS**, rerun 2026-11-09 on the switcher-truth takectl (`bench5-check.txt`). Outside change made via the API, not a UI click |
| — | TALLY crop in MASTER (static) | **PASS** for A and B — see test 3, step 6 |
| — | Layer Sets + `/mirror` | **PASS** — see below |
| — | COUNTER guard + split TALLY (brief of 2026-11-09) | **PASS**; the stale-verify check is falsified. Rerun on the switcher-truth takectl: ALL PASS — see below |
| — | Switcher truth, witness, panic (ruling of 2026-11-09) | **PASS**; panic and witness checks falsified against the takectl from before the ruling — see below |
| — | v0.2 round 1: setup mode, doctor page, greyed Layer Sets, launcher, hidden-key fallback (`round1-check.txt`, `round1-offline-check.txt`) | **PASS** 6/6 on the real app, 12/12 offline; v0.1.1 fails them (`falsify/`); `start.command` double-clicked in Finder opened the page. Details: CHANGES.md, "v0.2 round 1" |
| — | v0.2 round 1 amendments: PANIC while not ready, lost and back, loopback-only Save / Start Over, fallback expiry, password header, NDI link (`amend-check.txt`, `amend-offline-check.txt`) | **PASS** 3/3 on the real app, 10/10 offline; the build before the ruling fails 3/3 and 9/10 (`falsify/`). The NDI-link part on the real app is opt-in after it crashed mimoLive once (`amend-check-run1-crash.txt`) |
| — | v0.2 round 2: stinger, hooks, PUSH, steps, history, UNDO (`round2-check.txt`, `round2-stinger-frames.txt`, `round2-offline-check.txt`) | **PASS** 8/8 on the real app (hook tests on the real Lower Third since 2026-11-11), 34/34 offline. A recorded stinger TAKE: no frame shows A and B at once, and B appears only after full cover. A hook brings Cam PiP in on Program after the stinger clears; PANIC 200 ms after a TAKE fires no hook. v0.1.1 and the round 1 build fail 5/8 and 28/29; the gate for commands sent together fails without it (`falsify/`). Details: CHANGES.md, "v0.2 round 2" |
| — | Round 2 changes and the owed real-app coverage (`round2-coverage-check.txt`, `round2-coverage-cut-frames.txt`): pre-hook on the outgoing document, PANIC mid steps run, CUT under the stinger, stuck-stinger refusal (stuck reproduced on the real app), a failing hook, rehearse-then-TAKE | **PASS** 6/6 on the real app; the round 1 build fails 6/6; the build before the changes fails C6 (the rehearsal put-back), as it should. Offline `round2-offline-check` 34/34. Details: CHANGES.md |
| — | v0.2 round 3: the switcher panel (`round3-check.txt`, `round3-offline-check.txt`, `panel-chrome-*.txt`, `second-device-watch.txt`, `demo-run.txt`) | **PASS** 9/9 on the real app, 22/22 offline (16 fail on the build before round 3). One screen, ≥ 44 px, live pictures at 1440×900 and iPad sizes; no key moved across 19 state changes at both sizes. Bench 5 and a PANIC to SAFE watched and pressed from an iPad on the LAN. Details: CHANGES.md, "v0.2 round 3" |
| — | Safe source for PANIC (`safe-check.txt`, `safe-offline-check.txt`, `safe-source-probe.txt`, `slot4-probe.txt`) | **PASS** 13/13 on the real app, 20/20 offline; the build before it fails 12/13 (N, no safe source → A, passes on both) and 19/19; the stale-read check W fails before its fix (`falsify/`). By hand in mimoLive's UI: see CHANGES.md |
| — | v0.1.1: `lastError` cleared by the next success and shown with its age; `/mirror` refused mid-transition (`error-mirror-check.txt`) | **PASS** 7/7; 5 of the 7 fail against the previous takectl (`falsify/`) |
| — | Saved documents in release state (no COUNTER, TALLY off), checked by `saved-docs-check.py` | **PASS** on the 12:04 saves; the same check fails on the 11:57 bench-state saves (2026-11-09). v0.2: STINGER and FTB saved off above the switcher, **PASS** on the 17:47 saves (`saved-docs-check-v02.txt`, 2026-11-11); it failed on the earlier MASTER save, which had neither. Safe source: SAFE Test Pattern saved in slot 3, **PASS** on the 18:29 MASTER save (`saved-docs-check-safe.txt`) |
| — | Operator page, PVW Layer Sets, stall warning, TALLY repair (UI brief of 2026-11-09) | **PASS**, and the page on an iPad on the LAN shows both pictures moving — see below |
| — | Panic wins, in-flight never decides (second ruling of 2026-11-09) | **PASS**; 11, 12 and verify falsified against the takectl from the first ruling — see below |
| — | takectl against the mock, offline (`mock-smoke.txt`) | **PASS**: not evidence about mimoLive |

## Operator page, PVW Layer Sets, stall warning, TALLY repair — PASS (UI brief of 2026-11-09)

The full table, with falsifications, is in CHANGES.md ("UI brief"). The evidence in this folder:
- **Operator page:** `operator-page-bench5-watch.txt` (bench 5 watched),
  `operator-page-controls.txt` (keys, PANIC arming, Layer Set click) and
  `operator-page-chrome.txt` (pictures in headless Chrome; screenshot `../operator-page.png`).
- **Layer sets and stall:** `pvw-layerset-check.txt`, `stall-check.txt`.
- **TALLY repair:** `tally-repair-check.txt`; `panic-check-tally-shutdown-run.txt` is the failing
  run that found the fault.
- **Falsifications:** `falsify/*-before-ui.txt`.

**Second device:** the operator opened `http://192.0.2.10:8991/` on an iPad on the LAN
(2026-11-09): both pictures moving.

## Panic wins, in-flight never decides — PASS (second ruling of 2026-11-09)

Same bench and conditions as the next section. The falsification copy is takectl as it stood
after the first ruling; its output is in `falsify/*-before-11-12.*`.

**`panic-check.txt`**, now with 11 and 12 asserted:

| Case | `/panic` answered | End state | Before this ruling |
|---|---|---|---|
| `/take`, `/panic` +57 ms | +1271 ms, `ok`, 2 rounds | A on air, TALLY A lit / B dark, no error — **PASS** | PASS |
| `/take`, `/panic` +200 ms | +1273 ms, `ok`, 2 rounds | same — **PASS** | PASS |
| `/take`, `/panic` +602 ms | +880 ms, `ok`, 1 round | same — **PASS** | PASS |
| 11: `/take` and `/panic` together | +293 ms, `ok`, 1 round; `/take` answered `ok:false`, signal not sent | same — **PASS** | **FAIL**, ended on B |
| 12: `Dis_2` fired outside takectl, `/panic` +200 ms | +997 ms, `ok`, 2 rounds | same — **PASS** | **FAIL**, ended on B |

**`inflight-check.txt`**:
- **V.** The switcher's transition was set to 2.0 s while takectl expected 0.5 s. At +1.3 s
  `verify()` had run its 3 retries, still seeing 30/30, and decided nothing (`lastError` null, both
  TALLYs lit). The sources' event at the end of the dissolve settled it: pgm B, TALLY A dark / B
  lit, "transition settled on a later read (socket)".
  - Before this ruling: "verify failed … still mid-transition after 3 retries".
- **D.** `doctor` 200 ms into a 4 s dissolve fired at MASTER: no PGM decided, and it says the switcher
  was mid-transition (`doctor-mid-transition.txt`).
  - Before this ruling it also decided no PGM; it fails only for lacking the message. So D does
    not falsify the rule, only the report.

Durations restored to 0.5 s after both.

**Regression** (`guard-tally-check.txt`, `witness-check.txt`, `bench5-check.txt`): ALL PASS on the
new takectl. Bench 5 outside changes followed 0–42 ms after the slot moved.

**Offline** (`mock-smoke.txt`): takectl starts against the mock again. `/take`, panic mid-TAKE,
TAKE+panic together and panic mid outside dissolve all end on A. This is about the mock, not mimoLive.

## Switcher truth, witness, panic — PASS (ruling of 2026-11-09)

All against the real mimoLive, all three shows live, MASTER on slot 1 at the start. COUNTER is
switched off for runs that TAKE, and restored. Falsification copies ran from a scratch folder with
the same config; their output is in `falsify/`.

**Probe** (`switcher-probe.txt`, `switcher-probe-2.txt`): the live slot is
`currentLiveSource`. It flips at the end of a dissolve (~567 ms), with both per-slot codes at 30
meanwhile. The switcher sends no WebSocket event; `sources changed` fires at every switch. A cut
202 ms into a dissolve is overridden; one sent after it lands within 15 ms.

**`panic-check.txt`** (first ruling's run; the file now holds the second ruling's run, above): `/take` (A → B dissolve), then `/panic`:

| `/panic` sent | Cuts | `/panic` answered | End state |
|---|---|---|---|
| +60 ms (right after `/take` answered) | 2 | +1270 ms, `ok` | slot 1, pgm A, TALLY A lit / B dark, no error — **PASS** |
| +200 ms | 2 | +1268 ms, `ok` | same — **PASS** |
| +601 ms | 2 | +1270 ms, `ok` | same — **PASS** |

- **Falsified:** the takectl from before the ruling ended on **B** at 0 and 200 ms, both times
  answering `ok:true` (`falsify/panic-check-before-ruling.txt`). It passed at 600 ms, when the
  dissolve had already landed.
- **First run** (`panic-check-run1-early-read.txt`): the 200 ms round failed. MASTER was on A, but
  `/panic` read the switcher the instant its second cut returned, and reported failure. Fixed by
  taking the completion loop's first read one settle period after the last cut.
- **Two FINDINGS, recorded not asserted** (CHANGES.md, proposals 11 and 12): both end on B.
  - `/take` and `/panic` sent together: panic lands inside the TAKE's preflight.
  - A dissolve started outside takectl, then `/panic`: it answered `ok` from a mid-dissolve read.

**`witness-check.txt`**: slot 1 pointed at NDI PH-B, so the switcher says A while source tally says
B=`program`, A=`off`. The warning appeared after 415 ms, with one `WARNING` line in 6.5 s (past a
poll). Roles stayed A, with TALLY A lit and B dark. With slot 1 restored, the warning cleared after
106 ms with one "agrees … again" line.
- **Falsified:** the takectl from before the ruling handed PGM to B on the tally
  (`falsify/witness-check-before-ruling.txt`).

**`guard-tally-check.txt`** (regression): ALL PASS. The COUNTER guard, `doctor` both ways, the
TALLY handover and the stale-`verify()` check all still hold. Its FINDING, `/panic` 150 ms into a
dissolve, now ends on **A** (it ended on B before the ruling).

**`bench5-check.txt`**: outside Cut_2 / Dis_1 / Dis_2 / Cut_1 were followed by `/state` and both
TALLYs 0, 41, 38 and 0 ms after the switcher's slot moved. With takectl stopped on A, a hand
dissolve to B left the datastore saying A. On restart takectl came up `pgm: B` from the switcher,
fixed TALLY, and rewrote the datastore.

## COUNTER guard + split TALLY — PASS (2026-11-09)

`guard-tally-check.mjs` → `guard-tally-check.txt`, `tally-overlap-watch.txt`, `takectl-guard.log`.

- **COUNTER live in A and B:**
  - `doctor` exits 1 and names both documents (`doctor-counter-live.txt`).
  - `/take` is refused with the same message.
  - MASTER's live slot does not move.
- **COUNTER off:** `doctor` exits 0 (`doctor-real.txt`, regenerated).
- **TALLY overlap** (/take, /take, /cut, /cut):
  - The incoming TALLY lights in the same 40 ms poll as the request.
  - The outgoing TALLY goes off ~250 ms after MASTER's live slot changes, once `verify()` confirms.
  - Both are lit ~770 ms per dissolve and ~250 ms per cut.
- **Stale `verify()`:**
  - `/take` to B, then `/panic` at +620 ms (after the dissolve lands, before verify runs at +750).
  - The result is right: MASTER on slot 1, PGM A, TALLY A on / B off, `lastError` null.
  - **Falsified:** the same run against a copy of takectl without the `stale()` returns FAILS with
    `verify failed: expected B on program`.
- **Findings,** recorded and not asserted (CHANGES proposals 8 and 9):
  - `/panic` 150 ms *into* a dissolve does not land: MASTER finishes on B while takectl says A.
  - MASTER keeps reporting NDI PH-A as `program` while B is on air.

## Layer Sets + `/mirror` — PASS (2026-11-09)

The sets were recorded by hand in the UI. `layerset-check.mjs` (→ `layersets-check.txt`) reads them
back and recalls each one.

- **Contents:** all eight sets (four per document) match the table in `documents/README.md`.
  TALLY and COUNTER are absent from every set ("No Action").
- **Recall:** every recall switched the four content layers correctly and left TALLY and COUNTER
  untouched.
- **Active flag:** after each recall exactly that one set read `active`. This held in PH-B with its
  TALLY lit, so a lit tally does not stop a set reading as active.
- **`/mirror`** (`mirror-check.mjs` → `takectl-mirror.log`): with A as program, A recalled Slides PiP,
  then Two Shot, then Full Slides, and `/mirror` brought the same set active in B each time.

The crop check (`crop-check.mjs`) is described under test 3. The watcher (`watch-state.mjs` → `bench2-watch.txt`, `bench5a-watch.txt`) polls every 40 ms and logs only changes:

- the switcher's live slot;
- MASTER's tally for NDI PH-A / PH-B;
- the TALLY layers in A and B;
- takectl `/state`.

## 1. Independence — PASS (partial)

`bench1-independence.mjs` records ~3 s of MASTER, then compares PH-A's COUNTER region in two
frames 2 s apart.

**Result** (PH-A on program): mean absolute difference **2.58**, threshold 1.0, so PASS.

**Negative control:** with COUNTER switched off, the same check scored **0.00** and failed. So the
pass means something.

**Not covered:** I cannot minimise windows from here. mimoLive was the frontmost app, with the
window z-order not controlled. Re-run after minimising PH-A (manual step).

## 2. Signal control — PASS

`doctor` found Cut/Dis keys for slots 1–8. `/cut`, `/cut`, `/take`, `/take`:

- Every call returned `ok:true` and alternated B → A → B → A.
- The switcher's live slot followed within one poll.
- The TALLY layers followed.
- `verify()` cleared, with no errors in `takectl-bench.log`.
- Each dissolve showed tally `effect`/`effect` for ~450 ms (drift 2).

**Note:** the incoming TALLY goes live ~100 ms *before* its dissolve starts. See CHANGES.md proposal 2.

**Incidental preflight check — PASS.** The three shows were stopped by accident mid-bench. All four
calls were refused with `B document is not live (show not started)`, and MASTER's live slot never
moved (`bench2-watch-shows-stopped.txt`).

## 5. Desync recovery — PASS (outside change via the API)

*Rerun 2026-11-09 on the switcher-truth takectl, scripted as `bench5-check.mjs`: PASS, see "Switcher truth, witness, panic" above. The record below is the first run, when takectl still took PGM from source tally.*

The UI click "Dis 1" was replaced by firing the same signal straight at MASTER
(`GET …/layers/{switcher}/signals/tvGroup_Control__Dis_1_TypeSignal`), bypassing takectl. That
is the same switcher input the button drives. Whether a real click emits the same WebSocket
event is a manual step.

| Outside change (takectl idle) | /state + TALLY follow |
|---|---|
| Dis 1 (B → A) | `effect` from +0 ms, slot 1 at +459 ms, takectl `pgm=A` and TALLY flipped at **+509 ms** — one poll after tally settled |
| Cut 2 (A → B) | switcher, tally, `/state` and TALLY all changed within one 40 ms poll |
| Dis 1 (B → A) | `/state` + TALLY flipped one poll after the dissolve ended (+508 ms) |

`takectl-bench.log` logs each one as `PGM changed outside takectl (socket)`.

**Second half.** Stopped takectl with PGM=A; the datastore said `pgm:"A"`. Dissolved to B by hand,
so the datastore was now stale and TALLY was wrong (A lit) while takectl was down. Restarted takectl:

- `/state` came up `pgm:"B"` from tally;
- TALLY was corrected (A off, B lit);
- the datastore was rewritten to `pgm:"B"` (`takectl-bench-restart.log`).

**Original vs fixed.** The *original* takectl, run against two outside dissolves, logged
"tally inconclusive … using saved/default PGM" twice per dissolve (`takectl-original-falsify.log`).
The fixed version shows no such path.

## 3a. One real TAKE, recorded and scrubbed — PASS (2026-11-09)

`record-take.mjs` → `take-recording.json`, `take-recording-watch.txt`, `takectl-take-recording.log`;
`analyse-take.mjs` → `take-analysis.json`, `evidence/take/`. The clip is `evidence/take/take-A-to-B.mov`; re-scrub it with `node test/analyse-take.mjs test/evidence/take/take-A-to-B.mov`.

**How it was run:**
- takectl ran with a temporary config identical to `takectl.config.json` except `"preflight": false`.
  The COUNTER guard would otherwise refuse the TAKE, and the counters had to be on air. This was
  decided 2026-11-09; the guard is proven separately above.
- Both stopwatches were Reset and then Started together. The residual offset A − B, read back from
  the layers, was −0.007 s (reads ±0.04 s).
- One `/take` A → B was recorded on MASTER (H.264, 30 fps, 119 frames).
- **Trap:** on 7.0b3 the stopwatch's Reset signal also stops it. The first recording ran with both
  frozen at 0:00.00 and was discarded.

**Results:**
- **Both TALLYs lit through the fade** (`take-recording-watch.txt`): from the TAKE request to
  200 ms after the switch completed, ~760 ms in all.
- **Crop intact through the fade.** Every frame was compared, top rows against the background just
  below them:
  - worst colour difference **2.9**, worst row-to-row edge **0.5**;
  - the same metrics on the uncropped control frame (`evidence/master-pgm-A-zoom100.png`) score
    **98.5** and **72.4**;
  - no TALLY edge on any of the 14 dissolve frames (`evidence/take/top-band-contact-sheet.png`).
- **Clean fade:**
  - 14 frames (467 ms for a 500 ms setting), each one further into the fade, consecutive, none
    repeated;
  - `blackdetect`: no black.
- **Counter delta at the midpoint: 0.00 s.**
  - Every dissolve frame shows one crisp value, from 0:03.63 to 0:04.06, one frame per step
    (`evidence/take/counter-through-dissolve-f45-f58.png`).
  - The midpoint (frame 51, 47 % mix) reads **0:03.83**, with no second value showing through
    (`evidence/take/counter-2-midpoint.png`).
  - A 0.01 s difference would show as a half-transparent second digit. So with the −0.007 s reset
    offset, the A and B NDI paths differ by less than one frame.
  - An earlier clip showed H.264 block artefacts around one digit on a few frames. They are
    compression, not a second value.

**Not covered:**
- one take, not ten;
- the counters are two stopwatches reset together, not one shared NDI Test Patterns counter;
- the reverse direction (B → A) was not recorded.

## 3. Frame-cleanliness — procedure for the full ten-take run (needs a shared frame counter)

The COUNTER layers in A and B are independent stopwatches. They prove motion, not symmetry.
Test 3 needs one counter fed into both documents.

1. Launch **NDI Test Patterns**, choose a pattern with a frame counter or timecode, and note the sender name.
2. In PH-A and PH-B, put that sender on a Camera source and onto a full-screen Placer that is live
   in both documents. For example (in each document; `<doc>` and `<layer>` from `GET /documents`):

   ```
   curl -X POST localhost:8989/api/v1/documents/<doc>/sources -d '{"source-type":"com.boinx.mimoLive.sources.deviceVideoSource","name":"TESTPAT"}'
   curl -X PUT  localhost:8989/api/v1/documents/<doc>/sources/<src> -d '{"video-device-id":"<HOST>.LOCAL (<sender>)"}'
   curl -X PUT  localhost:8989/api/v1/documents/<doc>/layers/<Cam Wide id> -d '{"input-values":{"tvIn_VideoSourceAImage":"<src>"}}'
   ```
3. Start MASTER's Recording, run `curl localhost:8991/take` ten times about 3 s apart, then stop the recording.
4. Machine pass:

   ```
   ffmpeg -i <clip> -vf "blackdetect=d=0.03:pix_th=0.10,freezedetect=n=0.003:d=0.10" -f null -
   ```

   Any `black_start` or `freeze_start` near a take time is a FAIL.
5. Eye pass: use the TAKE times in takectl's log, and pull the 15 frames around each one:

   ```
   ffmpeg -ss <t-0.25> -i <clip> -frames:v 15 take%02d.png
   ```

   At the dissolve midpoint both ghosted counters must show the same value. A one-frame
   difference means the two NDI receivers in MASTER are on different bandwidth/latency settings.
6. Also check the first frames of each take for the TALLY bar, which must be cropped off.
   - **Static check done 2026-11-09** (`crop-check.mjs`): each side was put on air with its TALLY lit. MASTER's
     recording showed 24 red rows at zoom 100 and none at zoom 105, for both A and B
     (`evidence/master-pgm-{A,B}-zoom{100,105}.png`).
   - Still to do in a real run: check the frames *during* a dissolve.

## 4. Audio — procedure (not run: needs a tone source and the interface)

1. Set **Audio In** in MASTER to the show interface. Feed a steady 1 kHz tone at −18 dBFS.
2. Start the recording, `/take` ten times about 3 s apart, then stop.
3. Spectrogram:

   ```
   ffmpeg -i <clip> -lavfi showspectrumpic=s=1920x540 spec.png
   ```

   It must be flat through every take.
4. Numbers:

   ```
   ffmpeg -i <clip> -af "astats=metadata=1:reset=3,ametadata=print:key=lavfi.astats.Overall.RMS_level" -f null -
   ```

   Any RMS dip of more than 0.5 dB at a take time means audio leaked into A/B's NDI or onto the
   switcher. On this build the AB Switcher layer reports `volume: null` (no audio path), and A/B
   contain no audio sources.
