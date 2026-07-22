/**
 * Cave stage — locked 5-color palette (P4A cohort 1, 2026-05-18).
 *
 * Mirrors the FOREST_VISUAL_STYLE.md contract: every cave-stage mesh,
 * emissive, FX ring, particle, and tint MUST draw from these five slots.
 * No off-palette debug colors — placeholder geometry is OK, off-palette
 * colors are NOT.
 *
 * See docs/CAVE_VISUAL_STYLE.md for the human-readable spec + intended
 * usage of each slot (shadow / stone / moss / sigil / amber).
 *
 * Layered cohorts (P4A-c2 … P4A-cN) consume these constants for:
 *   c2 — stalactite landmarks (stone + moss accent tips)
 *   c3 — gloomshrimp neutrals (moss emissive)
 *   c4 — cave-in hazard rings (sigil telegraph)
 *   c5 — sealed door tint + amber lantern HUD parity
 *   …  (rooms, weapons, music phases, achievements)
 */
export const CAVE_PALETTE = {
  shadow: 0x1a1820,   // slot 1 — deep cave shadow, fog
  stone:  0x4a4a52,   // slot 2 — wet stone (walls, floor, stalactite base)
  moss:   0x7fffe4,   // slot 3 — glowmoss bioluminescence (emissive)
  sigil:  0xc87bff,   // slot 4 — sigil-pip violet (telegraphs, hazard rings)
  amber:  0xffd27f,   // slot 5 — amber lantern (HUD + chest pop highlight)
};
