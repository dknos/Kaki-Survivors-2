/**
 * TSL material for the one-draw billboard atlas pool in sprites/spritePool.js.
 *
 * The production pool writes translation-only instance matrices and carries
 * scale separately in `aScale`. r185 applies that instance translation to
 * positionLocal before vertexNode runs, allowing this graph to retain the
 * released screen/cylinder/none branches without a private renderer API.
 */
import {
  AdditiveBlending,
  MeshBasicNodeMaterial,
  NormalBlending,
  Vector2,
} from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cross,
  float,
  floor,
  int,
  max,
  mix,
  mod,
  modelViewMatrix,
  positionGeometry,
  positionLocal,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

export const SPRITE_BILLBOARD_MODES = Object.freeze({
  screen: 0,
  cylinder: 1,
  none: 2,
});

function finiteNumber(value, label, { min = -Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) {
    throw new RangeError(`${label} must be a finite number >= ${min}.`);
  }
  return number;
}

function positiveNumber(value, label) {
  const number = finiteNumber(value, label, { min: Number.EPSILON });
  return number;
}

function billboardMode(value) {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value <= 2) return value;
  } else if (Object.prototype.hasOwnProperty.call(SPRITE_BILLBOARD_MODES, value ?? 'screen')) {
    return SPRITE_BILLBOARD_MODES[value ?? 'screen'];
  }
  throw new RangeError('Sprite billboard must be "screen", "cylinder", "none", or 0..2.');
}

function anchorVector(value) {
  if (value?.isVector2) return value.clone();
  if (Array.isArray(value) && value.length >= 2) {
    return new Vector2(
      finiteNumber(value[0], 'sprite anchor x'),
      finiteNumber(value[1], 'sprite anchor y'),
    );
  }
  throw new TypeError('Sprite anchor must be a Vector2 or [x, y].');
}

/**
 * Port the atlas UVs, per-instance flash, pivot, scale, and three released
 * billboard branches. Default options accept the spriteAtlas record directly.
 */
export function createSpritePoolMaterial(atlas, options = {}) {
  if (!atlas?.texture?.isTexture) {
    throw new TypeError('createSpritePoolMaterial requires an atlas texture.');
  }

  const cols = positiveNumber(atlas.cols, 'sprite atlas columns');
  const rows = positiveNumber(atlas.rows, 'sprite atlas rows');
  const aspect = positiveNumber(
    options.aspect ?? (atlas.frameWidth / atlas.frameHeight),
    'sprite frame aspect',
  );
  const anchor = anchorVector(options.anchor ?? atlas.anchor ?? [0.5, 0.5]);
  const alphaTest = finiteNumber(
    options.alphaTest ?? (typeof atlas.alphaTest === 'number' ? atlas.alphaTest : 0.01),
    'sprite alpha test',
    { min: 0 },
  );
  const cutout = alphaTest >= 0.5;
  const resolvedCutout = options.cutout ?? atlas.cutout ?? cutout;
  const initialBillboardMode = billboardMode(options.billboard ?? atlas.billboard ?? 'screen');
  const gutterPixels = finiteNumber(
    options.gutterPixels ?? atlas.framePadding?.gutterPixels ?? 0,
    'sprite frame gutter',
    { min: 0 },
  );
  const frameWidth = positiveNumber(options.frameWidth ?? atlas.frameWidth, 'sprite frame width');
  const frameHeight = positiveNumber(options.frameHeight ?? atlas.frameHeight, 'sprite frame height');

  const uCols = uniform(cols);
  const uRows = uniform(rows);
  const uAspect = uniform(aspect);
  const uBillboard = uniform(initialBillboardMode, 'int');
  const uAnchor = uniform(anchor);
  const uAlphaTest = uniform(alphaTest);
  const uUvInset = uniform(new Vector2(gutterPixels / frameWidth, gutterPixels / frameHeight));
  const uUvScale = uniform(new Vector2(
    Math.max(0.000001, 1 - gutterPixels * 2 / frameWidth),
    Math.max(0.000001, 1 - gutterPixels * 2 / frameHeight),
  ));

  const aFrame = attribute('aFrame', 'float');
  const aScale = attribute('aScale', 'float');
  const aFlash = attribute('aFlash', 'float');
  const aFlip = attribute('aFlip', 'float');
  const aPose = attribute('aPose', 'vec3');

  // Row-major atlas indexing with frame zero at the image's top-left.
  const col = mod(aFrame, uCols);
  const row = floor(aFrame.div(uCols));
  const vRow = uRows.sub(1).sub(row);
  const sourceUv = uv();
  const flippedU = mix(sourceUv.x, float(1).sub(sourceUv.x), aFlip.clamp(0, 1));
  const paddedUv = vec2(flippedU, sourceUv.y).mul(uUvScale).add(uUvInset);
  const frameUv = paddedUv.add(vec2(col, vRow)).div(vec2(uCols, uRows));
  const uMap = texture(atlas.texture, frameUv);

  // PlaneGeometry is [-0.5, 0.5]. The Y pivot sign intentionally differs from
  // X because authored frame coordinates grow downward while world Y grows up.
  const anchorOffset = vec2(
    uAnchor.x.sub(0.5),
    float(0.5).sub(uAnchor.y),
  );
  const anchoredCorner = positionGeometry.xy.sub(anchorOffset);
  const posedCorner = vec2(
    anchoredCorner.x.mul(aPose.x).add(anchoredCorner.y.mul(aPose.z)),
    anchoredCorner.y.mul(aPose.y),
  );
  const cornerOffset = posedCorner
    .mul(vec2(uAspect, 1))
    .mul(aScale);

  // The released pool only writes identity + translation instance matrices.
  // r185 has already applied that matrix to positionLocal at this point.
  const instancePosition = positionLocal.sub(positionGeometry);

  const noBillboardPosition = instancePosition.add(vec3(
    posedCorner.mul(vec2(uAspect, 1)).mul(aScale),
    0,
  ));
  const noBillboardClip = cameraProjectionMatrix
    .mul(modelViewMatrix)
    .mul(vec4(noBillboardPosition, 1));

  const viewCenter = modelViewMatrix.mul(vec4(instancePosition, 1));
  const screenClip = cameraProjectionMatrix.mul(vec4(
    viewCenter.xy.add(cornerOffset),
    viewCenter.z,
    viewCenter.w,
  ));

  const horizontalCameraOffset = cameraPosition
    .sub(instancePosition)
    .mul(vec3(1, 0, 1));
  const horizontalCameraDirection = horizontalCameraOffset.div(
    max(0.000001, horizontalCameraOffset.length()),
  );
  // The cross product is unit length whenever the horizontal direction is
  // non-zero. Leaving the degenerate straight-overhead case as zero prevents
  // NaNs from contaminating the branchless screen/none modes.
  const right = cross(vec3(0, 1, 0), horizontalCameraDirection);
  const cylinderPosition = instancePosition
    .add(right.mul(cornerOffset.x))
    .add(vec3(0, 1, 0).mul(cornerOffset.y));
  const cylinderClip = cameraProjectionMatrix
    .mul(modelViewMatrix)
    .mul(vec4(cylinderPosition, 1));

  // Branchless 0/1 weights avoid backend-specific control-flow generation
  // while remaining exact for the integer mode uniform.
  const isScreen = float(uBillboard.equal(int(0)));
  const isNone = float(uBillboard.equal(int(2)));
  const billboardClip = mix(cylinderClip, screenClip, isScreen);
  const vertexNode = mix(billboardClip, noBillboardClip, isNone);

  const sampled = uMap;
  const flashedRgb = mix(sampled.rgb, vec3(1), aFlash.clamp(0, 1));

  const material = new MeshBasicNodeMaterial();
  material.name = 'KakiSpritePoolNodeMaterial';
  material.vertexNode = vertexNode;
  material.outputNode = vec4(flashedRgb, sampled.a);
  // `outputNode` is wrapped by the production selective-bloom MRT. A detached
  // TSL `.discard()` expression is not guaranteed to remain on that generated
  // fragment stack, which lets transparent texels write opaque black quads.
  // `maskNode` is evaluated by NodeMaterial before the custom output/MRT path
  // on both WebGPU and WebGL2, so cutout and depth writes stay in agreement.
  material.maskNode = sampled.a.greaterThanEqual(uAlphaTest);
  material.lights = false;
  material.fog = false;
  material.transparent = !resolvedCutout;
  material.depthWrite = options.depthWrite ?? atlas.depthWrite ?? resolvedCutout;
  material.depthTest = true;
  material.alphaToCoverage = false;
  material.blending = (options.blendMode ?? atlas.blendMode) === 'additive'
    ? AdditiveBlending
    : NormalBlending;
  material.userData.tslMaterialFamily = 'sprite-pool-atlas';
  material.userData.instanceAttributeContract = Object.freeze([
    'aFrame',
    'aScale',
    'aFlash',
    'aFlip',
    'aPose',
  ]);
  material.userData.translationOnlyInstanceMatrices = true;
  material.userData.cutout = resolvedCutout;

  const uniforms = Object.freeze({
    uMap,
    uCols,
    uRows,
    uAspect,
    uBillboard,
    uAnchor,
    uAlphaTest,
    uUvInset,
    uUvScale,
  });
  Object.defineProperty(material, 'uniforms', {
    configurable: true,
    enumerable: false,
    value: uniforms,
  });
  Object.defineProperties(material, {
    setMap: {
      configurable: true,
      enumerable: false,
      value(value) {
        if (!value?.isTexture) throw new TypeError('Sprite atlas map must be a Three.js texture.');
        uMap.value = value;
        return material;
      },
    },
    setBillboardMode: {
      configurable: true,
      enumerable: false,
      value(value) {
        uBillboard.value = billboardMode(value);
        return material;
      },
    },
    setAnchor: {
      configurable: true,
      enumerable: false,
      value(value) {
        uAnchor.value.copy(anchorVector(value));
        return material;
      },
    },
    setAtlasLayout: {
      configurable: true,
      enumerable: false,
      value(layout = {}) {
        if (Object.prototype.hasOwnProperty.call(layout, 'cols')) {
          uCols.value = positiveNumber(layout.cols, 'sprite atlas columns');
        }
        if (Object.prototype.hasOwnProperty.call(layout, 'rows')) {
          uRows.value = positiveNumber(layout.rows, 'sprite atlas rows');
        }
        if (Object.prototype.hasOwnProperty.call(layout, 'aspect')) {
          uAspect.value = positiveNumber(layout.aspect, 'sprite frame aspect');
        }
        if (Object.prototype.hasOwnProperty.call(layout, 'anchor')) {
          uAnchor.value.copy(anchorVector(layout.anchor));
        }
        return material;
      },
    },
    setAlphaThreshold: {
      configurable: true,
      enumerable: false,
      value(value) {
        const threshold = finiteNumber(value, 'sprite alpha test', { min: 0 });
        uAlphaTest.value = threshold;
        return material;
      },
    },
  });
  return material;
}
