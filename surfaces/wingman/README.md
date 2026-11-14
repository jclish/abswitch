# Wingman Surface for abswitch (optional)

The BirdDog Wingman Surface (formerly Maki Studio Surface), connected to the Mac over Bluetooth,
as a hardware panel for abswitch. **abswitch stays the switcher: the Surface is an input device and a
display.** A press calls the same takectl route the panel's key calls, so takectl's own checks apply and
the panel follows. With `--tally`, the PROGRAM and PREVIEW buttons light as the panel's buses do, read
from takectl's `/state`. The only thing ever written to the Surface is those two tally banks (ruled
2026-11-14), and nothing reaches mimoLive except through takectl.

**Status: PREVIEW 1–6, AUTO and CUT, and tally.** PREVIEW recalls look keys 1–6 in Preview; AUTO is the
panel's TAKE, CUT its CUT. Every other control is shown in the log and does nothing yet. The three
controls passed the hardware check on the real Surface (2026-11-13, 14 of 14). Tally passed 4 of 4 with
presses not armed and then the first limited armed test, 5 of 5, PREVIEW, CUT and AUTO from the Surface
(2026-11-14, `hardware-check.txt`). Power cycles, a takectl restart, rapid presses and all six positions
are not checked with tally yet.

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
presses count). Ctrl-C stops it, and with `--tally` darkens both banks first. To keep a log, pipe it
through `tee -i` (plain `tee` dies with the Ctrl-C and loses the last lines).

**Tally:** PROGRAM n is red when key n's look is on air, PREVIEW n amber when it is in Preview, exactly
as the panel's buses light them; none when the look is not one of keys 1–6, and no PROGRAM button in
SAFE. The adapter reads `/state` every 250 ms, as the panel does, and writes a bank only when its lamp
changes, PROGRAM first. Lamps follow takectl's state, never a press. After (re)connecting it writes both
banks. If takectl stops answering, the lamps keep their last state (as the panel does) and the log says
so; when takectl is up but not ready, both go dark, as the panel's do. A failed write is written again
on the next poll. The tally only ever reads `/state`, so it can never send a command.

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
| ON AIR | Nothing, on purpose: PANIC has no key on the panel either. |
| LOGO, U.N-TITLE, TITLE, SUPER FG ON | Nothing yet. Later: each set to a downstream key's label (`/dsk?label=…`), in this folder's own settings. |
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
- **A TAKE that gets no answer is not called unsent:** the log says it was sent and had no answer, and it is
  not sent again. Look at the panel.
- **Refusals are takectl's:** during a transition, for instance, takectl refuses the recall and the
  log shows its reason.
- **No Hammerspoon for abswitch shows.** A keystroke into a mimoLive document is a change by hand:
  abswitch reports it as CHANGED IN MIMOLIVE on Program, or switches UNDO off in Preview.

## Tests

```bash
python3 test_wingman.py      # 48 offline tests, standard library only: no Bluetooth, no takectl
python3 offline_check.py     # the adapter against the real takectl on test/mock-mimolive.mjs: 10 steps
python3 falsify.py           # 36 mutants, each one mechanism broken: every one must fail a check
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
7. **The rest.** PROGRAM 1, ON AIR, TITLE ON: logged only; nothing on air changes.
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
from the Surface and from the browser alike, and the log shows its reason.

Not checked on the Surface yet: power off and on, takectl stopped and started, rapid presses, and all six
positions of each bank.

## Known limits

- PREVIEW, AUTO and CUT so far; looks 7 and 8 have no button.
- A dissolve started in mimoLive's own window is caught only if takectl's view of the switcher has seen it
  (it is refreshed every few seconds), as on the panel; takectl itself does not refuse a TAKE then. Ruled
  2026-11-14: HOLD. abswitch does not own every way into a transition, and no guard is added until mimoLive's
  API is shown to report a transition in progress reliably.
- Tally lights PROGRAM and PREVIEW 1–6 only: red and amber, by bank, as the Surface chooses. Three tally
  writes were captured from the iPad app (PROGRAM 2, PREVIEW 3 and 4); the rest are built from the same
  format. Of those, PROGRAM 1, PREVIEW 1, 2 and both dark banks have been written to the Surface (T2–T4,
  A1–A5); buttons 5 and 6 of either bank, and PROGRAM 3 and 4, have not.
- Tally lags takectl by up to a quarter second (the poll), as the panel does.
- On a TAKE, the lamps move when takectl's state does, at the start of the dissolve, not at its end, as the
  panel's buses do.
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
- `hardware-check.txt`: the hardware check on the real Surface, 2026-11-13
- `requirements.txt`: Bleak, pinned
