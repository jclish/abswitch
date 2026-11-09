#!/usr/bin/env python3
"""saved-docs-check: verify the SAVED .tvshow bundles (not the live app) carry the finished build.

    python3 -I test/saved-docs-check.py [DIR]      # DIR holds PH-A/PH-B/PH-MASTER.tvshow (default ~/Desktop)

Checks:
  - PH-A, PH-B: the four Layer Sets match documents/README.md, with TALLY and COUNTER in none of
    them; Two Shot's Layout is 1 (2 x 1).
  - PH-A, PH-B, release state: no COUNTER layer at all (it is a bench instrument, added back only
    for bench test 3), and TALLY present and saved OFF (takectl lights it; a document must not
    open red without takectl).
  - PH-MASTER: NDI PH-A and NDI PH-B each carry a Scale & Transform filter at Custom 1920x1080,
    Zoom 105.

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
    two = next(l for l in p["layers"] if l["name"] == "Two Shot")
    lay = find(two, "tvGroup_Control__Layout")
    if lay != 1:
        fails.append(f"{doc}: Two Shot Layout = {lay} (want 1 = 2 x 1)")
    print(f"{doc}: {len(sets)} layer sets checked; Two Shot Layout = {lay}; COUNTER "
          f"{'present' if any(l['name'] == 'COUNTER' for l in p['layers']) else 'absent'}; TALLY saved "
          f"{'live' if tally and 'liveSetting' in tally[0] else 'off'}")

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

print("\n".join("FAIL " + f for f in fails) if fails else "ALL PASS")
sys.exit(1 if fails else 0)
