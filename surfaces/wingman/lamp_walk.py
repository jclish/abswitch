#!/usr/bin/env python3
"""The lamp walk: every tally position on the real Surface, checked by eye, with no takectl.

    .venv/bin/python lamp_walk.py      (from surfaces/wingman/, in Terminal.app; the adapter stopped)

The adapter lights only what takectl's looks say, and a bench with four looks can never light buttons
5 and 6 through it. This lights each position directly. It writes tally_bank()'s bytes to FFE2, the one
write ruled allowed (2026-11-14), and nothing else, anywhere: no takectl, no commands. After each
step it asks what you see, and your answer is what is recorded.

Order: both banks dark; PROGRAM 1-6, one at a time; PROGRAM dark; PREVIEW 1-6; PREVIEW dark. FFE1 is
listened to throughout, and every packet is logged (a press, or a write read back). Ctrl-C, or q at
a question, darkens both banks and stops. Output: lamp_walk.txt.
"""

import asyncio
import os
import sys
import threading
import time
from datetime import datetime

from wingman_protocol import DEVICE_NAME, NOTIFY_UUID, TALLY_BUTTONS, TALLY_UUID, decode_notification, describe, tally_bank

HERE = os.path.dirname(os.path.abspath(__file__))
WRITE_TIMEOUT_S = 2.0
COLOUR = {"PROGRAM": "red", "PREVIEW": "amber"}
ALL_DARK = "Are all twelve PROGRAM and PREVIEW buttons dark"


def steps():
    """The walk, in order: (the banks to write, as (bank, lit button or None), the question then asked)."""
    walk = [([("PROGRAM", None), ("PREVIEW", None)], ALL_DARK)]
    for bank in ("PROGRAM", "PREVIEW"):
        for n in range(1, TALLY_BUTTONS + 1):
            walk.append(([(bank, n)], f"Is {bank} {n} the only button lit, and is it {COLOUR[bank]}"))
        walk.append(([(bank, None)], ALL_DARK))
    return walk


def writer(client):
    """The one write there is: a whole bank, to FFE2, with a response."""
    return lambda data: client.write_gatt_char(TALLY_UUID, data, response=True)


async def write_bank(write, bank, lit, say):
    t = time.monotonic()
    await asyncio.wait_for(write(tally_bank(bank, lit)), WRITE_TIMEOUT_S)
    say(f"wrote {bank} {lit or 'dark'} ({(time.monotonic() - t) * 1000:.0f} ms)")


async def walk(write, ask, say):
    """Each step's writes, then its question. Returns (question, answer) for each step answered;
    q stops the walk. However it ends (q, Ctrl-C, a write that fails), both banks are darkened."""
    answers = []
    try:
        for writes, question in steps():
            for bank, lit in writes:
                await write_bank(write, bank, lit, say)
            answer = (await ask(f"{question}? [y/n, q to stop] ")).strip().lower()
            answers.append((question, answer))
            say(f"  {question}? {answer or '(nothing typed)'}")
            if answer == "q":
                break
    finally:
        for bank in ("PROGRAM", "PREVIEW"):
            try:
                await write_bank(write, bank, None, say)
            except Exception as e:  # darkening is best effort: say so, and try the other bank
                say(f"  {bank} not darkened: {type(e).__name__}: {e}")
    return answers


def passed(answers) -> bool:
    """Every step answered, and every answer y."""
    return len(answers) == len(steps()) and all(answer == "y" for _, answer in answers)


def ask_in_terminal(question):
    """input() on a daemon thread: a question still waiting never keeps Ctrl-C from ending the walk."""
    loop = asyncio.get_running_loop()
    answer = loop.create_future()

    def read():
        try:
            typed = input(question)
        except EOFError:
            typed = "q"
        try:
            loop.call_soon_threadsafe(lambda: answer.done() or answer.set_result(typed))
        except RuntimeError:  # the walk already ended
            pass

    threading.Thread(target=read, daemon=True).start()
    return answer


async def main() -> int:
    from bleak import BleakClient, BleakScanner  # here, so the file loads without Bleak

    out = [f"lamp walk, {datetime.now():%Y-%m-%d %H:%M:%S}: tally_bank() writes to FFE2 only, no takectl"]

    def say(line):
        out.append(line)
        print(line, flush=True)

    print(f"Scanning for {DEVICE_NAME} (25 s). Stop the adapter first: one connection at a time.", flush=True)
    device = await BleakScanner.find_device_by_filter(lambda d, a: d.name == DEVICE_NAME or a.local_name == DEVICE_NAME, timeout=25.0)
    if device is None:
        print("Not found. Is the adapter (or Wingman on the iPad, or LightBlue) still connected? Nothing written.")
        return 2
    heard, answers = [], []

    def notified(_s, data):
        heard.append(bytes(data))
        say(f"  heard on FFE1: {bytes(data).hex().upper()}  " + "; ".join(describe(e) for _, e in decode_notification(data)))

    try:
        async with BleakClient(device) as client:
            notify = client.services.get_characteristic(NOTIFY_UUID)
            tally = client.services.get_characteristic(TALLY_UUID)
            if notify is None or "notify" not in notify.properties or tally is None or "write" not in tally.properties:
                print("STOP: FFE1 (notify) or FFE2 (write with response) is not there. Nothing written.")
                return 2
            await client.start_notify(NOTIFY_UUID, notified)
            say("connected; listening on FFE1. Hands off the buttons; answer each question by looking.")
            answers = await walk(writer(client), ask_in_terminal, say)
    finally:  # written however the walk ends, so a stopped walk still leaves its record
        say(f"heard on FFE1 during the walk: {len(heard)} notification(s)")
        say("PASS: every position as asked" if passed(answers) else
            f"NOT PASSED: {sum(a == 'y' for _, a in answers)} of {len(steps())} steps answered y")
        with open(os.path.join(HERE, "lamp_walk.txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(out) + "\n")
    return 0 if passed(answers) and not heard else 1


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\nStopped (both banks darkened, if the Surface was still connected).")
