#!/usr/bin/env python3
"""Offline tests for the Wingman Surface adapter: no Bluetooth, no takectl, no mimoLive.

    python3 test_wingman.py                     (from surfaces/wingman/; standard library only)
    WINGMAN_DIR=<dir> python3 test_wingman.py   tests another copy of the code (falsification)

The authorities are read at run time, never copied in here: the packets in captures.txt (what the
real Surface sent) and the button map in wingman_monitor.py (the known-good monitor). takectl is a
fake that records every route asked of it, so nothing here can reach a live show.
"""

import argparse
import ast
import asyncio
import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
from urllib.error import URLError

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.environ.get("WINGMAN_DIR", HERE))
import lamp_walk as L  # noqa: E402
import wingman_abswitch as W  # noqa: E402
import wingman_protocol as P  # noqa: E402


def captures():
    with open(os.path.join(HERE, "captures.txt"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                hexs, label = line.split(None, 1)
                yield bytes.fromhex(hexs), label


def notifications():
    """Each captured notification and its records with their labels; "a + b" labels two records."""
    for raw, label in captures():
        yield raw, list(zip(records(raw), label.split(" + ")))


def capture_records():
    """Every captured record with its own label, whether it came alone or with another."""
    for _, pairs in notifications():
        yield from pairs


def monitor_buttons():
    with open(os.path.join(HERE, "wingman_monitor.py"), encoding="utf-8") as f:
        tree = ast.parse(f.read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "BUTTONS" for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError("no BUTTONS in wingman_monitor.py")


def packet(kind, state, value):
    """A packet as the Surface builds one (test_builder_reproduces_captures holds this to the captures)."""
    first = bytes([0xAA, 0x00, 0x07, kind, state, value, 0x00])
    x = 0
    for b in first:
        x ^= b
    return first + bytes([x])


def tally_captures():
    """The tally writes seen to work on the Surface: (bank, lit button, the 96 bytes)."""
    with open(os.path.join(HERE, "tally_captures.txt"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                bank, lit, *recs = line.split()
                yield bank, int(lit), bytes.fromhex("".join(recs))


def records(payload):
    return [payload[i:i + 8] for i in range(0, len(payload), 8)]


def panel_lines():
    with open(os.path.join(os.path.dirname(os.path.dirname(HERE)), "operator.html"), encoding="utf-8") as f:
        return {line.strip() for line in f}


BY_NAME = {name: i for i, name in monitor_buttons().items()}


def press(name, down=True):
    return packet(0x4D, 0x00 if down else 0x01, BY_NAME[name])


class Decoding(unittest.TestCase):
    def test_builder_reproduces_captures(self):
        for raw, label in capture_records():
            self.assertEqual(packet(raw[3], raw[4], raw[5]), raw, label)

    def test_captures_decode_as_labelled(self):
        n = 0
        for raw, label in capture_records():
            kind, *rest = label.split()
            event = P.decode(raw)
            if kind == "wheel":
                self.assertEqual(event, P.Wheel(int(rest[0])), label)
            elif kind == "tbar":
                self.assertEqual(event, P.TBar(int(rest[0])), label)
            elif kind == "button":
                *words, way = rest
                self.assertIsInstance(event, P.Button, label)
                self.assertEqual((event.name, event.down), (" ".join(words), way == "down"), label)
            else:
                self.fail(f"captures.txt: unknown label {label!r}")
            n += 1
        self.assertGreater(n, 0)

    def test_any_single_bit_flip_is_dropped(self):
        for raw, label in capture_records():
            for i in range(8):
                for bit in range(8):
                    bad = bytearray(raw)
                    bad[i] ^= 1 << bit
                    self.assertIsInstance(P.decode(bytes(bad)), P.Bad, f"{label}: byte {i} bit {bit}")

    def test_wrong_lengths_are_dropped(self):
        raw = next(captures())[0]
        for data in (b"", raw[:7], raw + b"\x00"):
            self.assertIsInstance(P.decode(data), P.Bad)

    def test_button_map_is_the_known_good_monitors(self):
        self.assertEqual(P.BUTTONS, monitor_buttons())

    def test_every_mapped_button_down_and_up(self):
        for i, name in monitor_buttons().items():
            self.assertEqual(P.decode(packet(0x4D, 0x00, i)), P.Button(i, name, True), name)
            self.assertEqual(P.decode(packet(0x4D, 0x01, i)), P.Button(i, name, False), name)

    def test_unknowns_are_named_unknown(self):
        unmapped = next(i for i in range(256) if i not in monitor_buttons())
        self.assertEqual(P.decode(packet(0x4D, 0x00, unmapped)).name, None)
        self.assertEqual(P.decode(packet(0x4D, 0x02, BY_NAME["CUT"])).down, None)
        self.assertEqual(P.decode(packet(0x49, 0x00, 0x05)), P.Wheel(None))
        self.assertIsInstance(P.decode(packet(0x55, 0x00, 0x00)), P.Other)

    def test_tbar_percent(self):
        self.assertEqual(P.TBar(0).percent, 0.0)
        self.assertEqual(P.TBar(P.TBAR_MAX).percent, 100.0)
        self.assertAlmostEqual(P.TBar(60).percent, 60 / P.TBAR_MAX * 100)
        self.assertEqual(P.TBar(255).percent, 100.0)


def two_record_captures(way):
    """The captured notifications that held two records, every one a "down" or every one an "up"."""
    found = [raw for raw, pairs in notifications() if len(pairs) == 2 and all(label.endswith(" " + way) for _, label in pairs)]
    assert found, f"captures.txt holds no notification of two {way}s"
    return found


def record(label):
    """One captured record, by its label in captures.txt."""
    return next(raw for raw, l in capture_records() if l == label)


class Framing(unittest.TestCase):
    """A notification is one or more whole records (captures.txt, 2026-11-14); decode_notification frames it."""

    def test_every_capture_is_whole_records_with_one_label_each(self):
        for raw, label in captures():
            self.assertEqual(len(raw) % P.RECORD_BYTES, 0, label)
            self.assertEqual(len(label.split(" + ")), len(raw) // P.RECORD_BYTES, label)

    def test_a_lone_record_decodes_as_it_always_has(self):
        lone = [raw for raw, _ in captures() if len(raw) == P.RECORD_BYTES]
        for raw in lone + [packet(0x55, 0x00, 0x00), packet(0x4D, 0x02, BY_NAME["CUT"])]:  # and an unknown type and state
            self.assertEqual(P.decode_notification(raw), [(raw, P.decode(raw))], raw.hex())

    def test_two_presses_together_are_two_downs_in_the_order_they_came(self):
        for raw in two_record_captures("down"):
            got = P.decode_notification(raw)
            self.assertEqual([r for r, _ in got], records(raw))
            self.assertEqual([e for _, e in got], [P.decode(r) for r in records(raw)])
            self.assertTrue(all(isinstance(e, P.Button) and e.down is True for _, e in got), got)
            swapped = P.decode_notification(raw[8:] + raw[:8])
            self.assertEqual([e for _, e in swapped], [e for _, e in reversed(got)])

    def test_two_releases_together_are_two_ups(self):
        for raw in two_record_captures("up"):
            got = P.decode_notification(raw)
            self.assertEqual([e for _, e in got], [P.decode(r) for r in records(raw)])
            self.assertTrue(all(isinstance(e, P.Button) and e.down is False for _, e in got), got)

    def test_a_release_and_a_press_together_come_in_order(self):
        up, down = record("button PREVIEW 1 up"), record("button PREVIEW 2 down")
        for data in (up + down, down + up):
            self.assertEqual([e for _, e in P.decode_notification(data)], [P.decode(data[:8]), P.decode(data[8:])], data.hex())

    def test_anything_but_whole_records_is_one_bad(self):
        pair = two_record_captures("down")[0]
        for data in [pair[:n] for n in range(16) if n != 8] + [pair + pair[:n] for n in range(1, 8)]:
            got = P.decode_notification(data)
            self.assertEqual(len(got), 1, data.hex())
            self.assertIsInstance(got[0][1], P.Bad, data.hex())

    def test_one_bad_record_and_none_of_the_notification_is_trusted(self):
        pair = two_record_captures("down")[0]
        for i in range(len(pair)):
            for bit in range(8):
                bad = bytearray(pair)
                bad[i] ^= 1 << bit
                got = P.decode_notification(bytes(bad))
                self.assertEqual(len(got), 1, f"byte {i} bit {bit}")
                self.assertIsInstance(got[0][1], P.Bad, f"byte {i} bit {bit}")
                self.assertIn(f"record {i // 8 + 1}:", got[0][1].why, f"byte {i} bit {bit}")

    def test_an_unknown_type_or_state_spoils_a_notification(self):
        down = record("button PREVIEW 1 down")
        for odd in (packet(0x55, 0x00, 0x0D), packet(0x4D, 0x02, 0x0D)):
            for data in (odd + down, down + odd):
                got = P.decode_notification(data)
                self.assertEqual(len(got), 1, data.hex())
                self.assertIsInstance(got[0][1], P.Bad, data.hex())

    def test_a_tally_write_read_back_is_never_a_press(self):
        # A lit record is byte for byte a DOWN. Read back, a bank holds it among off records, so no run of two
        # or more of a write's records is trusted; a lone off record is dropped by byte 6.
        n = 0
        for bank, lit, raw in tally_captures():
            recs = records(raw)
            for a in range(len(recs)):
                for b in range(a + 2, len(recs) + 1):
                    got = P.decode_notification(b"".join(recs[a:b]))
                    self.assertEqual(len(got), 1, f"{bank} {lit} records {a}-{b}")
                    self.assertIsInstance(got[0][1], P.Bad, f"{bank} {lit} records {a}-{b}")
                    n += 1
        self.assertGreater(n, 0)


class FakeTakectl:
    """takectl as the adapter sees it: /state as the panel reads it, and every route asked recorded."""

    def __init__(self, looks=("Speaker Wide", "Two Shot", "Q&A / Panel"), fail=False, state=None, answer=None, silent=None, **over):
        self.looks, self.fail, self.state, self.answer, self.silent, self.over = looks, fail, state, answer, silent, over
        self.calls = []

    def get(self, path, timeout=None):
        self.calls.append(path)
        if self.fail:
            raise URLError("connection refused")
        if path == "/state":
            if self.state is not None:
                return self.state
            s = {"ready": True, "pgm": "A", "pvw": "B", "busy": False, "switcher": {"inFlight": False}, "steps": {"running": False},
                 "rehearsal": None, "layerSetsAll": [{"name": n, "inA": True, "inB": True} for n in self.looks]}
            return {**s, **self.over}
        if path == self.silent:
            raise TimeoutError("timed out")
        return self.answer if self.answer is not None else {"ok": True, "pgm": "B", "pvw": "A", "transition": "dissolve", "ms": 560}


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


def surface(tk=None, armed=True):
    log, clock = [], Clock()
    s = W.Surface(tk or FakeTakectl(), armed=armed, settle_s=1.0, log=log.append, clock=clock)
    s.connected()
    clock.t += 1.0  # settled
    return s, log, clock


def run(aw):
    """Run an awaitable, or each command handle() returned, in order."""
    if isinstance(aw, list):
        for command in aw:
            asyncio.run(command)
        return None
    return asyncio.run(aw) if aw is not None else None


class Commands(unittest.TestCase):
    def test_preview_down_sends_one_recall_and_up_sends_nothing(self):
        tk = FakeTakectl()
        s, _, _ = surface(tk)
        run(s.handle(press("PREVIEW 2")))
        self.assertEqual(tk.calls, ["/state", "/pvw/layer-set?name=Two%20Shot"])
        self.assertEqual([], s.handle(press("PREVIEW 2", down=False)))
        self.assertEqual(len(tk.calls), 2)

    def test_preview_n_is_the_panels_key_n_and_an_empty_key_sends_nothing(self):
        looks = ("Speaker Wide", "Two Shot", "Q&A / Panel")
        for n in range(1, 7):
            tk = FakeTakectl(looks)
            s, log, _ = surface(tk)
            run(s.handle(press(f"PREVIEW {n}")))
            recalls = [c for c in tk.calls if c.startswith("/pvw/layer-set")]
            if n <= len(looks):
                self.assertEqual(len(recalls), 1, n)
                self.assertTrue(recalls[0].endswith(W.quote(looks[n - 1], safe="")), recalls)
            else:
                self.assertEqual(recalls, [], n)
                self.assertIn("empty", log[-1])

    def test_look_names_are_sent_whole(self):
        tk = FakeTakectl()
        s, _, _ = surface(tk)
        run(s.handle(press("PREVIEW 3")))
        self.assertEqual(tk.calls[-1], "/pvw/layer-set?name=Q%26A%20%2F%20Panel")

    def test_nothing_else_on_the_surface_sends_anything(self):
        tk = FakeTakectl()
        s, _, _ = surface(tk)
        for name in BY_NAME:
            if not name.startswith("PREVIEW ") and name not in ("AUTO", "CUT", "LOGO ON", "U.N-TITLE ON", "TITLE ON", "SUPER FG ON"):
                self.assertEqual([], s.handle(press(name)), name)
        for data in (packet(0x80, 0x00, 60), packet(0x49, 0x00, 0x01), packet(0x55, 0x00, 0x0D), b"\x00" * 8):
            self.assertEqual([], s.handle(data))
        self.assertEqual(tk.calls, [])

    def test_a_press_while_one_is_in_flight_is_dropped_not_queued(self):
        tk = FakeTakectl()
        s, log, _ = surface(tk)

        async def two_presses():
            [first] = s.handle(press("PREVIEW 1"))
            second = s.handle(press("PREVIEW 2"))
            self.assertIsNotNone(first)
            self.assertEqual(second, [])
            await first

        asyncio.run(two_presses())
        self.assertEqual(tk.calls, ["/state", "/pvw/layer-set?name=Speaker%20Wide"])
        self.assertTrue(any("dropped" in line for line in log))
        run(s.handle(press("PREVIEW 2")))  # once it has landed, the next press goes
        self.assertEqual(tk.calls[-1], "/pvw/layer-set?name=Two%20Shot")

    def test_presses_count_only_once_settled_after_connecting(self):
        tk = FakeTakectl()
        log, clock = [], Clock()
        s = W.Surface(tk, armed=True, settle_s=1.0, log=log.append, clock=clock)
        self.assertEqual([], s.handle(press("PREVIEW 1")))  # never connected
        s.connected()
        clock.t += 0.9
        self.assertEqual([], s.handle(press("PREVIEW 1")))  # inside the settle window
        clock.t += 0.2
        [settled] = s.handle(press("PREVIEW 1"))
        self.assertIsNotNone(settled)
        settled.close()  # not run: this test is only about when presses count
        s.busy = False
        s.disconnected()
        self.assertEqual([], s.handle(press("PREVIEW 1")))  # gone again
        self.assertEqual(tk.calls, [])

    def test_takectl_unreachable_is_logged_not_retried(self):
        tk = FakeTakectl(fail=True)
        s, log, _ = surface(tk)
        run(s.handle(press("PREVIEW 1")))
        self.assertEqual(tk.calls, ["/state"])
        self.assertIn("not reachable", log[-1])
        self.assertFalse(s.busy)

    def test_a_refusal_is_reported_with_takectls_reason(self):
        tk = FakeTakectl(answer={"ok": False, "error": "a transition is in progress; wait for it to land"})
        s, log, _ = surface(tk)
        run(s.handle(press("PREVIEW 1")))
        self.assertEqual(len([c for c in tk.calls if c.startswith("/pvw/")]), 1)
        self.assertIn("refused: a transition is in progress", log[-1])

    def test_takectl_not_ready_sends_nothing(self):
        tk = FakeTakectl(state={"ready": False, "mode": "setup"})
        s, log, _ = surface(tk)
        run(s.handle(press("PREVIEW 1")))
        self.assertEqual(tk.calls, ["/state"])
        self.assertIn("not ready", log[-1])

    def test_dry_run_reads_but_never_commands(self):
        tk = FakeTakectl()
        s, log, _ = surface(tk, armed=False)
        run(s.handle(press("PREVIEW 2")))
        self.assertEqual(tk.calls, ["/state"])
        self.assertIn("would send /pvw/layer-set?name=Two%20Shot", log[-1])
        for name, route in (("AUTO", "/take"), ("CUT", "/cut")):
            run(s.handle(press(name)))
            self.assertIn(f"would send {route}", log[-1])
        self.assertEqual(tk.calls, ["/state"] * 3)


class Notifications(unittest.TestCase):
    """Several records in one notification, at the adapter: each judged in order, as if it had come alone."""

    def test_two_presses_together_send_the_first_and_drop_the_second(self):
        for raw in two_record_captures("down"):
            first, second = (P.decode(r).name for r in records(raw))
            tk = FakeTakectl()
            s, log, _ = surface(tk)
            commands = s.handle(raw)
            self.assertEqual(len(commands), 1, log)
            self.assertEqual(log[0], f"BUTTON {first} DOWN")
            self.assertTrue(log[1].startswith(f"BUTTON {second} DOWN") and "dropped" in log[1], log)
            run(commands)
            n = int(first.split()[1])
            self.assertEqual(tk.calls, ["/state", "/pvw/layer-set?name=" + W.quote(tk.looks[n - 1], safe="")])

    def test_two_releases_together_send_nothing(self):
        for raw in two_record_captures("up"):
            tk = FakeTakectl()
            s, log, _ = surface(tk)
            self.assertEqual(s.handle(raw), [])
            self.assertEqual(len(log), 2)
            self.assertEqual(tk.calls, [])

    def test_a_release_and_a_press_together_send_the_press(self):
        up, down = record("button PREVIEW 1 up"), record("button PREVIEW 2 down")
        for data in (up + down, down + up):
            tk = FakeTakectl()
            s, _, _ = surface(tk)
            run(s.handle(data))
            self.assertEqual(tk.calls, ["/state", "/pvw/layer-set?name=Two%20Shot"], data.hex())

    def test_a_control_that_does_nothing_does_not_stop_the_press_beside_it(self):
        tk = FakeTakectl()
        s, _, _ = surface(tk)
        run(s.handle(press("PROGRAM 1") + press("PREVIEW 2")))
        self.assertEqual(tk.calls, ["/state", "/pvw/layer-set?name=Two%20Shot"])

    def test_a_bad_notification_sends_nothing_and_is_logged_whole(self):
        pair = two_record_captures("down")[0]
        for bad in (pair[:15] + bytes([pair[15] ^ 1]), pair[:12], pair + pair[:3]):
            tk = FakeTakectl()
            s, log, _ = surface(tk)
            self.assertEqual(s.handle(bad), [], bad.hex())
            self.assertEqual(tk.calls, [], bad.hex())
            self.assertEqual(len(log), 1, log)
            self.assertIn(bad.hex().upper(), log[0])

    def test_raw_shows_each_record_on_its_own_line(self):
        pair = two_record_captures("up")[0]
        log = []
        s = W.Surface(FakeTakectl(), armed=True, raw=True, log=log.append)
        s.handle(pair)
        self.assertEqual([line.split("[")[1].rstrip("]") for line in log], [r.hex().upper() for r in records(pair)])

    def test_inside_the_settle_window_every_record_is_ignored(self):
        tk = FakeTakectl()
        log, clock = [], Clock()
        s = W.Surface(tk, armed=True, settle_s=1.0, log=log.append, clock=clock)
        s.connected()
        self.assertEqual(s.handle(press("PREVIEW 1") + press("PREVIEW 2")), [])
        self.assertEqual(len([line for line in log if "only just connected" in line]), 2)
        self.assertEqual(tk.calls, [])

    def test_feed_runs_the_notifications_command(self):
        tk = FakeTakectl()
        s, _, _ = surface(tk)

        async def go():
            s.feed(two_record_captures("down")[0])
            await asyncio.gather(*s.tasks)

        asyncio.run(go())
        self.assertEqual(len([c for c in tk.calls if c.startswith("/pvw/")]), 1)


class TakeAndCut(unittest.TestCase):
    def test_auto_is_take_and_cut_is_cut_on_down_only(self):
        for name, route in (("AUTO", "/take"), ("CUT", "/cut")):
            tk = FakeTakectl()
            s, log, _ = surface(tk)
            run(s.handle(press(name)))
            self.assertEqual(tk.calls, ["/state", route], name)
            self.assertIn(f"sent {route}: {name if name == 'CUT' else 'TAKE'} to B", log[-1])
            self.assertEqual([], s.handle(press(name, down=False)))
            self.assertEqual(len(tk.calls), 2)

    def test_not_sent_whenever_the_panel_greys_take_and_cut(self):
        greyings = {
            "not ready": {"ready": False, "mode": "setup"},
            "Program not known": {"pgm": None},
            "busy": {"busy": True},
            "switcher in flight": {"switcher": {"inFlight": True}},
            "steps running": {"steps": {"running": True}},
            "rehearsing": {"rehearsal": {"look": "Speaker Wide"}},
        }
        for why, over in greyings.items():
            for name in ("AUTO", "CUT"):
                tk = FakeTakectl(**over)
                s, log, _ = surface(tk)
                run(s.handle(press(name)))
                self.assertEqual(tk.calls, ["/state"], f"{name} while {why}")
                self.assertIn("not sent", log[-1], f"{name} while {why}")

    def test_greyed_mirrors_the_panels_lines_as_they_are(self):
        panel = panel_lines()
        for line in W.PANEL_GREYING:
            self.assertIn(line, panel, "the panel's TAKE/CUT greying changed: revisit greyed() in wingman_abswitch.py")

    def test_one_command_at_a_time_across_controls(self):
        tk = FakeTakectl()
        s, log, _ = surface(tk)

        async def preview_then_auto():
            [first] = s.handle(press("PREVIEW 1"))
            self.assertEqual([], s.handle(press("AUTO")))
            self.assertEqual([], s.handle(press("CUT")))
            await first

        asyncio.run(preview_then_auto())
        self.assertNotIn("/take", tk.calls)
        self.assertNotIn("/cut", tk.calls)

    def test_a_take_with_no_answer_is_not_reported_as_unsent_or_retried(self):
        tk = FakeTakectl(silent="/take")
        s, log, _ = surface(tk)
        run(s.handle(press("AUTO")))
        self.assertEqual(tk.calls, ["/state", "/take"])
        self.assertIn("no answer within", log[-1])
        self.assertNotIn("nothing sent", log[-1])
        self.assertFalse(s.busy)

    def test_a_refused_take_shows_takectls_reason(self):
        tk = FakeTakectl(answer={"ok": False, "error": "busy: transition in progress (812 ms left)"})
        s, log, _ = surface(tk)
        run(s.handle(press("AUTO")))
        self.assertIn("refused: busy: transition in progress", log[-1])


# The pen's brief of 2026-11-19, stage 1: the four graphics buttons and the labels they default to.
GRAPHICS = {"LOGO ON": "Logo", "TITLE ON": "Title", "U.N-TITLE ON": "Up Next", "SUPER FG ON": "SuperFG"}


def keys(*labels, on=False):
    return [{"label": x, "on": on} for x in labels]


def dsk_tk(*labels, **kw):
    return FakeTakectl(dsk=keys(*labels), answer=kw.pop("answer", {"ok": True, "label": labels[0] if labels else "?", "on": True}), **kw)


class DownstreamKeys(unittest.TestCase):
    def test_each_graphics_button_toggles_its_default_label_on_down_only(self):
        for button, label in GRAPHICS.items():
            tk = dsk_tk(*GRAPHICS.values())
            s, _, _ = surface(tk)
            run(s.handle(press(button)))
            self.assertEqual(tk.calls, ["/state", "/dsk?label=" + W.quote(label, safe="")], button)
            self.assertEqual([], s.handle(press(button, down=False)), button)
            self.assertEqual(len(tk.calls), 2, button)

    def test_a_label_with_a_space_is_sent_whole(self):
        tk = dsk_tk("Up Next")
        s, _, _ = surface(tk)
        run(s.handle(press("U.N-TITLE ON")))
        self.assertEqual(tk.calls[-1], "/dsk?label=Up%20Next")

    def test_the_settings_choose_the_label_and_takectls_spelling_is_sent(self):
        tk = dsk_tk("Bug", "Clock")
        s, _, _ = surface(tk)
        s.dsk_labels = {**s.dsk_labels, "LOGO ON": "bug", "SUPER FG ON": "CLOCK"}
        run(s.handle(press("LOGO ON")))
        s.busy = False
        run(s.handle(press("SUPER FG ON")))
        self.assertEqual([c for c in tk.calls if c != "/state"], ["/dsk?label=Bug", "/dsk?label=Clock"])

    def test_a_button_whose_layer_master_does_not_have_sends_nothing(self):
        tk = dsk_tk("Bug", "Clock")
        s, log, _ = surface(tk)
        for button, label in GRAPHICS.items():
            run(s.handle(press(button)))
            self.assertIn(f'no "DSK {label}" layer in MASTER', log[-1], button)
            self.assertIn("Bug, Clock", log[-1], button)
            self.assertIn("nothing sent", log[-1], button)
        self.assertEqual(tk.calls, ["/state"] * 4)

    def test_a_layer_added_after_start_is_found_on_the_next_press(self):
        tk = dsk_tk("Bug")
        s, log, _ = surface(tk)
        report = []
        W.dsk_at_start(tk, s.dsk_labels, log=report.append)
        self.assertTrue(any("LOGO ON" in x and "sends nothing" in x for x in report), report)
        tk.over["dsk"] = keys("Bug", "Logo")
        run(s.handle(press("LOGO ON")))
        self.assertEqual(tk.calls[-1], "/dsk?label=Logo")

    def test_acts_mid_transition_in_safe_and_whenever_the_panels_keys_do(self):
        for why, over in (("a transition in progress", {"busy": True}), ("the switcher in flight", {"switcher": {"inFlight": True}}),
                          ("SAFE on air", {"pgm": "SAFE"}), ("OTHER on air", {"pgm": "OTHER"}), ("steps running", {"steps": {"running": True}}),
                          ("a rehearsal", {"rehearsal": {"pvw": "B"}})):
            tk = dsk_tk("Logo", **over)
            s, log, _ = surface(tk)
            run(s.handle(press("LOGO ON")))
            self.assertEqual(tk.calls, ["/state", "/dsk?label=Logo"], why)

    def test_not_sent_when_the_panel_greys_its_downstream_keys(self):
        for why, state in (("takectl not ready", {"ready": False, "mode": "setup", "dsk": keys("Logo")}),
                           ("Program not known", {"ready": True, "pgm": None, "pvw": "B", "dsk": keys("Logo")})):
            tk = FakeTakectl(state=state)
            s, log, _ = surface(tk)
            run(s.handle(press("LOGO ON")))
            self.assertEqual(tk.calls, ["/state"], why)
            self.assertIn("not sent", log[-1], why)
            self.assertIn("downstream keys are greyed too", log[-1], why)

    def test_a_dsk_press_while_a_command_is_in_flight_is_dropped_not_queued(self):
        tk = dsk_tk("Logo")
        s, log, _ = surface(tk)

        async def take_then_logo():
            [take] = s.handle(press("AUTO"))
            self.assertEqual(s.handle(press("LOGO ON")), [])
            await take

        asyncio.run(take_then_logo())
        self.assertIn("dropped", log[-2])
        self.assertNotIn("/dsk?label=Logo", tk.calls)

    def test_the_answer_says_on_or_off_and_a_refusal_gives_takectls_reason(self):
        for answer, want in (({"ok": True, "label": "Logo", "on": True}, "DSK Logo on"), ({"ok": True, "label": "Logo", "on": False}, "DSK Logo off"),
                             ({"ok": False, "error": 'no downstream key "Logo"'}, 'takectl refused: no downstream key "Logo"')):
            tk = dsk_tk("Logo", answer=answer)
            s, log, _ = surface(tk)
            run(s.handle(press("LOGO ON")))
            self.assertIn(want, log[-1])

    def test_dry_run_reads_but_never_toggles(self):
        tk = dsk_tk("Logo")
        s, log, _ = surface(tk, armed=False)
        run(s.handle(press("LOGO ON")))
        self.assertEqual(tk.calls, ["/state"])
        self.assertIn("would send /dsk?label=Logo", log[-1])

    def test_dsk_greying_mirrors_the_panels_lines_as_they_are(self):
        panel = panel_lines()
        for line in W.PANEL_DSK:
            self.assertIn(line, panel, "the panel's downstream keys changed: revisit dsk_greyed() and dsk_key() in wingman_abswitch.py")


class DskAtStart(unittest.TestCase):
    def test_it_says_which_buttons_have_a_layer_and_reads_only_state(self):
        tk = dsk_tk("Bug", "Clock")
        log = []
        W.dsk_at_start(tk, {**W.DSK_DEFAULTS, "LOGO ON": "bug", "TITLE ON": "Clock"}, log=log.append)
        self.assertEqual(tk.calls, ["/state"])
        self.assertIn("Bug, Clock", log[0])
        lines = {b: next(x for x in log if x.strip().startswith(b + ":")) for b in GRAPHICS}
        self.assertIn("DSK Bug", lines["LOGO ON"])
        self.assertIn("DSK Clock", lines["TITLE ON"])
        for button in ("U.N-TITLE ON", "SUPER FG ON"):
            self.assertIn(f'no "DSK {GRAPHICS[button]}" layer in MASTER; this button sends nothing', lines[button])

    def test_takectl_not_reachable_or_not_ready_is_said_and_nothing_fails(self):
        for tk, want in ((FakeTakectl(fail=True), "not reachable"), (FakeTakectl(state={"ready": False, "mode": "setup"}), "not ready (setup)")):
            log = []
            W.dsk_at_start(tk, dict(W.DSK_DEFAULTS), log=log.append)
            self.assertEqual(len(log), 1)
            self.assertIn(want, log[0])
            self.assertIn("each press looks again", log[0])

    def test_the_report_comes_at_start_before_scanning(self):
        class Stop(Exception):
            pass

        class Scanner:
            @staticmethod
            async def find_device_by_filter(*_a, **_k):
                raise Stop

        fake = types.ModuleType("bleak")
        fake.BleakScanner, fake.BleakClient = Scanner, object
        tk = dsk_tk("Bug")
        made = []

        class Recorded(W.Surface):
            def __init__(self, *a, **k):
                super().__init__(*a, **k)
                made.append(self)

        saved = sys.modules.get("bleak"), W.Takectl, W.Surface
        sys.modules["bleak"], W.Takectl, W.Surface = fake, (lambda _base: tk), Recorded
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out), self.assertRaises(Stop):
                args = argparse.Namespace(takectl="http://fake", arm=False, settle=1.0, raw=False, tally=False)
                asyncio.run(W.run(args, {"dsk": {**W.DSK_DEFAULTS, "LOGO ON": "Bug"}, "from": None}))
        finally:
            W.Takectl, W.Surface = saved[1], saved[2]
            if saved[0] is None:
                sys.modules.pop("bleak", None)
            else:
                sys.modules["bleak"] = saved[0]
        text = out.getvalue()
        self.assertIn("LOGO ON: DSK Bug", text)
        self.assertIn('TITLE ON: no "DSK Title" layer in MASTER; this button sends nothing', text)
        self.assertLess(text.index("LOGO ON: DSK Bug"), text.index("Scanning for"))
        self.assertEqual(made[0].dsk_labels["LOGO ON"], "Bug", "the presses use the settings' labels")


class Settings(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="wingman-settings-")

    def write(self, content):
        path = os.path.join(self.dir, "wingman.config.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write(content if isinstance(content, str) else json.dumps(content))
        return path

    def test_no_settings_file_beside_the_adapter_means_the_defaults(self):
        saved, W.SETTINGS_FILE = W.SETTINGS_FILE, os.path.join(self.dir, "not-there.json")
        try:
            got = W.load_settings()
        finally:
            W.SETTINGS_FILE = saved
        self.assertEqual(got, {"dsk": GRAPHICS, "from": None})

    def test_a_file_sets_some_labels_and_the_rest_keep_their_defaults(self):
        got = W.load_settings(self.write({"dsk": {"LOGO ON": " Bug ", "TITLE ON": "Clock"}}))
        self.assertEqual(got["dsk"], {**GRAPHICS, "LOGO ON": "Bug", "TITLE ON": "Clock"})

    def test_the_file_beside_the_adapter_is_read_with_no_path(self):
        saved, W.SETTINGS_FILE = W.SETTINGS_FILE, self.write({"dsk": {"SUPER FG ON": "Lower"}})
        try:
            got = W.load_settings()
        finally:
            W.SETTINGS_FILE = saved
        self.assertEqual(got["dsk"]["SUPER FG ON"], "Lower")

    def test_a_typo_or_a_label_that_is_not_text_is_refused(self):
        for bad in ({"dsk": {"LOGO": "Bug"}}, {"dsk": {"LOGO ON": 3}}, {"dsk": {"LOGO ON": "  "}}, {"dsk": ["Bug"]}, ["Bug"],
                    {"dsk": {}, "wheel": "up"}, "{not json"):
            with self.assertRaises(W.SettingsError, msg=str(bad)):
                W.load_settings(self.write(bad))

    def test_a_settings_file_named_but_not_there_is_refused(self):
        with self.assertRaises(W.SettingsError):
            W.load_settings(os.path.join(self.dir, "missing.json"))


class Tally(unittest.TestCase):
    def test_every_captured_write_is_rebuilt_byte_for_byte(self):
        n = 0
        for bank, lit, raw in tally_captures():
            self.assertEqual(P.tally_bank(bank, lit), raw, f"{bank} {lit}")
            n += 1
        self.assertGreater(n, 0)

    def test_every_button_and_a_dark_bank_keep_the_captured_shape(self):
        # The shape comes from the captures: their length, each record's first six bytes, and which
        # STATE byte the lit record and the others carry. Only which record is lit may change.
        ref = {}
        for bank, lit, raw in tally_captures():
            recs = records(raw)
            ref[bank] = ([r[:6] for r in recs], {recs[lit - 1][6]}, {r[6] for i, r in enumerate(recs) if i != lit - 1})
        self.assertEqual(set(ref), set(P.TALLY_FIRST_ID), "a bank with no captured write")
        for bank, (heads, lit_state, off_state) in ref.items():
            for lit in (None, *range(1, P.TALLY_BUTTONS + 1)):
                got = records(P.tally_bank(bank, lit))
                self.assertEqual([g[:6] for g in got], heads, f"{bank} {lit}")
                for i, g in enumerate(got):
                    self.assertEqual({g[6]}, lit_state if lit == i + 1 else off_state, f"{bank} {lit} record {i}")
                    x = 0
                    for b in g[:7]:
                        x ^= b
                    self.assertEqual(g[7], x, f"{bank} {lit} record {i}: check byte")

    def test_a_bank_or_button_that_does_not_exist_is_refused(self):
        for bank, lit in (("PROGRAM", 0), ("PREVIEW", 7), ("PREVIEW", "3"), ("PREVIEW", True), ("ON AIR", 1)):
            with self.assertRaises(ValueError, msg=f"{bank} {lit!r}"):
                P.tally_bank(bank, lit)

    def test_a_tally_record_read_back_is_dropped_unless_it_is_a_press(self):
        # A lit record is byte for byte its button's DOWN; an off record differs only in byte 6 and is
        # dropped. If the Surface ever echoed a write, only the lit record could read as a press.
        downs = {raw for raw, label in capture_records() if label.endswith(" down")}
        for bank, lit, raw in tally_captures():
            for i, rec in enumerate(records(raw)):
                event = P.decode(rec)
                if i == lit - 1:
                    self.assertEqual(event, P.Button(rec[5], P.BUTTONS[rec[5]], True), f"{bank} {lit}")
                    if bank == "PREVIEW" and lit == 3:
                        self.assertIn(rec, downs, "PREVIEW 3 lit is no longer the captured PREVIEW 3 DOWN")
                else:
                    self.assertIsInstance(event, P.Bad, f"{bank} {lit} off record {i}")


def lamp_state(**over):
    s = {"ready": True, "pgm": "A", "pvw": "B", "looks": {"A": "Two Shot", "B": "Speaker Wide"},
         "layerSetsAll": [{"name": n, "inA": True, "inB": True} for n in ("Speaker Wide", "Two Shot", "Q&A / Panel")]}
    return {**s, **over}


class Lamps(unittest.TestCase):
    def test_the_keys_of_the_looks_on_program_and_in_preview(self):
        self.assertEqual(W.lamps(lamp_state()), (2, 1))
        self.assertEqual(W.lamps(lamp_state(pgm="B", pvw="A")), (1, 2))
        self.assertEqual(W.lamps(lamp_state(looks={"A": "Q&A / Panel", "B": "Q&A / Panel"})), (3, 3))

    def test_no_program_button_in_safe_or_other(self):
        for pgm in ("SAFE", "OTHER", None):
            self.assertEqual(W.lamps(lamp_state(pgm=pgm)), (None, 1), pgm)

    def test_a_look_with_no_button_lights_nothing(self):
        eight = [{"name": f"Look {n}", "inA": True, "inB": True} for n in range(1, 9)]
        self.assertEqual(W.lamps(lamp_state(layerSetsAll=eight, looks={"A": "Look 7", "B": "Look 6"})), (None, 6))
        self.assertEqual(W.lamps(lamp_state(looks={"A": "Not A Key", "B": None})), (None, None))
        self.assertEqual(W.lamps(lamp_state(layerSetsAll=[])), (None, None))

    def test_not_ready_lights_nothing(self):
        self.assertEqual(W.lamps({"ready": False, "mode": "setup"}), (None, None))

    def test_lamps_mirror_the_panels_lines_as_they_are(self):
        panel = panel_lines()
        for line in W.PANEL_LAMPS:
            self.assertIn(line, panel, "the panel's bus lamps changed: revisit lamps() in wingman_abswitch.py")


class Writer:
    """The Surface's tally characteristic as the adapter sees it: every write recorded. fail: how many
    writes raise first; hang: writes never answer."""

    def __init__(self, fail=0, hang=False):
        self.writes, self.fail, self.hang = [], fail, hang

    async def __call__(self, data):
        if self.hang:
            await asyncio.sleep(2)  # far past the test's write timeout, short enough that waiting on it only fails
        if self.fail:
            self.fail -= 1
            raise OSError("write failed")
        self.writes.append(bytes(data))


def bank(name, lit):
    """A bank as it should reach the Surface. The bytes are tally_bank()'s, which the Tally tests hold to the captures."""
    return (name, lit, P.tally_bank(name, lit))


def written(w):
    """Each write as (bank, lit, bytes), named by the tally_bank() it equals, or ("?", None, bytes)."""
    names = {P.tally_bank(n, lit): (n, lit) for n in P.TALLY_FIRST_ID for lit in (None, *range(1, P.TALLY_BUTTONS + 1))}
    return [(*names.get(b, ("?", None)), b) for b in w.writes]


def follower(state, **kw):
    tk, w, log = FakeTakectl(state=state), Writer(**kw), []
    return W.Tally(tk, w, log=log.append, write_timeout_s=0.05), tk, w, log


class TallyFollowsTakectl(unittest.TestCase):
    def test_connecting_writes_program_then_preview_as_the_panel_lights_them(self):
        t, tk, w, _ = follower(lamp_state())
        run(t.refresh())
        self.assertEqual(written(w), [bank("PROGRAM", 2), bank("PREVIEW", 1)])

    def test_nothing_is_written_while_nothing_changes(self):
        t, tk, w, _ = follower(lamp_state())
        for _ in range(5):
            run(t.refresh())
        self.assertEqual(len(w.writes), 2)

    def test_only_the_bank_that_changed_is_written(self):
        t, tk, w, _ = follower(lamp_state())
        run(t.refresh())
        tk.state = lamp_state(looks={"A": "Two Shot", "B": "Q&A / Panel"})
        run(t.refresh())
        self.assertEqual(written(w)[2:], [bank("PREVIEW", 3)])

    def test_a_take_moves_both_program_first(self):
        t, tk, w, _ = follower(lamp_state())
        run(t.refresh())
        tk.state = lamp_state(pgm="B", pvw="A")
        run(t.refresh())
        self.assertEqual(written(w)[2:], [bank("PROGRAM", 1), bank("PREVIEW", 2)])

    def test_takectl_unreachable_leaves_the_lamps_and_says_so_once(self):
        t, tk, w, log = follower(lamp_state())
        run(t.refresh())
        tk.fail = True
        for _ in range(3):
            run(t.refresh())
        self.assertEqual(len(w.writes), 2)
        self.assertEqual(sum("not reachable" in line for line in log), 1)
        tk.fail = False
        run(t.refresh())
        self.assertEqual(len(w.writes), 2)  # back, and nothing changed: nothing written
        self.assertIn("back to normal", log[-1])

    def test_an_answer_that_is_not_state_leaves_the_lamps(self):
        t, tk, w, _ = follower(lamp_state())
        run(t.refresh())
        tk.state = {"ok": False, "error": "HTTP 502"}
        run(t.refresh())
        self.assertEqual(len(w.writes), 2)

    def test_takectl_not_ready_darkens_both_as_the_panel_does(self):
        t, tk, w, _ = follower(lamp_state())
        run(t.refresh())
        tk.state = {"ready": False, "mode": "setup"}
        run(t.refresh())
        self.assertEqual(written(w)[2:], [bank("PROGRAM", None), bank("PREVIEW", None)])

    def test_a_failed_write_is_written_again_and_preview_waits_for_program(self):
        t, tk, w, log = follower(lamp_state(), fail=1)
        run(t.refresh())
        self.assertEqual(w.writes, [])  # PROGRAM failed, so PREVIEW was not written ahead of it
        self.assertIn("PROGRAM lamp not written", log[-1])
        run(t.refresh())
        self.assertEqual(written(w), [bank("PROGRAM", 2), bank("PREVIEW", 1)])

    def test_a_write_that_never_answers_is_given_up_on(self):
        t, tk, w, log = follower(lamp_state(), hang=True)
        run(t.refresh())
        self.assertIn("TimeoutError", log[-1])
        self.assertEqual(t.shown, {})

    def test_reconnecting_writes_both_again(self):
        t, tk, w, _ = follower(lamp_state())
        run(t.refresh())
        t.forget()
        run(t.refresh())
        self.assertEqual(written(w)[2:], [bank("PROGRAM", 2), bank("PREVIEW", 1)])

    def test_the_tally_never_sends_a_command(self):
        # A refresh or a reconnect must never TAKE: whatever happens, the only route asked is /state.
        t, tk, w, _ = follower(lamp_state(), fail=1)
        for over in (lamp_state(), lamp_state(pgm="B", pvw="A"), {"ready": False}, lamp_state(pgm="SAFE")):
            tk.state = over
            run(t.refresh())
            t.forget()
            run(t.refresh())
        self.assertEqual(set(tk.calls), {"/state"})

    def test_stopping_darkens_both(self):
        t, tk, w, _ = follower(lamp_state())
        run(t.refresh())
        run(t.darken())
        self.assertEqual(written(w)[2:], [bank("PROGRAM", None), bank("PREVIEW", None)])

    def test_follow_refreshes_at_once_and_stops_when_told(self):
        t, tk, w, _ = follower(lamp_state())

        async def follow_then_stop():
            stop = asyncio.Event()
            task = asyncio.ensure_future(t.follow(stop))
            await asyncio.sleep(0.01)
            self.assertEqual(len(w.writes), 2)  # at once, not after the first poll interval
            stop.set()
            await asyncio.wait_for(task, 1.0)

        asyncio.run(follow_then_stop())

    def test_a_log_with_nowhere_to_go_stops_nothing(self):
        # On the bench, Ctrl-C killed the tee the log was piped to while the adapter was still darkening the lamps.
        class Gone:
            def write(self, _s):
                raise BrokenPipeError(32, "Broken pipe")

            def flush(self):
                raise BrokenPipeError(32, "Broken pipe")

        t, tk, w, _ = follower(lamp_state())
        t.log = W.say
        real, sys.stdout = sys.stdout, Gone()
        try:
            run(t.refresh())
            tk.state = lamp_state(pvw="A")
            run(t.refresh())
            run(t.darken())
        finally:
            sys.stdout = real
        self.assertEqual(written(w), [bank("PROGRAM", 2), bank("PREVIEW", 1), bank("PREVIEW", 2), bank("PROGRAM", None), bank("PREVIEW", None)])

    def test_the_one_write_goes_to_ffe2_with_a_response(self):
        sent = []

        class Client:
            async def write_gatt_char(self, char, data, response=None):
                sent.append((char, bytes(data), response))

        asyncio.run(W.tally_writer(Client())(P.tally_bank("PREVIEW", 3)))
        self.assertEqual(sent, [(P.TALLY_UUID, P.tally_bank("PREVIEW", 3), True)])
        self.assertEqual(P.TALLY_UUID, "0000ffe2-0000-1000-8000-00805f9b34fb")  # the ruling names FFE2; nothing else
        self.assertNotEqual(P.TALLY_UUID, P.NOTIFY_UUID)


class SurfaceModel:
    """What the Surface shows, worked out from the bytes written to it: each bank's lit button, by name."""

    def __init__(self):
        self.lit = {}

    def write(self, data):
        recs = records(bytes(data))
        bank = next(b for b, first in P.TALLY_FIRST_ID.items() if recs[0][5] == first)
        self.lit[bank] = [P.BUTTONS.get(r[5]) for r in recs if r[6] == 0x00]

    def showing(self):
        return {name for names in self.lit.values() for name in names}


def lamp_walk(answers, model=None, fail_write_at=None):
    """Run the walk with a typed answer per question (an exception is raised instead of answering).
    Returns (what was asked, with what the Surface showed then; every write; the walk's answers or its exception)."""
    model, asked, writes, typed = model or SurfaceModel(), [], [], iter(answers)

    async def write(data):
        if fail_write_at is not None and len(writes) == fail_write_at:
            writes.append(None)
            raise OSError("the Surface went away")
        writes.append(bytes(data))
        model.write(data)

    async def ask(question):
        asked.append((question, model.showing()))
        answer = next(typed)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    try:
        result = asyncio.run(L.walk(write, ask, lambda line: None))
    except BaseException as e:  # noqa: BLE001  (CancelledError is the Ctrl-C under test)
        result = e
    return asked, writes, result


class LampWalk(unittest.TestCase):
    """lamp_walk.py: every tally position lit on its own, asked about by eye, with no takectl."""

    def every_position(self):
        return {P.BUTTONS[first + i] for first in P.TALLY_FIRST_ID.values() for i in range(P.TALLY_BUTTONS)}

    def test_every_question_is_about_what_is_lit_and_every_position_is_asked(self):
        asked, writes, answers = lamp_walk(["y"] * 100)
        self.assertIsInstance(answers, list)
        covered = set()
        for question, showing in asked:
            if question.startswith(L.ALL_DARK):
                self.assertEqual(showing, set(), question)
            else:
                named = next(name for name in self.every_position() if f"Is {name} the only button lit" in question)
                self.assertEqual(showing, {named}, question)
                covered.add(named)
        self.assertEqual(covered, self.every_position())
        self.assertTrue(asked[0][0].startswith(L.ALL_DARK) and asked[-1][0].startswith(L.ALL_DARK))

    def test_only_tally_bank_bytes_are_written_and_it_ends_dark(self):
        allowed = {P.tally_bank(b, lit) for b in P.TALLY_FIRST_ID for lit in (None, *range(1, P.TALLY_BUTTONS + 1))}
        _, writes, _ = lamp_walk(["y"] * 100)
        self.assertTrue(set(writes) <= allowed)
        self.assertEqual(writes[-2:], [P.tally_bank("PROGRAM", None), P.tally_bank("PREVIEW", None)])

    def test_q_stops_the_walk_and_darkens_both(self):
        asked, writes, answers = lamp_walk(["y", "y", "q"])
        self.assertEqual(len(asked), 3)
        self.assertEqual([a for _, a in answers], ["y", "y", "q"])
        self.assertEqual(writes[-2:], [P.tally_bank("PROGRAM", None), P.tally_bank("PREVIEW", None)])
        self.assertFalse(L.passed(answers))

    def test_ctrl_c_darkens_both(self):
        model = SurfaceModel()
        asked, writes, result = lamp_walk(["y", "y", "y", asyncio.CancelledError()], model)
        self.assertIsInstance(result, asyncio.CancelledError)
        self.assertEqual(writes[-2:], [P.tally_bank("PROGRAM", None), P.tally_bank("PREVIEW", None)])
        self.assertEqual(model.showing(), set())

    def test_a_failed_write_still_darkens_both(self):
        model = SurfaceModel()
        _, writes, result = lamp_walk(["y"] * 100, model, fail_write_at=4)
        self.assertIsInstance(result, OSError)
        self.assertEqual(writes[-2:], [P.tally_bank("PROGRAM", None), P.tally_bank("PREVIEW", None)])
        self.assertEqual(model.showing(), set())

    def test_only_every_step_answered_y_passes(self):
        n = len(L.steps())
        self.assertTrue(L.passed([("q", "y")] * n))
        for answers in ([("q", "y")] * (n - 1), [("q", "y")] * (n - 1) + [("q", "n")], [("q", "y")] * (n - 1) + [("q", "")],
                        [("q", "y")] * (n - 1) + [("q", "yes?")]):
            self.assertFalse(L.passed(answers), answers[-1])

    def test_the_one_write_goes_to_ffe2_with_a_response(self):
        sent = []

        class Client:
            async def write_gatt_char(self, char, data, response=None):
                sent.append((char, bytes(data), response))

        asyncio.run(L.writer(Client())(P.tally_bank("PROGRAM", 5)))
        self.assertEqual(sent, [(P.TALLY_UUID, P.tally_bank("PROGRAM", 5), True)])

    def test_the_walk_cannot_reach_takectl(self):
        with open(L.__file__, encoding="utf-8") as f:
            tree = ast.parse(f.read())
        imported = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        imported |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
        self.assertFalse(imported & {"urllib", "http", "socket", "wingman_abswitch"}, imported)


if __name__ == "__main__":
    unittest.main(verbosity=2)
