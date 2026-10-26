# Asset configuration guide

The suite only **reads** your premium assets. It never edits, moves, re-encodes, renames or replaces them, and it never substitutes generic Text+ titles for your presets.

## Caption preset pack (MotionText Pro)

1. Panel › **Asset Setup** › *Locate preset file…*. (Or from a terminal: `node tools/sniff-asset.js "<file>"`.)
2. The file is identified by content. What you'll see:

| Identified as | Meaning | What to do |
|---|---|---|
| Bin export | Media Pool bin export (a ZIP of Resolve XML with a `.drb` extension, like MotionText Pro, or an unrecognised `.drb`) | *Import into current project*. Resolve imports it with its own bin importer; folder names and structure are preserved. A second import into the same project is skipped while those folders exist. |
| Resolve project archive (.drp / .dra) | A whole project, not a bin | **Do not import into your working project.** Migration: Project Manager › right-click › *Import Project* (or *Restore Project Archive* for .dra) → open it → select the caption folder in its Media Pool → right-click › *Export Bin…* → choose that .drb in Asset Setup. Your working project is untouched throughout. |
| Fusion template bundle (.drfx) | Installable titles | Double-click the .drfx (Resolve installs it), restart Resolve; titles appear in **Motion Graphics**. |
| Fusion setting (.setting) | Single title/macro | Copy into `Fusion/Templates/Edit/Titles/<pack>/` (paths below), restart Resolve. |
| Database | A Resolve database file | Not supported; the suite never touches Resolve databases. |
| Unknown | — | Send the `tools/discover.py` report; nothing is imported. |

3. After import, **Captions › Styled captions** lists the preset items from those folders. Always use *Place first caption (test)* once per new preset: it verifies the preset can be placed and that its Text+ text can be set. If a preset has no Text+ tool (e.g. a pre-rendered graphic), the suite reports that instead of faking text.

**Moved the file?** Status shows *moved*; use *Relink moved file…*. A byte-identical file is accepted automatically; a different file needs confirmation.

## mKeynote and other Fusion templates

Discovered automatically from:

| OS | User | System |
|---|---|---|
| macOS | `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Templates` | `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Templates` |
| Windows | `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Templates` | `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Fusion\Templates` |

Add other folders in **Settings › Extra template folders**. Thumbnails come from a `.png` with the same name as the `.setting`.

| Category | Programmatic insert | Notes |
|---|---|---|
| Titles | Yes — *Insert at playhead* | Lands on the Edit-page destination track at the playhead (API limitation). Duplicate names across packs cannot be inserted by name. |
| Generators | Not in this milestone | API exists; planned. Drag from the Effects Library meanwhile. |
| Transitions | Not in this milestone | Native transition API is new in 21.1 and only Cross Dissolve has third-party validation. |
| Effects | No (no API) | Drag from Effects Library › Toolbox/Fusion Effects onto the clip. |

## FFmpeg (optional)

Rough Cut reads audio levels directly from WAV. For other media it uses **your** FFmpeg (Settings › FFmpeg, or on PATH). Nothing is downloaded and no network service is used.
