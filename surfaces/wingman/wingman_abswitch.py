#!/usr/bin/env python3
"""Wingman Surface -> abswitch: the Surface's PREVIEW 1-6 recall look keys 1-6 in Preview.

    .venv/bin/python wingman_abswitch.py            dry run: prints what each press would send
    .venv/bin/python wingman_abswitch.py --arm      sends it to takectl
    options: --takectl http://127.0.0.1:8991   --raw (every packet in hex)   --settle 1.0

abswitch is the switcher; the Surface is an input device. A press calls the same takectl route the
panel's key calls (/pvw/layer-set?name=...), so takectl's own checks apply and the panel follows.
Nothing is written to the Surface, nothing goes to mimoLive except through takectl, and there is
no state here beyond "a command is in flight".

What a press does, and does not:
- DOWN acts, UP never does.
- One press, at most one command. A press while a command is in flight is dropped, not queued,
  so nothing can fire late. A failed command is logged and not retried.
- For --settle seconds after (re)connecting, presses are logged and ignored: a Surface that
  delivers presses held while it was away cannot act on them.
- PREVIEW n names key n the way the panel does (/state's layerSetsAll, A's order). An empty key
  sends nothing. Every other control is logged only (PROGRAM, AUTO and CUT come later; T-bar and
  wheel are shown, never acted on).
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

PREVIEW_KEYS = {f"PREVIEW {n}": n for n in range(1, 7)}


def stamp() -> str:
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]


def say(line: str) -> None:
    print(f"{stamp()} {line}", flush=True)


class Takectl:
    """takectl's HTTP API: GET a route, get its JSON back."""

    def __init__(self, base: str, timeout: float = 2.0):
        self.base = base.rstrip("/")
        self.timeout = timeout

    def get(self, path: str) -> dict:
        try:
            with urlopen(self.base + path, timeout=self.timeout) as r:
                return json.loads(r.read() or b"{}")
        except HTTPError as e:  # takectl answers refusals with JSON too
            try:
                return json.loads(e.read() or b"{}")
            except ValueError:
                return {"ok": False, "error": f"HTTP {e.code}"}


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
        if not (isinstance(event, Button) and event.down is True and event.name in PREVIEW_KEYS):
            self.log(line)
            return None
        if self.ready_at is None or self.clock() < self.ready_at:
            self.log(f"{line}: ignored, the Surface has only just connected")
            return None
        if self.busy:
            self.log(f"{line}: dropped, the last press is still being sent")
            return None
        self.log(line)
        self.busy = True
        return self._preview(PREVIEW_KEYS[event.name])

    def feed(self, data: bytes) -> None:
        """For the Bluetooth callback: handle a packet and run its command, if any."""
        command = self.handle(data)
        if command is not None:
            task = asyncio.ensure_future(command)
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)

    async def _preview(self, n: int) -> None:
        try:
            state = await asyncio.to_thread(self.takectl.get, "/state")
            if state.get("ready") is False:
                self.log(f"  key {n}: takectl is not ready ({state.get('mode') or 'starting'}); nothing sent")
                return
            looks = state.get("layerSetsAll") or []
            if n > len(looks):
                self.log(f"  key {n} is empty; nothing sent")
                return
            name = looks[n - 1]["name"]
            route = "/pvw/layer-set?name=" + quote(name, safe="")
            if not self.armed:
                self.log(f"  would send {route}  (key {n}, \"{name}\"; dry run)")
                return
            r = await asyncio.to_thread(self.takectl.get, route)
            if r.get("ok"):
                self.log(f"  sent {route}: \"{name}\" in Preview ({r.get('pvw', '?')})")
            else:
                self.log(f"  sent {route}: takectl refused: {r.get('error', 'no reason given')}")
        except (URLError, TimeoutError, OSError, ValueError) as e:
            self.log(f"  key {n}: takectl not reachable ({e}); nothing sent, not retried")
        except (KeyError, TypeError, AttributeError) as e:
            self.log(f"  key {n}: takectl's answer was not what the panel reads ({type(e).__name__}); nothing sent")
        except Exception as e:  # anything else: say so; a press never takes the adapter down
            self.log(f"  key {n}: {type(e).__name__}: {e}; nothing more sent")
        finally:
            self.busy = False


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
    p = argparse.ArgumentParser(description="Wingman Surface -> abswitch (PREVIEW 1-6). Dry run unless --arm.")
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
