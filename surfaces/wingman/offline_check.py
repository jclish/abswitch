#!/usr/bin/env python3
"""The adapter against the real takectl, on test/mock-mimolive.mjs: no Bluetooth, no mimoLive.

    python3 offline_check.py            (from surfaces/wingman/; needs node, and :18991 and :18989 free)
    WINGMAN_DIR=<dir> python3 offline_check.py   checks another copy of the adapter (falsification)

Surface packets are fed to the adapter exactly as the Bluetooth callback would, armed, so what is
checked is what takectl did with them: the off-air document's look, and that Program never moved.
The mock's A and B both hold two Layer Sets, "Speaker Wide" and "Slides PiP"; its MASTER has two
downstream keys, "DSK Bug" and "DSK Clock". Output: offline_check.txt.
"""

import asyncio
import json
import socket
import os
import subprocess
import sys
import tempfile
import threading
import time
from urllib.request import urlopen

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)  # test_wingman's packet builder
sys.path.insert(0, os.environ.get("WINGMAN_DIR", HERE))  # the adapter under test, first
import wingman_abswitch as W  # noqa: E402
import wingman_protocol as P  # noqa: E402
from test_wingman import press, two_record_captures  # noqa: E402  (packets as the Surface builds and sends them, held to captures.txt)


def bank_names(writes):
    names = {P.tally_bank(n, lit): f"{n} {lit or 'dark'}" for n in P.TALLY_FIRST_ID for lit in (None, *range(1, P.TALLY_BUTTONS + 1))}
    return [names.get(w, "?") for w in writes]

TP, MP = 18991, 18989  # this check's own takectl and mock: never :8991, where an operator's takectl runs
T = f"http://127.0.0.1:{TP}"
out, fails = [], 0


def say(line):
    out.append(line)
    print(line, flush=True)


def check(ok, what):
    global fails
    fails += 0 if ok else 1
    say(f"{'PASS' if ok else 'FAIL'}  {what}")


def get(path, timeout=10):
    with urlopen(T + path, timeout=timeout) as r:
        return json.loads(r.read())


def until(fn, seconds):
    end = time.time() + seconds
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except OSError:
            pass
        time.sleep(0.1)
    return None


def looks():
    s = get("/state")
    return s["pgm"], s["pvw"], dict(s.get("looks") or {})


def dsk_live():
    """MASTER's downstream key layers on the mock, name -> live-state: what mimoLive itself would show."""
    with urlopen(f"http://127.0.0.1:{MP}/api/v1/documents/333/layers", timeout=5) as r:
        return {x["attributes"]["name"]: x["attributes"]["live-state"] for x in json.loads(r.read())["data"] if x["attributes"]["name"].startswith("DSK ")}


def listening(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main():
    # Refuse to start if anything already holds the ports: something there would answer in place of this
    # check's own takectl (which then cannot start), and every press below would go to it. That happened
    # once, 2026-11-13, when this check used :8991 and the bench's takectl was up; it now has its own port.
    busy = [p for p in (TP, MP) if listening(p)]
    if busy:
        print(f"REFUSED: something is already listening on {', '.join(':' + str(p) for p in busy)} (an operator's takectl?).\n"
              "This check starts its own takectl there; stop the other one first. Nothing was sent.", flush=True)
        sys.exit(2)
    procs = []
    tmp = tempfile.mkdtemp(prefix="abswitch-wingman-")
    try:
        procs.append(subprocess.Popen(["node", os.path.join(ROOT, "test", "mock-mimolive.mjs"), str(MP)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        time.sleep(0.5)
        with open(os.path.join(ROOT, "takectl.config.example.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        for k in ("a", "b", "master"):
            cfg[k]["host"] = f"http://localhost:{MP}"
        cfg["a"]["documentName"], cfg["b"]["documentName"], cfg["master"]["documentName"] = "PH-A", "PH-B", "PH-MASTER"
        cfg["master"]["sourceNameSafe"] = "SAFE Test Pattern"
        cfg["companion"] = {"host": None}
        cfg["port"] = TP
        cfg_file = os.path.join(tmp, "takectl.config.json")
        with open(cfg_file, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        procs.append(subprocess.Popen(["node", os.path.join(ROOT, "takectl.mjs")], env={**os.environ, "TAKECTL_CONFIG": cfg_file}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        if not until(lambda: (lambda s: s.get("ready") is not False and s.get("pgm"))(get("/state")), 9):
            check(False, "takectl came up on the mock")
            return
        # And make sure the takectl answering is this check's own, on the mock, before a single press.
        master_host = ((get("/state").get("docs") or {}).get("MASTER") or {}).get("host") or ""
        if procs[-1].poll() is not None or not master_host.endswith(f":{MP}"):
            check(False, f"the takectl on :{TP} is not this check's own on the mock (MASTER host {master_host!r}); nothing sent")
            return
        time.sleep(0.6)

        log = []
        surface = W.Surface(W.Takectl(T), armed=True, settle_s=0.0, log=log.append)
        surface.connected()

        def feed(data):
            for command in surface.handle(data):
                try:
                    asyncio.run(command)
                except Exception as e:  # the adapter must never raise; if it does, that is a failure, not a crash
                    check(False, f"the adapter raised {type(e).__name__}: {e}")

        keys = [x["name"] for x in get("/state")["layerSetsAll"]]
        say(f"key order from /state: {keys}")
        pgm0, pvw0, l0 = looks()
        say(f"start: PGM {pgm0} \"{l0.get(pgm0)}\", PVW {pvw0} \"{l0.get(pvw0)}\"")

        # P1  PREVIEW n puts key n's look in the off-air document; Program is untouched.
        for n in (1, 2, 1):
            feed(press(f"PREVIEW {n}"))
            pgm, pvw, lk = until(lambda: (lambda r: r if r[2].get(r[1]) == keys[n - 1] else None)(looks()), 3) or looks()
            check(lk.get(pvw) == keys[n - 1] and (pgm, pvw) == (pgm0, pvw0) and lk.get(pgm) == l0.get(pgm0),
                  f"P1 PREVIEW {n}: {pvw} shows \"{lk.get(pvw)}\" (key {n} is \"{keys[n - 1]}\"); PGM still {pgm} \"{lk.get(pgm)}\"")

        # P2  UP and an empty key send nothing: the look stays as it is.
        before = looks()
        feed(press("PREVIEW 1", down=False))
        feed(press(f"PREVIEW {len(keys) + 1}"))
        time.sleep(0.5)
        check(looks() == before and "empty" in log[-1], f"P2 UP and empty key {len(keys) + 1}: nothing changed ({log[-1].strip()})")

        # P3  The rest of the Surface sends nothing (PROGRAM and the T-bar as ruled; ON AIR is not PANIC).
        dsk0 = dsk_live()
        for name in ("PROGRAM 1", "PROGRAM 2", "ON AIR", "PIP T-BAR", "PLUS", "AFV 1"):
            feed(press(name))
        time.sleep(0.5)
        check(looks() == before and dsk_live() == dsk0, "P3 PROGRAM 1-2, ON AIR, PIP T-BAR, PLUS, AFV 1: nothing changed, looks or downstream keys")

        # P4  A press during a TAKE: takectl refuses it, the adapter says so, and nothing lands late.
        get("/rate?s=2")
        pgm, pvw, lk = looks()
        other = next(k for k in keys if k != lk.get(pgm))  # a look the document going off air does not hold
        take = threading.Thread(target=lambda: get("/take", timeout=15))
        take.start()
        time.sleep(0.3)
        feed(press(f"PREVIEW {keys.index(other) + 1}"))
        refused = log[-1]
        take.join()
        until(lambda: (lambda r: r if r[0] == pvw else None)(looks()), 6)
        time.sleep(1.0)
        after = looks()
        check("refused" in refused and after[0] == pvw and after[2] == lk and other not in after[2].values(),
              f"P4 PREVIEW \"{other}\" during a TAKE: \"{refused.strip()}\"; landed PGM {after[0]}, looks unchanged {after[2]}")

        def mock_switches(since):
            with urlopen(f"http://127.0.0.1:{MP}/mock/log", timeout=5) as r:
                return [e["what"] for e in json.loads(r.read())["log"] if e["t"] >= since and e["what"].startswith("MASTER ")]

        def settled():
            return until(lambda: (lambda s: s if not s.get("busy") and not (s.get("switcher") or {}).get("inFlight") else None)(get("/state")), 8)

        def mock_now():
            with urlopen(f"http://127.0.0.1:{MP}/mock/log", timeout=5) as r:
                return json.loads(r.read())["now"]

        # The switcher slot each document sits in, from takectl's own setup (its /state switcher view can lag).
        master = get("/state")["docs"]["MASTER"]
        slot_of = {"A": master["slotA"], "B": master["slotB"]}

        # P5  AUTO is TAKE: the off-air document goes to Program with the panel's MIX.
        settled()
        pgm, pvw, _ = looks()
        t0 = mock_now()
        feed(press("AUTO"))
        sent = log[-1]
        s = settled()
        check(s["pgm"] == pvw and (s.get("lastTake") or {}).get("transition") == "dissolve" and mock_switches(t0) == [f"MASTER dissolve {slot_of[pvw]}"],
              f"P5 AUTO: \"{sent.strip()}\"; PGM {pgm} -> {s['pgm']}, {(s.get('lastTake') or {}).get('transition')}; switcher saw {mock_switches(t0)}")

        # P6  CUT is CUT: always bare, whatever the panel's transition.
        pgm, pvw, _ = looks()
        t0 = mock_now()
        feed(press("CUT"))
        sent = log[-1]
        s = settled()
        check(s["pgm"] == pvw and (s.get("lastTake") or {}).get("transition") == "cut" and mock_switches(t0) == [f"MASTER cut {slot_of[pvw]}"],
              f"P6 CUT: \"{sent.strip()}\"; PGM {pgm} -> {s['pgm']}, {(s.get('lastTake') or {}).get('transition')}; switcher saw {mock_switches(t0)}")

        # P7  AUTO pressed twice, the second during the dissolve: one TAKE, and the second says why not.
        pgm, pvw, _ = looks()
        t0 = mock_now()
        feed(press("AUTO"))
        feed(press("AUTO"))
        second = log[-1]
        s = settled()
        time.sleep(1.0)
        seen = mock_switches(t0)
        check(len(seen) == 1 and get("/state")["pgm"] == pvw and "not sent" in second,
              f"P7 AUTO twice: second \"{second.strip()}\"; switcher saw {seen}; PGM {pgm} -> {get('/state')['pgm']}")

        # P8  The tally follows takectl. Set up key 1's look on air and in Preview (PREVIEW 1, AUTO, PREVIEW 1);
        #     then PREVIEW 2 lights PREVIEW 2 only, and AUTO lights PROGRAM 2 and PREVIEW 1, Program first.
        def in_preview(n):
            return until(lambda: (lambda r: r if r[2].get(r[1]) == keys[n - 1] else None)(looks()), 3)

        settled()
        feed(press("PREVIEW 1"))
        in_preview(1)
        feed(press("AUTO"))
        settled()
        feed(press("PREVIEW 1"))
        start = in_preview(1)
        writes, tlog = [], []

        async def write(data):
            writes.append(bytes(data))

        tally = W.Tally(W.Takectl(T), write, log=tlog.append)
        asyncio.run(tally.refresh())
        at_start = list(writes)
        feed(press("PREVIEW 2"))
        in_preview(2)
        asyncio.run(tally.refresh())
        after_preview = writes[len(at_start):]
        feed(press("AUTO"))
        settled()
        asyncio.run(tally.refresh())
        after_take = writes[len(at_start) + len(after_preview):]
        n = len(writes)
        asyncio.run(tally.refresh())
        want = ([P.tally_bank("PROGRAM", 1), P.tally_bank("PREVIEW", 1)], [P.tally_bank("PREVIEW", 2)], [P.tally_bank("PROGRAM", 2), P.tally_bank("PREVIEW", 1)])
        check(start is not None and (at_start, after_preview, after_take) == want and len(writes) == n,
              f"P8 tally: at the start {bank_names(at_start)}, after PREVIEW 2 {bank_names(after_preview)}, after AUTO "
              f"{bank_names(after_take)}; then {len(writes) - n} more on a poll with nothing changed")

        # P9  Two buttons at the same instant, as the Surface sent them: one notification holding PREVIEW 1 DOWN and
        #     PREVIEW 3 DOWN (captures.txt, 2026-11-14). Each record is judged in order as if it came alone: key 1's
        #     look goes to Preview, and PREVIEW 3 is dropped by the in-flight rule. Start with key 2 in Preview.
        pair = two_record_captures("down")[0]
        settled()
        feed(press("PREVIEW 2"))
        in_preview(2)
        pgm, pvw, lk = looks()
        mark = len(log)
        feed(pair)
        landed = in_preview(1)
        time.sleep(0.5)
        after = looks()
        lines = [line.strip() for line in log[mark:]]
        check(landed is not None and after[:2] == (pgm, pvw) and after[2].get(pgm) == lk.get(pgm) and any("PREVIEW 3 DOWN" in x and "dropped" in x for x in lines),
              f"P9 PREVIEW 1 and 3 in one notification: {after[1]} shows \"{after[2].get(after[1])}\" (key 1 is \"{keys[0]}\"); "
              f"PGM still {after[0]}; the adapter: {lines}")

        # P10 The graphics buttons toggle MASTER's downstream keys (the pen's brief, 2026-11-19, stage 1). The
        #     settings put LOGO ON on "Bug" and TITLE ON on "clock" (takectl's own spelling is what is sent);
        #     U.N-TITLE ON and SUPER FG ON keep their defaults, Up Next and SuperFG, which MASTER does not have.
        labels = {**W.DSK_DEFAULTS, "LOGO ON": "Bug", "TITLE ON": "clock"}
        report = []
        W.dsk_at_start(W.Takectl(T), labels, log=report.append)
        rep = {b: next((x.strip() for x in report if x.strip().startswith(b + ":")), "") for b in W.DSK_BUTTONS}
        check(rep["LOGO ON"] == "LOGO ON: DSK Bug" and rep["TITLE ON"] == "TITLE ON: DSK Clock"
              and all("sends nothing" in rep[b] for b in ("U.N-TITLE ON", "SUPER FG ON")),
              f"P10a at start: {[x.strip() for x in report]}")
        surface.dsk_labels = labels

        def toggled(layer, want):
            return until(lambda: dsk_live().get(layer) == want, 3)

        settled()
        start = looks()
        d0 = dsk_live()
        mark = len(log)
        feed(press("LOGO ON"))
        on = toggled("DSK Bug", "live")
        others_on = dsk_live()
        feed(press("LOGO ON"))
        off = toggled("DSK Bug", "off")
        lines = [x.strip() for x in log[mark:]]
        check(d0 == {"DSK Bug": "off", "DSK Clock": "off"} and on and off and others_on.get("DSK Clock") == "off" and looks() == start
              and any("sent /dsk?label=Bug: DSK Bug on" in x for x in lines) and any("sent /dsk?label=Bug: DSK Bug off" in x for x in lines),
              f"P10b LOGO ON twice: DSK Bug on, then off; DSK Clock left {others_on.get('DSK Clock')}; Program and looks untouched; the adapter: {lines}")

        mark = len(log)
        feed(press("U.N-TITLE ON"))
        feed(press("SUPER FG ON"))
        time.sleep(0.5)
        lines = [x.strip() for x in log[mark:]]
        check(dsk_live() == d0 and sum("nothing sent" in x and 'layer in MASTER' in x for x in lines) == 2,
              f"P10c U.N-TITLE ON and SUPER FG ON, whose layers MASTER lacks: nothing changed; the adapter: {lines}")

        # Mid-transition: a 2 s MIX started from the panel's side; TITLE ON while takectl is still busy with it.
        get("/rate?s=2")
        pgm, pvw, _ = looks()
        take = threading.Thread(target=lambda: get("/take", timeout=15))
        take.start()
        busy = until(lambda: (lambda s: s if s.get("busy") or (s.get("switcher") or {}).get("inFlight") else None)(get("/state")), 2)
        mark = len(log)
        feed(press("TITLE ON"))
        still_busy = (lambda s: bool(s.get("busy") or (s.get("switcher") or {}).get("inFlight")))(get("/state"))
        clock_on = toggled("DSK Clock", "live")
        take.join()
        landed = settled()
        lines = [x.strip() for x in log[mark:]]
        check(busy is not None and still_busy and clock_on and landed and landed["pgm"] == pvw and any("sent /dsk?label=Clock: DSK Clock on" in x for x in lines),
              f"P10d TITLE ON mid-transition (busy at the press: {busy is not None}, after: {still_busy}): DSK Clock {dsk_live().get('DSK Clock')}; "
              f"the TAKE still landed, PGM {pgm} -> {landed and landed['pgm']}; the adapter: {lines}")

        # In SAFE: PANIC, then TITLE ON (Clock off again) and LOGO ON (Bug on); Program stays SAFE.
        get("/panic")
        in_safe = until(lambda: get("/state").get("pgm") == "SAFE", 3)
        mark = len(log)
        feed(press("TITLE ON"))
        clock_off = toggled("DSK Clock", "off")
        feed(press("LOGO ON"))
        bug_on = toggled("DSK Bug", "live")
        lines = [x.strip() for x in log[mark:]]
        check(in_safe and clock_off and bug_on and get("/state").get("pgm") == "SAFE",
              f"P10e in SAFE: TITLE ON -> DSK Clock {dsk_live().get('DSK Clock')}, LOGO ON -> DSK Bug {dsk_live().get('DSK Bug')}; "
              f"PGM {get('/state').get('pgm')}; the adapter: {lines}")
    finally:
        for p in reversed(procs):
            p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
        say(f"{'ALL PASS' if fails == 0 else f'{fails} FAILED'}")
        if not os.environ.get("WINGMAN_DIR"):
            with open(os.path.join(HERE, "offline_check.txt"), "w", encoding="utf-8") as f:
                f.write("\n".join(out) + "\n")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
