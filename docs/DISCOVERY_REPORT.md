# Technical discovery report — Milestone 1

Date: 2026-10-26 · Target: DaVinci Resolve Studio 21.1

## 1. What could and could not be inspected

| Item | Status | Notes |
|---|---|---|
| Installed Resolve version | **Not inspectable here** | Development ran in a headless Linux cloud container (Ubuntu 24.04, no GPU, no display, no Resolve, no Studio licence). |
| Developer docs shipped with Resolve 21.1 (`Developer/Scripting/README.txt`, typed stub, Workflow Integration README) | **Not available here** | Only ship inside the installer. `tools/discover.py` copies them from your machine into its report folder. |
| Official Workflow Integration sample (`Developer/Workflow Integrations/Examples/SamplePlugin`) | **Not available here** | The installer derives the manifest from *your* sample and copies `WorkflowIntegration.node` from it, so the runtime structure always comes from the installed version. |
| Caption preset pack | **Identified** (see §7) | The project's caption preset asset is **MotionText Pro (GFXLife)**. An earlier draft referred to a "Rayan Herrick" preset; no such asset exists. |
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
| Markers with custom data | `Timeline.AddMarker`, `GetMarkers`, `DeleteMarkerAtFrame` (`DeleteMarkerByCustomData` deletes only the first match) | official 21.0 docs | rough-cut review |
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

**Caption preset file.** `core/assets.js` identifies files by content: ZIP structure (Fusion bundle with `.setting` entries vs Resolve XML archive — see §7 for why `project.xml` alone does not mean a project export), SQLite (refused: a database), Fusion Lua tables, XML, or unknown. A `.drb` that is not otherwise recognisable is reported as *"bin export — identified by extension only"*; import is still Resolve's own `ImportFolderFromFile`, and the result is verified by diffing Media Pool folders before/after. Project archives (.drp/.dra) are **refused for bin import** and routed to a manual migration (restore in Project Manager → export the caption bin as .drb). Path + SHA-256 are stored; re-imports into the same project are skipped while the folders exist; moved files are detected and can be relinked (identical bytes required, or explicit confirmation).

**mKeynote templates.** Catalogued read-only from the Fusion Templates folders (user + system per OS, plus folders you add), including inside `.drfx` bundles: name, category (Titles / Generators / Effects / Transitions), pack, thumbnail (`.png` beside the `.setting`), Text+ presence, duplicate names. Titles are insertable by name (`InsertFusionTitleIntoTimeline`); duplicates are blocked from name insertion because the API cannot disambiguate.

## 6. Required user setup

1. DaVinci Resolve **Studio** 21.1 on macOS or Windows (Workflow Integrations are not documented for Linux).
2. Run `node tools/install.js` (sudo on macOS / Administrator on Windows). It needs Resolve's own SamplePlugin folder.
3. Restart Resolve → Workspace › Workflow Integrations › Edit Suite.
4. In the panel: Diagnostics › **Calibrate** and **Test subtitle import** (each uses and removes a scratch timeline).
5. Asset Setup › locate the caption preset file (MotionText Pro) → import into the project.
6. Optional: FFmpeg for Rough Cut on non-WAV media.
7. Run `python3 tools/discover.py --preset "<your preset file>"` (read-only) and send back the report — done once on 2026-10-26, see §7.

## 7. First discovery run on the user's machine (2026-10-26)

Run of `tools/discover.py` (SHA-256 `1fdd1a6d…ce69`) on the user's Mac, read-only.

| Item | Result |
|---|---|
| Resolve | **DaVinci Resolve Studio 21.0.0 beta 20** (`[21, 0, 0, 20, 'b']`) — the current test build; 21.1 later |
| OS | macOS (Darwin 25.4.0) |
| Connection | External scripting works |
| Method detection | `getattr` does **not** fabricate names on any probed object → `dir()`-based capability probing is reliable on this build |
| Resolve, ProjectManager, Project, MediaPool, Folder | All methods the suite calls are present |
| Timeline, TimelineItem, MediaPoolItem | **Not probed** — no timeline was open. Re-run with a timeline containing a clip on V1/A1 |
| 21.1-only methods | `GetTranscription`, `GetType`, `GetSpeed`, `SetFades`, `GetFades`, `AddTransition` are absent from this build's shipped docs → reported unavailable by the version adapter |
| Official docs | 20 files copied (Scripting, Workflow Integrations, Fusion Templates, OGraf HTML Templates, OpenFX, LUT, CodecPlugin, DaVinciCTL). Not yet reviewed here — the user still needs to send `Scripting/README.txt`, the Workflow Integrations README and the sample `manifest.xml` |
| Fusion templates | 29 `.drfx` packs in the user Templates folder, none in the system folder |

**Caption preset asset — MotionText Pro (GFXLife).** `MotionText Pro.drb`, 1,168,708 bytes, SHA-256 `fdf0a0c6…cc73a9`.

- ZIP of Resolve XML, written by **Resolve 20.3.0.0010** (`DbAppVer` in `project.xml`).
- Entries: `project.xml`, `MediaPool/Master/…/MpFolder.xml` for each bin, and two `SeqContainer/*.xml` sequences holding 39 and 51 Fusion compositions.
- Bins: **MotionText Pro** › *Timeline* (2 items: "Text design template", "Text design"), *Text Animation* (39 animated text presets, e.g. Smooth Word Up, Glitch Text, Partial Blur), *Zoom* (2 items: "Adjustment Clip", "slow zoomout").
- **Finding:** a genuine bin export contains `project.xml`. Milestone 1's classifier treated any ZIP with `project.xml` as a project archive and would have **refused** this file. Fixed: content now proves only "Resolve XML archive"; `.drb` → bin export (imported with `ImportFolderFromFile`), `.drp` → project archive (migration), anything else → not imported. Regression test uses the same entry layout with synthetic contents.
- Not yet known: the media-pool clip type of the Text Animation items and whether their text is driven by a Text+ tool. Determined by the first "Place first caption (test)" run, which reports it instead of assuming.

### Second run, with a timeline open (2026-10-26)

All eight objects probed on **Studio 21.0.0 beta 20**, `getattr` fabricates no names on any of them.

| Object | Result |
|---|---|
| Resolve, ProjectManager, Project, MediaPool, Folder, Timeline | Every method the suite calls is present |
| TimelineItem | Missing exactly the 21.1-only `GetType`, `GetSpeed`, `SetFades`, `GetFades`, `AddTransition` |
| MediaPoolItem | Missing exactly the 21.1-only `GetTranscription` |

Probed timeline: "Timeline 3", **24 fps** NDF, 1920×1080, start 86400 (01:00:00:00), 4 video / 1 audio / 0 subtitle tracks. Its first clip is **30 fps** media (1717 frames) occupying 1373 timeline frames — a real mixed-rate case.

**Confirmed by the official docs shipped with this build** (`Scripting/README.txt`, last updated 7 Oct 2025; `Workflow Integrations/README.txt`, 3 Oct 2024):

- Plugin manifest: `<BlackmagicDesign><Plugin>` with `Id`, `Name`, `Version`, `Description`, `FilePath` — exactly the elements the installer derives. Plugin directories are named `com.<company>.<plugin_name>`; the suite now installs to `com.editsuite.resolve.panel`.
- `WorkflowIntegration` module: `GetInfo`, `Initialize`, `InitializePromise`, `GetResolve`, `GetResolvePromise` (all further calls return promises), `RegisterCallback` (`RenderStart`, `RenderStop`, `ResolveQuit`), `DeregisterCallback`, `CleanUp`, `SetAPITimeout` (APIs do not time out by default). Plugins: macOS/Windows only.
- `AppendToTimeline` clipInfo keys: `mediaPoolItem`, `startFrame`, `endFrame` (float/int), optional `mediaType` (1 video, 2 audio), `trackIndex`, `recordFrame`. Inclusivity of `endFrame` is not documented — still measured by Diagnostics › Calibrate.
- Marker frames are offsets from the timeline start. **`DeleteMarkerByCustomData` deletes only the first match** — the suite's "Remove review markers" called it once and would have left all but one marker behind. Fixed: markers of the run are removed with `DeleteMarkerAtFrame` and the removal is verified; the mock now follows the documented behaviour, and a regression test covers it.
- `TimelineItem.GetSourceStartTime` (seconds) is documented. For mixed-rate clips the unit of `GetLeftOffset` is not, so audio analysis and rough-cut source in-points now use `GetSourceStartTime` for mixed-rate clips (same-rate clips keep `GetLeftOffset`, which third parties measured exact).
- Also documented and available for later milestones: `AddTrack` with `{index}`, `SetTrackLock`/`GetIsTrackLocked`, `Timeline.GetMediaPoolItem` (nested-timeline title placement), `GetMarkInOut`/`SetMarkInOut`, `CreateCompoundClip`, `GetVoiceIsolationState`/`SetVoiceIsolationState`.
- Captions on 21.0: `TranscribeAudio` exists but there is no `GetTranscription` and no API to read or write subtitle text. Caption sources on this build are SRT/VTT files; `CreateSubtitlesFromAudio` can create Resolve's own (unstyled) subtitles.

Not yet obtained: the SamplePlugin's `main.js`/`preload.js` (discovery copies only README/manifest/docs files), to compare the sandboxed IPC structure line by line.

### First run of the plugin inside Resolve (2026-10-26, 21.0.0b20, Electron 36.3.2)

- Plugin loads from `com.editsuite.resolve.panel`, connects, and reads project, timeline, rate and resolution correctly. Calibration ran.
- **Bug found:** "Test subtitle import" failed with `TimelineItem.GetLeftOffset … (errorStr:Item is not a media) (errorCode:6)`. The JS API **raises** on items without source media (subtitles, titles, generators) instead of returning a value. The verification step read source offsets for every item; it now reads them only where available. The mock now raises the same way, and the test also removes its test clip even when a step fails (it previously could leave `subtitle-import-test.srt` in the Media Pool).
- **Subtitle placement on a real timeline (21.0.0b20):** `AppendToTimeline([{mediaPoolItem: <srt>, recordFrame}])` (no `trackIndex`) **ignored `recordFrame`** and appended the subtitles after the existing timeline content. Measured: caption 1 expected at 86424, placed at 87797 — offset 1373 frames, exactly the length of the clip already on the timeline. The first scratch test had passed only because its timeline was empty.
  Response: placement now goes to a newly created subtitle track with an explicit `trackIndex` (whether Resolve then honours `recordFrame` is the hypothesis being tested), the items the call added are identified by unique id and **removed again if any frame is wrong**, a failed real placement switches the feature off for the build, and the scratch test (v2) puts ~6 s of real media on the scratch timeline first. Passes from the v1 test no longer count.
- **Caption segmentation bug:** words from consecutive entries of an imported SRT could merge into one caption ("…Edit Suite We grew our revenue…"). Captions from a subtitle file now never cross its entry boundaries.
- **Subtitle placement, scratch test v2 (21.0.0b20):** with an explicit `trackIndex` on a new subtitle track, Resolve still ignored `recordFrame`: both test subtitles landed exactly 144 frames (the 6 s of media already on the scratch timeline) late, with correct durations and spacing. Conclusion for this build: SRT subtitle items are always appended after existing content, so automatic subtitle-track placement stays disabled; the manual route (Export SRT → File › Import › Subtitle) remains. Calibration on the same build: `AppendToTimeline` endFrame **exclusive**, `TimelineItem.GetEnd` **exclusive**.
- **MotionText Pro styled captions:** placing a preset worked, but its words did not change. Decoding the presets' embedded compositions (`CompositionBA` = 4-byte length + zlib(header + zlib(tool graph))) showed why: in **30 of 39** text presets the Text+ `StyledText` input is driven by a `StyledTextFollower` (the word-by-word animation), so the words live in the follower's `Text` input and writing `StyledText` is ignored. **9** presets hold the words in Text+ directly; **3** items (2× Adjustment Clip, slow zoomout) have no text; **2** are template timelines. All were authored at 2160×3840, 24 fps.
  Response: the suite writes the follower's `Text` when the preset is follower-driven (found via `GetToolList`, or by the node name recorded in the `.drb`), Text+ `StyledText` otherwise, and reads every write back; the style picker reads each preset's wiring from the `.drb`, labels animated presets and hides non-text items.
- **Captions from timeline audio (option A, chosen by the user):** `Timeline.CreateSubtitlesFromAudio()` runs on the user's own timeline — no copy. Success is judged by new subtitle items (the boolean is unreliable), polled with a grace period; the API timeout is raised to 30 min for the call. Each generated item's text is read with `GetName` and timing with `GetStart`/`GetEnd`; placeholder-looking names are reported as "text not exposed by this build" (track kept). Resolve's subtitle track is removed again unless the user keeps it. Still to confirm on 21.0.0b20: that `GetName` returns the spoken text.
- **No more timeline copies:** caption placement no longer duplicates the timeline (it only adds a track). "Remove these captions" deletes exactly the items one placement added (by unique id) and its now-empty track. Timeline backups are an opt-in setting.
- **Captions from timeline audio — confirmed on 21.0.0b20:** `CreateSubtitlesFromAudio` + `GetName` returned real speech (72 captions from Timeline 3, e.g. "I sold my phone").
- **Follower nodes unreachable on 21.0.0b20:** `GetToolList(false, 'StyledTextFollower')` returned nothing and `FindTool('Follower1')` found nothing, while Text+ was listed. Response: when the words cannot be set through the API, the suite exports the placed item's composition (`ExportFusionComp`), replaces the follower `Text` (or literal Text+ `StyledText`) in Resolve's own file, imports it as a new composition (`ImportFusionComp`), makes it active (`LoadFusionCompByName`) and verifies by exporting again. All four methods are in the 21.0 README. The edit keeps Text+ connected to the follower, so the animation is preserved (checked against the real decoded Smooth Word Up graph).
