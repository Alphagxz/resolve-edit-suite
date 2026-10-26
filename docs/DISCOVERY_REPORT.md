# Technical discovery report — Milestone 1

Date: 2026-10-26 · Target: DaVinci Resolve Studio 21.1

## 1. What could and could not be inspected

| Item | Status | Notes |
|---|---|---|
| Installed Resolve version | **Not inspectable here** | Development ran in a headless Linux cloud container (Ubuntu 24.04, no GPU, no display, no Resolve, no Studio licence). |
| Developer docs shipped with Resolve 21.1 (`Developer/Scripting/README.txt`, typed stub, Workflow Integration README) | **Not available here** | Only ship inside the installer. `tools/discover.py` copies them from your machine into its report folder. |
| Official Workflow Integration sample (`Developer/Workflow Integrations/Examples/SamplePlugin`) | **Not available here** | The installer derives the manifest from *your* sample and copies `WorkflowIntegration.node` from it, so the runtime structure always comes from the installed version. |
| Rayan Herrick caption preset file | **Not supplied** | Not in the working directory or in the connected Google Drive. Format is therefore **unknown**; the suite identifies it by content when you locate it (see §4). |
| mKeynote templates | **Not supplied** | Catalogued at runtime from the Fusion Templates folders (see §5). |

Because the primary evidence sources were unavailable, **every Resolve-facing behaviour in this milestone is unverified on 21.1 until it is run on a real install.** The design makes that explicit at runtime instead of assuming: capability probing, scratch-timeline calibration and verification after every write.

## 2. Evidence used instead, and how strong it is

1. **Public mirror of the legacy scripting README** (2018, Resolve 15-era) — used only for the general object model; too old to rely on for signatures.
2. **`samuelgursky/davinci-resolve-mcp`** — an open-source project that live-tests the Resolve API and publishes method-by-method results:
   - [API coverage & test results](https://github.com/samuelgursky/davinci-resolve-mcp/blob/main/docs/reference/api-coverage.md) — 338/361 legacy methods live-tested on Studio 19.1.3 / 20.3.2 / 21.0.2.
   - [Resolve 21.1 read controls](https://github.com/samuelgursky/davinci-resolve-mcp/blob/main/docs/reference/resolve211-read-controls.md), [transcription & type](https://github.com/samuelgursky/davinci-resolve-mcp/blob/main/docs/reference/resolve211-transcription-type.md), [speed & fades](https://github.com/samuelgursky/davinci-resolve-mcp/blob/main/docs/reference/resolve211-speed-fades.md), [native transitions](https://github.com/samuelgursky/davinci-resolve-mcp/blob/main/docs/reference/resolve211-native-transitions.md) — contributor live tests on **Studio 21.1.0.14** (macOS).
   - [API limitations ledger](https://github.com/samuelgursky/davinci-resolve-mcp/blob/main/docs/reference/api-limitations.md) — absent methods verified with `dir()` and live failure tests.
3. Blackmagic forum statements: Workflow Integrations are Studio-only, and from 19.0.2 the sample uses Electron sandboxing + context isolation (a separate "CompatibleSamplePlugin" exists for old non-sandboxed plugins).

This is third-party evidence. It is recorded per feature in `plugin/resolve/capabilities.js` (`evidence` field) and shown in the UI. It never counts as "verified on this machine".

## 3. Supported operations (planned use, with evidence level)

| Operation | API | Evidence | Used by |
|---|---|---|---|
| Read timeline rate, DF flag, resolution, start/end, start TC | `Timeline.GetSetting`, `GetStartFrame`, `GetEndFrame`, `GetStartTimecode` | live 19/20 | everything |
| Duplicate timeline (backup) | `Timeline.DuplicateTimeline` | live 19/20 | captions apply |
| New timeline + placement at exact track/frame | `MediaPool.CreateEmptyTimeline`, `AppendToTimeline` (clipInfo `startFrame/endFrame/recordFrame/trackIndex/mediaType`) | live 19/20 | rough cut, styled captions |
| Import bin export (.drb) | `MediaPool.ImportFolderFromFile` | live 19/20 | caption presets |
| Import files into a chosen bin | `SetCurrentFolder` + `ImportMedia` | live 19/20 | SRT |
| Word-timed transcription | `MediaPoolItem.TranscribeAudio`, `GetTranscription` (21.1, Studio) | live 21.1.0.14 | captions |
| Markers with custom data | `Timeline.AddMarker`, `GetMarkers`, `DeleteMarkerByCustomData` | live 19/20 | rough-cut review |
| Fusion title by name | `Timeline.InsertFusionTitleIntoTimeline` | live 19/20 | motion graphics |
| Set Text+ text | `TimelineItem.GetFusionCompByIndex` → comp `GetToolList(false,'TextPlus')` → `SetInput('StyledText')` | live 19/20 (Text+ via title items) | styled captions |
| Native fades / transitions / speed / item type | `SetFades`, `AddTransition`, `GetSpeed`, `GetType` (21.1) | live 21.1.0.14 | speed read in rough cut; others reserved for later modules |
| SRT onto a subtitle track | `ImportMedia(.srt)` + `AppendToTimeline` | **single report on 21.0.4.5** | captions — disabled until the Diagnostics scratch test passes on your build |

## 4. Unsupported operations and API limitations (and the design response)

| Limitation (verified absent by third parties) | Consequence | Design response |
|---|---|---|
| No razor/blade, trim, move, ripple-delete, insert/overwrite modes for timeline items | Rough cut cannot edit a timeline in place | Rough cut **builds a new timeline** from kept ranges with `AppendToTimeline`; the original is never modified. |
| `AppendToTimeline` silently drops overlapping placements (earlier wins); errored-call placements may vanish on save | Silent data loss | Styled captions go on a **new empty track**; rough cut places non-overlapping ranges; both **read back and verify**, rough cut **saves and re-verifies**. |
| Mixed-rate placement durations are floored by Resolve | Off-by-one frames | Plan models the floor; verification expects it; warnings list affected pieces. |
| `Insert*IntoTimeline` has no track parameter (uses Edit-page destination track at the playhead) | Titles cannot be targeted programmatically | UI states it before inserting; verification reports the track and frame actually used. Nested-timeline route documented for later. |
| No API to set subtitle text, per-word timing or subtitle style | Subtitle tracks are unstyled | Styled captions use **your imported preset items** (Fusion) instead; subtitle-track route is plain text only and says so. The suite will **not** write Resolve's project database (a third-party workaround does; this violates the brief). |
| No API applies an Effects-library Fusion effect to a clip | Effects templates can't be inserted | Catalogued and searchable; card shows the manual workflow. |
| `CreateSubtitlesFromAudio` returns unreliable booleans; Studio-gated calls on free raise a blocking modal | False success; stuck API | Edition checked **before** Studio features; success judged by track counts. |
| Python bridge fabricated attributes for `hasattr` on 21.0.0 (unresolved) | Feature detection can lie | Probe with a sentinel name; if it looks callable, detection is marked unreliable and features show **"assumed"**. JS binding behaviour is unmeasured → `discover.py` and the panel both test it. |
| `TimelineItem.GetSourceStartFrame` off by one on some items | Wrong source mapping | Source in-points use `GetLeftOffset`. |
| Free edition 21.1 removed Python from the Scripts menu | Discovery from menu needs Studio | Target is Studio; external scripting documented. |

## 5. Premium assets — how they are handled without assuming a format

**Caption preset file.** `core/assets.js` identifies files by content: ZIP structure (Fusion bundle with `.setting` entries vs `project.xml` project export), SQLite (refused: a database), Fusion Lua tables, XML, or unknown. A `.drb` that is not otherwise recognisable is reported as *"bin export — identified by extension only"*; import is still Resolve's own `ImportFolderFromFile`, and the result is verified by diffing Media Pool folders before/after. Project archives (.drp/.dra) are **refused for bin import** and routed to a manual migration (restore in Project Manager → export the caption bin as .drb). Path + SHA-256 are stored; re-imports into the same project are skipped while the folders exist; moved files are detected and can be relinked (identical bytes required, or explicit confirmation).

**mKeynote templates.** Catalogued read-only from the Fusion Templates folders (user + system per OS, plus folders you add), including inside `.drfx` bundles: name, category (Titles / Generators / Effects / Transitions), pack, thumbnail (`.png` beside the `.setting`), Text+ presence, duplicate names. Titles are insertable by name (`InsertFusionTitleIntoTimeline`); duplicates are blocked from name insertion because the API cannot disambiguate.

## 6. Required user setup

1. DaVinci Resolve **Studio** 21.1 on macOS or Windows (Workflow Integrations are not documented for Linux).
2. Run `node tools/install.js` (sudo on macOS / Administrator on Windows). It needs Resolve's own SamplePlugin folder.
3. Restart Resolve → Workspace › Workflow Integrations › Edit Suite.
4. In the panel: Diagnostics › **Calibrate** and **Test subtitle import** (each uses and removes a scratch timeline).
5. Asset Setup › locate the caption preset file → import into the project.
6. Optional: FFmpeg for Rough Cut on non-WAV media.
7. **Please run `python3 tools/discover.py --preset "<your preset file>"` and send back the `edit-suite-discovery-*` folder.** It is read-only and is the evidence needed to move features from "third-party evidence" to "verified" and to finalise the 21.1 compatibility matrix.
