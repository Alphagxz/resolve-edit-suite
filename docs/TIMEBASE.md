# Timing model

**Internal timebase: flicks** — 1 flick = 1/705,600,000 s, stored as integers.

Why: every supported frame rate has an exact integer number of flicks per frame (23.976 → 29,429,400; 29.97 → 23,543,520; 59.94 → 11,771,760), so frame↔time conversion is exact in both directions and SRT milliseconds (705,600 flicks) are exact too.

Rules (enforced in `plugin/core/`):

1. **Rates are rationals.** Resolve's `"23.976"` maps to 24000/1001 through a lookup table with a 0.0005 fps tolerance; unknown rates are rejected, never approximated.
2. **Absolute conversion.** Each boundary is converted from its own absolute time (BigInt for the multiply). Durations are never accumulated, so a 10-hour sequence has the same error per cue as a 10-second one (≤ ½ frame from rounding).
3. **Rounding is explicit.** Cue boundaries round half away from zero; source-range mapping uses `round`; Resolve's floor for mixed-rate placement is modelled with `floor`.
4. **Source ≠ timeline rate.** Source frames are converted with the media's own `FPS` clip property via exact cross-rate conversion; a WAV's rate is whatever Resolve froze at import, so it is always read, never assumed.
5. **Timecode.** Drop-frame is defined only for 29.97 and 59.94 and refused elsewhere. DF labels that do not exist (e.g. `00:01:00;00`) are rejected.
6. **Timeline coordinates.** Absolute frames (`GetStartFrame`-based) for placement; marker frames are relative to the timeline start. Frame-convention questions that the docs leave open (inclusive `endFrame` in `AppendToTimeline`, `GetEnd`, `GetEndFrame`) are **measured** by Diagnostics › Calibrate and stored per build.
7. **Frame-safe SRT.** When writing frame-aligned cues to SRT, milliseconds are rounded *up* so that a reader that floors or rounds lands on the same frame.
8. **Never changes project or timeline frame rates.** Mismatched new-timeline settings abort the rough cut instead.
