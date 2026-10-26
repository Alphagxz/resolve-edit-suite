# Milestone 1 report — core integration

## Implemented

| Area | What exists |
|---|---|
| Discovery | `tools/discover.py` (read-only probe: version, official docs copy, `dir()` surfaces vs required methods, transcription payload shape, timeline conventions, preset format, template inventory); `tools/sniff-asset.js` |
| Timing engine | Flick timebase, rational rates, DF/NDF timecode, timeline context, cross-rate conversion (`plugin/core/timebase.js`, `timecode.js`, `timeline-context.js`) |
| Captions engine | SRT/VTT parse & write, Resolve 21.1 transcription loader, segmentation (chars/lines/words-per-cue/durations/pauses/sentence/speaker), balanced line breaks, emphasis rules, case, timing shift, overlap/duration/extent repair, safe-area layout for any frame shape |
| Rough cut engine | WAV reader, level envelope, silence detection (auto/fixed threshold), padding, retained pause, marker-protected ranges, keep-range planning to `AppendToTimeline` clipInfos with mixed-rate modelling, placement verification |
| Assets | Content-based identification (ZIP/.drfx/.drp/SQLite/Fusion/XML), Fusion `.setting` inspection (Text+, published inputs), template catalogue incl. `.drfx`, thumbnails, duplicates, search, categories, favourites |
| Integration | Version adapter + capability evaluation with evidence levels and sentinel-probe reliability check; instrumented API wrapper with error classification; operation log; settings; task progress + cooperative cancel |
| Panel | Sandboxed Electron (contextIsolation, sandbox, preload bridge, strict CSP, whitelisted IPC, writes only to save-dialog paths). Views: Overview (live summary, setup checklist, feature table), Captions, Rough Cut, Motion Graphics, Asset Setup, Diagnostics, Settings |
| Safety | Confirmation enforced server-side for every write; timeline backup before caption writes; rough cut never edits the source timeline; previews/analyses applied by id (what you reviewed is what is applied); read-back verification; save-and-re-verify; scratch-timeline cleanup |
| Delivery | Installer (manifest derived from your SamplePlugin, binding copied from your install, receipt, previous-version backup), receipt-based uninstaller (keeps user files and suite data unless `--purge-data`), docs |

## Tested (automatically, in this repository)

`npm test` — 54 tests, all passing; `npm run test:ui` — Chromium smoke of every view, no console errors.

- Pure logic: all listed frame rates, DF/NDF, 24 h round-trips, 10 h drift, five frame shapes, SRT/VTT round-trips, segmentation, layout, WAV + silence detection on synthesised audio, rough-cut planning (same-rate and mixed-rate), asset identification on real ZIP bytes.
- Plugin logic against a **mock** Resolve: import dedupe/move/relink, project-archive refusal, gated subtitle placement, styled test-one-then-all with text verification, rough cut with linked/unlinked tracks and settings mismatch, calibration, checklist, error classification, confirmation enforcement.
- Installer/uninstaller on temporary folders.

## Verified on a real Resolve

**Nothing yet.** No Resolve install was available. All Resolve-facing behaviour is based on third-party evidence (see DISCOVERY_REPORT.md) and must be verified with the integration checklist in COMPATIBILITY.md.

## Known limitations / unsupported

- Subtitle-track styling, per-word subtitle timing, razor/trim/move, title track targeting, applying Effects templates: **not possible through the API** (see DISCOVERY_REPORT.md §4).
- Rough cut rebuilds the analysed track plus its linked partner only; other tracks (music, B-roll, titles) are listed as not carried over. Retimed clips are blocked when speed is readable (21.1); on older builds speed cannot be read and a warning is shown.
- Styled captions: preset length caps caption length (reported per caption); per-word emphasis is applied by switching to an alternative preset for captions containing an emphasised word, not by restyling characters inside Text+.
- Auto-repositioning of preset captions is not applied (preset positions are preserved); the layout engine drives the preview and safe-area checks.
- Workflow Integration manifest/runtime details are taken from your installed SamplePlugin at install time; if Blackmagic changed the structure in 21.1 the installer stops instead of guessing.

## Not started (later milestones)

Sound Design, B-Roll Assistant, Ad Builder, Reframe, Audio Polish, Project Organisation, Quality Check. They are deliberately **absent from the panel** rather than shown as non-functional controls. Proposed order, reusing this milestone's engine:

1. **Quality Check** (read-only: gaps, overlaps, offline media, caption reading speed, safe-area, loudness via FFmpeg).
2. **Sound Design** (local SFX library index, event matching to cuts/markers, verified placement on a new audio track, duplicate-placement guard) — uses `AppendToTimeline` + native fades (21.1).
3. **Project Organisation** (bins, markers, naming — no rename API for folders).
4. **Ad Builder** (section markers + variant timelines built from a common base).
5. **B-Roll Assistant** (transcript keyword ↔ clip metadata suggestions; approval-gated placement on an upper track).
6. **Reframe / Audio Polish** after discovery confirms which 21.1 controls are exposed.

## What I need from you to continue

1. The Rayan Herrick caption preset file (or the `discover.py` report with `--preset`).
2. The `discover.py` output folder from your Resolve Studio 21.1 machine.
3. One run of Diagnostics › Calibrate and › Test subtitle import, with the saved report.
