#!/usr/bin/env python3
"""Falsification: break one mechanism per copy of the adapter and show the checks catch each.

    python3 falsify.py           (from surfaces/wingman/; the offline check needs :8991 and :18989 free)

Every mutant must FAIL test_wingman.py; the ones that change what reaches takectl must also fail
offline_check.py. A mutant that passes means a check is vacuous. Output: falsify.txt.
"""

import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
A, P = "wingman_abswitch.py", "wingman_protocol.py"

# (name, file, text to replace, replacement, also run the offline check)
MUTANTS = [
    ("M1 acts on UP, not DOWN", A, "event.down is True and event.name in ACTIONS", "event.down is False and event.name in ACTIONS", False),
    ("M2 no in-flight guard", A, "        if self.busy:\n", "        if False:\n", False),
    ("M3 no settle window", A, "if self.ready_at is None or self.clock() < self.ready_at:", "if False:", False),
    ("M4 check byte not checked", P, "    if check_byte(packet[:7]) != packet[7]:\n", "    if False:\n", False),
    ("M5 PREVIEW n is the wrong key", A, 'name = looks[n - 1]["name"]', 'name = looks[n % len(looks)]["name"]', True),
    ("M6 PROGRAM buttons recall too", A, '"AUTO": ("take", None),',
     '"AUTO": ("take", None), **{f"PROGRAM {n}": ("preview", n) for n in range(1, 7)},', True),
    ("M7 look name not encoded", A, '"/pvw/layer-set?name=" + quote(name, safe="")', '"/pvw/layer-set?name=" + name', True),
    ("M8 a failed command is retried", A, "        except (URLError, TimeoutError, OSError, ValueError) as e:\n",
     "        except (URLError, TimeoutError, OSError, ValueError) as e:\n            try:\n                await asyncio.to_thread(self.takectl.get, \"/state\")\n            except Exception:\n                pass\n", False),
    ("M9 dry run sends anyway", A, "            if not self.armed:\n", "            if False:\n", False),
    ("M10 button map drifts from the monitor", P, '    0x21: "AUTO",', '    0x21: "CUT",', False),
    ("M11 an empty key recalls the last look", A, "                if n > len(looks):\n", "                if not looks:\n", False),
    ("M12 AUTO sends CUT", A, '"AUTO": ("take", None)', '"AUTO": ("cut", None)', True),
    ("M13 a transition in flight is not checked", A, '    if (s.get("switcher") or {}).get("inFlight"):\n', "    if False:\n", False),
    ("M14 the panel's greying is ignored", A, "                why = greyed(state)\n", "                why = None\n", False),
    ("M15 a TAKE with no answer is sent again", A,
     '        except TimeoutError:  # sent, and takectl did not answer: it may still act, so this must not say "nothing sent"\n',
     '        except TimeoutError:  # sent, and takectl did not answer: it may still act, so this must not say "nothing sent"\n'
     "            try:\n                await asyncio.to_thread(self.takectl.get, route, COMMAND_TIMEOUT_S)\n            except Exception:\n                pass\n", False),
    ("M16 a TAKE with no answer is called unsent", A, "no answer within {COMMAND_TIMEOUT_S:g} s; not retried. Look at the panel.",
     "takectl not reachable; nothing sent", False),
]


def run(cmd, env):
    r = subprocess.run([sys.executable, "-I", *cmd], cwd=HERE, env=env, capture_output=True, text=True, timeout=180)
    return r.returncode, (r.stdout + r.stderr)


def failed_tests(text):
    return [line.split(" ", 2)[1] for line in text.splitlines() if line.startswith(("FAIL: ", "ERROR: "))]


def offline_fails(text):
    """The FAIL lines of an offline check. A crash is not a catch: it proves nothing about the adapter."""
    return [x for x in text.splitlines() if x.startswith("FAIL ")]


def main():
    out, vacuous = [], 0
    rc, _ = run(["test_wingman.py"], dict(os.environ))
    rc2, text2 = run(["offline_check.py"], dict(os.environ))
    out.append(f"unmutated: test_wingman {'passes' if rc == 0 else 'FAILS'}; offline_check {'passes' if rc2 == 0 and not offline_fails(text2) else 'FAILS'}")
    vacuous += (rc != 0) + (rc2 != 0)
    for name, file, old, new, offline in MUTANTS:
        d = tempfile.mkdtemp(prefix="wingman-mutant-")
        for f in (A, P):
            shutil.copy(os.path.join(HERE, f), d)
        with open(os.path.join(d, file), encoding="utf-8") as f:
            src = f.read()
        if src.count(old) != 1:
            out.append(f"{name}: NOT APPLIED (the text to break is not there once)")
            vacuous += 1
            continue
        with open(os.path.join(d, file), "w", encoding="utf-8") as f:
            f.write(src.replace(old, new))
        env = {**os.environ, "WINGMAN_DIR": d}
        rc, text = run(["test_wingman.py"], env)
        failed = failed_tests(text)
        caught = rc != 0 and bool(failed)
        line = f"{name}: test_wingman {'caught it (' + ', '.join(failed) + ')' if caught else 'MISSED IT'}"
        vacuous += 0 if caught else 1
        if offline:
            rc2, text2 = run(["offline_check.py"], env)
            fails = offline_fails(text2)
            line += f"; offline_check {'caught it (' + ' | '.join(f[6:96] for f in fails) + ')' if rc2 and fails else 'MISSED IT' + (' (it crashed)' if rc2 else '')}"
            vacuous += 0 if rc2 and fails else 1
        out.append(line)
        shutil.rmtree(d, ignore_errors=True)
    out.append("every mutant caught" if vacuous == 0 else f"{vacuous} MISSED")
    print("\n".join(out))
    with open(os.path.join(HERE, "falsify.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    sys.exit(1 if vacuous else 0)


if __name__ == "__main__":
    main()
