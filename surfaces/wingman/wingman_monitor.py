#!/usr/bin/env python3
"""Read-only BLE monitor for the BirdDog Wingman / Maki Studio Surface.

Requires: pip install bleak
Run: python wingman_monitor.py

Does not write to the Surface or send commands to mimoLive.
"""

import asyncio
from datetime import datetime

from bleak import BleakClient, BleakScanner

DEVICE_NAME = "BirdDogSwitcher"
NOTIFY_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
TBAR_MAX = 119  # Measured on this particular Wingman Surface

BUTTONS = {
    0x00: "ON AIR",
    0x01: "PROGRAM 1",
    0x02: "PROGRAM 2",
    0x03: "PROGRAM 3",
    0x04: "PROGRAM 4",
    0x05: "PROGRAM 5",
    0x06: "PROGRAM 6",
    0x0D: "PREVIEW 1",
    0x0E: "PREVIEW 2",
    0x0F: "PREVIEW 3",
    0x10: "PREVIEW 4",
    0x11: "PREVIEW 5",
    0x12: "PREVIEW 6",
    0x19: "LOGO ON",
    0x1A: "U.N-TITLE ON",
    0x1B: "TITLE ON",
    0x1C: "SUPER FG ON",
    0x1D: "SCHED",
    0x1E: "PGM RESET",
    0x1F: "PIP T-BAR",
    0x20: "PIP TRANS",
    0x21: "AUTO",
    0x22: "CUT",
    0x23: "AFV 1",
    0x24: "AFV 2",
    0x25: "AFV 3",
    0x26: "AFV 4",
    0x27: "MINUS",
    0x28: "PLUS",
}


def on_notification(_sender, data):
    packet = bytes(data)
    raw = packet.hex().upper()
    stamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]

    if len(packet) != 8 or packet[:3] != b"\xAA\x00\x07":
        print(f"{stamp} UNKNOWN PACKET {raw}", flush=True)
        return

    # The final byte matches an XOR of the first seven bytes in our captures.
    checksum = 0
    for byte in packet[:-1]:
        checksum ^= byte
    if checksum != packet[-1]:
        print(f"{stamp} CHECKSUM MISMATCH {raw} (expected {checksum:02X})", flush=True)
        return

    kind = packet[3]

    if kind == 0x4D:
        state = packet[4]
        button_id = packet[5]
        name = BUTTONS.get(button_id, f"UNKNOWN BUTTON 0x{button_id:02X}")
        action = {0: "DOWN", 1: "UP"}.get(state, f"STATE {state}")
        print(f"{stamp} BUTTON {name:<20} {action:<7} {raw}", flush=True)

    elif kind == 0x80:
        position = packet[5]
        percent = min(100.0, max(0.0, position / TBAR_MAX * 100))
        print(f"{stamp} T-BAR  {position:3d}/{TBAR_MAX}  {percent:5.1f}%  {raw}", flush=True)

    elif kind == 0x49:
        step_byte = packet[5]
        if step_byte == 0x01:
            direction = "+1"
        elif step_byte == 0xFF:
            direction = "-1"
        else:
            direction = f"UNKNOWN 0x{step_byte:02X}"
        # +/- identifies signed step, not yet which physical direction is clockwise.
        print(f"{stamp} WHEEL  {direction:<12} {raw}", flush=True)

    else:
        print(f"{stamp} OTHER  {raw}", flush=True)


async def main():
    print(f"Scanning for {DEVICE_NAME} (25 seconds)...", flush=True)
    device = await BleakScanner.find_device_by_filter(
        lambda d, a: d.name == DEVICE_NAME or a.local_name == DEVICE_NAME,
        timeout=25.0,
    )
    if device is None:
        print("BirdDogSwitcher not found.")
        print("Disconnect LightBlue, close Wingman on the iPad, power-cycle the Surface, and retry.")
        return

    print(f"Found {device.name or DEVICE_NAME}: {device.address}", flush=True)
    async with BleakClient(device) as client:
        print("Connected. Subscribing to FFE1...", flush=True)
        await client.start_notify(NOTIFY_UUID, on_notification)
        print("Ready: press buttons, turn wheel, or move T-bar. Ctrl+C to exit.\n", flush=True)
        try:
            while client.is_connected:
                await asyncio.sleep(0.5)
            print("Surface disconnected.", flush=True)
        finally:
            if client.is_connected:
                await client.stop_notify(NOTIFY_UUID)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
    except Exception as exc:
        print(f"\nBLE error: {type(exc).__name__}: {exc}")
