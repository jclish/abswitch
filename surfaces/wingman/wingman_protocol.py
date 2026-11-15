"""The Wingman Surface's BLE notifications, decoded. Standard library only, no Bluetooth here.

Every record is eight bytes:  AA 00 07 TYPE STATE VALUE 00 CHECK
  TYPE 0x4D  a button: STATE 0x00 = DOWN, 0x01 = UP; VALUE = the button's id
  TYPE 0x80  the T-bar: VALUE = position, 0 (bottom) to 119 (top) on the Surface it was measured on
  TYPE 0x49  the wheel: VALUE = a signed step, 0x01 = +1, 0xFF = -1
CHECK is the XOR of the first seven bytes: it holds for every packet captured so far
(captures.txt), and a packet whose CHECK does not match is dropped, never guessed at. Byte 6 is
00 in every capture; a packet where it is not is dropped too.

A notification is one or more whole records (decode_notification): two buttons pressed at the
same instant arrived as one 16-byte notification on the real Surface (2026-11-14). Each record is
checked on its own, and a notification is trusted only if every record in it passes; otherwise
none of it is, since what it holds is then unknown. A record split across two notifications has
never been seen, so nothing is buffered between them.

The button ids are the ones Production Engineering mapped on the real Surface (2026-11-13) and
kept in wingman_monitor.py, the known-good monitor; test_wingman.py checks the two never drift.

The tally lamps, the other way (tally_bank): one write sets a whole bank, twelve 8-byte records
AA 00 07 4D 00 ID STATE CHECK, STATE 00 lit and 01 off, exactly as the iPad Wingman app writes
them (tally_captures.txt). A lit record is byte for byte the same as its button's DOWN, and an
off record differs from one only in byte 6: that is why byte 6 is checked on the way in, and why
a notification with any bad record is not trusted at all (a whole bank written back would hold
one lit record, a DOWN to look at, among eleven off ones).
"""

from dataclasses import dataclass

DEVICE_NAME = "BirdDogSwitcher"
SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"  # the controls: read only
TALLY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"  # the lamps: tally_bank()'s bytes only, write with response
HEADER = b"\xAA\x00\x07"
RECORD_BYTES = 8
TBAR_MAX = 119  # measured on one Surface; others may differ

TALLY_FIRST_ID = {"PROGRAM": 0x01, "PREVIEW": 0x0D}  # a bank's write covers 12 ids from here
TALLY_RECORDS = 12  # as captured; this Surface has buttons for the first six of each bank
TALLY_BUTTONS = 6

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
    if packet[6] != 0x00:
        return Bad(f"byte 6 is {packet[6]:02X}, not 00 (a tally record read back?)")
    kind, state, value = packet[3], packet[4], packet[5]
    if kind == 0x4D:
        return Button(value, BUTTONS.get(value), {0x00: True, 0x01: False}.get(state))
    if kind == 0x80:
        return TBar(value)
    if kind == 0x49:
        return Wheel({0x01: +1, 0xFF: -1}.get(value))
    return Other(kind)


def untrusted(event) -> str | None:
    """Why one decoded record cannot be trusted, or None: a bad record, a type nobody has decoded,
    or a button state that is neither DOWN nor UP."""
    if isinstance(event, Bad):
        return event.why
    if isinstance(event, Other):
        return f"type 0x{event.kind:02X} is not known"
    if isinstance(event, Button) and event.down is None:
        return "a button state that is neither DOWN nor UP"
    return None


def decode_notification(data: bytes) -> list:
    """One notification, as (record, event) pairs in the order received. Framing only: what to do
    with an event is the adapter's business. Anything but whole records comes back as one Bad. A
    lone record comes back as it decodes, as it always has (a Bad, an unknown type or an unknown
    state is never acted on). Of two or more, if any is not trusted, the whole notification comes
    back as one Bad, naming each record that failed."""
    data = bytes(data)
    if not data or len(data) % RECORD_BYTES:
        return [(data, Bad(f"{len(data)} bytes, not whole {RECORD_BYTES}-byte records"))]
    pairs = [(data[i:i + RECORD_BYTES], decode(data[i:i + RECORD_BYTES])) for i in range(0, len(data), RECORD_BYTES)]
    failed = [f"record {n}: {why}" for n, (_, event) in enumerate(pairs, 1) if (why := untrusted(event))]
    if failed and len(pairs) > 1:
        return [(data, Bad(f"{len(pairs)} records, none trusted; " + "; ".join(failed)))]
    return pairs


def tally_bank(bank: str, lit: int | None) -> bytes:
    """One whole bank's lamps, as one write: "PROGRAM" (red) or "PREVIEW" (amber), with button lit
    (1-6) or None for the whole bank dark. The ids count up from the bank's first. A dark bank was
    never captured: it is the captured records with every STATE 01."""
    if bank not in TALLY_FIRST_ID:
        raise ValueError(f"no tally bank {bank!r}")
    if lit is not None and (type(lit) is not int or not 1 <= lit <= TALLY_BUTTONS):
        raise ValueError(f"{bank} {lit!r}: the lit button is 1-{TALLY_BUTTONS}, or None")
    out = bytearray()
    for i in range(TALLY_RECORDS):
        first = HEADER + bytes((0x4D, 0x00, TALLY_FIRST_ID[bank] + i, 0x00 if lit == i + 1 else 0x01))
        out += first + bytes((check_byte(first),))
    return bytes(out)


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
