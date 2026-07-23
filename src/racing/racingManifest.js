/**
 * Local-only asset manifest for Kaki Rally.
 *
 * Keeping this module renderer-free makes the mapping easy to validate in Node
 * and prevents production visuals from gaining a hidden network dependency.
 */

export const RALLY_ASSET_MANIFEST = Object.freeze({
  environmentKitV2: Object.freeze({ url: 'assets/racing/models/kaki-rally-environment-kit-v2.glb', kind: 'model' }),
  decalAtlas: Object.freeze({ url: 'assets/racing/kaki-rally-decal-atlas-imagegen-v1.webp', kind: 'color' }),
  monsterDecal: Object.freeze({ url: 'assets/racing/kitty-monster-truck-decal-oekaki-v2.webp', kind: 'color' }),
  monsterKeyArt: Object.freeze({ url: 'assets/racing/monster-smash-key-art-oekaki-v2.webp', kind: 'color' }),
  mightyMeowsterBody: Object.freeze({ url: 'assets/racing/models/mighty-meowster-body-v1.glb', kind: 'model' }),
  cyberKakiBody: Object.freeze({ url: 'assets/racing/models/cyber-kaki-body-v1.glb', kind: 'model' }),
  tipsyTumblerBody: Object.freeze({ url: 'assets/racing/monster-arena/models/tipsy-tumbler-monster-truck-v2.glb', kind: 'model' }),
  arenaTrafficKit: Object.freeze({ url: 'assets/racing/models/arena-traffic-kit-runtime-v2.glb', kind: 'model' }),
  crashVehicleKit: Object.freeze({ url: 'assets/racing/crash/kaki-crash-kit-v1.glb', kind: 'model' }),
  crashVehicleKitV2: Object.freeze({ url: 'assets/racing/crash/kaki-catastrophe-vehicles-v2.glb', kind: 'model' }),
  crashEnvironmentV2: Object.freeze({ url: 'assets/racing/crash/pawprint-moonpaw-environment-v2.glb', kind: 'model' }),
  monsterEnvironmentKit: Object.freeze({ url: 'assets/racing/monster-arena/models/monster-arena-environment-kit-v1.glb', kind: 'model' }),
  monsterAudienceBank: Object.freeze({ url: 'assets/racing/monster-arena/models/arena-audience-bank-v1.glb', kind: 'model' }),
  monsterArenaBackdrop: Object.freeze({ url: 'assets/racing/domino-grand-yard-exterior-grok-v2.webp', kind: 'color' }),
  monsterArenaDirtColor: Object.freeze({ url: 'assets/racing/monster-arena/materials/arena-dirt-color.webp', kind: 'color', repeat: [7, 6] }),
  monsterArenaDirtNormal: Object.freeze({ url: 'assets/racing/monster-arena/materials/arena-dirt-normal.webp', kind: 'normal', repeat: [7, 6] }),
  monsterArenaDirtRoughness: Object.freeze({ url: 'assets/racing/monster-arena/materials/arena-dirt-roughness.webp', kind: 'data', repeat: [7, 6] }),
  monsterArenaDirtMacro: Object.freeze({ url: 'assets/racing/monster-arena/materials/arena-dirt-macro.webp', kind: 'color' }),
  monsterArenaCrowd: Object.freeze({ url: 'assets/racing/monster-arena/materials/arena-crowd-cats.webp', kind: 'color' }),
  monsterArenaGroundDecals: Object.freeze({ url: 'assets/racing/monster-arena/decals/arena-ground-decals.webp', kind: 'color' }),
  monsterArenaVfx: Object.freeze({ url: 'assets/racing/monster-arena/vfx/arena-vfx-atlas.webp', kind: 'color' }),

  skyMidday: Object.freeze({ url: 'assets/textures/sky_midday.webp', kind: 'color' }),
  skyGolden: Object.freeze({ url: 'assets/textures/sky_golden.webp', kind: 'color' }),
  skyDusk: Object.freeze({ url: 'assets/textures/sky_dusk.webp', kind: 'color' }),
  skyTwilight: Object.freeze({ url: 'assets/textures/sky_twilight.webp', kind: 'color' }),
  skyBloodmoon: Object.freeze({ url: 'assets/textures/sky_bloodmoon.webp', kind: 'color' }),
  skyKakiLand: Object.freeze({ url: 'assets/kakiland/kaki-land-sky-gpt-v2.png', kind: 'color' }),

  groundForest: Object.freeze({ url: 'assets/textures/ground_detail_forest_512.webp', kind: 'color', repeat: [12, 12] }),
  groundTwilight: Object.freeze({ url: 'assets/textures/ground_detail_twilight_512.webp', kind: 'color', repeat: [12, 12] }),
  groundCinder: Object.freeze({ url: 'assets/textures/ground_detail_cinder_512.webp', kind: 'color', repeat: [12, 12] }),
  groundVoid: Object.freeze({ url: 'assets/textures/ground_detail_void_512.webp', kind: 'color', repeat: [12, 12] }),
  groundCave: Object.freeze({ url: 'assets/textures/ground_detail_cave_512.webp', kind: 'color', repeat: [12, 12] }),
  groundKakiLand: Object.freeze({ url: 'assets/kakiland/kaki-land-turf-grok-v1.webp', kind: 'color', repeat: [12, 12] }),
  groundForestV2Color: Object.freeze({ url: 'assets/racing/terrain-v2/forest-ground-color.webp', kind: 'color' }),
  groundForestV2Normal: Object.freeze({ url: 'assets/racing/terrain-v2/forest-ground-normal.webp', kind: 'normal' }),
  groundForestV2Roughness: Object.freeze({ url: 'assets/racing/terrain-v2/forest-ground-roughness.webp', kind: 'data' }),
  groundTwilightV2Color: Object.freeze({ url: 'assets/racing/terrain-v2/twilight-ground-color.webp', kind: 'color' }),
  groundTwilightV2Normal: Object.freeze({ url: 'assets/racing/terrain-v2/twilight-ground-normal.webp', kind: 'normal' }),
  groundTwilightV2Roughness: Object.freeze({ url: 'assets/racing/terrain-v2/twilight-ground-roughness.webp', kind: 'data' }),
  groundCinderV2Color: Object.freeze({ url: 'assets/racing/terrain-v2/cinder-ground-color.webp', kind: 'color' }),
  groundCinderV2Normal: Object.freeze({ url: 'assets/racing/terrain-v2/cinder-ground-normal.webp', kind: 'normal' }),
  groundCinderV2Roughness: Object.freeze({ url: 'assets/racing/terrain-v2/cinder-ground-roughness.webp', kind: 'data' }),
  groundVoidV2Color: Object.freeze({ url: 'assets/racing/terrain-v2/void-ground-color.webp', kind: 'color' }),
  groundVoidV2Normal: Object.freeze({ url: 'assets/racing/terrain-v2/void-ground-normal.webp', kind: 'normal' }),
  groundVoidV2Roughness: Object.freeze({ url: 'assets/racing/terrain-v2/void-ground-roughness.webp', kind: 'data' }),
  groundCaveV2Color: Object.freeze({ url: 'assets/racing/terrain-v2/cave-ground-color.webp', kind: 'color' }),
  groundCaveV2Normal: Object.freeze({ url: 'assets/racing/terrain-v2/cave-ground-normal.webp', kind: 'normal' }),
  groundCaveV2Roughness: Object.freeze({ url: 'assets/racing/terrain-v2/cave-ground-roughness.webp', kind: 'data' }),
  groundKakiLandV2Color: Object.freeze({ url: 'assets/racing/terrain-v2/kakiland-ground-color.webp', kind: 'color' }),
  groundKakiLandV2Normal: Object.freeze({ url: 'assets/racing/terrain-v2/kakiland-ground-normal.webp', kind: 'normal' }),
  groundKakiLandV2Roughness: Object.freeze({ url: 'assets/racing/terrain-v2/kakiland-ground-roughness.webp', kind: 'data' }),
  groundKakiLandBase: Object.freeze({ url: 'assets/kakiland/kaki-land-turf-vertex-v1.png', kind: 'color', repeat: [12, 12] }),
  kakiTurfNormal: Object.freeze({ url: 'assets/kakiland/kaki-land-turf-vertex-v1-normal.png', kind: 'normal', repeat: [12, 12] }),
  kakiTurfRoughness: Object.freeze({ url: 'assets/kakiland/kaki-land-turf-vertex-v1-roughness.png', kind: 'data', repeat: [12, 12] }),
  caveStoneColor: Object.freeze({ url: 'assets/textures/cave_stone_diffuse.png', kind: 'color', repeat: [10, 6] }),
  caveStoneNormal: Object.freeze({ url: 'assets/textures/cave_stone_normal.png', kind: 'normal', repeat: [10, 6] }),
  caveStoneRoughness: Object.freeze({ url: 'assets/textures/cave_stone_rough.png', kind: 'data', repeat: [10, 6] }),
  mudColor: Object.freeze({ url: 'assets/sprites/brown_mud/diff.jpg', kind: 'color', repeat: [10, 10] }),
  mudNormal: Object.freeze({ url: 'assets/sprites/brown_mud/nor_gl.jpg', kind: 'normal', repeat: [10, 10] }),
  mudRoughness: Object.freeze({ url: 'assets/sprites/brown_mud/rough.jpg', kind: 'data', repeat: [10, 10] }),
  flagstone: Object.freeze({ url: 'assets/textures/biome_flagstone_512.webp', kind: 'color', repeat: [9, 9] }),
  weatheredWood: Object.freeze({ url: 'assets/textures/landmark_weathered_wood_512.webp', kind: 'color', repeat: [5, 5] }),
  slateMasonry: Object.freeze({ url: 'assets/textures/landmark_slate_masonry_512.webp', kind: 'color', repeat: [6, 6] }),

  chapterForest: Object.freeze({ url: 'assets/sprites/chapters/chapter_forest.webp', kind: 'color' }),
  chapterTwilight: Object.freeze({ url: 'assets/sprites/chapters/chapter_twilight.webp', kind: 'color' }),
  chapterCinder: Object.freeze({ url: 'assets/sprites/chapters/chapter_cinder.webp', kind: 'color' }),
  chapterVoid: Object.freeze({ url: 'assets/sprites/chapters/chapter_void.webp', kind: 'color' }),
  chapterCave: Object.freeze({ url: 'assets/sprites/chapters/chapter_cave.webp', kind: 'color' }),
  chapterKakiLand: Object.freeze({ url: 'assets/kakiland/kaki-land-key-art-gpt-v2.png', kind: 'color' }),
  trialsMeadowBackdropV2: Object.freeze({ url: 'assets/racing/backdrops-v2/trials-meadow-backdrop.webp', kind: 'color' }),
  trialsQuarryBackdropV2: Object.freeze({ url: 'assets/racing/backdrops-v2/trials-quarry-backdrop.webp', kind: 'color' }),
  trialsCrownBackdropV2: Object.freeze({ url: 'assets/racing/backdrops-v2/trials-crown-backdrop-v2.webp', kind: 'color' }),
});

export const RALLY_COURSE_ASSETS = Object.freeze({
  forest: Object.freeze(['environmentKitV2', 'skyGolden', 'groundForest', 'groundForestV2Color', 'groundForestV2Normal', 'groundForestV2Roughness', 'mudColor', 'mudNormal', 'mudRoughness']),
  twilight: Object.freeze(['environmentKitV2', 'skyTwilight', 'groundTwilight', 'groundTwilightV2Color', 'groundTwilightV2Normal', 'groundTwilightV2Roughness', 'mudColor', 'mudNormal', 'mudRoughness']),
  cinder: Object.freeze(['environmentKitV2', 'skyBloodmoon', 'groundCinder', 'groundCinderV2Color', 'groundCinderV2Normal', 'groundCinderV2Roughness', 'caveStoneColor', 'caveStoneNormal', 'caveStoneRoughness']),
  void: Object.freeze(['environmentKitV2', 'skyBloodmoon', 'groundVoid', 'groundVoidV2Color', 'groundVoidV2Normal', 'groundVoidV2Roughness', 'flagstone']),
  cave: Object.freeze(['environmentKitV2', 'skyDusk', 'groundCave', 'groundCaveV2Color', 'groundCaveV2Normal', 'groundCaveV2Roughness', 'caveStoneColor', 'caveStoneNormal', 'caveStoneRoughness']),
  kakiland: Object.freeze(['environmentKitV2', 'skyKakiLand', 'groundKakiLandBase', 'groundKakiLand', 'groundKakiLandV2Color', 'groundKakiLandV2Normal', 'groundKakiLandV2Roughness', 'flagstone']),
});

export const TRIALS_COURSE_ASSETS = Object.freeze({
  meadow: Object.freeze(['environmentKitV2', 'trialsMeadowBackdropV2', 'skyMidday', 'groundForestV2Color', 'groundForestV2Normal', 'groundForestV2Roughness', 'mudColor', 'mudNormal', 'mudRoughness', 'weatheredWood']),
  quarry: Object.freeze(['environmentKitV2', 'trialsQuarryBackdropV2', 'skyGolden', 'groundCaveV2Color', 'groundCaveV2Normal', 'groundCaveV2Roughness', 'caveStoneColor', 'caveStoneNormal', 'caveStoneRoughness', 'slateMasonry']),
  crown: Object.freeze(['environmentKitV2', 'trialsCrownBackdropV2', 'skyKakiLand', 'groundKakiLandV2Color', 'groundKakiLandV2Normal', 'groundKakiLandV2Roughness', 'kakiTurfNormal', 'kakiTurfRoughness', 'flagstone']),
});

export function rallyAssetIds(
  courseId,
  mode = 'circuit',
  monsterVehicleId = 'meowster',
  { monsterProductionAssets = false } = {},
) {
  if (mode === 'crash') {
    return ['decalAtlas', 'crashVehicleKitV2', 'crashEnvironmentV2', 'skyTwilight'];
  }
  // Release Monster Smash uses the decimated, instanced traffic kit plus a
  // bounded selection of authored arena props. The expensive full stadium and
  // 3D audience remain opt-in, but ordinary play no longer falls all the way
  // back to flat placeholder crushables and dressing.
  if (mode === 'monster') {
    const bodyAsset = monsterVehicleId === 'cyber'
      ? 'cyberKakiBody'
      : monsterVehicleId === 'tipsy'
        ? 'tipsyTumblerBody'
        : 'mightyMeowsterBody';
    return [
      'monsterDecal',
      'monsterKeyArt',
      bodyAsset,
      'arenaTrafficKit',
      'monsterEnvironmentKit',
      ...(monsterProductionAssets ? [
        'monsterAudienceBank',
      ] : []),
      'monsterArenaBackdrop',
      'monsterArenaDirtColor',
      'monsterArenaDirtNormal',
      'monsterArenaDirtRoughness',
      'monsterArenaDirtMacro',
      'monsterArenaCrowd',
      'monsterArenaGroundDecals',
      'monsterArenaVfx',
    ];
  }
  const ids = new Set(['decalAtlas']);
  const courseIds = RALLY_COURSE_ASSETS[courseId] || RALLY_COURSE_ASSETS.forest;
  for (const id of courseIds) ids.add(id);
  return [...ids];
}

export function trialsAssetIds(courseId) {
  return ['decalAtlas', 'monsterDecal', ...(TRIALS_COURSE_ASSETS[courseId] || TRIALS_COURSE_ASSETS.meadow)];
}
