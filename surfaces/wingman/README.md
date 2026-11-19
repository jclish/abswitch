# Wingman Surface for abswitch (optional)

The BirdDog Wingman Surface (formerly Maki Studio Surface), connected to the Mac over Bluetooth,
as a hardware panel for abswitch. **abswitch stays the switcher: the Surface is an input device and a
display.** A press calls the same takectl route the panel's key calls, so takectl's own checks apply and
the panel follows. With `--tally`, the PROGRAM and PREVIEW buttons light as the panel's buses do, read
from takectl's `/state`. The only thing ever written to the Surface is those two tally banks (ruled
2026-11-14), and nothing reaches mimoLive except through takectl.

**Status: PREVIEW 1–6, AUTO and CUT, tally, and the four graphics buttons.** PREVIEW recalls look keys 1–6
in Preview; AUTO is the panel's TAKE, CUT its CUT. LOGO ON, U.N-TITLE ON, TITLE ON and SUPER FG ON each toggle
a downstream key (built 2026-11-19, the pen's brief, stage 1; **not yet checked on the real Surface**). Every
other control is shown in the log and does nothing yet. The three
controls passed the hardware check on the real Surface (2026-11-13, 14 of 14). Tally passed 4 of 4 with
presses not armed and then the first limited armed test, 5 of 5, PREVIEW, CUT and AUTO from the Surface
(2026-11-14, `hardware-check.txt`), then a power cycle and a takectl restart, 9 of 9, fast presses, 5 of 5,
and two buttons at once after the framing fix, 4 of 4. A lamp walk with no takectl lit every position of
both banks on its own, 15 of 15 by eye.

The Surface's protocol was decoded by Production Engineering on 2026-11-13 (`wingman_monitor.py` is
their known-good monitor, kept as it was). This folder is optional: takectl never loads it, and it
needs Python and Bleak, which abswitch itself does not.

## Setup (macOS)

```bash
cd surfaces/wingman
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Python 3.10 or later; tested with 3.13 and Bleak 3.1.0.

**Run it from Terminal.app.** macOS gives Bluetooth to the app a command runs under, not to Python: the
first scan from Terminal asks once (allow it). Started from an app that has no Bluetooth access (an
editor's or an agent's built-in terminal, for instance), the process is killed outright, with
"Fatal Python error: Aborted" and no prompt.

The Surface takes one Bluetooth connection at a time: close Wingman on the iPad and LightBlue first.

## Run

takectl must be running (`start.command`). Start with a dry run: it prints what each press would send.

```bash
.venv/bin/python wingman_abswitch.py
```

Then armed, to send:

```bash
.venv/bin/python wingman_abswitch.py --arm
```

And with the lamps:

```bash
.venv/bin/python wingman_abswitch.py --arm --tally
```

Options: `--tally` (light PROGRAM and PREVIEW from takectl), `--takectl http://127.0.0.1:8991`
(takectl's address), `--raw` (every packet in hex), `--settle 1.0` (seconds after connecting before
presses count), `--config <file>` (the settings, below). Ctrl-C stops it, and with `--tally` darkens both banks first. To keep a log, pipe it
through `tee -i` (plain `tee` dies with the Ctrl-C and loses the last lines).

**Tally:** PROGRAM n is red when key n's look is on air, PREVIEW n amber when it is in Preview, exactly
as the panel's buses light them; none when the look is not one of keys 1–6, and no PROGRAM button in
SAFE. The adapter reads `/state` every 250 ms, as the panel does, and writes a bank only when its lamp
changes, PROGRAM first. Lamps follow takectl's state, never a press. After (re)connecting it writes both
banks. If takectl stops answering, the lamps keep their last state (as the panel does) and the log says
so; when takectl is up but not ready, both go dark, as the panel's do. A failed write is written again
on the next poll. The tally only ever reads `/state`, so it can never send a command.

**Settings:** the label each graphics button toggles. With no `--config`, the adapter reads
`wingman.config.json` beside it, if it is there (it is never committed); with neither, the defaults. Name only
the buttons you change; the rest keep their defaults:

```json
{ "dsk": { "LOGO ON": "Bug", "TITLE ON": "Clock" } }
```

The defaults are Logo, Up Next, Title and SuperFG, for LOGO ON, U.N-TITLE ON, TITLE ON and SUPER FG ON. A
button name that is not one of the four, a label that is not text, or anything else in the file stops the
adapter before it starts (`Settings refused: …`), so a typo never leaves a button quietly on its default.

At start, before scanning, the adapter says which buttons have a layer:

```
DSK buttons: MASTER's downstream keys are Clock, Bug
  LOGO ON: DSK Bug
  U.N-TITLE ON: no "DSK Up Next" layer in MASTER; this button sends nothing
```

`wingman_monitor.py` is the standalone diagnostic: it shows every control and sends nothing.

## What each control does

| Surface | abswitch |
|---|---|
| PREVIEW 1–6 | Look key 1–6, recalled in Preview (`/pvw/layer-set?name=…`, the panel's own route). An empty key sends nothing. |
| PROGRAM 1–6 | Pressing them does nothing: abswitch's PGM row is lamps only, and you compose in the green document. (Ruled 2026-11-13.) With `--tally` they are the Program tally lamps. |
| AUTO | TAKE (`/take`): the panel's MIX or STINGER, at its RATE. Sent only when the panel's TAKE is not greyed. |
| CUT | CUT (`/cut`): always a bare cut, as on the panel. Sent only when the panel's CUT is not greyed. |
| T-bar | Shown in the log, never acted on. abswitch takes a look in one step; a T-bar parked halfway is a state it has no name for. (Ruled 2026-11-13.) |
| Wheel | Shown in the log. Which way is +1 is not confirmed yet. |
| ON AIR | Nothing, on purpose: PANIC has no key on the panel either. FTB stays on the panel: with no lamp, the Surface could not show you are in black. (2026-11-19.) |
| LOGO ON, U.N-TITLE ON, TITLE ON, SUPER FG ON | Each toggles a downstream key, the MASTER layer named `DSK <label>` (`/dsk?label=…`, the panel's own route), with the label from the settings. A button whose layer MASTER does not have sends nothing. No lamp shows a key's state; only the panel does. |
| SCHED, PGM RESET, PIP T-BAR, PIP TRANS, AFV 1–4, PLUS, MINUS | Nothing. |

## What a press does, and does not

- **DOWN acts; UP never does.**
- **One press, at most one command.** A press while the last one is still being sent is dropped,
  not queued, so nothing can fire late. A failed command is logged and not retried.
- **For `--settle` seconds after connecting, presses are ignored** (and logged), so presses held while
  the Surface was away cannot act when it comes back. It reconnects by itself.
- **PREVIEW n is the panel's key n:** the first eight Layer Sets, in A's order, from takectl's `/state`.
- **AUTO and CUT go only when the panel's TAKE and CUT would be pressable:** takectl ready, Program known,
  no transition in progress or in flight on the switcher, no steps being pushed, no rehearsal. Otherwise
  the log says `not sent` and why. (`greyed()` mirrors the panel's lines; a test fails if they change.)
- **The graphics buttons go whenever the panel's downstream keys are pressable:** takectl ready and Program
  known. Mid-transition, in SAFE, while steps are pushed or hooks rehearsed, they toggle, as the panel's do.
  (`dsk_greyed()` mirrors the panel's lines; a test fails if they change.) A press while the last command is
  still being sent is dropped, as for every button: press a graphics button during a TAKE once the log says
  `sent /take`.
- **A graphics button toggles the key takectl lists,** matched without regard to case, as takectl matches it,
  and sent as takectl spells it. Each press reads `/state` again, so a layer added after start is found.
- **A TAKE that gets no answer is not called unsent:** the log says it was sent and had no answer, and it is
  not sent again. Look at the panel.
- **Refusals are takectl's:** during a transition, for instance, takectl refuses the recall and the
  log shows its reason.
- **No Hammerspoon for abswitch shows.** A keystroke into a mimoLive document is a change by hand:
  abswitch reports it as CHANGED IN MIMOLIVE on Program, or switches UNDO off in Preview.

## Tests

```bash
python3 test_wingman.py      # 92 offline tests, standard library only: no Bluetooth, no takectl
python3 offline_check.py     # the adapter against the real takectl on test/mock-mimolive.mjs: 16 steps
python3 falsify.py           # 67 mutants, each one mechanism broken: every one must fail a check
```

The tests read their authorities at run time: `captures.txt` (packets the real Surface sent),
`tally_captures.txt` (tally writes seen to light it), the button map in `wingman_monitor.py`, and the
panel's own lines in `operator.html`. The packet check byte (XOR of the first seven bytes) is held to the
captures, and a single flipped bit anywhere in a captured packet is dropped. Bluetooth is a fake that
records every write, so nothing here can reach the Surface. `offline_check.txt` and `falsify.txt` are the
last results.

**`offline_check.py` runs its own takectl on :18991 and its mock on :18989, never on :8991, and refuses to
run if anything already answers on either.** It used to share :8991: on 2026-11-13 it ran while the
bench's takectl was up, its own could not start, and its presses (three TAKEs, a CUT, RATE 2 s) went to
the bench.

## Hardware check (the real Surface, on the bench)

Run on the bench documents, never during a show. Each step says what you should see. Passed 14 of 14
on 2026-11-13 (`hardware-check.txt`: the adapter's log and takectl's own record, merged by time). Step 5
could not make the in-flight guard drop a press: the Surface sends presses one at a time, and each command
landed (15–20 ms) before the next arrived; the guard is covered by the tests and mutant M2.

1. **Connect.** `.venv/bin/python wingman_monitor.py`. Press PREVIEW 1: `BUTTON PREVIEW 1 DOWN`, then `UP`.
2. **Dry run.** takectl running; `wingman_abswitch.py --raw`. Press PREVIEW 1 to 6: each says
   `would send /pvw/layer-set?name=…` with the name on the panel's key 1 to 6. The panel does not change.
3. **Captures.** From step 2's log, add each PREVIEW button's DOWN and UP packets, and AUTO's and CUT's, to
   `captures.txt` as `button PREVIEW 1 down`, and so on. The tests then hold them too.
4. **Armed.** `--arm`. Press PREVIEW 2: Preview shows key 2's look, key 2 lights green, Program is unchanged.
5. **Fast presses.** Press PREVIEW 1 and 3 together, several times: a press may be dropped (the log says
   so), nothing arrives late, Preview ends on one of them.
6. **During a TAKE.** RATE 3 s, TAKE on the panel, then PREVIEW 1 at once: the log shows takectl refusing it.
7. **The rest.** PROGRAM 1, ON AIR, TITLE ON: logged only; nothing on air changes. (Since 2026-11-19 TITLE ON
   toggles a downstream key: see the DSK walk below.)
8. **Power.** Switch the Surface off: the log says it disconnected. Press buttons while it is off, switch it
   on: it reconnects, and nothing is sent until you press again.
9. **takectl away.** Stop takectl, press PREVIEW 1: `not reachable; nothing sent`. Start it again: the next
   press works, and nothing from before is sent.
10. **AUTO.** MIX, RATE 1.0 s. Press AUTO: Program and Preview swap with a 1 s dissolve, as the panel's TAKE.
11. **CUT.** Select STINGER on the panel. Press CUT: they swap at once, no wipe (CUT is always bare).
12. **AUTO with STINGER.** Still STINGER. Press AUTO: the stinger wipe, as the panel's TAKE.
13. **AUTO twice.** MIX, RATE 3.0 s. Press AUTO, then AUTO again during the dissolve: one TAKE, and the
    log says the second was not sent.
14. **Out of SAFE.** PANIC on the panel (hold). Press AUTO: it takes out of SAFE to the document in TAKE
    GOES TO, as the panel's TAKE does.

**Tally**, presses not armed (no `--arm`), passed 4 of 4 on 2026-11-14:

- T1. **Echo.** With the adapter stopped, `.venv/bin/python echo_check.py`, hands off: it writes one captured
  PREVIEW 3 write and listens on FFE1. PREVIEW 3 lights amber, and the verdict is `NO ECHO`. (A lit tally
  record is byte for byte its button's DOWN, so an echo would read as a press; there is none.)
- T2. **Connect.** `wingman_abswitch.py --tally --raw`: red on Program's key, amber on Preview's.
- T3. **Browser Preview.** Click Preview keys on the panel, one at a time: amber follows each within a
  quarter second, red stays.
- T4. **Stop.** Ctrl-C: both banks go dark.

**Tally with presses armed** (`--arm --tally`), passed 5 of 5 on 2026-11-14. All three shows running,
PH-MASTER's File Recording off, no streaming output; wait for each CUT or TAKE to land before the next press
(overlapping transitions are out of this test, as ruled).

- A1. **Start.** Red on Program's key, amber on Preview's.
- A2. **PREVIEW 2.** The panel's Preview key 2 lights; amber moves to PREVIEW 2; red stays.
- A3. **CUT.** Program and Preview swap at once; red and amber swap with them, PROGRAM first.
- A4. **AUTO.** MIX, RATE 1.0 s on the panel: AUTO dissolves for 1 s, as the panel's TAKE (takectl's `lastTake`
  says `dissolve 1060 ms`); red and amber swap.
- A5. **Stop.** Ctrl-C: both banks go dark.

With a show off, takectl refuses to switch to that document (`B document is not live (show not started)`),
from the Surface and from the browser alike, and the log shows its reason. That refusal stays (ruled
2026-11-14): nothing starts a show to satisfy a press. To keep recording off for a test, switch off only
PH-MASTER's File Recording output, not its show.

**Tally recovery** (`--arm --tally`), passed 9 of 9 on 2026-11-14, same conditions as the armed test:

- R1. **Start.** Red on Program's key, amber on Preview's.
- R2. **Surface off.** The log says it disconnected.
- R3. **A Preview change while it is off.** Pick another look on the panel's Preview bus.
- R4. **Surface on.** It reconnects and both banks are written: amber on the look picked in R3, not the old one.
- R5. **PREVIEW 2.** Amber moves to PREVIEW 2; red stays.
- R6. **takectl stopped.** The lamps stay as they are; the log says so once.
- R7. **A press while takectl is down.** `not reachable; nothing sent, not retried`.
- R8. **takectl started again.** The lamps go dark while takectl is not ready, then show the panel's state.
  The press from R7 is never sent.
- R9. **Stop.** Ctrl-C: both banks go dark.

**Fast presses** (`--arm --tally --raw`), passed 5 of 5 on 2026-11-14, same conditions, PREVIEW only (no TAKE or
CUT):

- F1. **Start.** Red on Program's key, amber on Preview's.
- F2. **Run the keys.** PREVIEW 1, 2, 3, 4, 3, 2, 1 as fast as you can, a few times: every press is sent once,
  none late, and amber ends on the panel's Preview key.
- F3. **Two at once.** PREVIEW 1 and 3 together, several times: nothing is sent late, and amber ends on the
  panel's Preview key. Pressed at the same instant, the two can arrive in one notification, which this run
  dropped whole; that led to the framing fix (Known limits) and the test below.
- F4. **One key hammered.** PREVIEW 2 ten times: amber stays on 2, written once.
- F5. **Stop.** Ctrl-C: both banks go dark.

**Two at once, after the framing fix** (`--arm --tally --raw`), passed 4 of 4 on 2026-11-14, same conditions:

- C1. **Start.** Red on Program's key, amber on Preview's.
- C2. **PREVIEW 2.** As F2.
- C3. **PREVIEW 1 and 3 together, ten times.** Each time the first to arrive acts and the second is dropped
  (`dropped, the last press has not finished`), or, if the second came after the first had landed, both are
  sent and the second wins. Amber ends on the panel's Preview key every time; nothing is dropped as malformed.
- C4. **Stop.** Ctrl-C: both banks go dark.

**Lamp walk** (`lamp_walk.py`, no takectl, no adapter), passed 15 of 15 on 2026-11-14. Through the adapter a
lamp lights only for a look on its key, and the bench's four looks can never light 5 or 6, so the walk writes
each bank itself (`tally_bank()` to FFE2, nothing else) and asks what you see. Stop the adapter first, then
run it from Terminal.app:

```bash
.venv/bin/python lamp_walk.py
```

- L1. **Both banks dark.**
- L2. **PROGRAM 1–6, one at a time.** Each is the only button lit, and red.
- L3. **PROGRAM dark.** All twelve dark.
- L4. **PREVIEW 1–6, one at a time.** Each is the only button lit, and amber.
- L5. **PREVIEW dark.** All twelve dark.

Answer y or n to each; q or Ctrl-C stops it, and both banks are darkened however it ends. Your answers, as
typed, and anything heard on FFE1 go to `lamp_walk.txt`. The adapter lighting key 5 or 6 from takectl's state
is covered by the tests, not by this walk.

**Downstream keys** (`--arm --tally --raw`), **not yet run.** All three shows running, PH-MASTER's File
Recording off, no streaming output, both of the bench's downstream keys off (Bug and Clock). The bench has two,
so the walk runs twice, with the two settings files here: the first puts LOGO ON on Bug and TITLE ON on Clock,
the second U.N-TITLE ON on Bug and SUPER FG ON on Clock. In each, the other two buttons keep defaults the bench
does not have. Stop any other adapter, then run it from Terminal.app:

```bash
.venv/bin/python wingman_abswitch.py --arm --tally --raw --config dsk_walk_1.json 2>&1 | tee -i dsk-walk.txt
```

- D1. **Start.** Before scanning, the log lists MASTER's downstream keys (Clock, Bug), `LOGO ON: DSK Bug`,
  `TITLE ON: DSK Clock`, and for U.N-TITLE ON and SUPER FG ON `no "DSK …" layer in MASTER; this button sends
  nothing`. Red and amber as usual.
- D2. **LOGO ON.** The logo appears on Program and the panel's Bug key lights; Program and Preview do not
  change. Again: the logo goes and the key goes dark.
- D3. **TITLE ON.** The clock appears and the panel's Clock key lights. Again: it goes.
- D4. **U.N-TITLE ON, then SUPER FG ON.** Each: the log says `no "DSK …" layer in MASTER`, `nothing sent`;
  nothing changes.
- D5. **Mid-transition.** MIX, RATE 5.0 s on the panel. Press AUTO; once the log says `sent /take`, during
  the dissolve, press LOGO ON: the logo appears while the dissolve runs, and the TAKE lands as usual. After
  it lands, LOGO ON again: the logo goes.
- D6. **In SAFE.** PANIC on the panel (hold). Press TITLE ON: the clock appears and Program stays on SAFE.
  Again: it goes. Then TAKE out of SAFE on the panel.
- D7. **The other two buttons.** Ctrl-C (both banks go dark). Run it again with `--config dsk_walk_2.json`
  (`tee -i -a dsk-walk.txt`): the start lines say `U.N-TITLE ON: DSK Bug`, `SUPER FG ON: DSK Clock`, and that
  LOGO ON and TITLE ON send nothing. U.N-TITLE ON twice: the logo on, then off. SUPER FG ON twice: the
  clock on, then off. LOGO ON and TITLE ON: `nothing sent`.
- D8. **Stop.** Ctrl-C: both banks go dark; both downstream keys are off, as at the start.

## Known limits

- PREVIEW, AUTO, CUT and the four graphics buttons so far; looks 7 and 8 have no button.
- No lamp but the two tally banks is written (ruled 2026-11-14), so the graphics buttons have no lamp: a
  key's state shows on the panel only, and a refused press is in the log only. Lighting them needs a capture
  of what the iPad app writes to light them.
- Two buttons pressed at the same instant can reach the Mac as one notification of two 8-byte records
  (captures.txt). Ruled 2026-11-14: each record is checked on its own and judged in the order it came, as if it
  had come alone, so the first press acts and the in-flight rule drops the second, as for two presses one after
  the other. No combination of buttons means anything. A notification that is not whole records, or that holds
  any record that fails (header, check byte, byte 6, an unknown type or button state), is dropped whole and
  nothing in it acts: so a tally write read back can never act as a press. Nothing is buffered across
  notifications; a record split across two has never been seen. One lit tally record read back on its own would
  still look exactly like its button's DOWN. None has been seen: nothing came back on FFE1 in the echo check
  (T1), nor during the lamp walk's 18 writes, which lit each of the twelve positions in turn.
- A dissolve started in mimoLive's own window is caught only if takectl's view of the switcher has seen it
  (it is refreshed every few seconds), as on the panel; takectl itself does not refuse a TAKE then. Ruled
  2026-11-14: HOLD. abswitch does not own every way into a transition, and no guard is added until mimoLive's
  API is shown to report a transition in progress reliably.
- Tally lights PROGRAM and PREVIEW 1–6 only: red and amber, by bank, as the Surface chooses. Three tally
  writes were captured from the iPad app (PROGRAM 2, PREVIEW 3 and 4); the rest are built from the same
  format. All twelve, and both dark banks, have been written to the Surface and seen as built (the lamp walk,
  2026-11-14). The adapter lighting 5 or 6 from a look on that key has not been seen on the Surface: the bench
  has four looks.
- Tally lags takectl by up to a quarter second (the poll), as the panel does.
- A takectl restart blinks both banks dark for about 0.3 s: takectl's first answer is "not ready", and the
  lamps show it, as the panel's buses do. Keeping the lamps covers takectl not answering, not takectl
  answering "not ready".
- **PROGRAM's red means the document assigned to Program, not that only its picture is on air.** On a TAKE
  the lamps move when takectl's state does, at the start of the dissolve, as the panel's buses do; during
  the dissolve both pictures are on screen. Ruled 2026-11-14: keep it, with no delay and no
  transition-completion state.
- The T-bar's range (0–119) was measured on one Surface.
- Tested on macOS only.

## Files

- `wingman_abswitch.py`: the adapter (Bluetooth in, takectl out)
- `wingman_protocol.py`: the packet decoder, standard library only
- `wingman_monitor.py`: Production Engineering's known-good monitor, unchanged
- `captures.txt`: packets captured from the real Surface, with what was pressed
- `tally_captures.txt`: tally writes captured from the iPad Wingman app and seen to light the Surface
- `test_wingman.py`, `offline_check.py`, `falsify.py`: the checks; `offline_check.txt`, `falsify.txt`: their last results
- `echo_check.py`: the echo check (one tally write, FFE1 listened to); `echo_check.txt`: its last result
- `lamp_walk.py`: every tally position lit on its own and asked about, FFE2 only, no takectl; `lamp_walk.txt`:
  its last result, with the answers as typed
- `hardware-check.txt`: the hardware checks on the real Surface, 2026-11-13 and 14
- `dsk_walk_1.json`, `dsk_walk_2.json`: the settings for the two halves of the downstream-key walk, on the
  bench's two keys
- `wingman.config.json`: your own settings, if you make one (gitignored)
- `requirements.txt`: Bleak, pinned
