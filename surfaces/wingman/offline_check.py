#!/usr/bin/env python3
"""The adapter against the real takectl, on test/mock-mimolive.mjs: no Bluetooth, no mimoLive.

    python3 offline_check.py            (from surfaces/wingman/; needs node, and :8991 and :18989 free)
    WINGMAN_DIR=<dir> python3 offline_check.py   checks another copy of the adapter (falsification)

Surface packets are fed to the adapter exactly as the Bluetooth callback would, armed, so what is
checked is what takectl did with them: the off-air document's look, and that Program never moved.
The mock's A and B both hold two Layer Sets, "Speaker Wide" and "Slides PiP". Output: offline_check.txt.
"""

import asyncio
import json
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
from test_wingman import press  # noqa: E402  (a packet as the Surface builds it, held to captures.txt)

T, MP = "http://127.0.0.1:8991", 18989
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


def main():
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
        cfg_file = os.path.join(tmp, "takectl.config.json")
        with open(cfg_file, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        procs.append(subprocess.Popen(["node", os.path.join(ROOT, "takectl.mjs")], env={**os.environ, "TAKECTL_CONFIG": cfg_file}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        if not until(lambda: (lambda s: s.get("ready") is not False and s.get("pgm"))(get("/state")), 9):
            check(False, "takectl came up on the mock")
            return
        time.sleep(0.6)

        log = []
        surface = W.Surface(W.Takectl(T, timeout=10), armed=True, settle_s=0.0, log=log.append)
        surface.connected()

        def feed(data):
            command = surface.handle(data)
            if command is not None:
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

        # P3  The rest of the Surface sends nothing (PROGRAM, AUTO, CUT and the others are not mapped yet).
        for name in ("PROGRAM 1", "PROGRAM 2", "AUTO", "CUT", "ON AIR", "TITLE ON"):
            feed(press(name))
        time.sleep(0.5)
        check(looks() == before, "P3 PROGRAM 1-2, AUTO, CUT, ON AIR, TITLE ON: nothing changed")

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
