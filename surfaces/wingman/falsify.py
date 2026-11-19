#!/usr/bin/env python3
"""Falsification: break one mechanism per copy of the adapter and show the checks catch each.

    python3 falsify.py           (from surfaces/wingman/; the offline check needs :18991 and :18989 free)

Every mutant must FAIL test_wingman.py; the ones that change what reaches takectl must also fail
offline_check.py. A mutant that passes means a check is vacuous. Output: falsify.txt.
"""

import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
A, P, L = "wingman_abswitch.py", "wingman_protocol.py", "lamp_walk.py"

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
    ("M17 tally lit and off swapped", P, "0x00 if lit == i + 1 else 0x01", "0x01 if lit == i + 1 else 0x00", False),
    ("M18 the PREVIEW bank starts one id early", P, '"PREVIEW": 0x0D}', '"PREVIEW": 0x0C}', False),
    ("M19 a tally record's check byte is not its own", P, "out += first + bytes((check_byte(first),))",
     "out += first + bytes((check_byte(first[:6]),))", False),
    ("M20 a bank's write is six records, not twelve", P, "    for i in range(TALLY_RECORDS):\n", "    for i in range(TALLY_BUTTONS):\n", False),
    ("M21 a tally record read back counts as a press", P, "    if packet[6] != 0x00:\n", "    if False:\n", False),
    ("M22 a key past six lights a button", A, '(s.get("layerSetsAll") or [])][:TALLY_BUTTONS]', '(s.get("layerSetsAll") or [])]', False),
    # (SAFE on air lighting a PROGRAM button is not a mutant here: /state's looks only ever holds A and B.)
    ("M23 the Preview lamp follows Program's look", A, 'key(looks.get(s["pvw"]) if s.get("pvw")', 'key(looks.get(s["pgm"]) if s.get("pvw")', False),
    ("M24 the lamps are one key off", A, "return keys.index(look) + 1 if", "return keys.index(look) if", False),
    ("M25 a lamp is written on every poll", A, "            if bank in self.shown and self.shown[bank] == want[bank]:\n", "            if False:\n", True),
    ("M26 PREVIEW is written before PROGRAM", A, 'for bank in ("PROGRAM", "PREVIEW"):  # Program first', 'for bank in ("PREVIEW", "PROGRAM"):  # Program first', True),
    ("M27 a takectl outage darkens the lamps", A, "# as the panel keeps its last state\n            return\n",
     "# as the panel keeps its last state\n            state = {}\n", False),
    ("M28 a reconnect is not a full refresh", A, 'so the next refresh writes both banks."""\n        self.shown = {}\n',
     'so the next refresh writes both banks."""\n        pass\n', False),
    ("M29 the tally is written without a response", A, "data, response=True)", "data, response=False)", False),
    ("M30 the tally is written to FFE1", A, "client.write_gatt_char(TALLY_UUID,", "client.write_gatt_char(NOTIFY_UUID,", False),
    ("M31 a failed write counts as written", A, 'trying again")\n                return\n',
     'trying again")\n                self.shown[bank] = want[bank]\n                continue\n', False),
    ("M32 PREVIEW is written although PROGRAM failed", A, 'trying again")\n                return\n', 'trying again")\n                continue\n', False),
    ("M33 a write that never answers is waited on", A, "await asyncio.wait_for(self.write(tally_bank(bank, want[bank])), self.write_timeout_s)",
     "await self.write(tally_bank(bank, want[bank]))", False),
    ("M34 stopping leaves the lamps lit", A, "await asyncio.wait_for(self.write(tally_bank(bank, None)), self.write_timeout_s)", "pass", False),
    ("M35 the first refresh waits a poll", A, "        while not stop.is_set():\n            await self.refresh()\n",
     "        while not stop.is_set():\n            await asyncio.sleep(TALLY_POLL_S)\n            await self.refresh()\n", False),
    ("M36 a dead log stops the lamps", A, "    except OSError:  # the terminal or a pipe went away", "    except ZeroDivisionError:  # the terminal or a pipe went away", False),
    # Framing (ruled 2026-11-14): a notification is whole 8-byte records, each checked, in order.
    ("M37 a notification must be exactly 8 bytes, as before", P, "    if not data or len(data) % RECORD_BYTES:\n", "    if len(data) != RECORD_BYTES:\n", True),
    ("M38 a notification's records are read last first", P, "for i in range(0, len(data), RECORD_BYTES)]",
     "for i in reversed(range(0, len(data), RECORD_BYTES))]", True),
    ("M39 only a notification's first record is read", P, "range(0, len(data), RECORD_BYTES)]", "range(0, RECORD_BYTES, RECORD_BYTES)]", False),
    ("M40 a bad record does not spoil its notification", P, "    if failed and len(pairs) > 1:\n", "    if False:\n", False),
    ("M41 a record of unknown type is trusted beside another", P, '    if isinstance(event, Other):\n        return f"type 0x',
     '    if False:\n        return f"type 0x', False),
    ("M42 a button state neither DOWN nor UP is trusted beside another", P, "    if isinstance(event, Button) and event.down is None:\n",
     "    if False:\n", False),
    ("M43 a truncated notification's whole records are read", P, "    if not data or len(data) % RECORD_BYTES:\n        return [(data, Bad(",
     "    data = data[:len(data) - len(data) % RECORD_BYTES]\n    if not data:\n        return [(data, Bad(", False),
    ("M44 the adapter judges only a notification's first record", A, "        for record, event in decode_notification(data):\n",
     "        for record, event in decode_notification(data)[:1]:\n", False),
    ("M45 the adapter judges a notification's records last first", A, "        for record, event in decode_notification(data):\n",
     "        for record, event in reversed(decode_notification(data)):\n", True),
    ("M46 the Bluetooth callback runs no command", A, "        for command in self.handle(data):\n", "        for command in self.handle(data)[:0]:\n", False),
    # The lamp walk (lamp_walk.py): every position lit on its own, asked about, FFE2 only.
    ("M47 the walk stops at button 5", L, "        for n in range(1, TALLY_BUTTONS + 1):\n", "        for n in range(1, TALLY_BUTTONS):\n", False),
    ("M48 the walk lights one button and asks about another", L, 'walk.append(([(bank, n)], f"Is {bank} {n} the only',
     'walk.append(([(bank, n % TALLY_BUTTONS + 1)], f"Is {bank} {n} the only', False),
    ("M49 the walk leaves a bank lit going into the next", L, "        walk.append(([(bank, None)], ALL_DARK))\n", "", False),
    ("M50 the walk writes without a response", L, "data, response=True)", "data, response=False)", False),
    ("M51 the walk writes to FFE1", L, "client.write_gatt_char(TALLY_UUID,", "client.write_gatt_char(NOTIFY_UUID,", False),
    ("M52 a stopped walk leaves the lamps lit", L, '    finally:\n        for bank in ("PROGRAM", "PREVIEW"):\n',
     "    finally:\n        for bank in ():\n", False),
    ("M53 any answer but n passes", L, 'all(answer == "y" for', 'all(answer != "n" for', False),
    ("M54 a walk stopped early can pass", L, "    return len(answers) == len(steps()) and", "    return len(answers) >= 0 and", False),
    # Downstream keys (the pen's brief of 2026-11-19, stage 1): the four graphics buttons toggle "DSK <label>".
    ("M55 a DSK button toggles its neighbour's label", A, "                label = self.dsk_labels[n]\n",
     "                label = self.dsk_labels[DSK_BUTTONS[(DSK_BUTTONS.index(n) + 1) % len(DSK_BUTTONS)]]\n", True),
    ("M56 TITLE ON and U.N-TITLE ON defaults swapped", A, '"U.N-TITLE ON": "Up Next", "TITLE ON": "Title"', '"U.N-TITLE ON": "Title", "TITLE ON": "Up Next"', False),
    ("M57 a layer MASTER lacks is sent anyway", A, "            return k[\"label\"]\n    return None\n", "            return k[\"label\"]\n    return label\n", True),
    ("M58 a DSK is greyed mid-transition as TAKE is", A, "                why = dsk_greyed(state)\n", "                why = greyed(state)\n", True),
    ("M59 a DSK is sent while not ready", A, "                why = dsk_greyed(state)\n", "                why = None\n", False),
    ("M60 the settings' spelling is sent, not takectl's", A, '"/dsk?label=" + quote(key, safe="")', '"/dsk?label=" + quote(label, safe="")', False),
    ("M61 a DSK label is not encoded", A, '"/dsk?label=" + quote(key, safe="")', '"/dsk?label=" + key', False),
    ("M62 a settings typo falls back to the default", A, "        if button not in DSK_DEFAULTS:\n            raise SettingsError(",
     "        if button not in DSK_DEFAULTS:\n            continue\n            raise SettingsError(", False),
    ("M63 a settings file named but missing means the defaults", A, "        if path:\n            raise SettingsError(", "        if False:\n            raise SettingsError(", False),
    ("M64 the start report finds every layer", A, "        key = dsk_key(s, labels[button])\n", "        key = labels[button]\n", True),
    ("M65 no report at start", A, '    await asyncio.to_thread(dsk_at_start, Takectl(args.takectl), settings["dsk"])\n', "", False),
    ("M66 a DSK label must match takectl's case", A, 'if str(k.get("label", "")).lower() == label.lower():', 'if str(k.get("label", "")) == label:', True),
    ("M67 the presses ignore the settings", A, 'raw=args.raw, dsk_labels=settings["dsk"])', "raw=args.raw)", False),
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
        for f in (A, P, L):
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
