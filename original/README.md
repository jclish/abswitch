# abswitch — A/B composition switcher for mimoLive 7

Two mimoLive documents compose independently and alternate PGM/PVW roles. A third
document owns the only on-air output and performs the TAKE with its Video Switcher
layer. `takectl` is the brain: it knows which document is on air, fires the
transition, verifies it against mimoLive's own tally, lights tally in A and B,
and gives Companion/Stream Deck one button to press.

```
   cameras / Keynote / MyLowerThird  (NDI, shared)
              │              │
        ┌─────▼─────┐  ┌─────▼─────┐
        │  PH-A     │  │  PH-B     │   composition documents
        │  layers   │  │  layers   │   (video-only NDI out, TALLY layer on top)
        └─────┬─────┘  └─────┬─────┘
          NDI "PH-A"     NDI "PH-B"
              │              │
        ┌─────▼──────────────▼─────┐
        │  PH-MASTER               │   Video Switcher: slot1=PH-A slot2=PH-B
        │  audio from interface    │   program audio lives HERE only
        │  record / stream / NDI   │
        └─────────────▲────────────┘
                      │ HTTP API :8989  (signals, tally, datastore, websocket)
                ┌─────┴─────┐
                │  takectl  │ :8991   /take /cut /mirror /panic /state
                └─────▲─────┘
                      │ HTTP
               Companion / Stream Deck
```

Everything takectl does is in the public mimoLive 7.0b3 HTTP API
(https://mimolive.com/user-manual/remote-control-automation/http-api/endpoints/):

| takectl action | mimoLive API used |
|---|---|
| discover docs/layers/sources | `GET /documents`, `/layers`, `/sources`, `/output-destinations` |
| TAKE / CUT | `GET /documents/{M}/layers/{switcher}/signals/tvGroup_Control__Dis_n_TypeSignal` (or `Cut_n`) |
| who is on air (ground truth) | `GET /documents/{M}/sources/{ndiA}` → `attributes.tally-state` = `program` |
| tally lights in A/B | `GET /documents/{A}/layers/{TALLY}/setLive` / `setOff` |
| persist role state | `PUT /documents/{M}/datastores/abswitch-state` |
| mirror PGM look into PVW | `GET /documents/{PVW}/layer-sets/{id}/recall` |
| catch changes made outside takectl | `ws://host:8989/api/v1/socket` → `sources changed` |

## Build the three documents

**PH-A.tvshow and PH-B.tvshow** (identical; build one, Save As the other)
1. Show Settings: same size and frame rate as MASTER (1920×1080, 30 or 60 — pick one and match everywhere).
2. Add your NDI cameras, Keynote NDI, MyLowerThird browser source, etc.
3. Build the layer stack you want to switch between. Create Layer Sets for your standard looks
   (e.g. `Speaker Wide`, `Two Shot`, `Slides PiP`, `Full Slides`). **Use identical Layer Set names in A and B** — `/mirror` relies on that.
4. Top of the stack: a Box/Placer layer named exactly `TALLY` — a 24-px red border frame, or a solid red bar across the top,
   whatever you can see from across the room. Leave it **off**. takectl turns it on when that document is PGM.
   You will crop it out in MASTER (step 4 below), so the audience never sees it.
5. Output Destinations: add **NDI Output**, name it `PH-A` (`PH-B`), **Audio: none / muted**, Start with show ✓.
   Remove or disable every other output destination.
6. Do not put program audio in these documents. If a camera source carries audio, mute it in the layer.
7. Enable Settings → Remote Control → Allow Remote Control Access (no password, or set `apiPasswordSha256`).

**PH-MASTER.tvshow**
1. Same size/frame rate.
2. Sources: NDI `PH-A`, NDI `PH-B` (name them `NDI PH-A`, `NDI PH-B` to match the config), and the **audio interface** as an Audio Device source.
3. Layer stack, bottom to top:
   - **Video Switcher**, name it `AB Switcher`. Source Count = 2. Slot 1 = NDI PH-A, Slot 2 = NDI PH-B. Transition Duration = 0.5 s.
     Disable audio-follow-video on this layer (the switcher must not carry audio).
     If you kept a TALLY frame in A/B, set the switcher's geometry to zoom ~2.5 % so the frame is cropped off.
   - **Audio Only** layer fed by the audio interface — this is program audio.
   - Optional: a `MASTER TALLY` text layer that shows "A" / "B" (takectl can be extended to set its text).
4. Output Destinations: File Recording, Live Streaming, and/or NDI `PH-PGM` to the streaming Mac. Start with show ✓.
5. Right-click the switcher's "Cut 1" button → *Copy URL to Trigger Button*. Paste it in a browser.
   If it switches, the API is alive and takectl will find the same signal key automatically.

## Run

```
cp takectl.config.example.json takectl.config.json   # edit hosts / names
node takectl.mjs doctor      # discovery + preflight, exits non-zero on problems
node takectl.mjs             # runs the controller on :8991
```

`doctor` prints the signal keys it found. If `dis` is empty, your beta's Video Switcher uses
different input keys — copy the URL from the right-click menu and set the key names in the config
(open an issue; the regex in `Master.discover()` is the only place to touch).

Endpoints (all GET, all return JSON):

| | |
|---|---|
| `/take` | dissolve PVW → PGM, flip roles. Refused if busy or preflight fails. |
| `/cut` | same, hard cut |
| `/mirror` | recall PVW's Layer Set with the same name as PGM's active set (start the next look from the current one) |
| `/panic` | cut to A unconditionally, reset state |
| `/resync` | re-read tally and re-apply roles |
| `/state` | pgm, pvw, busy, raw tally, last error, recent events |

Preflight before every transition: target document is live, its NDI output is live, MASTER has a
signal for its slot. A failed preflight returns `ok:false` with the reason and does **not** touch MASTER.

## Companion page

Use the **Generic HTTP** module pointed at `http://<takectl-host>:8991`, plus Companion's HTTP API
(Settings → HTTP → enable) so takectl can push custom variables `ab_pgm`, `ab_pvw`, `ab_error`.

| Key | Action | Feedback |
|---|---|---|
| **TAKE** (big, red) | GET `/take` | text `$(custom:ab_pvw) → PGM`; flash while `/state.busy` |
| CUT | GET `/cut` | |
| MIRROR | GET `/mirror` | |
| A | none (label only) | background red if `$(custom:ab_pgm) == A`, green if `== B` |
| B | none | inverse |
| PANIC | GET `/panic` | hold-to-press |
| ERR | none | text `$(custom:ab_error)`, red when non-empty |

Operator rule printed on the deck: **compose only in the GREEN document.**
Rest of the deck: Layer Set recall buttons that target *both* A and B
(Companion mimoLive module, one connection per document) — the one that's PGM gets ignored
by convention; or better, route them through takectl so they only hit PVW (trivial addition: `/pvw/layer-set/<name>`).

## Why this shape and not the alternatives

- **Not the Automation Layer.** It runs inside a document, has no cross-document state, and its
  timing is explicitly not real-time. takectl holds state in one place and uses mimoLive's own
  tally as ground truth, so an operator clicking in MASTER directly can't desync it.
- **Not Multi-Out.** Program outputs in 7.0 share layer live-state, variants and Layer Sets; only
  parameter values can differ. That's one composition at two sizes, not two compositions.
- **Tally from `sources/{id}.tally-state`, not from takectl's memory.** After every TAKE we wait
  dissolve+settle and read it back; the WebSocket `sources changed` event triggers a resync any time
  it moves while we're idle. The datastore copy is only for recovering a guess at startup.
- **Audio only in MASTER.** Two NDI paths with slightly different latency dissolved together comb-filter.
  A and B publish video only; the audio interface feeds MASTER directly.

## Bench protocol — do these before trusting it in a show

1. **Independence.** Hide/minimize PH-A's window behind PH-MASTER. Confirm NDI PH-A keeps updating
   in MASTER's multiview (mimoLive renders when a document is live regardless of window state; verify on this beta).
2. **Signal control.** `node takectl.mjs doctor` shows cut/dis keys for slots 1 and 2. `curl :8991/cut` twice; watch MASTER.
3. **Frame-cleanliness.** Put a frame counter (NDI Test Patterns app) into both A and B. Record MASTER. Scrub the
   dissolve: one source should fade to the other with no black, no freeze, and identical counter values at the
   midpoint (proves A and B latency is symmetric). If the counters differ by a frame, one NDI receiver is on a
   different bandwidth/latency setting — match them.
4. **Audio.** Play tone through the interface. TAKE ten times. Record. Spectrogram should be flat through every
   transition. Any dip/comb = audio leaked into A or B's NDI.
5. **Desync recovery.** While takectl runs, click "Dis 1" in MASTER's UI. Within ~0.5 s `/state` should show
   PGM=A and the TALLY layers should have flipped. Then kill takectl, TAKE manually, restart takectl — it must
   start with the correct PGM from tally, not from the stale datastore.
6. **Load.** All three documents on one Mac, 1080p60, five NDI cams in each of A and B. Watch
   Status display → render time in each document. If MASTER drops frames, move A and B to the AV Mac
   (change `host` in the config; takectl doesn't care where documents live).
7. **Latency budget.** Camera → A → NDI → MASTER → NDI → streaming Mac is three NDI hops (~2–3 frames each).
   Measure glass-to-glass with a clapper. Fine for stream; if there's room video from MASTER, know the number.

## Files

- `takectl.mjs` — the controller (zero dependencies, Node 22+)
- `takectl.config.example.json` — copy to `takectl.config.json`
- `test/mock-mimolive.mjs` — fake mimoLive 7 API + WebSocket for development; `node test/mock-mimolive.mjs` then `node takectl.mjs`
