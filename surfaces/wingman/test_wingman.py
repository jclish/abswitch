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
        panel = panel_lines()
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
        downs = {raw for raw, label in captures() if label.endswith(" down")}
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
