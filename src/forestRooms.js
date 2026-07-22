/**
 * Forest Expansion v0.1 — Room Registry (Cohort 1A Foundations).
 *
 * Defines the 4-room layout for the Forest stage: one central hub (The Glade)
 * plus 3 puzzle rooms (Sap Hollow, Crystal Choir Grove, Amber Labyrinth).
 * Each room has world-space bounds + a center anchor. Portals in the Glade
 * connect outward to the 3 puzzle rooms.
 *
 * Read by:
 *   - Cohort 2 (puzzleSystem.js, arenaDecor.js per-room switch)
 *   - Cohort 3 (forestPortals.js, spawnDirector.js room-scope, main.js camera bounds)
 *
 * Source: docs/FOREST_EXPANSION_PLAN.md §1, §3, §4.
 * Constraints: flat single-file module, no THREE import, no game-state mutation.
 */

/**
 * @typedef {Object} ForestRoomBounds
 * @property {number} minX
 * @property {number} maxX
 * @property {number} minZ
 * @property {number} maxZ
 */

/**
 * @typedef {Object} ForestRoomDef
 * @property {string} id
 * @property {string} name
 * @property {{x:number,z:number}} center
 * @property {ForestRoomBounds} bounds
 * @property {boolean} isHub
 * @property {?string} puzzle      // puzzle id implemented by Cohort 3 Agent 6
 * @property {?string} weapon      // weapon id implemented by Cohort 1B Agent 2
 */

/** @type {Record<string, ForestRoomDef>} */
// landmarkBudget (optional, FE-V2 2026-05-17): per-room override for the
// shrine/altar counts spawned by src/forestLandmarks.js. Module defaults are
// {shrines:5, altars:2}; per-room caps below bias
// density toward the larger rooms and ease density in puzzle rooms so
// landmarks don't shadow the puzzle telegraphs.
export const FOREST_ROOMS = {
  glade:          { id: 'glade',          name: 'The Glade',           center: { x:   0, z:   0 }, bounds: { minX:  -45, maxX:  45, minZ:  -45, maxZ:  45 }, isHub: true,  puzzle: null,                  weapon: null,           landmarkBudget: { shrines: 6, altars: 3 } },
  saphollow:      { id: 'saphollow',      name: 'Sap Hollow',          center: { x: -70, z: -90 }, bounds: { minX:  -90, maxX: -50, minZ: -120, maxZ: -60 }, isHub: false, puzzle: 'flow_weaver',         weapon: 'sap_weaver',   landmarkBudget: { shrines: 5, altars: 2 } },
  crystalchoir:   { id: 'crystalchoir',   name: 'Crystal Choir Grove', center: { x:   0, z:  80 }, bounds: { minX:  -25, maxX:  25, minZ:   55, maxZ: 105 }, isHub: false, puzzle: 'harmonic_alignment',  weapon: 'choir_lance',  landmarkBudget: { shrines: 4, altars: 2 } },
  amberlabyrinth: { id: 'amberlabyrinth', name: 'Amber Labyrinth',     center: { x: 130, z:   0 }, bounds: { minX:  103, maxX: 158, minZ:  -20, maxZ:  20 }, isHub: false, puzzle: 'prism_lock',          weapon: 'prism_warden', landmarkBudget: { shrines: 4, altars: 2 }, travelAnchors: { entry: { x: 121, z: 8 }, return: { x: 118, z: 8 } } },
  // ── Forest Expansion v0.2 (FE-V2, 2026-05-17) — 3 new rooms ──
  // bramblemaze: SE relic-chest room. No puzzle, no hidden weapon (relic chest
  //   pattern — future hazards agent wires scratch DoT via _brambleMazeHazard.
  // mossroot: far-S puzzle room. Simon-says puzzle 'mossroot_pulse' unlocks
  //   weapon 'root_grasp' via puzzleSystem._win (weaponReward field).
  // glowfen: far-W lore/relic room. No puzzle for v1; weapon 'wisp_lantern'
  //   ships as scaffolding — REGISTRY-ready, FOREST_SPECIAL_IDS-equipped, but
  //   no in-game unlock path (no puzzle). Future ticket wires unlock.
  bramblemaze:    { id: 'bramblemaze',    name: 'Bramble Maze',        center: { x:  95, z:  80 }, bounds: { minX:   70, maxX: 120, minZ:   55, maxZ: 105 }, isHub: false, puzzle: null,                  weapon: null,           landmarkBudget: { shrines: 5, altars: 2 } },
  mossroot:       { id: 'mossroot',       name: 'Mossroot Hollow',     center: { x:   0, z: -140 }, bounds: { minX:  -35, maxX:  35, minZ: -170, maxZ: -110 }, isHub: false, puzzle: 'mossroot_pulse',     weapon: 'root_grasp',   landmarkBudget: { shrines: 4, altars: 2 } },
  glowfen:        { id: 'glowfen',        name: 'Glowfen Marshes',     center: { x: -160, z:   0 }, bounds: { minX: -200, maxX: -130, minZ:  -30, maxZ:  30 }, isHub: false, puzzle: null,                  weapon: 'wisp_lantern', landmarkBudget: { shrines: 5, altars: 2 } },
};

/** Stable authored order for the six required Forest portal trials. */
export const FOREST_TRIAL_ROOM_IDS = Object.freeze(
  Object.values(FOREST_ROOMS).filter((room) => !room.isHub).map((room) => room.id),
);

export const FOREST_RETURN_PORTAL_OFFSET = 12;
export const FOREST_ROOM_ENTRY_OFFSET = 9;

// The authored rooms sit inside one finite Wildwood. The old 2,400u ground
// plane had no gameplay boundary, so walking past a room presented hundreds
// of units of valid-looking but empty grass. These bounds are deliberately
// generous around the outer rooms and are dressed with a visible tree line.
export const FOREST_WORLD_BOUNDS = Object.freeze({
  minX: -215,
  maxX: 225,
  minZ: -185,
  maxZ: 130,
  // Trunks sit on the raw edge; this keeps the hero clear of their canopy.
  inset: 6,
});

export function forestPlayableMinX(padding = 0) {
  return FOREST_WORLD_BOUNDS.minX + FOREST_WORLD_BOUNDS.inset + padding;
}
export function forestPlayableMaxX(padding = 0) {
  return FOREST_WORLD_BOUNDS.maxX - FOREST_WORLD_BOUNDS.inset - padding;
}
export function forestPlayableMinZ(padding = 0) {
  return FOREST_WORLD_BOUNDS.minZ + FOREST_WORLD_BOUNDS.inset + padding;
}
export function forestPlayableMaxZ(padding = 0) {
  return FOREST_WORLD_BOUNDS.maxZ - FOREST_WORLD_BOUNDS.inset - padding;
}

export function constrainForestX(x, padding = 0) {
  return Math.max(forestPlayableMinX(padding), Math.min(forestPlayableMaxX(padding), x));
}
export function constrainForestZ(z, padding = 0) {
  return Math.max(forestPlayableMinZ(padding), Math.min(forestPlayableMaxZ(padding), z));
}

export function isForestPositionPlayable(x, z, padding = 0) {
  return x >= forestPlayableMinX(padding) && x <= forestPlayableMaxX(padding)
    && z >= forestPlayableMinZ(padding) && z <= forestPlayableMaxZ(padding);
}

/**
 * Shared entry/return anchors for a side room. Most rooms derive a line toward
 * the Glade; authored overrides avoid known puzzle fixtures (Amber's western
 * emitter row). Consumers receive fresh plain objects and may mutate safely.
 */
export function getForestTravelAnchors(roomId) {
  const room = FOREST_ROOMS[roomId];
  if (!room || room.isHub) return null;
  if (room.travelAnchors) {
    return {
      entry: { ...room.travelAnchors.entry },
      return: { ...room.travelAnchors.return },
    };
  }
  const glade = FOREST_ROOMS.glade.center;
  const dx = glade.x - room.center.x;
  const dz = glade.z - room.center.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  return {
    entry: {
      x: room.center.x + ux * FOREST_ROOM_ENTRY_OFFSET,
      z: room.center.z + uz * FOREST_ROOM_ENTRY_OFFSET,
    },
    return: {
      x: room.center.x + ux * FOREST_RETURN_PORTAL_OFFSET,
      z: room.center.z + uz * FOREST_RETURN_PORTAL_OFFSET,
    },
  };
}

/**
 * Portal hotspot positions. Each portal sits inside the Glade hub bounds,
 * close to the edge nearest its destination room. Cohort 3 Agent 5
 * (forestPortals.js) consumes this to spawn portal entities + pollen trails.
 *
 * @type {Record<string, {from:string,to:string,x:number,z:number}>}
 */
export const FOREST_PORTAL_POSITIONS = {
  // Keep every outbound pad inside the Glade. Pads on/over a room boundary
  // changed currentRoom before the interact edge could be consumed, making
  // the north/east gates look present but behave inconsistently.
  toSaphollow:      { from: 'glade', to: 'saphollow',      x: -24, z: -38 },
  toCrystalchoir:   { from: 'glade', to: 'crystalchoir',   x:   0, z:  43 },
  toAmberlabyrinth: { from: 'glade', to: 'amberlabyrinth', x:  43, z:  10 },
  // ── FE-V2 (2026-05-17): 3 new outbound portals at glade boundaries ──
  // Bramble: NE-ish glade edge → bramblemaze SW corner (closest entry side).
  // Mossroot: S glade edge, offset east so the central keep cannot cover it.
  // Glowfen: W glade edge → glowfen E entry inset (1u inside room).
  toBramblemaze:    { from: 'glade', to: 'bramblemaze',    x:  40, z:  40 },
  toMossroot:       { from: 'glade', to: 'mossroot',       x:  16, z: -40 },
  toGlowfen:        { from: 'glade', to: 'glowfen',        x: -43, z:   0 },
};

/**
 * Logical portal links between each Glade gate and its remote arrival anchor.
 * The minimap renders these as dotted topology, while the world landscape
 * deliberately leaves no continuous road that implies the portal is optional.
 * Freeze the table once so the 8Hz minimap redraw allocates nothing per tick.
 */
export const FOREST_TRAVEL_CORRIDORS = Object.freeze(
  Object.values(FOREST_PORTAL_POSITIONS).map((portal) => {
    const anchors = getForestTravelAnchors(portal.to);
    return Object.freeze({
      roomId: portal.to,
      from: Object.freeze({ x: portal.x, z: portal.z }),
      to: Object.freeze({ x: anchors.entry.x, z: anchors.entry.z }),
    });
  }),
);

export function getForestTravelCorridors() {
  return FOREST_TRAVEL_CORRIDORS;
}

/** Allocation-free boundary clamp used once per Forest movement frame. */
export function constrainForestPosition(pos) {
  if (!pos) return false;
  const x = constrainForestX(pos.x);
  const z = constrainForestZ(pos.z);
  const changed = x !== pos.x || z !== pos.z;
  pos.x = x;
  pos.z = z;
  return changed;
}

/**
 * Portal-only room containment for the normal Forest objective.
 *
 * The moss roads remain useful visual breadcrumbs, but they are not alternate
 * entrances: leaving the current authored room without a matching short-lived
 * portal transfer token clamps the hero back inside its bounds. A legitimate
 * portal snap lands directly inside the destination room and carries the token
 * installed by forestPortals.js, so it passes without a one-frame snap-back.
 */
export function constrainForestPortalRoomPosition(pos, currentRoomId, transfer, now = 0, padding = 0.7) {
  if (!pos) return false;
  const current = FOREST_ROOMS[currentRoomId] || FOREST_ROOMS.glade;
  const detected = detectRoom(pos.x, pos.z);
  if (detected === current.id) return false;
  if (detected && transfer && transfer.to === detected && transfer.from === current.id
      && Number.isFinite(transfer.expiresAt) && now <= transfer.expiresAt) {
    return false;
  }
  const b = current.bounds;
  const x = Math.max(b.minX + padding, Math.min(b.maxX - padding, pos.x));
  const z = Math.max(b.minZ + padding, Math.min(b.maxZ - padding, pos.z));
  const changed = x !== pos.x || z !== pos.z;
  pos.x = x;
  pos.z = z;
  return changed;
}

/**
 * Lookup a room definition by id. Returns null for unknown ids so callers
 * can branch without throwing (e.g. on a malformed save with a stale room id).
 *
 * @param {string} id
 * @returns {ForestRoomDef|null}
 */
export function getRoomById(id) {
  return FOREST_ROOMS[id] || null;
}

/**
 * Axis-aligned bounds check. Inclusive on all 4 edges so a position exactly
 * on the boundary counts as inside. Used for room-scope despawn and "which
 * room is the hero in" detection.
 *
 * @param {number} x
 * @param {number} z
 * @param {string} roomId
 * @returns {boolean}
 */
export function isPositionInRoom(x, z, roomId) {
  const r = FOREST_ROOMS[roomId];
  if (!r) return false;
  return x >= r.bounds.minX && x <= r.bounds.maxX
      && z >= r.bounds.minZ && z <= r.bounds.maxZ;
}

/**
 * Returns the id of the first room whose bounds contain (x, z), or null if
 * the position is in a no-man's-land corridor between rooms. Iteration order
 * follows Object.keys(FOREST_ROOMS) — rooms are non-overlapping by design so
 * order does not matter for correctness.
 *
 * @param {number} x
 * @param {number} z
 * @returns {?string}
 */
export function detectRoom(x, z) {
  for (const id in FOREST_ROOMS) {
    if (isPositionInRoom(x, z, id)) return id;
  }
  return null;
}
