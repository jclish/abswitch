#!/usr/bin/env python3
"""Wingman Surface -> abswitch: PREVIEW 1-6 recall look keys 1-6 in Preview; AUTO is TAKE, CUT is CUT.

    .venv/bin/python wingman_abswitch.py            dry run: prints what each press would send
    .venv/bin/python wingman_abswitch.py --arm      sends it to takectl
    options: --takectl http://127.0.0.1:8991   --raw (every packet in hex)   --settle 1.0

abswitch is the switcher; the Surface is an input device. A press calls the same takectl route the
panel's key calls (/pvw/layer-set?name=..., /take, /cut), so takectl's own checks apply and the panel
follows. Nothing is written to the Surface, nothing goes to mimoLive except through takectl, and there
is no state here beyond "a command is in flight".

What a press does, and does not:
- DOWN acts, UP never does.
- One press, at most one command. A press while a command is in flight is dropped, not queued,
  so nothing can fire late. A failed command is logged and not retried.
- For --settle seconds after (re)connecting, presses are logged and ignored: a Surface that
  delivers presses held while it was away cannot act on them.
- PREVIEW n names key n the way the panel does (/state's layerSetsAll, A's order). An empty key
  sends nothing.
- AUTO and CUT are sent only when the panel's own TAKE and CUT would be pressable (see greyed()).
  AUTO is TAKE: the panel's MIX or STINGER, at its RATE. CUT is always a bare cut.
- Every other control is logged only: PROGRAM and the T-bar as ruled 2026-11-13, ON AIR because
  PANIC has no key on the panel either.
"""

import argparse
import asyncio
import json
import time
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import urlopen

from wingman_protocol import DEVICE_NAME, NOTIFY_UUID, Bad, Button, decode, describe

ACTIONS = {**{f"PREVIEW {n}": ("preview", n) for n in range(1, 7)}, "AUTO": ("take", None), "CUT": ("cut", None)}
READ_TIMEOUT_S = 2.0  # /state
COMMAND_TIMEOUT_S = 10.0  # a TAKE answers once its signal is sent, after any pre-hooks and stinger cover


def stamp() -> str:
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]


def say(line: str) -> None:
    print(f"{stamp()} {line}", flush=True)


class Takectl:
    """takectl's HTTP API: GET a route, get its JSON back."""

    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def get(self, path: str, timeout: float = READ_TIMEOUT_S) -> dict:
        try:
            with urlopen(self.base + path, timeout=timeout) as r:
                return json.loads(r.read() or b"{}")
        except HTTPError as e:  # takectl answers refusals with JSON too
            try:
                return json.loads(e.read() or b"{}")
            except ValueError:
                return {"ok": False, "error": f"HTTP {e.code}"}


# The panel's lines that grey TAKE and CUT, as greyed() mirrors them. test_wingman.py reads operator.html
# and fails if any of them changes, so a change there is never missed here.
PANEL_GREYING = (
    "const ready = !!(s && s.pgm) && !offline;",
    "const inFlight = !!(s && s.switcher && s.switcher.inFlight);",
    "const busy = !!(s && (s.busy || inFlight));",
    "const rehearsing = !!(s && s.rehearsal);",
    "const running = !!(s && s.steps && s.steps.running);",
    '$("take").disabled = $("cut").disabled = !ready || busy || pending || running || rehearsing;',
)


def greyed(s: dict) -> str | None:
    """Why the panel's TAKE and CUT would be greyed now (operator.html: ready, busy, the switcher in
    flight, steps running, a rehearsal), or None. takectl refuses most of these itself; not a
    transition started outside it, which only the panel's greying guards."""
    if s.get("ready") is False:
        return f"takectl is not ready ({s.get('mode') or 'starting'})"
    if not s.get("pgm"):
        return "Program is not known yet"
    if s.get("busy"):
        return "a transition is in progress"
    if (s.get("switcher") or {}).get("inFlight"):
        return "the switcher is mid-transition"
    if (s.get("steps") or {}).get("running"):
        return "steps are being pushed"
    if s.get("rehearsal"):
        return "hooks are being rehearsed"
    return None


class Surface:
    """Decoded Surface events in, takectl commands out: at most one per press."""

    def __init__(self, takectl, armed: bool, settle_s: float = 1.0, raw: bool = False, log=say, clock=time.monotonic):
        self.takectl, self.armed, self.settle_s, self.raw, self.log, self.clock = takectl, armed, settle_s, raw, log, clock
        self.ready_at = None  # None: not connected, nothing acts
        self.busy = False
        self.tasks = set()

    def connected(self) -> None:
        self.ready_at = self.clock() + self.settle_s

    def disconnected(self) -> None:
        self.ready_at = None

    def handle(self, data: bytes):
        """Log one packet; return the command to run (an awaitable), or None."""
        event = decode(data)
        line = describe(event) + (f"  [{bytes(data).hex().upper()}]" if self.raw or isinstance(event, Bad) else "")
        if not (isinstance(event, Button) and event.down is True and event.name in ACTIONS):
            self.log(line)
            return None
        if self.ready_at is None or self.clock() < self.ready_at:
            self.log(f"{line}: ignored, the Surface has only just connected")
            return None
        if self.busy:
            self.log(f"{line}: dropped, the last press has not finished")
            return None
        self.log(line)
        self.busy = True
        return self._run(*ACTIONS[event.name])

    def feed(self, data: bytes) -> None:
        """For the Bluetooth callback: handle a packet and run its command, if any."""
        command = self.handle(data)
        if command is not None:
            task = asyncio.ensure_future(command)
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)

    async def _run(self, kind: str, n: int | None) -> None:
        what = f"key {n}" if kind == "preview" else kind.upper()
        try:
            state = await asyncio.to_thread(self.takectl.get, "/state")
            if kind == "preview":
                if state.get("ready") is False:
                    self.log(f"  {what}: takectl is not ready ({state.get('mode') or 'starting'}); nothing sent")
                    return
                looks = state.get("layerSetsAll") or []
                if n > len(looks):
                    self.log(f"  {what} is empty; nothing sent")
                    return
                name = looks[n - 1]["name"]
                route, note = "/pvw/layer-set?name=" + quote(name, safe=""), f"{what}, \"{name}\""
            else:
                why = greyed(state)
                if why:
                    self.log(f"  {what}: not sent, {why} (the panel's {what} is greyed too)")
                    return
                route, note = f"/{kind}", what
            if not self.armed:
                self.log(f"  would send {route}  ({note}; dry run)")
                return
            await self._send(route, what)
        except (URLError, TimeoutError, OSError, ValueError) as e:
            self.log(f"  {what}: takectl not reachable ({e}); nothing sent, not retried")
        except (KeyError, TypeError, AttributeError) as e:
            self.log(f"  {what}: takectl's answer was not what the panel reads ({type(e).__name__}); nothing sent")
        except Exception as e:  # anything else: say so; a press never takes the adapter down
            self.log(f"  {what}: {type(e).__name__}: {e}; nothing more sent")
        finally:
            self.busy = False

    async def _send(self, route: str, what: str) -> None:
        try:
            r = await asyncio.to_thread(self.takectl.get, route, COMMAND_TIMEOUT_S)
        except TimeoutError:  # sent, and takectl did not answer: it may still act, so this must not say "nothing sent"
            self.log(f"  sent {route}: no answer within {COMMAND_TIMEOUT_S:g} s; not retried. Look at the panel.")
            return
        if not r.get("ok"):
            self.log(f"  sent {route}: takectl refused: {r.get('error', 'no reason given')}")
        elif route.startswith("/pvw/"):
            self.log(f"  sent {route}: \"{r.get('layerSet', '?')}\" in Preview ({r.get('pvw', '?')})")
        else:
            ms = f" {r['ms']} ms" if r.get("ms") else ""
            self.log(f"  sent {route}: {what} to {r.get('pgm', '?')} ({r.get('transition', '?')}{ms}); Preview is now {r.get('pvw', '?')}")


async def run(args) -> None:
    # Imported here, so the tests and a machine without Bleak can still load this file.
    from bleak import BleakClient, BleakScanner

    surface = Surface(Takectl(args.takectl), armed=args.arm, settle_s=args.settle, raw=args.raw)
    say(f"Mode: {'ARMED: presses go to ' + args.takectl if args.arm else 'DRY RUN: nothing is sent (add --arm)'}")
    while True:
        say(f"Scanning for {DEVICE_NAME} (25 s)...")
        device = await BleakScanner.find_device_by_filter(
            lambda d, a: d.name == DEVICE_NAME or a.local_name == DEVICE_NAME, timeout=25.0
        )
        if device is None:
            say("Not found. Close Wingman on the iPad and LightBlue (one connection at a time), power-cycle the Surface.")
            await asyncio.sleep(5)
            continue
        gone = asyncio.Event()
        try:
            async with BleakClient(device, disconnected_callback=lambda _c: gone.set()) as client:
                await client.start_notify(NOTIFY_UUID, lambda _s, data: surface.feed(data))
                surface.connected()
                say(f"Connected to {device.name or DEVICE_NAME}; presses count in {args.settle:g} s. Ctrl-C to stop.")
                await gone.wait()
                say("The Surface disconnected.")
        except Exception as e:  # a failed connect is reported and retried; it never fires anything
            say(f"Bluetooth: {type(e).__name__}: {e}")
        finally:
            surface.disconnected()
        await asyncio.sleep(2)


def main() -> None:
    p = argparse.ArgumentParser(description="Wingman Surface -> abswitch (PREVIEW 1-6, AUTO, CUT). Dry run unless --arm.")
    p.add_argument("--arm", action="store_true", help="send commands to takectl (default: print them only)")
    p.add_argument("--takectl", default="http://127.0.0.1:8991", help="takectl's address")
    p.add_argument("--settle", type=float, default=1.0, help="seconds after connecting before presses count")
    p.add_argument("--raw", action="store_true", help="log every packet in hex")
    args = p.parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
