import * as THREE from 'three';

const BOUNDS_COLOR = new THREE.Color(0xffd45c);
const DYNAMIC_COLOR = new THREE.Color(0x67f28b);
const KINEMATIC_COLOR = new THREE.Color(0x55d8ff);
const SATURATED_COLOR = new THREE.Color(0xff5bd7);
const PLAYER_COLOR = new THREE.Color(0xffffff);

function own(owned, value, bucket) {
  owned?.[bucket]?.add?.(value);
  return value;
}

function lineObject(owned, color, { vertexColors = false, opacity = 1 } = {}) {
  const geometry = own(owned, new THREE.BufferGeometry(), 'geometries');
  const material = own(owned, new THREE.LineBasicMaterial({
    color,
    vertexColors,
    transparent: opacity < 1,
    opacity,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  }), 'materials');
  const line = new THREE.LineSegments(geometry, material);
  line.frustumCulled = false;
  line.renderOrder = 10000;
  return line;
}

function setLinePositions(line, values, colors = null) {
  line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
  if (colors) line.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  else line.geometry.deleteAttribute('color');
  line.geometry.computeBoundingSphere();
}

function appendEdge(values, a, b) {
  values.push(a.x, a.y, a.z, b.x, b.y, b.z);
}

function appendBox(values, box, worldRoot) {
  const min = box.min; const max = box.max;
  const points = [
    new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z), new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z), new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z), new THREE.Vector3(min.x, max.y, max.z),
  ].map((point) => worldRoot.worldToLocal(point));
  for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) appendEdge(values, points[a], points[b]);
}

function stateColor(entity) {
  if (entity.kind === 'player') return PLAYER_COLOR;
  if (entity.promotionState === 'saturated-physical-proxy') return SATURATED_COLOR;
  return entity.dynamic ? DYNAMIC_COLOR : KINEMATIC_COLOR;
}

export function createCrashColliderOverlay({ root, owned, physics, traffic, player }) {
  const overlayRoot = new THREE.Group();
  overlayRoot.name = 'crash-collider-qa-overlay';
  overlayRoot.visible = false;
  root.add(overlayRoot);
  const physicsLines = lineObject(owned, 0xffffff, { vertexColors: true, opacity: 0.72 });
  const boundsLines = lineObject(owned, BOUNDS_COLOR, { opacity: 0.78 });
  const wheelLines = lineObject(owned, 0x5ff5ff, { opacity: 0.95 });
  const stateLines = lineObject(owned, 0xffffff, { vertexColors: true, opacity: 0.96 });
  const contactGeometry = own(owned, new THREE.BufferGeometry(), 'geometries');
  const contactMaterial = own(owned, new THREE.PointsMaterial({ color: 0xff62dd, size: 0.28, sizeAttenuation: true, depthTest: false, toneMapped: false }), 'materials');
  const contactPoints = new THREE.Points(contactGeometry, contactMaterial);
  contactPoints.frustumCulled = false;
  contactPoints.renderOrder = 10001;
  overlayRoot.add(physicsLines, boundsLines, wheelLines, stateLines, contactPoints);
  const overlay = {
    root: overlayRoot,
    worldRoot: root,
    physics,
    traffic,
    player,
    enabled: false,
    contacts: [],
    disposed: false,
  };
  overlay.setEnabled = (enabled) => {
    overlay.enabled = !!enabled;
    overlayRoot.visible = overlay.enabled;
    return overlay.enabled;
  };
  overlay.update = (contacts = []) => {
    if (!overlay.enabled || overlay.disposed) return;
    root.updateWorldMatrix(true, true);
    const debug = physics.world.debugRender();
    const debugPositions = Array.from(debug.vertices || []);
    const debugColors = [];
    const rgba = debug.colors || [];
    for (let index = 0; index < rgba.length; index += 4) debugColors.push(rgba[index], rgba[index + 1], rgba[index + 2]);
    setLinePositions(physicsLines, debugPositions, debugColors);

    const entities = [player, ...(traffic?.entities || [])].filter((entity) => entity?.active !== false && entity?.visual?.root?.visible && entity?.body);
    const bounds = [];
    const states = [];
    const stateColors = [];
    for (const entity of entities) {
      const box = new THREE.Box3().setFromObject(entity.visual.root);
      if (!box.isEmpty()) appendBox(bounds, box, root);
      const position = entity.body.translation();
      const height = Math.max(0.8, entity.profile?.height || entity.playerProfile?.height || 1.5);
      states.push(position.x, position.y, position.z, position.x, position.y + height, position.z);
      const color = stateColor(entity);
      stateColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
    setLinePositions(boundsLines, bounds);
    setLinePositions(stateLines, states, stateColors);

    const wheelRays = [];
    const controller = player?.vehicleController;
    if (controller) {
      for (let index = 0; index < controller.numWheels(); index++) {
        const hardPoint = controller.wheelHardPoint(index);
        const contact = controller.wheelContactPoint(index);
        const direction = controller.wheelDirectionCs(index);
        const length = controller.wheelSuspensionLength(index) ?? controller.wheelSuspensionRestLength(index) ?? 0;
        const radius = controller.wheelRadius(index) || 0;
        if (!hardPoint || !direction) continue;
        const end = controller.wheelIsInContact(index) && contact
          ? contact
          : { x: hardPoint.x + direction.x * (length + radius), y: hardPoint.y + direction.y * (length + radius), z: hardPoint.z + direction.z * (length + radius) };
        wheelRays.push(hardPoint.x, hardPoint.y, hardPoint.z, end.x, end.y, end.z);
      }
    }
    setLinePositions(wheelLines, wheelRays);

    overlay.contacts = contacts.map((contact) => contact.point).filter((point) => point && [point.x, point.y, point.z].every(Number.isFinite));
    const points = overlay.contacts.flatMap((point) => [point.x, point.y, point.z]);
    contactGeometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    contactGeometry.computeBoundingSphere();
  };
  overlay.snapshot = () => ({
    enabled: overlay.enabled,
    renderedBounds: [player, ...(traffic?.entities || [])].filter((entity) => entity?.active && entity?.visual?.root?.visible).length,
    compoundColliders: physics?.colliderEntities?.size || 0,
    wheelRays: player?.vehicleController?.numWheels?.() || 0,
    contacts: overlay.contacts.length,
    legend: { player: 'white', dynamic: 'green', kinematic: 'cyan', saturatedProxy: 'magenta', renderedBounds: 'yellow' },
  });
  overlay.dispose = () => {
    if (overlay.disposed) return false;
    overlay.disposed = true;
    overlayRoot.parent?.remove(overlayRoot);
    return true;
  };
  return overlay;
}
