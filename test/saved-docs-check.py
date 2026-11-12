#!/usr/bin/env python3
"""saved-docs-check: verify the SAVED .tvshow bundles (not the live app) carry the finished build.

    python3 -I test/saved-docs-check.py [DIR]      # DIR holds PH-A/PH-B/PH-MASTER.tvshow (default ~/Desktop)

Checks:
  - PH-A, PH-B: the four Layer Sets match documents/README.md, with TALLY and COUNTER in none of
    them; Two Shot's Layout is 1 (2 x 1).
  - PH-A, PH-B (v0.2): one "Lower Third" layer, saved OFF, directly under TALLY, in no Layer Set
    (takectl's hooks bring it in; a Layer Set recall must never touch it).
  - PH-A, PH-B, release state: no COUNTER layer at all (it is a bench instrument, added back only
    for bench test 3), and TALLY present and saved OFF (takectl lights it; a document must not
    open red without takectl).
  - PH-MASTER: NDI PH-A and NDI PH-B each carry a Scale & Transform filter at Custom 1920x1080,
    Zoom 105.
  - PH-MASTER (v0.2): a STINGER layer and an FTB layer exist, each exactly once, both saved OFF, and
    above the AB Switcher (FTB on top, then STINGER).
  - PH-MASTER (v0.2 round 3, downstream keys): one "DSK Bug" and one "DSK Clock", saved OFF, above the
    AB Switcher and under FTB (takectl's DSK toggles are the MASTER layers named "DSK <label>").
  - PH-MASTER (v0.2, safe source): a source "SAFE Test Pattern" exists once and sits in the AB
    Switcher's slot 3 (tvIn_VideoSourceCImage holds its identifier). The bench slate PANIC cuts to.

Saved layer-set action codes, read from a 7.0b3 save: 0 = live, 1 = off.
A layer saved live carries a `liveSetting` key; one saved off has none (read from 7.0b3 saves on
2026-11-09: PH-A's TALLY gained `liveSetting` when it was saved lit, and nothing else changed).
"""
import os
import plistlib
import sys

D = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/Desktop")
WANT = {
    "Speaker Wide": {"Cam Wide": "live", "Two Shot": "off", "Cam PiP": "off", "Slides": "off"},
    "Two Shot": {"Two Shot": "live", "Cam Wide": "off", "Cam PiP": "off", "Slides": "off"},
    "Slides PiP": {"Slides": "live", "Cam PiP": "live", "Cam Wide": "off", "Two Shot": "off"},
    "Full Slides": {"Slides": "live", "Cam Wide": "off", "Two Shot": "off", "Cam PiP": "off"},
}
ACTION = {0: "live", 1: "off"}
fails = []


def load(name):
    with open(os.path.join(D, f"{name}.tvshow", "Document.plist"), "rb") as f:
        return plistlib.load(f)


def find(node, key):
    """First value for `key` anywhere under node."""
    if isinstance(node, dict):
        if key in node:
            return node[key]
        node = list(node.values())
    if isinstance(node, list):
        for v in node:
            r = find(v, key)
            if r is not None:
                return r
    return None


for doc in ("PH-A", "PH-B"):
    p = load(doc)
    names = {l["identifier"]: l["name"] for l in p["layers"]}
    sets = {s["name"]: s for s in p["documentState"]["layerSets"]}
    if set(sets) != set(WANT):
        fails.append(f"{doc}: layer sets {sorted(sets)}")
    for sn, want in WANT.items():
        s = sets.get(sn)
        if not s:
            continue
        got = {names.get(e["layerIdentifier"], e["layerIdentifier"]): ACTION.get(e["action"][0], e["action"][0])
               for e in s["layerSettings"]}
        if got != want:
            fails.append(f"{doc} {sn}: {got}")
        if {"TALLY", "COUNTER"} & set(got):
            fails.append(f"{doc} {sn}: includes TALLY/COUNTER")
    if any(l["name"] == "COUNTER" for l in p["layers"]):
        fails.append(f"{doc}: has a COUNTER layer (bench only: delete it before shipping)")
    tally = [l for l in p["layers"] if l["name"] == "TALLY"]
    if len(tally) != 1:
        fails.append(f"{doc}: {len(tally)} TALLY layers (want 1)")
    elif "liveSetting" in tally[0]:
        fails.append(f"{doc}: TALLY saved live (switch it off and save)")
    lower = [l for l in p["layers"] if l["name"] == "Lower Third"]
    in_sets = [sn for sn, st in sets.items() if any(names.get(e["layerIdentifier"]) == "Lower Third" for e in st["layerSettings"])]
    order = [l["name"] for l in p["layers"]]
    if len(lower) != 1:
        fails.append(f"{doc}: {len(lower)} Lower Third layers (want 1: run documents/build-documents.mjs, then save)")
    else:
        if "liveSetting" in lower[0]:
            fails.append(f"{doc}: Lower Third saved live (switch it off and save)")
        if in_sets:
            fails.append(f"{doc}: Lower Third is in Layer Set(s) {in_sets} (it must be in none)")
        if "TALLY" in order and abs(order.index("Lower Third") - order.index("TALLY")) != 1:
            fails.append(f"{doc}: Lower Third is not directly under TALLY (stack {order})")
    two = next(l for l in p["layers"] if l["name"] == "Two Shot")
    lay = find(two, "tvGroup_Control__Layout")
    if lay != 1:
        fails.append(f"{doc}: Two Shot Layout = {lay} (want 1 = 2 x 1)")
    print(f"{doc}: {len(sets)} layer sets checked; Two Shot Layout = {lay}; COUNTER "
          f"{'present' if any(l['name'] == 'COUNTER' for l in p['layers']) else 'absent'}; TALLY saved "
          f"{'live' if tally and 'liveSetting' in tally[0] else 'off'}; Lower Third "
          f"{'absent' if not lower else ('saved live' if 'liveSetting' in lower[0] else 'saved off')}{', in sets ' + str(in_sets) if in_sets else ''}")

m = load("PH-MASTER")
for src in ("NDI PH-A", "NDI PH-B"):
    s = next((x for x in m["sources"] if x.get("name") == src), None)
    fl = [f for f in (s or {}).get("filters", []) if f.get("filterIdentifier") == "com.boinx.boinxtv.filter.transform"]
    if len(fl) != 1:
        fails.append(f"PH-MASTER {src}: {len(fl)} Scale & Transform filters")
        continue
    v = {k: find(fl[0], f"tvGroup_Geometry__{k}") for k in ("Mode", "Width", "Height", "Zoom")}
    if v != {"Mode": 0, "Width": 1920, "Height": 1080, "Zoom": 105}:
        fails.append(f"PH-MASTER {src}: {v}")
    print(f"PH-MASTER {src}: {v}")

order = [l["name"] for l in m["layers"]]
for name in ("STINGER", "FTB"):
    ls = [l for l in m["layers"] if l["name"] == name]
    if len(ls) != 1:
        fails.append(f"PH-MASTER: {len(ls)} {name} layers (want 1: run documents/build-documents.mjs, then save)")
    elif "liveSetting" in ls[0]:
        fails.append(f"PH-MASTER: {name} saved live (switch it off and save)")
# Saved layer order: the plist lists layers in stack order; which end is the top is read from the
# switcher's place (it is at the bottom of MASTER's stack).
if all(n in order for n in ("STINGER", "FTB", "AB Switcher")):
    top_first = order.index("AB Switcher") > order.index("STINGER")
    stack = order if top_first else order[::-1]
    if not stack.index("FTB") < stack.index("STINGER") < stack.index("AB Switcher"):
        fails.append(f"PH-MASTER: stack {stack} (want FTB above STINGER above AB Switcher)")
    print(f"PH-MASTER stack (top first): {stack}; STINGER saved "
          f"{'live' if any(l['name'] == 'STINGER' and 'liveSetting' in l for l in m['layers']) else 'off'}, FTB saved "
          f"{'live' if any(l['name'] == 'FTB' and 'liveSetting' in l for l in m['layers']) else 'off'}")

for name in ("DSK Bug", "DSK Clock"):
    ls = [l for l in m["layers"] if l["name"] == name]
    if len(ls) != 1:
        fails.append(f"PH-MASTER: {len(ls)} {name} layers (want 1: run documents/build-documents.mjs, then save)")
        continue
    if "liveSetting" in ls[0]:
        fails.append(f"PH-MASTER: {name} saved live (switch it off and save)")
    if all(n in order for n in ("FTB", "AB Switcher")):
        top = order if order.index("AB Switcher") > order.index("FTB") else order[::-1]
        if not top.index("FTB") < top.index(name) < top.index("AB Switcher"):
            fails.append(f"PH-MASTER: {name} is not between FTB and the AB Switcher (stack {top})")
print(f"PH-MASTER downstream keys: " + ", ".join(f"{n} {'saved live' if any(l['name'] == n and 'liveSetting' in l for l in m['layers']) else ('saved off' if any(l['name'] == n for l in m['layers']) else 'absent')}" for n in ("DSK Bug", "DSK Clock")))

safe = [x for x in m["sources"] if x.get("name") == "SAFE Test Pattern"]
sw = next((l for l in m["layers"] if l["name"] == "AB Switcher"), None)
slot3 = find(sw, "tvIn_VideoSourceCImage") if sw else None
if len(safe) != 1:
    fails.append(f"PH-MASTER: {len(safe)} \"SAFE Test Pattern\" sources (want 1: run documents/build-documents.mjs, then save)")
elif slot3 != safe[0].get("identifier"):
    fails.append(f"PH-MASTER: AB Switcher slot 3 holds {slot3!r}, not SAFE Test Pattern ({safe[0].get('identifier')})")
print(f"PH-MASTER safe source: {'SAFE Test Pattern in slot 3' if safe and slot3 == safe[0].get('identifier') else 'missing or not in slot 3'}")

print("\n".join("FAIL " + f for f in fails) if fails else "ALL PASS")
sys.exit(1 if fails else 0)
