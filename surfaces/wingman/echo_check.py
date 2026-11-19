#!/usr/bin/env python3
"""The echo check: does a tally write come back from the Surface as a button event?

    .venv/bin/python echo_check.py      (from surfaces/wingman/, in Terminal.app; hands off the Surface)

A lit tally record is byte for byte its button's DOWN, so if the Surface ever sent a write back on
FFE1 the adapter could read it as a press. This finds out, with nothing that can switch: no takectl,
no commands, and the adapter not running (the Surface takes one connection at a time).

It connects, listens on FFE1 for QUIET_S with nothing written (a packet then means someone touched
the Surface, and the run is void), writes ONE captured tally payload to FFE2 (PREVIEW 3, from
tally_captures.txt, the write whose lit record is the captured PREVIEW 3 DOWN), listens LISTEN_S
more, and disconnects. Every notification is logged in hex with its time from the write.
Output: echo_check.txt.
"""

import asyncio
import os
import sys
import time
from datetime import datetime

from wingman_protocol import DEVICE_NAME, NOTIFY_UUID, TALLY_UUID, decode, describe, tally_bank

HERE = os.path.dirname(os.path.abspath(__file__))
QUIET_S, LISTEN_S = 3.0, 5.0
BANK, LIT = "PREVIEW", 3


def captured():
    with open(os.path.join(HERE, "tally_captures.txt"), encoding="utf-8") as f:
        for line in f:
            if line.strip() and not line.startswith("#"):
                bank, lit, *recs = line.split()
                if (bank, int(lit)) == (BANK, LIT):
                    return bytes.fromhex("".join(recs))
    raise SystemExit(f"tally_captures.txt has no {BANK} {LIT}; nothing written")


async def main() -> int:
    from bleak import BleakClient, BleakScanner  # here, so the file loads without Bleak

    payload = captured()
    if tally_bank(BANK, LIT) != payload:
        print(f"STOP: tally_bank() does not rebuild the captured {BANK} {LIT}; nothing written")
        return 2
    records = [payload[i:i + 8] for i in range(0, len(payload), 8)]
    out = [f"echo check, {datetime.now():%Y-%m-%d %H:%M:%S}: one captured {BANK} {LIT} write ({len(payload)} bytes) to FFE2"]

    def say(line):
        out.append(line)
        print(line, flush=True)

    print(f"Scanning for {DEVICE_NAME} (25 s). Stop the adapter first: one connection at a time.", flush=True)
    device = await BleakScanner.find_device_by_filter(lambda d, a: d.name == DEVICE_NAME or a.local_name == DEVICE_NAME, timeout=25.0)
    if device is None:
        print("Not found. Is the adapter (or Wingman on the iPad, or LightBlue) still connected? Nothing written.")
        return 2
    seen = []  # (seconds from the write, negative before it; bytes)
    t_write = None

    def heard(_s, data):
        t = time.monotonic()
        seen.append((t - t_write if t_write is not None else None, t, bytes(data)))

    async with BleakClient(device) as client:
        notify = client.services.get_characteristic(NOTIFY_UUID)
        tally = client.services.get_characteristic(TALLY_UUID)
        if notify is None or "notify" not in notify.properties or tally is None or "write" not in tally.properties:
            print("STOP: FFE1 (notify) or FFE2 (write with response) is not there. Nothing written.")
            return 2
        await client.start_notify(NOTIFY_UUID, heard)
        say("connected; listening on FFE1.")
        answer = await asyncio.to_thread(input, f"Hands off the Surface. Type ECHO and Return to write one {BANK} {LIT} packet: ")
        if answer.strip() != "ECHO":
            print("Cancelled. Nothing written.")
            return 2
        seen.clear()  # what came while the question was up does not count
        say(f"{QUIET_S:g} s of quiet, one write, {LISTEN_S:g} s more.")
        await asyncio.sleep(QUIET_S)
        t_write = time.monotonic()
        before = [(t - t_write, d) for _, t, d in seen]
        seen.clear()
        await client.write_gatt_char(TALLY_UUID, payload, response=True)
        say(f"wrote {BANK} {LIT}: the write was answered in {(time.monotonic() - t_write) * 1000:.0f} ms. Look: PREVIEW 3 should be amber.")
        await asyncio.sleep(LISTEN_S)
        await client.stop_notify(NOTIFY_UUID)
        after = [(dt, d) for dt, _, d in seen]

    say(f"before the write ({QUIET_S:g} s): {len(before)} packet(s)")
    for dt, d in before:
        say(f"  {dt * 1000:+8.0f} ms  {d.hex().upper()}  {describe(decode(d))}")
    say(f"after the write ({LISTEN_S:g} s): {len(after)} packet(s)")
    for dt, d in after:
        match = "the whole write" if d == payload else f"record {records.index(d) + 1} of the write" if d in records else "not part of the write"
        say(f"  {dt * 1000:+8.0f} ms  {d.hex().upper()}  {describe(decode(d))}  ({match})")
    if before:
        verdict = "VOID: the Surface sent packets before anything was written (touched?). Run it again, hands off."
    elif not after:
        verdict = f"NO ECHO: nothing came back in {LISTEN_S:g} s after the write."
    else:
        echoed = [d for _, d in after if d == payload or d in records]
        verdict = (f"ECHO: {len(echoed)} of {len(after)} packet(s) after the write are part of it." if echoed
                   else f"NOT AN ECHO, BUT NOT QUIET: {len(after)} packet(s) after the write, none part of it.")
    say(verdict)
    with open(os.path.join(HERE, "echo_check.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    return 0 if verdict.startswith("NO ECHO") else 1


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\nStopped.")
