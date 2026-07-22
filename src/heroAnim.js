// heroAnim.js — additive procedural pose layer for the UNRIGGED hero.
// The hero GLB has no skeleton, so all motion is code. This pure function
// reads plain hero fields and ACCUMULATES offsets into `out`, which hero.js
// composes on top of its existing walk/idle/landing animation. No allocations.
//
// Layer 1 HIT FLINCH   — sharp squash + dip + backward tilt on recent damage.
// Layer 2 DASH STRETCH — elongate along travel + forward lean, overshoot on exit.
// Layer 3 IDLE BREATH  — slow sy breathe + counter-phase dy when grounded & still.
// Layer 4 ATTACK RECOIL— faint kick biased toward aim dir on recent weapon fire.

// --- timing windows (seconds) ---
const HIT_DUR = 0.22;
const DASH_OUT_DUR = 0.12; // post-dash overshoot settle
const ATK_DUR = 0.13;

// --- easing helpers ---------------------------------------------------------
// 0..1 clamp.
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
// clamp to [a,b].
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
// Sharp punch-in then ease-out: rises fast on first `peak` of the window,
// eases back to 0 after. p in 0..1 -> envelope 0..1..0.
function punch(p, peak) {
  if (p <= 0 || p >= 1) return 0;
  if (p < peak) return p / peak;                 // fast attack
  const q = (p - peak) / (1 - peak);             // 0..1 release
  return 1 - q * q;                              // ease-out (quad)
}
// easeOutBack-ish overshoot: 0->1 with a small bounce past 1 then settle.
function overshoot(p) {
  const c = 1.70158;
  const q = p - 1;
  return 1 + (c + 1) * q * q * q + c * q * q;    // standard easeOutBack
}

export function updateHeroProcAnim(h, t, dt, out) {
  if (!h) return;
  const vx = (h.vel && h.vel.x) || 0;
  const vz = (h.vel && h.vel.z) || 0;
  const speed = Math.sqrt(vx * vx + vz * vz);

  // --- Layer 1: HIT FLINCH -------------------------------------------------
  if (h._hurtAt) {
    const p = (t - h._hurtAt) / HIT_DUR;         // 0..1 over window
    if (p > 0 && p < 1) {
      const e = punch(p, 0.25);                  // fast jolt, ease back
      out.sy *= 1 - 0.18 * e;                    // squash down
      out.sx *= 1 + 0.12 * e;                    // bulge wide
      out.sz *= 1 + 0.12 * e;
      out.dy += -0.14 * e;                       // dip down
      // backward tilt AWAY from facing/velocity (lean back on the X axis)
      out.rx += -0.30 * e;
    }
  }

  // --- Layer 2: DASH STRETCH ----------------------------------------------
  const dashing = h.dashUntil && t < h.dashUntil;
  if (dashing) {
    out.sz *= 1.22;                              // elongate along travel
    out.sx *= 0.86;                              // pinch
    out.sy *= 0.86;
    out.rx += 0.28;                              // forward lean into the whoosh
  } else if (h.dashUntil) {
    // Exit overshoot: bounce back through rest over DASH_OUT_DUR.
    const p = (t - h.dashUntil) / DASH_OUT_DUR;  // 0..1 after dash end
    if (p > 0 && p < 1) {
      const k = 1 - overshoot(p);                // ~1 -> 0 with a settle dip
      out.sz *= 1 + 0.22 * k;
      out.sx *= 1 - 0.14 * k;
      out.sy *= 1 - 0.14 * k;
      out.rx += 0.28 * k;
    }
  }

  // --- Layer 3: IDLE BREATHING --------------------------------------------
  // Only when grounded; fade out smoothly as motion picks up so it never
  // fights the walk cycle. still=1 at rest, ->0 by speed ~0.05.
  if (h.grounded) {
    const still = clamp01(1 - speed / 0.05);
    if (still > 0.001) {
      const breathe = Math.sin(t * 2.2) * 0.035 * still;
      out.sy *= 1 + breathe;
      out.dy += -breathe * 0.10;                 // counter-phase, volume feel
    }
  }

  // --- Layer 4: ATTACK RECOIL ---------------------------------------------
  // Faint pulse only — hero auto-fires constantly. Needs both fields.
  if (h._attackAt && h._attackDir) {
    const p = (t - h._attackAt) / ATK_DUR;
    if (p > 0 && p < 1) {
      const e = punch(p, 0.2);                   // quick kick, fast decay
      const ax = h._attackDir.x || 0;
      const az = h._attackDir.z || 0;
      out.rx += az * 0.08 * e;                   // lean toward aim
      out.rz += -ax * 0.08 * e;
      out.sx *= 1 + 0.06 * e;                    // tiny pop
      out.sz *= 1 + 0.06 * e;
    }
  }

  // --- safety clamp on composed contributions -----------------------------
  out.dy = clamp(out.dy, -0.20, 0.35);
  out.rx = clamp(out.rx, -0.5, 0.5);
  out.rz = clamp(out.rz, -0.5, 0.5);
  out.sx = clamp(out.sx, 0.75, 1.30);
  out.sy = clamp(out.sy, 0.75, 1.30);
  out.sz = clamp(out.sz, 0.75, 1.30);
}
