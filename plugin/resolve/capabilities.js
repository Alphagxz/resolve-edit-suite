'use strict';
/**
 * Version adapter: the ONLY place that knows which Resolve API methods a
 * feature needs, which version introduced them and how strong our evidence
 * is. UI and operations ask `isAvailable(featureId)`; they never compare
 * version numbers themselves.
 *
 * Evidence levels (strongest first):
 *   verified-here   probed AND exercised on this machine by Diagnostics
 *   live-21.1       third-party live test on Studio 21.1.0.14
 *   live-21.0       third-party live test on Studio 21.0.x
 *   live-legacy     third-party live test on Studio 19.1.3 / 20.3.2
 *   reported        single user report, not reproduced
 *   unverified      documented or inferred, never exercised
 *
 * Statuses: available | assumed (presence not probeable) | needs-verification
 * (weak evidence; enabled only after a Diagnostics scratch test passes on
 * this build) | failed-verification | unavailable.
 * See docs/DISCOVERY_REPORT.md for sources.
 */

const FEATURES = [
  { id: 'timeline.read', label: 'Read project & timeline settings', minVersion: [19, 0, 0],
    methods: [['Project', 'GetCurrentTimeline'], ['Timeline', 'GetSetting'], ['Timeline', 'GetStartFrame'], ['Timeline', 'GetEndFrame'], ['Timeline', 'GetStartTimecode'], ['Timeline', 'GetTrackCount'], ['Timeline', 'GetItemListInTrack']],
    evidence: 'live-legacy' },
  { id: 'timeline.backup', label: 'Back up timeline (duplicate)', minVersion: [19, 0, 0],
    methods: [['Timeline', 'DuplicateTimeline'], ['Project', 'SetCurrentTimeline']], evidence: 'live-legacy' },
  { id: 'timeline.create', label: 'Create timeline & place media', minVersion: [19, 0, 0],
    methods: [['MediaPool', 'CreateEmptyTimeline'], ['MediaPool', 'AppendToTimeline']], evidence: 'live-legacy',
    caveats: ['Overlapping placements are silently dropped (earlier item wins).', 'Mixed-rate durations are floored by Resolve.', 'Placements from an errored call may not survive a save; the suite saves and re-reads.'] },
  { id: 'timeline.tracks', label: 'Add tracks', minVersion: [19, 0, 0], methods: [['Timeline', 'AddTrack']], evidence: 'live-legacy' },
  { id: 'markers', label: 'Timeline markers', minVersion: [19, 0, 0],
    methods: [['Timeline', 'AddMarker'], ['Timeline', 'GetMarkers'], ['Timeline', 'DeleteMarkerByCustomData']], evidence: 'live-legacy' },
  { id: 'media.importBin', label: 'Import Media Pool bin export (.drb)', minVersion: [19, 0, 0],
    methods: [['MediaPool', 'ImportFolderFromFile'], ['MediaPool', 'GetRootFolder']], evidence: 'live-legacy' },
  { id: 'media.import', label: 'Import media files', minVersion: [19, 0, 0],
    methods: [['MediaPool', 'ImportMedia'], ['MediaPool', 'SetCurrentFolder'], ['MediaPool', 'AddSubFolder']], evidence: 'live-legacy',
    caveats: ['Imports land in the current Media Pool folder.'] },
  { id: 'captions.srtTrack', label: 'Place SRT on a subtitle track', minVersion: [21, 0, 4], requiresVerification: true,
    methods: [['MediaPool', 'ImportMedia'], ['MediaPool', 'AppendToTimeline']], evidence: 'reported',
    caveats: ['Reported working on 21.0.4.5 only; Diagnostics runs a scratch test before this is enabled.', 'Subtitle styling cannot be set through the API.'] },
  { id: 'captions.transcription', label: 'Read word-timed transcription', minVersion: [21, 1, 0], studioOnly: true,
    methods: [['MediaPoolItem', 'TranscribeAudio'], ['MediaPoolItem', 'GetTranscription']], evidence: 'live-21.1' },
  { id: 'captions.autoSubtitles', label: "Resolve's own subtitles from audio", minVersion: [18, 5, 0], studioOnly: true,
    methods: [['Timeline', 'CreateSubtitlesFromAudio']], evidence: 'live-legacy',
    caveats: ['Return value is unreliable; success is judged by subtitle track count before/after.'] },
  { id: 'fusion.textEdit', label: 'Set text on Fusion title items', minVersion: [19, 0, 0],
    methods: [['TimelineItem', 'GetFusionCompCount'], ['TimelineItem', 'GetFusionCompByIndex']], evidence: 'live-legacy' },
  { id: 'fusion.insertTitle', label: 'Insert Fusion title by name', minVersion: [19, 0, 0],
    methods: [['Timeline', 'InsertFusionTitleIntoTimeline']], evidence: 'live-legacy',
    caveats: ['No track parameter: lands on the Edit page destination track at the playhead.'] },
  { id: 'item.fades', label: 'Native clip fades', minVersion: [21, 1, 0], methods: [['TimelineItem', 'SetFades'], ['TimelineItem', 'GetFades']], evidence: 'live-21.1' },
  { id: 'item.transitions', label: 'Native transitions', minVersion: [21, 1, 0], methods: [['TimelineItem', 'AddTransition']], evidence: 'live-21.1',
    caveats: ['Only Cross Dissolve was live-validated by third parties.'] },
  { id: 'item.type', label: 'Timeline item type', minVersion: [21, 1, 0], methods: [['TimelineItem', 'GetType']], evidence: 'live-21.1' },
  { id: 'project.save', label: 'Save project', minVersion: [19, 0, 0], methods: [['ProjectManager', 'SaveProject']], evidence: 'live-legacy' },
];

const PROBE_SENTINEL = '__editSuiteNonexistentProbe__';

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Decide whether `name` exists on `obj`. Python's bridge was observed to
 * fabricate attributes; the JS bridge is unmeasured, so we run a control
 * probe with a name that cannot exist. If the control looks callable,
 * presence detection is declared unreliable and features fall back to
 * version floors (clearly labelled "assumed").
 */
function makeProber() {
  const reliability = new Map(); // objType -> boolean
  return {
    reliableFor(objType, obj) {
      if (!reliability.has(objType)) {
        let fabricated = false;
        try { fabricated = typeof obj[PROBE_SENTINEL] === 'function'; } catch { fabricated = false; }
        reliability.set(objType, !fabricated);
      }
      return reliability.get(objType);
    },
    has(obj, name) {
      try { return typeof obj[name] === 'function'; } catch { return false; }
    },
    report() {
      return Object.fromEntries(reliability);
    },
  };
}

/**
 * Evaluate every feature against the live objects available now.
 * @param {object} env { version: [maj,min,patch,build], isStudio: boolean|null, objects: { Resolve, ProjectManager, Project, MediaPool, Timeline, TimelineItem, MediaPoolItem } }
 * @param {object} [verified] featureId -> { ok, at, detail } from Diagnostics scratch tests
 */
function evaluateCapabilities(env, verified = {}) {
  const prober = makeProber();
  const results = {};
  for (const f of FEATURES) {
    const reasons = [];
    let status = 'available';
    if (!env.version || cmpVersion(env.version, f.minVersion) < 0) {
      status = 'unavailable';
      reasons.push(`Requires Resolve ${f.minVersion.join('.')} or newer.`);
    }
    if (f.studioOnly && env.isStudio === false) {
      status = 'unavailable';
      reasons.push('Requires DaVinci Resolve Studio.');
    }
    let assumed = false;
    for (const [objType, method] of f.methods) {
      const obj = env.objects && env.objects[objType];
      if (!obj) {
        assumed = true;
        reasons.push(`${objType} not available to probe (open a project/timeline or select a clip); presence of ${objType}.${method} assumed from version.`);
        continue;
      }
      if (!prober.reliableFor(objType, obj)) {
        assumed = true;
        reasons.push(`Method detection on ${objType} is unreliable on this build; ${method} assumed from version.`);
        continue;
      }
      if (!prober.has(obj, method)) {
        status = 'unavailable';
        reasons.push(`${objType}.${method} is not exposed by this Resolve build.`);
      }
    }
    const v = verified[f.id];
    if (status === 'available' && v && v.ok === false) {
      status = 'failed-verification';
      reasons.push(`Scratch test failed on ${v.at}: ${v.detail}`);
    }
    if (status === 'available' && f.requiresVerification && !(v && v.ok)) {
      status = 'needs-verification';
      reasons.push('Evidence is too weak to enable automatically. Run the scratch test in Diagnostics first.');
    }
    results[f.id] = {
      id: f.id,
      label: f.label,
      status: status === 'available' && assumed ? 'assumed' : status,
      evidence: v && v.ok ? 'verified-here' : f.evidence,
      caveats: f.caveats || [],
      reasons,
    };
  }
  return { features: results, probeReliability: prober.report() };
}

function isAvailable(caps, id) {
  const f = caps && caps.features[id];
  return Boolean(f && (f.status === 'available' || f.status === 'assumed'));
}

module.exports = { FEATURES, evaluateCapabilities, isAvailable, cmpVersion, PROBE_SENTINEL };
