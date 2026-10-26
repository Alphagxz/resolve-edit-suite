'use strict';
/**
 * Edit the caption words inside an exported Fusion composition (.comp, Lua
 * table text as written by TimelineItem.ExportFusionComp).
 *
 * Why: on Resolve 21.0.0b20 the scripting API does not expose StyledTextFollower
 * modifier nodes (not in GetToolList, not found by FindTool), and in 30 of
 * MotionText Pro's 39 text presets the words live in that follower's Text
 * input. Exporting the composition, replacing the words and importing it back
 * uses only documented TimelineItem methods.
 *
 * Targets, in order:
 *   1. every StyledTextFollower's  Text = Input { Value = StyledText { Value = "…" } }
 *   2. otherwise every TextPlus     StyledText = Input { Value = "…" }
 * Connected inputs (SourceOp = …) are never touched.
 */

const STR = '"(?:[^"\\\\]|\\\\.)*"';

function luaString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

function unLuaString(lit) {
  return lit.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));
}

/** Slice the Lua text into top-level tool blocks "Name = Type { ... }" with balanced braces. */
function toolBlocks(lua) {
  const blocks = [];
  const re = /(\w+)\s*=\s*(\w+)\s*\{/g;
  let m;
  while ((m = re.exec(lua))) {
    if (!['TextPlus', 'StyledTextFollower'].includes(m[2])) continue;
    let depth = 0;
    let i = re.lastIndex - 1;
    let inStr = false;
    for (; i < lua.length; i++) {
      const ch = lua[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) break;
    }
    blocks.push({ name: m[1], type: m[2], start: m.index, end: i + 1 });
    re.lastIndex = i + 1;
  }
  return blocks;
}

const FOLLOWER_TEXT = new RegExp(`(\\bText\\s*=\\s*Input\\s*\\{\\s*Value\\s*=\\s*StyledText\\s*\\{\\s*Value\\s*=\\s*)(${STR})`);
const TEXTPLUS_TEXT = new RegExp(`(\\bStyledText\\s*=\\s*Input\\s*\\{\\s*Value\\s*=\\s*)(${STR})`);

/**
 * @returns {{ ok: true, lua, target: 'follower'|'text+', count } | { ok: false, reason }}
 */
function patchCompText(lua, text) {
  if (/\bCompressed\s*=\s*true\b/.test(lua) && !/\bTools\s*=\s*ordered\(\)/.test(lua)) {
    return { ok: false, reason: 'Resolve exported this composition in compressed form, so its words cannot be edited.' };
  }
  const blocks = toolBlocks(lua);
  for (const [type, re, target] of [['StyledTextFollower', FOLLOWER_TEXT, 'follower'], ['TextPlus', TEXTPLUS_TEXT, 'text+']]) {
    const hits = blocks.filter((b) => b.type === type && re.test(lua.slice(b.start, b.end)));
    if (!hits.length) continue;
    let out = '';
    let pos = 0;
    for (const b of hits) {
      out += lua.slice(pos, b.start) + lua.slice(b.start, b.end).replace(re, (_, pre) => pre + luaString(text));
      pos = b.end;
    }
    return { ok: true, lua: out + lua.slice(pos), target, count: hits.length };
  }
  return { ok: false, reason: 'No editable text was found in the exported composition (no follower Text and no literal Text+ StyledText).' };
}

/** The words a composition will show: follower Text first, else literal Text+ StyledText. */
function readCompText(lua) {
  const blocks = toolBlocks(lua);
  for (const [type, re] of [['StyledTextFollower', FOLLOWER_TEXT], ['TextPlus', TEXTPLUS_TEXT]]) {
    for (const b of blocks.filter((x) => x.type === type)) {
      const m = re.exec(lua.slice(b.start, b.end));
      if (m) return unLuaString(m[2]);
    }
  }
  return null;
}

module.exports = { patchCompText, readCompText, luaString, toolBlocks };
