# The three documents

`PH-A.tvshow`, `PH-B.tvshow`, `PH-MASTER.tvshow` (mimoLive 7.0b3 build 30982, 1920×1080 @ 30).

## How they were built

The operator created three blank documents and saved them once. They opened at 1280×720, and the script
set them to 1920×1080. Everything else was built through the HTTP API by
`build-documents.mjs`, which is re-runnable:

```
node documents/build-documents.mjs
```

It finds things by name and only creates what is missing. It reads back every write, because on
7.0b3 a wrongly shaped write returns HTTP 200 and does nothing. Whatever the API would not take,
it prints as a manual step.

**Third-party files:** each `.tvshow` bundle carries mimoLive's own layer compositions
(`Layers/*.qtz`), copied in by mimoLive when the document is saved. They belong to Boinx Software
and are not covered by this project's MIT license.

**PH-A / PH-B** — layer stack, top first:

| Layer | Type | Source | Starts |
|---|---|---|---|
| `TALLY` | Box, red, 24 px bar across the top | — | off (takectl owns it) |
| `Lower Third` | Lower Third (Manual), "Lower Third" / "abswitch bench" | — | off; in **no** Layer Set: takectl's hooks bring it in and out |
| `Cam PiP` | PIP Window | CAM 1 | off |
| `Two Shot` | Split Screen 2×1 | CAM 1, CAM 2 | off |
| `Cam Wide` | Placer | CAM 1 | live |
| `Slides` | Placer | SLIDES | off |

Not in the release: the bench stopwatch `COUNTER` (Stopwatch, 1/100 s, live). Only
`BENCH_COUNTER=1 node documents/build-documents.mjs` adds it, for bench test 3; see the top-level
README, Bench protocol. The saved-files check refuses a package that still has it.

**Camera stand-ins:**
- `CAM 1` / `CAM 2` are Placeholder sources: A shows the letters A/C, B shows B/D.
- `SLIDES` is a test chart: SMPTE bars in A, PM5544 in B.
- These make A and B tell-apart at a glance. I used placeholders because NDI Test Patterns gives
  one shared sender, which would make A and B look identical.

**Outputs:** one NDI output titled `PH-A` / `PH-B`, Start with show. These documents contain no
audio sources, so their NDI carries no programme audio.

**Layer Sets:** `Speaker Wide`, `Two Shot`, `Slides PiP`, `Full Slides` exist by name but are
**empty**. The API cannot record their contents.

**PH-MASTER:**
- **Sources:** `NDI PH-A` and `NDI PH-B` are Camera sources whose device is the NDI sender. 7.0b3
  has no separate NDI source type, and it advertises the senders as `<HOST>.LOCAL (PHA)` / `(PHB)`,
  with the hyphen dropped. `Audio In` is the built-in microphone for the bench.
- **Sources (v0.2):** `SAFE Test Pattern`, a Video Output Test source showing Philips PM5544: the
  **bench** slate PANIC cuts to. For a show, put a wide camera wired straight into MASTER, or a
  holding slide, in slot 3 instead, and choose it in setup.
- **Layers, top first:**
  - `FTB` — Box, black, full frame, 0.5 s dissolve; off (round 3 wires it).
  - `STINGER` — Box, slate, full frame, wipes in from the left and out to the right in 0.4 s; off.
    The default stinger (no media needed); takectl sets it live over a TAKE.
  - `Program Audio` — Audio Only, fed from Audio In.
  - `AB Switcher` — Video Switcher; slot 1 = NDI PH-A, slot 2 = NDI PH-B, slot 3 = SAFE Test
    Pattern, slots 4–8 cleared, Source Count 4 (2 isn't offered), 0.5 s dissolve, no audio path.
- **Output:** `Recording` (File Recording to ~/Movies), Start with show.

## Done by hand

**Already done:**
- Creating and saving the three blank documents.
- Adding a **Scale & Transform** filter to `NDI PH-A` and `NDI PH-B` in PH-MASTER. The API cannot
  *add* a filter, but it can set the values of an existing one, so the build set them:
  Mode *Custom*, **1920 × 1080, Zoom 105**, everything else 0. Re-running the build re-applies them.
  - **Why these settings:**
    - The filter's defaults (500 × 500, Zoom 50) squash the picture.
    - The `1080p` preset hides Zoom.
    - Zoom is in percent of the 1920 × 1080 frame, so 100 = unchanged.
  - **Measured on MASTER's recording,** once per side with that side on air and its TALLY lit
    (`test/evidence/master-pgm-{A,B}-zoom*.png`): zoom 100 leaves 24 red rows, zoom 105 none.
  - **On-air cost:** about 27 px at top and bottom and 48 px each side. Keep titles and graphics
    in A/B inside that margin.
  - The Video Switcher has no zoom input on this build, and the README's 2.5 % only hides ~13 px.

- Recording the **Layer Sets** in PH-A and PH-B (2026-11-09):
  - **TALLY, COUNTER and Lower Third: "No Action"** in every set. Never record them as *Off*: a recall
    would then take the lower third out from under a hook.
  - **The other four layers: explicitly Live or Off** in every set (use Off, not Force Off):

  | Set | Live | Off |
  |---|---|---|
  | Speaker Wide | Cam Wide | Two Shot, Cam PiP, Slides |
  | Two Shot | Two Shot | Cam Wide, Cam PiP, Slides |
  | Slides PiP | Slides, Cam PiP | Cam Wide, Two Shot |
  | Full Slides | Slides | Cam Wide, Two Shot, Cam PiP |

  - **Why TALLY must not be recorded as off:**
    - A recall on the on-air document would put its tally out.
    - The on-air document's set could never read as `active` while TALLY is lit, so `/mirror` would fail.
  - **Why COUNTER must not be recorded as off:** a recall would freeze bench tests 1 and 3.
  - **Why the content layers must be explicit:** a layer the set doesn't touch stays as it was, so
    Cam PiP would survive a recall of Speaker Wide.
  - **Don't use "Update to reflect current Layer Stack"** in the set editor. It records every
    layer, TALLY and COUNTER included.
  - **How the API sees it:** a set's `layers` list holds only the layers it affects; an empty set
    reads `active: true`.
  - **How the saved file sees it:** `documentState.layerSets[].layerSettings`, where action 0 = live
    and 1 = off.
  - **Verified:** `test/layerset-check.mjs` (live app) and `test/saved-docs-check.py` (saved files).

**Saving:** press ⌘S in each document after any change. The API cannot save. `pack.sh` runs
`test/saved-docs-check.py` against the saved files and refuses a stale save.

**Nothing is left to do by hand** for the bench build. For a show, see below.

## For real cameras

In **PH-A and PH-B**:
1. Add one Camera source per NDI camera (device = that camera's NDI sender).
2. Point the layers at them: in the UI, each layer's source pop-up; or by API,
   `PUT /documents/<doc>/layers/<id>` with `{"input-values":{"tvIn_VideoSourceAImage":"<source id>"}}`
   (Two Shot also uses `…BImage`).
3. Delete `CAM 1`, `CAM 2`, `SLIDES`.
4. **No `COUNTER` layer** (the release has none). If one was added back for bench test 3, delete it:
   - It goes to air: MASTER shows it top-left, with its first digit clipped by the crop.
   - No Layer Set touches it, so nothing else will ever switch it off.
   - takectl refuses every TAKE and CUT while it is live in either document, and `doctor` reports it.
   - Deleting it is safe: no set and no part of takectl refers to it.
   - The bench tests that need it (`bench1-independence`, `guard-tally-check`, `record-take`) stop
     with directions to add it back.

**Leave alone:** layer names, TALLY, the Layer Sets (they store layers' on/off states, not
sources), the NDI outputs, and all of MASTER.

**One change in MASTER:** pick the show's audio interface on `Audio In`.

Nothing in `takectl.config.json` needs to change.

**API traps found while building (7.0b3):**
- Creates take a *flat* body.
- Layer `input-values` only land with a flat `PUT`; `PATCH` returns 200 and does nothing.
- Renames only land with a *wrapped* `PATCH {"data":{"attributes":{…}}}`.
- A slot is cleared with `""` (`null` is ignored).
- `?include=` returns `{}`.
- New layers go to the **bottom** unless created with `"index": 0`, and cannot be reordered afterwards.
- New layers auto-create a "Placeholder X" source for every empty slot. The script deletes them, but mimoLive recreates them every time a document is reopened. They aren't connected to anything and are harmless; ignore them.
- Box margins treat the full frame height as 2.0.
- Stopwatch: the `Reset` signal also *stops* it. Fire `Start` afterwards, which `test/record-take.mjs` does.
- Filters:
  - `POST …/sources/{id}/filters` is 404 for every body shape, so filters can't be added.
  - A flat `PUT …/filters/{id} {"input-values":{…}}` does set an existing filter.
- Enum `value-list`s can contain a `"-"` separator that is *not* an index. Two examples:
  - Scale & Transform's Mode list reads `Custom, -, Rotate…, Square, 1080p, 720p`, so 1080p is index 5, not 6.
  - Split Screen's Layout reads `Custom, -, 2 x 1, 3 x 1, …`, so 2 x 1 is index 1. The first build
    wrote 2 and got 3 x 1; this was fixed 2026-11-09.
- Re-PATCHing an NDI output with its current title kills the sender while it still reports "live".
