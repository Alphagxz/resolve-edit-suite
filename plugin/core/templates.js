'use strict';
/**
 * Catalogue installed Fusion templates (titles, generators, effects,
 * transitions) from the Fusion Templates folders, including inside .drfx
 * bundles. Read-only: templates and their dependencies are never modified.
 */
const fs = require('fs');
const path = require('path');
const { listZip, readZipEntry } = require('./zip');
const { inspectFusionSetting } = require('./assets');

/** Default template roots per OS (user + system). Callers may add more. */
function defaultTemplateRoots(platform = process.platform, env = process.env, home = require('os').homedir()) {
  if (platform === 'darwin') {
    return [
      path.join(home, 'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Templates'),
      '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Templates',
    ];
  }
  if (platform === 'win32') {
    return [
      path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), 'Blackmagic Design/DaVinci Resolve/Support/Fusion/Templates'),
      path.join(env.PROGRAMDATA || 'C:/ProgramData', 'Blackmagic Design/DaVinci Resolve/Fusion/Templates'),
    ];
  }
  return [path.join(home, '.local/share/DaVinciResolve/Fusion/Templates'), '/opt/resolve/Fusion/Templates'];
}

const CATEGORY_INSERT = {
  Titles: { method: 'Timeline.InsertFusionTitleIntoTimeline', supported: true,
    note: 'Inserted at the playhead on the Edit page destination track (no track parameter in the API). Track targeting uses the nested-timeline route.' },
  Generators: { method: 'Timeline.InsertFusionGeneratorIntoTimeline', supported: true,
    note: 'Inserted at the playhead on the destination track (no track parameter in the API).' },
  Transitions: { method: 'TimelineItem.AddTransition (category "fusion", Resolve 21.1+)', supported: 'unverified',
    note: 'Native transition creation exists from 21.1; Fusion transitions are not yet live-validated. Manual drag is the fallback.' },
  Effects: { method: null, supported: false,
    note: 'No API applies an Effects-library Fusion effect to a clip. Manual workflow: drag from Effects Library > Toolbox/Fusion Effects onto the clip.' },
};

function categoryFromPath(rel) {
  const parts = rel.split(/[\\/]/);
  const editIdx = parts.findIndex((p) => p.toLowerCase() === 'edit');
  const cat = editIdx >= 0 ? parts[editIdx + 1] : parts.find((p) => CATEGORY_INSERT[p]);
  const sub = editIdx >= 0 ? parts.slice(editIdx + 2, -1).join('/') : parts.slice(0, -1).join('/');
  return { category: CATEGORY_INSERT[cat] ? cat : 'Other', subcategory: sub || null };
}

function walk(dir, out, depth = 0) {
  if (depth > 12) return;
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of list) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) walk(full, out, depth + 1);
    else if (/\.(setting|drfx)$/i.test(d.name)) out.push(full);
  }
}

function makeEntry({ name, rel, source, bundle, thumbnail, info, root }) {
  const { category, subcategory } = categoryFromPath(rel);
  const ins = CATEGORY_INSERT[category] || { method: null, supported: false, note: 'Not in a recognised Edit template category; manual workflow only.' };
  return {
    id: `${bundle || source}::${rel}`,
    name,
    category,
    subcategory,
    root,
    source,
    bundle: bundle || null,
    thumbnail: thumbnail || null,
    insertMethod: ins.method,
    insertSupported: ins.supported,
    insertNote: ins.note,
    hasEditableText: info ? info.editableText.length > 0 || info.hasTextPlus : null,
    toolTypes: info ? info.toolTypes : null,
  };
}

/**
 * @returns {{ templates: Array, errors: Array<{path, error}>, duplicates: Array<{name, count}> }}
 */
function catalogueTemplates(roots = defaultTemplateRoots()) {
  const templates = [];
  const errors = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const files = [];
    walk(root, files);
    for (const file of files) {
      const rel = path.relative(root, file);
      try {
        if (/\.drfx$/i.test(file)) {
          const entries = listZip(file);
          const pngs = new Set(entries.filter((e) => /\.png$/i.test(e.name)).map((e) => e.name.toLowerCase()));
          for (const e of entries.filter((x) => /\.setting$/i.test(x.name))) {
            let info = null;
            try { info = inspectFusionSetting(readZipEntry(file, e).toString('utf8')); } catch (err) { errors.push({ path: `${file}!${e.name}`, error: err.message }); }
            const thumbName = e.name.replace(/\.setting$/i, '.png');
            templates.push(makeEntry({
              name: path.basename(e.name, path.extname(e.name)), rel: e.name, source: file, bundle: file, root,
              thumbnail: pngs.has(thumbName.toLowerCase()) ? { bundle: file, entry: thumbName } : null, info,
            }));
          }
        } else {
          let info = null;
          try { info = inspectFusionSetting(fs.readFileSync(file, 'utf8')); } catch (err) { errors.push({ path: file, error: err.message }); }
          const png = file.replace(/\.setting$/i, '.png');
          templates.push(makeEntry({ name: path.basename(file, path.extname(file)), rel, source: file, root, thumbnail: fs.existsSync(png) ? { file: png } : null, info }));
        }
      } catch (err) {
        errors.push({ path: file, error: err.message });
      }
    }
  }
  const counts = new Map();
  for (const t of templates) {
    const k = `${t.category}/${t.name}`.toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const duplicates = [...counts].filter(([, c]) => c > 1).map(([name, count]) => ({ name, count }));
  for (const t of templates) {
    t.ambiguousName = (counts.get(`${t.category}/${t.name}`.toLowerCase()) || 0) > 1;
  }
  return { templates, errors, duplicates };
}

/** Case-insensitive multi-term search over name, category, subcategory and bundle. */
function searchTemplates(templates, query, { category, favourites } = {}) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return templates.filter((t) => {
    if (category && t.category !== category) return false;
    if (favourites && !favourites.has(t.id)) return false;
    const hay = `${t.name} ${t.category} ${t.subcategory || ''} ${t.bundle ? path.basename(t.bundle) : ''}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

module.exports = { defaultTemplateRoots, catalogueTemplates, searchTemplates, CATEGORY_INSERT, categoryFromPath };
