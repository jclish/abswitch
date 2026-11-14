"""The Wingman Surface's BLE notifications, decoded. Standard library only, no Bluetooth here.

Every notification is eight bytes:  AA 00 07 TYPE STATE VALUE 00 CHECK
  TYPE 0x4D  a button: STATE 0x00 = DOWN, 0x01 = UP; VALUE = the button's id
  TYPE 0x80  the T-bar: VALUE = position, 0 (bottom) to 119 (top) on the Surface it was measured on
  TYPE 0x49  the wheel: VALUE = a signed step, 0x01 = +1, 0xFF = -1
CHECK is the XOR of the first seven bytes: it holds for every packet captured so far
(captures.txt), and a packet whose CHECK does not match is dropped, never guessed at.

The button ids are the ones Production Engineering mapped on the real Surface (2026-11-13) and
kept in wingman_monitor.py, the known-good monitor; test_wingman.py checks the two never drift.
"""

from dataclasses import dataclass

DEVICE_NAME = "BirdDogSwitcher"
SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"  # read only: nothing is ever written to the Surface
HEADER = b"\xAA\x00\x07"
TBAR_MAX = 119  # measured on one Surface; others may differ

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


@dataclass(frozen=True)
class Button:
    id: int
    name: str | None  # None: an id nobody has mapped
    down: bool | None  # True DOWN, False UP, None an unknown state byte


@dataclass(frozen=True)
class TBar:
    raw: int

    @property
    def percent(self) -> float:
        return min(100.0, max(0.0, self.raw / TBAR_MAX * 100.0))


@dataclass(frozen=True)
class Wheel:
    delta: int | None  # +1 or -1; None for a step byte never seen


@dataclass(frozen=True)
class Other:
    kind: int  # a well-formed packet of a type nobody has decoded


@dataclass(frozen=True)
class Bad:
    why: str  # dropped: wrong length, wrong header or wrong check byte


def check_byte(first_seven: bytes) -> int:
    x = 0
    for b in first_seven:
        x ^= b
    return x


def decode(packet: bytes):
    packet = bytes(packet)
    if len(packet) != 8:
        return Bad(f"{len(packet)} bytes, not 8")
    if packet[:3] != HEADER:
        return Bad("header is not AA 00 07")
    if check_byte(packet[:7]) != packet[7]:
        return Bad(f"check byte {packet[7]:02X}, expected {check_byte(packet[:7]):02X}")
    kind, state, value = packet[3], packet[4], packet[5]
    if kind == 0x4D:
        return Button(value, BUTTONS.get(value), {0x00: True, 0x01: False}.get(state))
    if kind == 0x80:
        return TBar(value)
    if kind == 0x49:
        return Wheel({0x01: +1, 0xFF: -1}.get(value))
    return Other(kind)


def describe(event) -> str:
    if isinstance(event, Button):
        name = event.name or f"UNKNOWN 0x{event.id:02X}"
        return f"BUTTON {name} {'DOWN' if event.down else 'UP' if event.down is False else 'STATE?'}"
    if isinstance(event, TBar):
        return f"TBAR POSITION {event.raw} ({event.percent:.1f}%)"
    if isinstance(event, Wheel):
        return f"WHEEL DELTA {event.delta:+d}" if event.delta is not None else "WHEEL DELTA ?"
    if isinstance(event, Other):
        return f"OTHER TYPE 0x{event.kind:02X}"
    return f"DROPPED ({event.why})"
