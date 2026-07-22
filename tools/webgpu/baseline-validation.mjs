const CONSOLE_ABORT_PATTERN = /failed to load resource.*net::ERR_ABORTED|net::ERR_ABORTED.*failed to load resource/i;
const ACTIONABLE_ASSET_WARNING_PATTERN = /(?:\bload[A-Z_a-z0-9-]*\s+failed\b|\b(?:assets?|textures?|models?|gltf|glb|kit)\b[^\n]*(?:\bfailed\b|\bmissing\b|\bnot preloaded\b)|(?:\bfailed\b|\bmissing\b|\bnot preloaded\b)[^\n]*\b(?:assets?|textures?|models?|gltf|glb|kit)\b)/i;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function isLocalUrl(candidate, origin) {
  try { return new URL(candidate, origin).origin === new URL(origin).origin; }
  catch (_) { return false; }
}

function isMenuGlitchUrl(candidate, origin) {
  try {
    const url = new URL(candidate, origin);
    return url.origin === new URL(origin).origin
      && url.pathname === '/assets/music/menu_glitch.mp3';
  } catch (_) {
    return false;
  }
}

/** Only the deliberately interrupted menu-music stream may abort locally. */
export function isToleratedRequestFailure(row, origin) {
  return row?.method === 'GET'
    && row?.resourceType === 'media'
    && /^net::ERR_ABORTED$/i.test(row?.error || '')
    && isMenuGlitchUrl(row?.url, origin);
}

/**
 * Chromium can report the deliberately cancelled menu-music stream as a
 * console error. Asset, model, texture, and decoder aborts remain actionable.
 */
export function isToleratedConsoleError(row, origin) {
  if (row?.type !== 'error') return false;
  const text = String(row.text || '');
  const sourceUrl = row.location?.url || '';
  return CONSOLE_ABORT_PATTERN.test(text)
    && !!sourceUrl
    && isMenuGlitchUrl(sourceUrl, origin);
}

function rendererMetricCandidates(runtime, names) {
  const currentRender = runtime?.rendererInfo?.render || {};
  const qaRender = runtime?.qa?.renderer?.info?.render || {};
  const diagnostics = runtime?.diagnostics || {};
  const sources = [currentRender, qaRender, diagnostics];
  const candidates = [];
  for (const source of sources) {
    for (const name of names) {
      const value = finiteNonNegative(source?.[name]);
      if (value != null) candidates.push(value);
    }
  }
  return candidates;
}

export function rendererActivityFailures(runtime) {
  const failures = [];
  const drawCalls = rendererMetricCandidates(runtime, ['drawCalls']);
  const triangles = rendererMetricCandidates(runtime, ['triangles']);

  if (drawCalls.length === 0) {
    failures.push('renderer draw-call metrics are unavailable after QA readiness');
  } else if (Math.max(...drawCalls) <= 0) {
    failures.push('renderer recorded zero draw calls after QA readiness');
  }

  if (triangles.length === 0) {
    failures.push('renderer triangle metrics are unavailable after QA readiness');
  } else if (Math.max(...triangles) <= 0) {
    failures.push('renderer recorded zero triangles after QA readiness');
  }
  return failures;
}

function quantizedColorKey(red, green, blue) {
  return `${red >> 4}:${green >> 4}:${blue >> 4}`;
}

/** Analyze an RGBA canvas capture without relying on browser readback APIs. */
export function analyzeCanvasRgba(data, width, height) {
  if (!data || !Number.isInteger(width) || !Number.isInteger(height)
      || width <= 0 || height <= 0 || data.length !== width * height * 4) {
    throw new TypeError('Canvas RGBA data does not match its dimensions.');
  }

  const pixels = width * height;
  let luminanceSum = 0;
  let luminanceSquaredSum = 0;
  let alphaPixels = 0;
  let veryDarkPixels = 0;
  let minimumLuminance = 255;
  let maximumLuminance = 0;
  const quantizedColors = new Map();

  for (let offset = 0; offset < data.length; offset += 4) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const alpha = data[offset + 3];
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    luminanceSum += luminance;
    luminanceSquaredSum += luminance * luminance;
    if (alpha > 8) alphaPixels += 1;
    if (luminance < 2) veryDarkPixels += 1;
    minimumLuminance = Math.min(minimumLuminance, luminance);
    maximumLuminance = Math.max(maximumLuminance, luminance);
    const key = quantizedColorKey(red, green, blue);
    quantizedColors.set(key, (quantizedColors.get(key) || 0) + 1);
  }

  const meanLuminance = luminanceSum / pixels;
  const variance = Math.max(0, luminanceSquaredSum / pixels - meanLuminance * meanLuminance);
  const dominantColorPixels = Math.max(...quantizedColors.values());
  return {
    width,
    height,
    pixels,
    meanLuminance: Number(meanLuminance.toFixed(3)),
    luminanceStdDev: Number(Math.sqrt(variance).toFixed(3)),
    luminanceRange: Number((maximumLuminance - minimumLuminance).toFixed(3)),
    opaquePixelRatio: Number((alphaPixels / pixels).toFixed(5)),
    veryDarkPixelRatio: Number((veryDarkPixels / pixels).toFixed(5)),
    quantizedColorCount: quantizedColors.size,
    dominantColorRatio: Number((dominantColorPixels / pixels).toFixed(5)),
  };
}

/**
 * These bounds intentionally detect only blank/clear frames. Atmospheric,
 * dark, reduced-effects, and accessibility scenes retain ample headroom.
 */
export function canvasFrameFailures(frame) {
  if (!frame) return ['renderer canvas frame capture is unavailable'];
  const failures = [];
  if (!(frame.width > 1 && frame.height > 1 && frame.pixels > 4)) {
    failures.push('renderer canvas has no capturable pixel area');
    return failures;
  }
  if (frame.opaquePixelRatio <= 0.001) {
    failures.push('renderer canvas frame is effectively transparent');
  }
  if (frame.meanLuminance < 0.75 && frame.veryDarkPixelRatio > 0.995) {
    failures.push('renderer canvas frame is effectively black');
  }
  if (frame.luminanceStdDev < 1.25
      || frame.luminanceRange < 5
      || frame.quantizedColorCount < 6
      || frame.dominantColorRatio > 0.9975) {
    failures.push(`renderer canvas frame is effectively blank (${JSON.stringify(frame)})`);
  }
  return failures;
}

export function collectBaselineValidationFailures(result, origin) {
  const failures = [];
  for (const error of result.pageErrors || []) {
    failures.push(`pageerror: ${error.message || 'unknown page error'}`);
  }
  for (const error of result.runtime?.browserErrors || []) {
    failures.push(`${error.source || 'browser'}: ${error.message || 'unknown browser error'}`);
  }
  for (const error of result.runtime?.qa?.errors || []) {
    failures.push(`qa.${error.source || 'error'}: ${error.message || 'unknown QA error'}`);
  }
  for (const row of result.requestFailures || []) {
    if (isLocalUrl(row.url, origin) && !isToleratedRequestFailure(row, origin)) {
      failures.push(`local request failed: ${row.method} ${row.url} (${row.error})`);
    }
  }
  for (const row of result.httpErrors || []) {
    if (isLocalUrl(row.url, origin)) failures.push(`local HTTP ${row.status}: ${row.url}`);
  }
  for (const row of result.console || []) {
    const sourceUrl = row.location?.url || '';
    const location = sourceUrl ? ` at ${sourceUrl}` : '';
    if (row.type === 'warning' && ACTIONABLE_ASSET_WARNING_PATTERN.test(row.text || '')) {
      failures.push(`asset warning${location}: ${row.text || 'unknown asset warning'}`);
    } else if (row.type === 'error' && !isToleratedConsoleError(row, origin)) {
      failures.push(`console error${location}: ${row.text || 'unknown console error'}`);
    }
  }
  failures.push(...rendererActivityFailures(result.runtime));
  failures.push(...canvasFrameFailures(result.runtime?.canvasFrame));
  return [...new Set(failures)];
}
