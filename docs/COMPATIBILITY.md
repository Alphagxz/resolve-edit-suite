# Compatibility matrix

**No Resolve version is verified yet.** "Verified" requires the Diagnostics scratch tests and the integration checklist below to pass on a real install. Cells state what the suite *expects* and why.

| Resolve | Edition | OS | Status | Basis |
|---|---|---|---|---|
| 21.1.x | Studio | macOS / Windows | **Primary target — untested** | Third-party live tests on 21.1.0.14; all 21.1-only features feature-detected |
| 21.0.4+ | Studio | macOS / Windows | Expected to work without 21.1 features (word-timed transcription, speed read, fades, transitions unavailable) | Version floors in `capabilities.js` |
| 20.x / 19.1.x | Studio | macOS / Windows | Declared minimum candidate (19.0.2: sandboxed Electron sample) — untested | Third-party live tests of legacy methods on 19.1.3 / 20.3.2 |
| < 19.0.2 | any | any | Not supported (pre-sandbox Workflow Integration runtime) | |
| any | Free | any | Not supported (Workflow Integrations are Studio-only) | Blackmagic forum |
| any | any | Linux | Not supported (Workflow Integrations not documented on Linux) | |

## Verified automatically in this repository (no Resolve required)

| Area | Coverage |
|---|---|
| Frame rates | 23.976, 24, 25, 29.97 (DF/NDF), 30, 47.952, 48, 50, 59.94 (DF/NDF), 60, 95.904, 96, 100, 119.88, 120 — exact rational/flick round-trips over 24 h; DF known values and 40k-frame round-trips; 10-hour no-drift test |
| Frame shapes | 1920×1080, 3840×2160, 1080×1920, 1080×1080, 1080×1350 caption finalisation and layout |
| Plugin logic | Router + operations against a mock Resolve (`test/helpers/fake-resolve.js`) — proves logic, **not** Resolve behaviour |
| UI | Chromium smoke test of every view against the mock (`npm run test:ui`) |

## Integration checklist to mark a version "verified"

Run on a disposable project with a 25 fps, a 29.97 DF, a 23.976 vertical (1080×1920) and a 1080×1080 timeline:

1. `tools/discover.py` — no `missing` methods; record `getattrFabricatesNames`.
2. Diagnostics › Calibrate — record the three conventions.
3. Diagnostics › Test subtitle import — must pass to enable subtitle tracks.
4. Captions from SRT → subtitle track: read-back matches preview on every timeline.
5. Captions from 21.1 transcription → styled preset, test-one then all: placement + text verified.
6. Rough cut on linked V1/A1 interview: continuity verified after save; original unchanged; mixed-rate clip (29.97 in 23.976) piece lengths match plan.
7. Insert a catalogued title: reported track/frame correct.
8. Caption bin import: second import skipped; moved file detected; relink works.
9. Uninstall: only receipt files removed; projects open unchanged.

Record results in the table above with build number, OS and date.
