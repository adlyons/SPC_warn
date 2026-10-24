# SPC Warn (MVP)

Single-file browser radar workstation: live NEXRAD Level II from AWS, decoded in the browser, with storm tracking and recommended warnings.

## Run
Open `dist/spcwarn.html` in Chrome or Edge (double-click works, no server needed). Add `#KFWS` to the URL to start on another radar.

## Data
- Archive volumes: `unidata-nexrad-level2`, 1991 to present. Type the case end time in UTC, 24-hour (`2013-05-20 20:15`) next to the radar ID, or open `index.html#KTLX/2013-05-20T20:15`. Older `.gz` files and the pre-2008 Message 1 format are decoded too. The Frames menu loads 6 to 48 volumes (about 40 MB of memory each for modern super-res data).
- Real time: `unidata-nexrad-level2-chunks`, polled every 10 s, so low tilts appear while the volume is still scanning.
- Every cut is kept, including split cuts, SAILS / MESO-SAILS and MRLE rescans. Left/right steps through each scan at the current tilt.

## Keys
Arrows: tilt and time. S: storm-relative velocity (SCIT storm motion by default). Shift+S: SRV motion box (SCIT, your track, or manual). U: dealiasing on/off. O: ProbSevere. Shift+K: CWAs. Shift+X: clear tracks. Shift-click a SCIT cell or one of your G tracks: polygon. Tap right-click: cursor readout.
 1/2/4: panel layout. R V W Z C P: product. T: track cell. L: track line. G / Shift+G: track only (no polygon). I: SCIT tracks. Hold right-click: radar menu. Enter: next step. D: recommendation dialog. Ctrl+Enter: issue. E: export GeoJSON. ?: help.

## Build
`python3 build.py` bundles `src/` and `data/` into `dist/spcwarn.html` and the root `index.html`.

## GitHub Pages

`index.html` at the repo root is the hosted page. Push to GitHub, then in the repo go to Settings → Pages, set Source to "Deploy from a branch", branch `main`, folder `/ (root)`. The site appears at `https://<user>.github.io/SPC_warn/`. Rerun `python3 build.py` and commit after any source change.
- `src/bzip2.js`, `src/level2.js`: decoder (Message 31 + Message 5 VCP angles)
- `src/render.js`: WebGL MapLibre layer (polar texture sampled per pixel)
- `src/warn.js`: tracking, pathcast, polygon, recommendation rules (`recommend()`), product text, GeoJSON log
- `src/velocity.js`: dealiasing (fold-aware VAD per 10 km ring + local continuity) and SRV
- `src/level3.js`, `src/extras.js`: Level III NST (SCIT) parser and overlay, radar menu
- `data/`: CWA polygons (from IEM pyiem), radar sites, state/county lines (us-atlas), US places (GeoNames via cities.json), MapLibre 4.7.1
