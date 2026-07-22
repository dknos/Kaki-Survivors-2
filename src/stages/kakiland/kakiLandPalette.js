/**
 * Kaki Land's small, deliberately candy-bright material palette.
 *
 * Keep stage meshes in kakiLandStage.js on these swatches so the floating
 * islands, bridges, clouds, and portals read as one illustrated world rather
 * than as a collection of unrelated props.
 */
export const KAKI_LAND_PALETTE = Object.freeze({
  grass:          0x58a95a,
  grassLight:     0x91d56d,
  grassDark:      0x2d7146,
  stone:          0x4a5265,
  stoneLight:     0x78869a,
  stoneWarm:      0x755a49,
  bridgeWood:     0x8e6646,
  bridgeHighlight:0xd9af73,
  cloud:          0xf3f5ff,
  cloudShadow:    0xc9d7ee,
  rune:           0xf7e2a1,
  plazaStone:     0xd9d3bb,
  plazaInlay:     0x7d9bd8,
  ruinStone:      0x8e9ab4,
  water:          0x5bdcff,
  waterDeep:      0x268eca,
  flower:         0xf2a7ed,
  emberRock:      0x392a35,
  emberGlow:      0xff713d,
  tideStone:      0xd4eaf0,
  tideGlow:       0x59e9ff,
  bloomStone:     0x44365c,
  bloomGlow:      0xda74ff,
  mainPortal:     0xffb84d,
  mainPortalGlow: 0xff5f9d,
  trialEmber:     0xff7867,
  trialTide:      0x58d7ef,
  trialBloom:     0xb486ff,
  locked:         0x536078,
});

/**
 * World-space portal landing locations.  They are exported alongside the
 * palette so interaction code can use the exact same source of truth as the
 * visual map. `x` and `z` are gameplay-plane coordinates; `y` is supplied by
 * the stage builder.
 */
export const KAKI_LAND_PORTAL_LAYOUT = Object.freeze({
  main: Object.freeze({
    id: 'kaki-main',
    kind: 'main',
    x: 0,
    z: 0,
    label: 'Kaki Sovereign',
  }),
  trials: Object.freeze([
    Object.freeze({
      id: 'kaki-ember',
      kind: 'trial',
      x: -50,
      z: -48,
      label: 'Ember Trial',
      color: KAKI_LAND_PALETTE.trialEmber,
    }),
    Object.freeze({
      id: 'kaki-tide',
      kind: 'trial',
      x: 0,
      z: 58,
      label: 'Tide Trial',
      color: KAKI_LAND_PALETTE.trialTide,
    }),
    Object.freeze({
      id: 'kaki-bloom',
      kind: 'trial',
      x: 52,
      z: -12,
      label: 'Bloom Trial',
      color: KAKI_LAND_PALETTE.trialBloom,
    }),
  ]),
});

export const KAKI_LAND_MAIN_PORTAL_REQUIREMENT = KAKI_LAND_PORTAL_LAYOUT.trials.length;
