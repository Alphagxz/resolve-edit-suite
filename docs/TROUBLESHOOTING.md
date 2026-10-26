# Troubleshooting & diagnostics

Every error in the panel names its **source**:

| Source | Meaning | First step |
|---|---|---|
| Resolve | Resolve not running / plugin not connected | Open the panel from Workspace › Workflow Integrations in **Studio** |
| Resolve state | No project or no active timeline | Open a timeline on the Edit page, press Refresh |
| Resolve API (method not exposed) | This build lacks the method | Diagnostics table shows which; check the compatibility matrix |
| Resolve API (call returned failure) | Resolve refused the call | Read the message; check track locks, Media Pool state, Studio edition |
| Resolve API (no response) | Call timed out | Close modal dialogs in Resolve (e.g. the free-edition upsell blocks all calls) |
| Resolve API limitation | Not possible through the API | The message gives the manual alternative |
| Missing asset | File moved/offline, FFmpeg missing | Asset Setup › Relink; Settings › FFmpeg |
| Result verification | Resolve accepted the call but the result differs | The backup timeline name is in the message; compare, then report with Diagnostics |
| Plugin | Bug in the suite | Save the Diagnostics report and send it |

## Diagnostics panel

- **Feature table** — status per feature: *available*, *assumed* (method presence could not be probed reliably), *needs-verification* (enabled after a scratch test), *failed-verification*, *unavailable* — with the evidence level.
- **Calibrate frame conventions** / **Test subtitle import** — create a timeline named *Edit Suite Scratch (safe to delete)*, test, delete it, restore your timeline. If deletion fails you are told to delete it manually.
- **Operation log** — every action with affected objects, result, error source and the API calls made. File: `operations.log.jsonl` in the data folder.
- **Save report…** — JSON with versions, OS, capabilities, calibration, FFmpeg, template folders and recent errors. Contains file paths and project/timeline names; review before sharing.

Data folder: macOS `~/Library/Application Support/ResolveEditSuite`, Windows `%APPDATA%\ResolveEditSuite`.

## Common problems

| Symptom | Cause / fix |
|---|---|
| Panel not in the Workflow Integrations menu | Studio only; restart Resolve after installing; check `Workflow Integration Plugins/EditSuite/manifest.xml` exists. |
| Banner "WorkflowIntegration.node could not be loaded" | Re-run the installer after a Resolve update (the binding comes from your Resolve version). |
| "Initialize returned false" | Manifest Id mismatch — reinstall. |
| Subtitle track button disabled | Run Diagnostics › Test subtitle import on this build. |
| Styled caption text not set | Preset has no Text+ tool, or text is driven by a different input; use another preset or the subtitle track route. |
| Rough cut refuses: timeline-specific settings | New timelines take project settings; set project rate/resolution to match the timeline, or rough-cut a timeline that uses project settings. |
| Rough cut verification problems after save | Resolve discarded some placements on save (known API behaviour). The original is intact; delete the rough-cut timeline and retry, then send the report. |
| "needs FFmpeg" | Install FFmpeg and set its path, or use WAV media. |
| Title inserted on the wrong track | Set the destination track (Edit page track selector) before inserting; the API cannot choose it. |
