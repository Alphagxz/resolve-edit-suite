'use strict';
/**
 * In-memory MOCK of the subset of the Resolve scripting object model that the
 * suite uses. It encodes behaviour reported by third-party live tests
 * (AppendToTimeline drops overlapping placements; imports land in the
 * current folder; Insert*IntoTimeline has no track argument) so the plugin
 * logic can be exercised end to end. Passing these tests says nothing about
 * real Resolve behaviour — that is what Diagnostics on a real install is for.
 */
const fs = require('fs');
const path = require('path');
const { parseSrt } = require('../../plugin/core/subtitles');
const tb = require('../../plugin/core/timebase');

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

class Tool {
  constructor(type, inputs) { this.type = type; this.inputs = { ...inputs }; this.drivenBy = {}; }
  SetInput(k, v) {
    if (this.drivenBy[k]) return false; // connected input: Fusion ignores the write
    this.inputs[k] = v;
    return true;
  }
  GetInput(k) { return this.drivenBy[k] ? this.drivenBy[k].tool.GetInput(this.drivenBy[k].input) : this.inputs[k]; }
}
/**
 * Mirrors the MotionText Pro wirings decoded from the real .drb:
 *   'follower' Text+ StyledText <- StyledTextFollower.Text (word animations)
 *   'direct'   Text+ StyledText holds the words
 *   'none'     no Text+ (zoom / adjustment clips)
 */
class Comp {
  constructor(wiring = 'direct', presetText = 'Caption') {
    this.tools = {};
    if (wiring === 'none') { this.tools.Transform1 = new Tool('Transform', {}); return; }
    this.tools.Template = new Tool('TextPlus', { StyledText: presetText });
    if (wiring === 'follower') {
      this.tools.Follower1 = new Tool('StyledTextFollower', { Text: presetText });
      this.tools.Template.drivenBy.StyledText = { tool: this.tools.Follower1, input: 'Text' };
    }
  }
  GetToolList(_sel, type) {
    const list = Object.values(this.tools).filter((t) => !type || t.type === type);
    return Object.fromEntries(list.map((t, i) => [i + 1, t]));
  }
  FindTool(name) { return this.tools[name] || null; }
  /** What the viewer would show (test helper). */
  renderedText() { return this.tools.Template ? this.tools.Template.GetInput('StyledText') : null; }
}

class MediaPoolItem {
  constructor(name, props = {}, extra = {}) {
    this.id = nextId('mpi');
    this.name = name;
    this.props = { Type: 'Video + Audio', FPS: 25, 'Start TC': '00:00:00:00', 'Transcription Status': '', ...props };
    Object.assign(this, extra);
  }
  GetName() { return this.name; }
  GetUniqueId() { return this.id; }
  GetClipProperty(k) { return k === undefined ? { ...this.props } : this.props[k]; }
  GetTranscription() { return this.transcription || null; }
  TranscribeAudio() { this.props['Transcription Status'] = 'Transcribed'; return true; }
}

class Folder {
  constructor(name) { this.name = name; this.id = nextId('folder'); this.subs = []; this.clips = []; }
  GetName() { return this.name; }
  GetUniqueId() { return this.id; }
  GetSubFolderList() { return { ...this.subs.reduce((o, f, i) => ({ ...o, [i + 1]: f }), {}) }; }
  GetClipList() { return this.clips.slice(); }
}

class TimelineItem {
  constructor({ name, start, end, leftOffset = 0, mpi = null, fusion = false, text = null, sourceStartTime = null }) {
    Object.assign(this, { name, start, end, leftOffset, mpi, sourceStartTimeOverride: sourceStartTime });
    this.uid = nextId('item');
    this.comp = fusion ? new Comp(mpi && mpi.wiring, mpi && mpi.name) : null;
    if (text !== null) this.text = text;
  }
  GetName() { return this.text || this.name; }
  GetUniqueId() { return this.uid; }
  GetStart() { return this.start; }
  GetEnd() { return this.end; }
  GetDuration() { return this.end - this.start; }
  // Real Resolve (21.0.0b20) raises for items without source media.
  _requireMedia(method) {
    if (!this.mpi) throw new Error(`Execute: ${method}: Error response (errorStr:Item is not a media) (errorCode:6)`);
  }
  GetLeftOffset() { this._requireMedia('GetLeftOffset'); return this.leftOffset; }
  // Seconds into the source media (official since 21.0). Mock: leftOffset is in media frames.
  GetSourceStartTime() {
    this._requireMedia('GetSourceStartTime');
    if (this.sourceStartTimeOverride !== null) return this.sourceStartTimeOverride;
    return this.mpi ? this.leftOffset / Number(this.mpi.props.FPS) : 0;
  }
  GetMediaPoolItem() { return this.mpi; }
  GetFusionCompCount() { return this.comp ? 1 : 0; }
  GetFusionCompByIndex(i) { return i === 1 ? this.comp : null; }
  GetSpeed() { return { Percentage: 100 }; }
}

class Timeline {
  constructor(project, name, { rate = '25', width = 1920, height = 1080, startFrame = 90000 } = {}) {
    this.project = project;
    this.name = name;
    this.settings = { timelineFrameRate: rate, timelineResolutionWidth: String(width), timelineResolutionHeight: String(height), timelineDropFrameTimecode: '0' };
    this.startFrame = startFrame;
    this.tracks = { video: [[]], audio: [[]], subtitle: [] };
    this.markers = {};
    this.minLength = 0;
  }
  GetName() { return this.name; }
  GetSetting(k) { return k === undefined ? { ...this.settings } : this.settings[k]; }
  GetStartFrame() { return this.startFrame; }
  GetEndFrame() {
    let end = this.startFrame + this.minLength;
    for (const t of Object.values(this.tracks)) for (const tr of t) for (const it of tr) end = Math.max(end, it.end);
    return end; // mock convention: exclusive
  }
  GetStartTimecode() { return require('../../plugin/core/timecode').framesToTimecode(this.startFrame, tb.parseFrameRate(this.settings.timelineFrameRate)); }
  GetTrackCount(type) { return this.tracks[type].length; }
  GetItemListInTrack(type, i) { return (this.tracks[type][i - 1] || []).slice().sort((a, b) => a.start - b.start); }
  AddTrack(type) { this.tracks[type].push([]); return true; }
  DeleteTrack(type, i) {
    if (!this.tracks[type][i - 1]) return false;
    this.tracks[type].splice(i - 1, 1);
    return true;
  }
  DeleteClips(items) {
    for (const k of Object.keys(this.tracks)) this.tracks[k] = this.tracks[k].map((tr) => tr.filter((x) => !items.includes(x)));
    return true;
  }
  contentEnd() {
    let end = this.startFrame;
    for (const k of ['video', 'audio']) for (const tr of this.tracks[k]) for (const it of tr) end = Math.max(end, it.end);
    return end;
  }
  AddMarker(frame, color, name, note, duration, customData) {
    if (this.markers[frame]) return false;
    this.markers[frame] = { color, name, note, duration, customData };
    return true;
  }
  GetMarkers() { return { ...this.markers }; }
  // Official README (21.0): "Delete first matching marker with specified customData."
  DeleteMarkerByCustomData(cd) {
    const hit = Object.entries(this.markers).find(([, m]) => m.customData === cd);
    if (!hit) return false;
    delete this.markers[hit[0]];
    return true;
  }
  DeleteMarkerAtFrame(frame) {
    if (!this.markers[frame]) return false;
    delete this.markers[frame];
    return true;
  }
  DuplicateTimeline(name) {
    const t = new Timeline(this.project, name, {});
    t.settings = { ...this.settings };
    t.startFrame = this.startFrame;
    t.tracks = JSON.parse(JSON.stringify({ video: [], audio: [], subtitle: [] }));
    for (const k of Object.keys(this.tracks)) t.tracks[k] = this.tracks[k].map((tr) => tr.map((it) => Object.assign(Object.create(TimelineItem.prototype), it)));
    this.project.timelines.push(t);
    this.project.current = t; // mimic a duplicate becoming current
    return t;
  }
  InsertFusionTitleIntoTimeline(name) {
    const tr = this.tracks.video[0];
    const at = this.playhead ?? this.startFrame;
    if (tr.some((x) => x.start < at + 125 && x.end > at)) {
      // Real Resolve ripple-inserts; the mock just places on a fresh track to keep tests simple.
      this.tracks.video.push([]);
    }
    const item = new TimelineItem({ name, start: at, end: at + 125, fusion: true });
    this.tracks.video[this.tracks.video.length - 1].push(item);
    return item;
  }
}

class MediaPool {
  constructor(project) {
    this.project = project;
    this.root = new Folder('Master');
    this.current = this.root;
  }
  GetRootFolder() { return this.root; }
  GetCurrentFolder() { return this.current; }
  SetCurrentFolder(f) { this.current = f; return true; }
  AddSubFolder(parent, name) { const f = new Folder(name); parent.subs.push(f); return f; }
  CreateEmptyTimeline(name) {
    if (this.project.timelines.some((t) => t.name === name)) return null;
    const t = new Timeline(this.project, name, { rate: this.project.settings.timelineFrameRate, width: Number(this.project.settings.timelineResolutionWidth), height: Number(this.project.settings.timelineResolutionHeight), startFrame: this.project.newTimelineStart });
    this.project.timelines.push(t);
    return t;
  }
  DeleteTimelines(list) {
    this.project.timelines = this.project.timelines.filter((t) => !list.includes(t));
    return true;
  }
  DeleteClips(list) {
    const rm = (f) => { f.clips = f.clips.filter((c) => !list.includes(c)); f.subs.forEach(rm); };
    rm(this.root);
    return true;
  }
  ImportMedia(paths) {
    const out = [];
    for (const p of paths) {
      if (!fs.existsSync(p)) continue;
      const item = /\.srt$/i.test(p)
        ? new MediaPoolItem(path.basename(p), { Type: 'Subtitle' }, { srt: fs.readFileSync(p, 'utf8') })
        : new MediaPoolItem(path.basename(p), { 'File Path': p });
      this.current.clips.push(item);
      out.push(item);
    }
    return out;
  }
  ImportFolderFromFile(file) {
    if (!fs.existsSync(file)) return false;
    const f = new Folder(path.basename(file).replace(/\.drb$/i, ''));
    // Same three wirings as the real MotionText Pro presets (24 fps generators).
    const gen = (name, wiring) => new MediaPoolItem(name, { Type: 'Generator', FPS: 25, Frames: 250 }, { fusionTitle: true, wiring });
    f.clips.push(gen('Smooth Word Up', 'follower'), gen('Glitch Text', 'direct'), gen('slow zoomout', 'none'));
    this.root.subs.push(f);
    return true;
  }
  AppendToTimeline(infos) {
    const tl = this.project.current;
    const placed = [];
    for (const info of infos) {
      const mpi = info.mediaPoolItem;
      if (mpi.srt) {
        // Observed on 21.0.0b20: with recordFrame but no trackIndex, Resolve
        // appended after the existing content. Honouring recordFrame when a
        // trackIndex is given is the HYPOTHESIS under test on real Resolve;
        // subtitlePlacement = 'always-append' simulates a build where it is not.
        const rate = tb.parseFrameRate(tl.settings.timelineFrameRate);
        const honour = info.trackIndex && this.subtitlePlacement !== 'always-append';
        const base = honour ? info.recordFrame ?? tl.startFrame : tl.contentEnd();
        const tIdx = info.trackIndex ? info.trackIndex - 1 : 0;
        while (tl.tracks.subtitle.length <= tIdx) tl.tracks.subtitle.push([]);
        for (const c of parseSrt(mpi.srt).cues) {
          tl.tracks.subtitle[tIdx].push(new TimelineItem({ name: 'Subtitle', text: c.text, start: base + tb.flicksToFrames(c.start, rate, 'floor'), end: base + tb.flicksToFrames(c.end, rate, 'floor') }));
        }
        placed.push(true);
        continue;
      }
      const trackIdx = (info.trackIndex || 1) - 1;
      const kinds = info.mediaType === 2 ? ['audio'] : info.mediaType === 1 || mpi.fusionTitle ? ['video'] : ['video', 'audio'];
      const srcRate = tb.parseFrameRate(mpi.props.FPS);
      const tlRate = tb.parseFrameRate(tl.settings.timelineFrameRate);
      const srcFrames = info.endFrame - info.startFrame + 1; // mock: inclusive endFrame
      const dur = tb.convertFrames(srcFrames, srcRate, tlRate, 'floor');
      const rec = info.recordFrame ?? tl.GetEndFrame();
      let first = null;
      for (const k of kinds) {
        while (tl.tracks[k].length <= trackIdx) tl.tracks[k].push([]);
        const tr = tl.tracks[k][trackIdx];
        if (tr.some((x) => x.start < rec + dur && x.end > rec)) continue; // earlier item wins
        const item = new TimelineItem({ name: mpi.name, start: rec, end: rec + dur, leftOffset: info.startFrame, mpi, fusion: Boolean(mpi.fusionTitle) });
        tr.push(item);
        first = first || item;
      }
      placed.push(first);
    }
    return placed.filter(Boolean).length ? placed : [];
  }
}

class Project {
  constructor() {
    this.id = nextId('project');
    this.name = 'Client Ad';
    this.settings = { timelineFrameRate: '25', timelineResolutionWidth: '1920', timelineResolutionHeight: '1080' };
    this.mediaPool = new MediaPool(this);
    this.timelines = [];
    this.current = null;
    this.newTimelineStart = 90000;
  }
  GetName() { return this.name; }
  GetUniqueId() { return this.id; }
  GetSetting(k) { return this.settings[k]; }
  GetMediaPool() { return this.mediaPool; }
  GetCurrentTimeline() { return this.current; }
  SetCurrentTimeline(t) { if (!this.timelines.includes(t)) return false; this.current = t; return true; }
  GetTimelineCount() { return this.timelines.length; }
}

function createFakeResolve({ version = [21, 1, 0, 14, ''], studio = true } = {}) {
  const project = new Project();
  const pm = { GetCurrentProject: () => project, SaveProject: () => true };
  const resolve = {
    GetVersion: () => version,
    GetVersionString: () => version.slice(0, 4).join('.'),
    GetProductName: () => (studio ? 'DaVinci Resolve Studio' : 'DaVinci Resolve'),
    GetProjectManager: () => pm,
  };
  return { resolve, project, pm, MediaPoolItem, Timeline, TimelineItem };
}

module.exports = { createFakeResolve, MediaPoolItem, Timeline, TimelineItem, Comp };
