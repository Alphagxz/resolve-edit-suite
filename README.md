# Edit Suite for DaVinci Resolve Studio

A Workflow Integration panel for DaVinci Resolve Studio 21.1: captions, rough cut, motion-graphics templates, premium asset setup and diagnostics. It is designed around what the Resolve API can actually do. Every feature is capability-checked on your build, every write is confirmed, backed up or non-destructive, and every result is read back and verified.

> **Status: Milestone 1.** Tested in this repository (logic, mock integration, UI). **Not yet verified on a real Resolve install.** See [docs/MILESTONE_1.md](docs/MILESTONE_1.md).

## Install

Requirements: DaVinci Resolve **Studio** (macOS or Windows), Node.js 20+.

```sh
# macOS (plugins live under /Library)
sudo node tools/install.js --dry-run   # review the plan
sudo node tools/install.js
# Windows: run from an Administrator terminal
node tools/install.js
```

The installer copies `WorkflowIntegration.node` and the manifest structure from **your** Resolve's `Developer/Workflow Integrations/Examples/SamplePlugin`, so the runtime always matches your installed version. Restart Resolve, then open **Workspace › Workflow Integrations › Edit Suite** and follow the Overview checklist.

First run:
1. Diagnostics › **Calibrate frame conventions** and **Test subtitle import**.
2. Asset Setup › locate the caption preset file › import.
3. Optional: Settings › FFmpeg path.

## Uninstall

```sh
sudo node tools/uninstall.js            # removes only files listed in the install receipt
sudo node tools/uninstall.js --purge-data   # also removes suite settings/log/generated SRTs
```

Projects, timelines (including Edit Suite backups and rough cuts, which are yours to keep or delete), imported caption bins, media, presets and Fusion templates are never touched.

## Discovery (please run once)

```sh
python3 tools/discover.py --preset "/path/to/Rayan Herrick Captions.drb"
```

Read-only. Writes `edit-suite-discovery-<time>/` with the official docs from your install, the API surface per object and the real format of your preset file.

## Layout

```
plugin/                 installed as-is into Workflow Integration Plugins/EditSuite
  main.js, preload.js   sandboxed Electron entry + bridge
  router.js             whitelisted IPC operations, confirmation & preview-by-id rules
  resolve/              version adapter (capabilities.js) and instrumented API wrapper (adapter.js)
  ops/                  Resolve-facing operations: captions, roughcut, assets, diagnostics, backup
  services/             storage, operation log, tasks, audio decoding
  core/                 pure logic: timebase, timecode, subtitles, segmentation, cues, layout,
                        audio, silence, roughcut planning, asset identification, templates
  renderer/             UI (no framework, strict CSP)
tools/                  discover.py, sniff-asset.js, install.js, uninstall.js
test/                   unit tests, mock-Resolve integration tests, UI smoke harness
docs/                   discovery report, compatibility, timebase, asset guide, troubleshooting
```

## Develop & test

```sh
npm test            # unit + mock integration + installer tests
npm run test:ui     # Chromium smoke test of the panel against the mock Resolve
node test/ui/harness.js 5173   # open the panel in a browser against the mock
```

The mock (`test/helpers/fake-resolve.js`) encodes reported Resolve behaviour to exercise the plugin's logic. Passing it is not evidence about real Resolve behaviour; the [integration checklist](docs/COMPATIBILITY.md) is.

## Documentation

- [Technical discovery report](docs/DISCOVERY_REPORT.md)
- [Compatibility matrix](docs/COMPATIBILITY.md)
- [Timing model](docs/TIMEBASE.md)
- [Asset configuration guide](docs/ASSET_SETUP.md)
- [Troubleshooting & diagnostics](docs/TROUBLESHOOTING.md)
- [Milestone 1 report](docs/MILESTONE_1.md)
