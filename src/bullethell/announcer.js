/**
 * Compact, mode-owned event presentation for Bullet Hell.
 *
 * The shared game banner is intentionally cinematic (38px, center-screen),
 * which made routine wave/item/graze messages cover the dodge field. Bullet
 * Hell uses this small priority-aware rail instead. Only campaign victory keeps
 * the shared cinematic banner.
 */
let _notice = null;
let _hideTimer = 0;
let _priority = 0;

function _ensureNotice() {
  if (_notice) return _notice;
  _notice = document.createElement('div');
  _notice.id = 'kk-bh-notice';
  _notice.setAttribute('role', 'status');
  _notice.setAttribute('aria-live', 'polite');
  _notice.style.cssText = `
    position:fixed; left:50%; top:92px; transform:translate(-50%, -4px);
    z-index:64; pointer-events:none; opacity:0;
    max-width:min(560px, 84vw); box-sizing:border-box;
    padding:5px 12px; border:1px solid rgba(216,160,255,0.28);
    border-radius:999px; background:rgba(10,7,22,0.76);
    color:#f4ecff; box-shadow:0 5px 18px rgba(0,0,0,0.35);
    backdrop-filter:blur(5px); -webkit-backdrop-filter:blur(5px);
    font-family:'Courier New',monospace; font-size:clamp(11px,1.25vw,14px);
    font-weight:700; letter-spacing:0.13em; line-height:1.25;
    text-align:center; text-transform:uppercase; white-space:normal;
    transition:opacity 0.14s ease, transform 0.14s ease;
  `;
  document.body.appendChild(_notice);
  return _notice;
}

/**
 * Show a compact event chip. Higher-priority messages cannot be replaced by
 * routine ones before they finish.
 * opts: { duration, priority, major }
 */
export function notifyBh(text, color = '#d8a0ff', opts = null) {
  const el = _ensureNotice();
  const priority = (opts && opts.priority) || 0;
  if (_hideTimer && priority < _priority) return false;
  if (_hideTimer) window.clearTimeout(_hideTimer);
  _priority = priority;
  const major = !!(opts && opts.major);
  const duration = (opts && opts.duration) || (major ? 1.7 : 1.15);
  el.textContent = text;
  el.style.color = color;
  el.style.borderColor = color + '66';
  el.style.boxShadow = `0 5px 18px rgba(0,0,0,0.38), 0 0 ${major ? 18 : 10}px ${color}33`;
  el.style.fontSize = major ? 'clamp(13px, 1.6vw, 18px)' : 'clamp(11px, 1.25vw, 14px)';
  el.style.padding = major ? '7px 16px' : '5px 12px';
  el.style.opacity = '1';
  el.style.transform = 'translate(-50%, 0)';
  _hideTimer = window.setTimeout(() => {
    if (!_notice) return;
    _notice.style.opacity = '0';
    _notice.style.transform = 'translate(-50%, -4px)';
    _hideTimer = 0;
    _priority = 0;
  }, duration * 1000);
  return true;
}

export function disposeBhAnnouncer() {
  if (_hideTimer) window.clearTimeout(_hideTimer);
  _hideTimer = 0;
  _priority = 0;
  if (_notice && _notice.parentNode) _notice.parentNode.removeChild(_notice);
  _notice = null;
}
