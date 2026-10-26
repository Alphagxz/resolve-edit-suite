#!/usr/bin/env python3
"""
Edit Suite discovery probe — READ-ONLY.

Collects the facts the suite cannot know without your machine:
  * Resolve product/version, OS, Python
  * the official developer docs shipped with YOUR install (scripting README,
    typed stub, Workflow Integration README and sample plugin layout/manifest)
  * the methods each live Resolve object really exposes (dir()), compared with
    the methods the suite needs
  * the shape (not the content) of a Resolve 21.1 transcription payload
  * current timeline settings and frame conventions as reported
  * the real format of your caption preset file and your installed templates

It never writes to Resolve, your projects, presets or media. Output goes to a
new folder "edit-suite-discovery-<timestamp>" next to this script (or --out).

Run either:
  1. Inside Resolve: copy to the Scripts/Utility folder, then
     Workspace > Scripts > discover   (set EDIT_SUITE_PRESET=/path/to/file first,
     or pass nothing and the preset section is skipped), or
  2. From a terminal with Resolve running (Studio, external scripting enabled
     in Preferences > System > General > "External scripting using"):
       python3 discover.py --preset "/path/to/Rayan Herrick Captions.drb"
"""
import argparse
import datetime
import json
import os
import platform
import shutil
import sys
import zipfile

# Methods the suite calls, grouped by object (kept in sync with
# plugin/resolve/capabilities.js and the ops/ modules).
REQUIRED = {
    "Resolve": ["GetVersion", "GetVersionString", "GetProductName", "GetProjectManager"],
    "ProjectManager": ["GetCurrentProject", "SaveProject"],
    "Project": ["GetName", "GetUniqueId", "GetCurrentTimeline", "SetCurrentTimeline", "GetMediaPool", "GetSetting", "GetTimelineCount"],
    "MediaPool": ["GetRootFolder", "GetCurrentFolder", "SetCurrentFolder", "AddSubFolder", "CreateEmptyTimeline", "AppendToTimeline",
                  "ImportMedia", "ImportFolderFromFile", "DeleteTimelines", "DeleteClips"],
    "Folder": ["GetName", "GetUniqueId", "GetSubFolderList", "GetClipList"],
    "Timeline": ["GetName", "GetSetting", "GetStartFrame", "GetEndFrame", "GetStartTimecode", "GetTrackCount", "GetItemListInTrack",
                 "AddTrack", "AddMarker", "GetMarkers", "DeleteMarkerByCustomData", "DuplicateTimeline",
                 "InsertFusionTitleIntoTimeline", "CreateSubtitlesFromAudio"],
    "TimelineItem": ["GetName", "GetStart", "GetEnd", "GetDuration", "GetLeftOffset", "GetMediaPoolItem", "GetFusionCompCount",
                     "GetFusionCompByIndex", "GetType", "GetSpeed", "SetFades", "GetFades", "AddTransition"],
    "MediaPoolItem": ["GetName", "GetUniqueId", "GetClipProperty", "TranscribeAudio", "GetTranscription"],
}

SENTINEL = "__editSuiteNonexistentProbe__"


def get_resolve():
    g = globals()
    if "resolve" in g and g["resolve"]:
        return g["resolve"], "in-app"
    try:
        import DaVinciResolveScript as dvr  # noqa: N813
    except ImportError:
        api = {
            "darwin": "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules",
            "win32": os.path.join(os.environ.get("PROGRAMDATA", "C:\\ProgramData"), "Blackmagic Design", "DaVinci Resolve", "Support", "Developer", "Scripting", "Modules"),
        }.get(sys.platform, "/opt/resolve/Developer/Scripting/Modules")
        sys.path.append(api)
        try:
            import DaVinciResolveScript as dvr  # noqa: N813
        except ImportError:
            return None, "DaVinciResolveScript module not found (see README section 'Using a script')"
    r = dvr.scriptapp("Resolve")
    return r, "external" if r else "external scripting refused (enable it in Preferences, Studio only)"


def developer_dirs():
    if sys.platform == "darwin":
        base = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer"
    elif sys.platform == "win32":
        base = os.path.join(os.environ.get("PROGRAMDATA", "C:\\ProgramData"), "Blackmagic Design", "DaVinci Resolve", "Support", "Developer")
    else:
        base = "/opt/resolve/Developer"
    return base


def wi_plugin_dir():
    if sys.platform == "darwin":
        return "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins"
    if sys.platform == "win32":
        return os.path.join(os.environ.get("PROGRAMDATA", "C:\\ProgramData"), "Blackmagic Design", "DaVinci Resolve", "Support", "Workflow Integration Plugins")
    return None


def template_roots():
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        return [os.path.join(home, "Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Templates"),
                "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Templates"]
    if sys.platform == "win32":
        return [os.path.join(os.environ.get("APPDATA", ""), "Blackmagic Design", "DaVinci Resolve", "Support", "Fusion", "Templates"),
                os.path.join(os.environ.get("PROGRAMDATA", "C:\\ProgramData"), "Blackmagic Design", "DaVinci Resolve", "Fusion", "Templates")]
    return [os.path.join(home, ".local/share/DaVinciResolve/Fusion/Templates"), "/opt/resolve/Fusion/Templates"]


def safe(fn, *a):
    try:
        return fn(*a)
    except Exception as e:  # noqa: BLE001 - discovery must never crash
        return {"error": repr(e)}


def methods_of(obj):
    if obj is None:
        return None
    try:
        names = sorted(n for n in dir(obj) if not n.startswith("_"))
    except Exception as e:  # noqa: BLE001
        return {"error": repr(e)}
    fabricated = False
    try:
        fabricated = callable(getattr(obj, SENTINEL, None))
    except Exception:  # noqa: BLE001
        fabricated = False
    return {"dir": names, "getattrFabricatesNames": fabricated}


def first(seq):
    if isinstance(seq, dict):
        seq = [seq[k] for k in sorted(seq)]
    return seq[0] if seq else None


def shape(value, depth=0):
    """Structure of a value without its content (text replaced by its length)."""
    if depth > 6:
        return "…"
    if isinstance(value, dict):
        return {k: shape(v, depth + 1) for k, v in list(value.items())[:20]}
    if isinstance(value, (list, tuple)):
        return [shape(value[0], depth + 1), f"(+{len(value) - 1} more)"] if value else []
    if isinstance(value, str):
        return f"<str len={len(value)} sample={value[:12]!r}>" if any(c.isdigit() for c in value[:12]) else f"<str len={len(value)}>"
    return value if isinstance(value, (int, float, bool)) or value is None else repr(type(value))


def sniff_file(path):
    out = {"path": path, "exists": os.path.exists(path)}
    if not out["exists"]:
        return out
    if os.path.isdir(path):
        out["kind"] = "directory"
        out["entries"] = sorted(os.listdir(path))[:100]
        return out
    out["size"] = os.path.getsize(path)
    with open(path, "rb") as f:
        head = f.read(64)
    out["magicHex"] = head[:16].hex(" ")
    if head.startswith(b"SQLite format 3"):
        out["kind"] = "sqlite-database"
    elif zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
        out["kind"] = "zip"
        out["entryCount"] = len(names)
        out["entries"] = names[:200]
    elif head.lstrip().startswith(b"{"):
        out["kind"] = "lua-table (Fusion .setting/.comp?)"
    elif head.lstrip().startswith(b"<"):
        out["kind"] = "xml"
    else:
        out["kind"] = "unknown-binary"
    return out


def copy_if(src, dst_dir, collected):
    if os.path.exists(src):
        dst = os.path.join(dst_dir, os.path.basename(src))
        shutil.copy2(src, dst)
        collected.append(dst)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--preset", default=os.environ.get("EDIT_SUITE_PRESET"), help="caption preset file to identify")
    ap.add_argument("--out", default=None, help="output folder (default: next to this script)")
    args = ap.parse_args([] if "resolve" in globals() else None)

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), f"edit-suite-discovery-{stamp}")
    os.makedirs(out_dir, exist_ok=True)
    docs_dir = os.path.join(out_dir, "official-docs")
    os.makedirs(docs_dir, exist_ok=True)

    report = {"generatedAt": stamp, "os": {"platform": sys.platform, "release": platform.release(), "machine": platform.machine()},
              "python": sys.version}

    resolve, mode = get_resolve()
    report["connection"] = mode
    if resolve:
        report["resolve"] = {"product": safe(resolve.GetProductName), "version": safe(resolve.GetVersionString), "versionList": safe(resolve.GetVersion)}

    # Official documentation shipped with this install.
    dev = developer_dirs()
    collected = []
    report["developerDir"] = {"path": dev, "exists": os.path.isdir(dev)}
    if os.path.isdir(dev):
        listing = []
        for root, _dirs, files in os.walk(dev):
            for f in files:
                rel = os.path.relpath(os.path.join(root, f), dev)
                listing.append(rel)
                low = f.lower()
                if low.startswith("readme") or low.endswith(".pyi") or low == "manifest.xml" or low.endswith(".md"):
                    sub = os.path.join(docs_dir, os.path.dirname(rel))
                    os.makedirs(sub, exist_ok=True)
                    copy_if(os.path.join(root, f), sub, collected)
        report["developerDir"]["files"] = sorted(listing)
    report["officialDocsCopied"] = [os.path.relpath(p, out_dir) for p in collected]
    report["workflowIntegrationPluginDir"] = {"path": wi_plugin_dir(), "exists": bool(wi_plugin_dir() and os.path.isdir(wi_plugin_dir()))}
    if report["workflowIntegrationPluginDir"]["exists"]:
        report["workflowIntegrationPluginDir"]["installed"] = sorted(os.listdir(wi_plugin_dir()))

    # Which required methods are documented in the shipped README text?
    readme_text = ""
    for p in collected:
        if os.path.basename(p).lower().startswith("readme") or p.endswith(".pyi"):
            with open(p, "r", encoding="utf-8", errors="replace") as fh:
                readme_text += fh.read()

    # Live object surfaces (read-only calls only).
    objs = {"Resolve": resolve}
    if resolve:
        pm = safe(resolve.GetProjectManager)
        objs["ProjectManager"] = pm if not isinstance(pm, dict) else None
        proj = safe(pm.GetCurrentProject) if objs["ProjectManager"] else None
        objs["Project"] = proj if proj and not isinstance(proj, dict) else None
        if objs["Project"]:
            mp = safe(objs["Project"].GetMediaPool)
            objs["MediaPool"] = mp if not isinstance(mp, dict) else None
            if objs["MediaPool"]:
                objs["Folder"] = safe(objs["MediaPool"].GetRootFolder)
            tl = safe(objs["Project"].GetCurrentTimeline)
            objs["Timeline"] = tl if tl and not isinstance(tl, dict) else None
            if objs["Timeline"]:
                t = objs["Timeline"]
                report["timeline"] = {
                    "name": safe(t.GetName),
                    "settings": {k: safe(t.GetSetting, k) for k in ["timelineFrameRate", "timelineDropFrameTimecode", "timelineResolutionWidth",
                                                                     "timelineResolutionHeight", "timelinePlaybackFrameRate", "timelineInterlaceProcessing"]},
                    "startFrame": safe(t.GetStartFrame), "endFrame": safe(t.GetEndFrame), "startTimecode": safe(t.GetStartTimecode),
                    "trackCounts": {k: safe(t.GetTrackCount, k) for k in ["video", "audio", "subtitle"]},
                }
                for kind in ["video", "audio"]:
                    item = first(safe(t.GetItemListInTrack, kind, 1) or [])
                    if item and not isinstance(item, dict):
                        objs["TimelineItem"] = item
                        report["timeline"]["firstItem"] = {"start": safe(item.GetStart), "end": safe(item.GetEnd), "duration": safe(item.GetDuration),
                                                           "leftOffset": safe(item.GetLeftOffset)}
                        mpi = safe(item.GetMediaPoolItem)
                        if mpi and not isinstance(mpi, dict):
                            objs["MediaPoolItem"] = mpi
                            props = safe(mpi.GetClipProperty) or {}
                            report["timeline"]["firstItem"]["clipProperties"] = {k: props.get(k) for k in ["Type", "FPS", "Frames", "Start TC", "Duration", "Transcription Status"]} if isinstance(props, dict) else props
                            if isinstance(props, dict) and props.get("Transcription Status") == "Transcribed" and "GetTranscription" in dir(mpi):
                                report["transcriptionShape"] = shape(safe(mpi.GetTranscription, False))
                        break

    surface = {}
    for name, needed in REQUIRED.items():
        m = methods_of(objs.get(name))
        entry = {"probed": m is not None and "dir" in (m or {})}
        if entry["probed"]:
            entry["getattrFabricatesNames"] = m["getattrFabricatesNames"]
            entry["dir"] = m["dir"]
            entry["missing"] = [x for x in needed if x not in m["dir"]]
        entry["undocumented"] = [x for x in needed if readme_text and x not in readme_text]
        surface[name] = entry
    report["apiSurface"] = surface

    if args.preset:
        report["captionPreset"] = sniff_file(args.preset)

    templates = []
    for root in template_roots():
        info = {"root": root, "exists": os.path.isdir(root), "settings": [], "drfx": []}
        if info["exists"]:
            for r, _d, files in os.walk(root):
                for f in files:
                    rel = os.path.relpath(os.path.join(r, f), root)
                    if f.lower().endswith(".setting"):
                        info["settings"].append(rel)
                    elif f.lower().endswith(".drfx"):
                        z = sniff_file(os.path.join(r, f))
                        info["drfx"].append({"file": rel, "entries": [e for e in z.get("entries", []) if e.lower().endswith((".setting", ".png"))]})
        templates.append(info)
    report["templates"] = templates

    with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, default=str)

    lines = [f"# Edit Suite discovery {stamp}", "",
             f"- Resolve: {report.get('resolve', {}).get('product')} {report.get('resolve', {}).get('version')} ({mode})",
             f"- OS: {sys.platform} {platform.release()}",
             f"- Developer docs: {dev} ({'found' if os.path.isdir(dev) else 'NOT FOUND'}); copied {len(collected)} file(s)", ""]
    lines.append("## Required methods")
    for name, e in surface.items():
        if not e["probed"]:
            why = "Resolve not connected" if not resolve else "object unavailable — open a project/timeline with a clip on V1/A1"
            lines.append(f"- {name}: not probed ({why})")
        else:
            lines.append(f"- {name}: missing {e['missing'] or 'none'}; getattr fabricates names: {e['getattrFabricatesNames']}")
        if e["undocumented"]:
            lines.append(f"  - not found in shipped docs: {e['undocumented']}")
    if "captionPreset" in report:
        cp = report["captionPreset"]
        lines += ["", "## Caption preset", f"- {cp.get('path')}: {cp.get('kind')} ({cp.get('size')} bytes, magic {cp.get('magicHex')})"]
    lines += ["", "## Templates"] + [f"- {t['root']}: {'%d .setting, %d .drfx' % (len(t['settings']), len(t['drfx'])) if t['exists'] else 'not present'}" for t in templates]
    with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"Discovery written to {out_dir}")
    print("Nothing in Resolve, your projects, presets or media was changed.")


if __name__ == "__main__" or "resolve" in globals():
    main()
