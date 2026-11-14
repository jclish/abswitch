# Wingman Surface for abswitch (optional)

The BirdDog Wingman Surface (formerly Maki Studio Surface), connected to the Mac over Bluetooth,
as a hardware panel for abswitch. **abswitch stays the switcher: the Surface is an input device.**
A press calls the same takectl route the panel's key calls, so takectl's own checks apply and the
panel follows. Nothing is written to the Surface, and nothing reaches mimoLive except through takectl.

**Status: PREVIEW 1–6, AUTO and CUT.** PREVIEW recalls look keys 1–6 in Preview; AUTO is the panel's
TAKE, CUT its CUT. Every other control is shown in the log and does nothing yet. All three passed the
hardware check on the real Surface (2026-11-13, 14 of 14, `hardware-check.txt`).

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

Options: `--takectl http://127.0.0.1:8991` (takectl's address), `--raw` (every packet in hex),
`--settle 1.0` (seconds after connecting before presses count). Ctrl-C stops it.

`wingman_monitor.py` is the standalone diagnostic: it shows every control and sends nothing.

## What each control does

| Surface | abswitch |
|---|---|
| PREVIEW 1–6 | Look key 1–6, recalled in Preview (`/pvw/layer-set?name=…`, the panel's own route). An empty key sends nothing. |
| PROGRAM 1–6 | Nothing yet. abswitch's PGM row is lamps only: you compose in the green document. Once the Surface's lights are decoded, these become Program tally lamps. (Ruled 2026-11-13.) |
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
python3 test_wingman.py      # 24 offline tests, standard library only: no Bluetooth, no takectl
python3 offline_check.py     # the adapter against the real takectl on test/mock-mimolive.mjs: 9 steps
python3 falsify.py           # 16 mutants, each one mechanism broken: every one must fail a check
```

The tests read their authorities at run time: `captures.txt` (packets the real Surface sent) and the
button map in `wingman_monitor.py`. The packet check byte (XOR of the first seven bytes) is held to the
captures, and a single flipped bit anywhere in a captured packet is dropped. `offline_check.txt` and
`falsify.txt` are the last results.

**`offline_check.py` starts its own takectl on :8991 and refuses to run if anything already answers there
or on the mock's port.** It used not to: on 2026-11-13 it ran while the bench's takectl was up, its own
could not start, and its presses (three TAKEs, a CUT, RATE 2 s) went to the bench. Stop any takectl first.

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

## Known limits

- PREVIEW, AUTO and CUT so far; looks 7 and 8 have no button.
- A dissolve started in mimoLive's own window is caught only if takectl's view of the switcher has seen it
  (it is refreshed every few seconds), as on the panel; takectl itself does not refuse a TAKE then.
- No lights: tally and button lights need the commands sent *to* the Surface, which are not decoded.
  Nothing is ever written to it.
- The T-bar's range (0–119) was measured on one Surface.
- Tested on macOS only.

## Files

- `wingman_abswitch.py`: the adapter (Bluetooth in, takectl out)
- `wingman_protocol.py`: the packet decoder, standard library only
- `wingman_monitor.py`: Production Engineering's known-good monitor, unchanged
- `captures.txt`: packets captured from the real Surface, with what was pressed
- `test_wingman.py`, `offline_check.py`, `falsify.py`: the checks; `offline_check.txt`, `falsify.txt`: their last results
- `hardware-check.txt`: the hardware check on the real Surface, 2026-11-13
- `requirements.txt`: Bleak, pinned
