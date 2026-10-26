'use strict';
/**
 * Caption safe-area layout for any timeline resolution.
 *
 * Output is in two forms:
 *   - pixel geometry (for previews and validation)
 *   - normalised Fusion coordinates: Center {x, y} in 0..1 with the origin at
 *     the BOTTOM-LEFT (Fusion convention), widths relative to frame width.
 *
 * Safe-zone presets are configurable defaults, not official platform specs.
 * Social platforms change their overlay UI; the values here are deliberately
 * conservative and every one can be overridden in Settings.
 */

const SAFE_ZONES = Object.freeze({
  'title-safe': { label: 'Broadcast title-safe (90%)', top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 },
  'action-safe': { label: 'Action-safe (93%)', top: 0.035, bottom: 0.035, left: 0.035, right: 0.035 },
  'social-vertical': { label: 'Social vertical overlay zone (conservative, approximate)', top: 0.12, bottom: 0.2, left: 0.06, right: 0.15 },
  'social-square': { label: 'Social square (approximate)', top: 0.06, bottom: 0.1, left: 0.06, right: 0.06 },
  none: { label: 'Full frame', top: 0, bottom: 0, left: 0, right: 0 },
});

function defaultZoneFor(aspect) {
  if (aspect === 'vertical' || aspect === 'vertical-wide') return 'social-vertical';
  if (aspect === 'square') return 'social-square';
  return 'title-safe';
}

/**
 * @param {{width:number,height:number,aspect:string}} frame
 * @param {object} [opts]
 * @param {string|object} [opts.zone]        preset key or {top,bottom,left,right} fractions
 * @param {'bottom'|'lower-third'|'center'|'top'} [opts.anchor='bottom']
 * @param {number} [opts.fontScale]          font cap height as fraction of the frame's short side
 * @param {number} [opts.lines=2]            lines to reserve
 * @param {number} [opts.lineSpacing=1.2]
 */
function captionLayout(frame, opts = {}) {
  const { width, height } = frame;
  if (!(width > 0 && height > 0)) throw new RangeError('Frame dimensions must be positive');
  const zoneKey = typeof opts.zone === 'string' ? opts.zone : opts.zone ? 'custom' : defaultZoneFor(frame.aspect);
  const zone = typeof opts.zone === 'object' && opts.zone ? opts.zone : SAFE_ZONES[zoneKey];
  if (!zone) throw new RangeError(`Unknown safe zone "${opts.zone}"`);
  for (const k of ['top', 'bottom', 'left', 'right']) {
    if (!(zone[k] >= 0 && zone[k] < 0.5)) throw new RangeError(`Safe zone ${k} must be in [0, 0.5)`);
  }
  const shortSide = Math.min(width, height);
  const isVertical = height > width;
  const fontScale = opts.fontScale ?? (isVertical ? 0.065 : 0.055);
  const lines = opts.lines ?? 2;
  const lineSpacing = opts.lineSpacing ?? 1.2;

  const safe = {
    x: Math.round(width * zone.left),
    y: Math.round(height * zone.top),
    w: Math.round(width * (1 - zone.left - zone.right)),
    h: Math.round(height * (1 - zone.top - zone.bottom)),
  };
  const fontPx = Math.round(shortSide * fontScale);
  const blockH = Math.round(fontPx * lineSpacing * lines);
  const anchor = opts.anchor || (isVertical ? 'lower-third' : 'bottom');
  let centerYpx; // from top
  if (anchor === 'bottom') centerYpx = safe.y + safe.h - blockH / 2;
  else if (anchor === 'lower-third') centerYpx = safe.y + safe.h * (2 / 3);
  else if (anchor === 'center') centerYpx = safe.y + safe.h / 2;
  else if (anchor === 'top') centerYpx = safe.y + blockH / 2;
  else throw new RangeError(`Unknown anchor "${anchor}"`);
  const centerXpx = safe.x + safe.w / 2;

  const box = { x: Math.round(centerXpx - safe.w / 2), y: Math.round(centerYpx - blockH / 2), w: safe.w, h: blockH };
  const fits = box.y >= safe.y && box.y + box.h <= safe.y + safe.h;

  return {
    zone: zoneKey,
    anchor,
    safe,
    box,
    fits,
    fontPx,
    // Approximate max characters per line for an average glyph width of ~0.55em.
    suggestedMaxChars: Math.max(8, Math.floor(safe.w / (fontPx * 0.55))),
    fusion: {
      center: { x: +(centerXpx / width).toFixed(5), y: +(1 - centerYpx / height).toFixed(5) },
      // Text+ "Size" is relative to frame width in Fusion; recorded here as an
      // assumption to be confirmed against the installed build in Diagnostics.
      size: +(fontPx / width).toFixed(5),
      wrapWidth: +(safe.w / width).toFixed(5),
    },
  };
}

/**
 * Scale a preset authored at one resolution for use at another. Positions
 * are kept relative to the safe area; size follows the short side so text
 * keeps the same visual weight on vertical, square and horizontal frames.
 */
function scaleForResolution(authored, target) {
  const shortA = Math.min(authored.width, authored.height);
  const shortT = Math.min(target.width, target.height);
  // Text+ size is width-relative, so convert through pixels.
  const sizeFactor = (shortT / target.width) / (shortA / authored.width);
  return { sizeFactor: +sizeFactor.toFixed(5), shortSideRatio: +(shortT / shortA).toFixed(5) };
}

module.exports = { SAFE_ZONES, defaultZoneFor, captionLayout, scaleForResolution };
