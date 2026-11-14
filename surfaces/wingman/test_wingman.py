#!/usr/bin/env python3
"""Offline tests for the Wingman Surface adapter: no Bluetooth, no takectl, no mimoLive.

    python3 test_wingman.py                     (from surfaces/wingman/; standard library only)
    WINGMAN_DIR=<dir> python3 test_wingman.py   tests another copy of the code (falsification)

The authorities are read at run time, never copied in here: the packets in captures.txt (what the
real Surface sent) and the button map in wingman_monitor.py (the known-good monitor). takectl is a
fake that records every route asked of it, so nothing here can reach a live show.
"""

import ast
import asyncio
import os
import sys
import unittest
from urllib.error import URLError

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.environ.get("WINGMAN_DIR", HERE))
import wingman_abswitch as W  # noqa: E402
import wingman_protocol as P  # noqa: E402


def captures():
    with open(os.path.join(HERE, "captures.txt"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                hexs, label = line.split(None, 1)
                yield bytes.fromhex(hexs), label


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


BY_NAME = {name: i for i, name in monitor_buttons().items()}


def press(name, down=True):
    return packet(0x4D, 0x00 if down else 0x01, BY_NAME[name])


class Decoding(unittest.TestCase):
    def test_builder_reproduces_captures(self):
        for raw, label in captures():
            self.assertEqual(packet(raw[3], raw[4], raw[5]), raw, label)

    def test_captures_decode_as_labelled(self):
        n = 0
        for raw, label in captures():
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
        for raw, label in captures():
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
    return asyncio.run(aw) if aw is not None else None


class Commands(unittest.TestCase):
    def test_preview_down_sends_one_recall_and_up_sends_nothing(self):
        tk = FakeTakectl()
        s, _, _ = surface(tk)
        run(s.handle(press("PREVIEW 2")))
        self.assertEqual(tk.calls, ["/state", "/pvw/layer-set?name=Two%20Shot"])
        self.assertIsNone(s.handle(press("PREVIEW 2", down=False)))
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
            if not name.startswith("PREVIEW ") and name not in ("AUTO", "CUT"):
                self.assertIsNone(s.handle(press(name)), name)
        for data in (packet(0x80, 0x00, 60), packet(0x49, 0x00, 0x01), packet(0x55, 0x00, 0x0D), b"\x00" * 8):
            self.assertIsNone(s.handle(data))
        self.assertEqual(tk.calls, [])

    def test_a_press_while_one_is_in_flight_is_dropped_not_queued(self):
        tk = FakeTakectl()
        s, log, _ = surface(tk)

        async def two_presses():
            first = s.handle(press("PREVIEW 1"))
            second = s.handle(press("PREVIEW 2"))
            self.assertIsNotNone(first)
            self.assertIsNone(second)
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
        self.assertIsNone(s.handle(press("PREVIEW 1")))  # never connected
        s.connected()
        clock.t += 0.9
        self.assertIsNone(s.handle(press("PREVIEW 1")))  # inside the settle window
        clock.t += 0.2
        settled = s.handle(press("PREVIEW 1"))
        self.assertIsNotNone(settled)
        settled.close()  # not run: this test is only about when presses count
        s.busy = False
        s.disconnected()
        self.assertIsNone(s.handle(press("PREVIEW 1")))  # gone again
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


class TakeAndCut(unittest.TestCase):
    def test_auto_is_take_and_cut_is_cut_on_down_only(self):
        for name, route in (("AUTO", "/take"), ("CUT", "/cut")):
            tk = FakeTakectl()
            s, log, _ = surface(tk)
            run(s.handle(press(name)))
            self.assertEqual(tk.calls, ["/state", route], name)
            self.assertIn(f"sent {route}: {name if name == 'CUT' else 'TAKE'} to B", log[-1])
            self.assertIsNone(s.handle(press(name, down=False)))
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
        with open(os.path.join(os.path.dirname(os.path.dirname(HERE)), "operator.html"), encoding="utf-8") as f:
            panel = {line.strip() for line in f}
        for line in W.PANEL_GREYING:
            self.assertIn(line, panel, "the panel's TAKE/CUT greying changed: revisit greyed() in wingman_abswitch.py")

    def test_one_command_at_a_time_across_controls(self):
        tk = FakeTakectl()
        s, log, _ = surface(tk)

        async def preview_then_auto():
            first = s.handle(press("PREVIEW 1"))
            self.assertIsNone(s.handle(press("AUTO")))
            self.assertIsNone(s.handle(press("CUT")))
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
