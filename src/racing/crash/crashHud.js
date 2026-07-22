const formatScore = (value) => Math.max(0, Math.round(Number(value) || 0)).toLocaleString();
const formatSeconds = (value) => `${Math.max(0, Number(value) || 0).toFixed(1)} SEC`;

function button(root, selector, handler) {
  const element = root.querySelector(selector);
  if (element) element.addEventListener('click', handler);
  return element;
}

export function createCrashHud(session, actions = {}) {
  const host = document.getElementById('ui-root') || document.body;
  const root = document.createElement('div');
  root.className = 'kkc-hud';
  root.dataset.phase = 'LOADING';
  root.dataset.reduceMotion = session.reduceMotion ? 'true' : 'false';
  root.dataset.reducedFlashing = session.reducedFlashing ? 'true' : 'false';
  root.innerHTML = `
    <div class="kkc-scanlines" aria-hidden="true"></div>
    <header class="kkc-command">
      <section><span>INCIDENT</span><strong>06 · KAKI CATASTROPHE</strong><small>PAWPRINT INTERCHANGE / SIGNAL 06</small></section>
      <section class="kkc-score"><span>DESTRUCTION VALUE</span><strong>0</strong><small>PERSONAL BEST ${formatScore(session.record?.score)}</small></section>
      <button class="kkc-menu" type="button">MENU</button>
    </header>
    <section class="kkc-objective">
      <span>LIVE OBJECTIVE</span><strong>CAUSE THE CHAIN REACTION</strong><small>BLOCK THE BUS ROUTE · TURN THE SEMI · SAVE BOOM FOR HEAVY TRAFFIC</small>
    </section>
    <section class="kkc-chain" aria-live="polite"><span>CURRENT CHAIN</span><strong>CHAIN 0</strong><small>ENTER AT AN ANGLE</small></section>
    <section class="kkc-speed"><strong>000</strong><span>KM/H</span></section>
    <section class="kkc-boom">
      <div><span>KAKI BOOM</span><strong>CHARGING</strong></div>
      <div class="kkc-boom-track"><i></i></div>
      <small>BUILD REAL IMPACT ENERGY · <kbd>X</kbd> / <kbd>SHIFT</kbd> RELEASE</small>
      <button type="button" aria-label="Trigger Kaki Boom">BOOM</button>
    </section>
    <div class="kkc-callout" aria-live="assertive"></div>
    <div class="kkc-camera-control">
      <button class="kkr-camera-cycle" type="button" aria-label="Camera: Chase. Activate to cycle; hold for camera list."><span>CAMERA</span><strong>CHASE</strong></button>
      <div class="kkr-camera-list" role="menu" aria-label="Catastrophe camera" hidden>
        <button type="button" role="menuitem" data-camera-mode="chase">CHASE</button>
        <button type="button" role="menuitem" data-camera-mode="driver_fpv">DRIVER FPV</button>
      </div>
    </div>
    <div class="kkc-controls"><kbd>W S</kbd> GAS / BRAKE&nbsp;&nbsp;<kbd>A D</kbd> STEER&nbsp;&nbsp;<kbd>SPACE</kbd> HANDBRAKE&nbsp;&nbsp;CAMERA ON-SCREEN&nbsp;&nbsp;<kbd>B</kbd> LOOK BACK&nbsp;&nbsp;<kbd>V</kbd> RECENTER</div>
    <section class="kkc-cinematic" aria-live="polite">
      <span>06 · MUNICIPAL INCIDENT TEST</span><h1>PAWPRINT<br>INTERCHANGE</h1><p>CAUSE THE CHAIN REACTION</p><small>BUS ROUTE / ARTICULATED FREIGHT / ENERGY TANKER</small>
    </section>
    <section class="kkc-countdown"><span>LAUNCH WINDOW</span><strong>3</strong><small>W / RT TO ACCELERATE</small></section>
    <section class="kkc-replay" hidden>
      <div><span>INCIDENT REPLAY</span><strong>DIRECTOR CUT</strong><small>BEST IMPACT AUTO-SELECTED</small></div>
      <div class="kkc-replay-track"><i></i><b></b></div>
      <div class="kkc-replay-meta"><span>ROAD-SIDE 01</span><strong>1.00×</strong></div>
      <div class="kkc-replay-actions"><button data-replay-speed="1" type="button">1×</button><button data-replay-speed="0.5" type="button">½×</button><button data-replay-speed="0.25" type="button">¼×</button><button data-replay-speed="0.12" type="button">0.12×</button><button data-action="skip-replay" type="button">SKIP REPLAY</button></div>
    </section>
    <section class="kkc-results" hidden>
      <div class="kkc-results-card">
        <span>PAWPRINT INTERCHANGE · INCIDENT CLOSED</span><h2>GOLD PAW</h2><strong class="kkc-result-score">0</strong><small>DESTRUCTION VALUE</small>
        <div class="kkc-result-grid">
          <div><strong data-result="vehicles">0</strong><span>VEHICLES INVOLVED</span></div>
          <div><strong data-result="impact">0</strong><span>LARGEST IMPACT</span></div>
          <div><strong data-result="chain">0.0 SEC</strong><span>LONGEST CHAIN</span></div>
          <div><strong data-result="classes">0</strong><span>UNIQUE CLASSES</span></div>
          <div><strong data-result="lanes">0</strong><span>LANES BLOCKED</span></div>
          <div><strong data-result="specials">—</strong><span>SPECIAL TARGETS</span></div>
        </div>
        <p class="kkc-result-note"></p>
        <div class="kkc-result-actions"><button data-action="retry" type="button">RETRY NOW</button><button data-action="replay-again" type="button">REPLAY AGAIN</button><button data-action="menu" type="button">MAIN MENU</button></div>
      </div>
    </section>
    <div class="kkc-touch" aria-label="Touch driving controls">
      <button data-touch="left" type="button">◀</button><button data-touch="right" type="button">▶</button><button data-touch="brake" type="button">BRAKE</button><button data-touch="gas" type="button">GAS</button>
    </div>`;
  host.appendChild(root);
  const touch = { left: false, right: false, brake: false, gas: false, boom: false };
  root.querySelectorAll('[data-touch]').forEach((element) => {
    const key = element.dataset.touch;
    const set = (value) => { touch[key] = value; element.classList.toggle('is-held', value); };
    element.addEventListener('pointerdown', (event) => { event.preventDefault(); element.setPointerCapture?.(event.pointerId); set(true); });
    element.addEventListener('pointerup', () => set(false));
    element.addEventListener('pointercancel', () => set(false));
    element.addEventListener('lostpointercapture', () => set(false));
  });
  button(root, '.kkc-boom button', () => actions.boom?.());
  button(root, '.kkc-menu', () => actions.menu?.());
  button(root, '[data-action="skip-replay"]', () => actions.skipReplay?.());
  button(root, '[data-action="retry"]', () => actions.retry?.());
  button(root, '[data-action="replay-again"]', () => actions.replayAgain?.());
  button(root, '[data-action="menu"]', () => actions.menu?.());
  root.querySelectorAll('[data-replay-speed]').forEach((element) => element.addEventListener('click', () => actions.replaySpeed?.(Number(element.dataset.replaySpeed))));
  return {
    root,
    touch,
    score: root.querySelector('.kkc-score strong'),
    scoreBest: root.querySelector('.kkc-score small'),
    objective: root.querySelector('.kkc-objective'),
    chain: root.querySelector('.kkc-chain strong'),
    chainHint: root.querySelector('.kkc-chain small'),
    speed: root.querySelector('.kkc-speed strong'),
    boom: root.querySelector('.kkc-boom'),
    boomLabel: root.querySelector('.kkc-boom strong'),
    boomFill: root.querySelector('.kkc-boom i'),
    boomButton: root.querySelector('.kkc-boom button'),
    callout: root.querySelector('.kkc-callout'),
    cinematic: root.querySelector('.kkc-cinematic'),
    countdown: root.querySelector('.kkc-countdown'),
    countdownValue: root.querySelector('.kkc-countdown strong'),
    replay: root.querySelector('.kkc-replay'),
    replayFill: root.querySelector('.kkc-replay-track i'),
    replayMarker: root.querySelector('.kkc-replay-track b'),
    replayShot: root.querySelector('.kkc-replay-meta span'),
    replaySpeed: root.querySelector('.kkc-replay-meta strong'),
    results: root.querySelector('.kkc-results'),
  };
}

export function setCrashHudCallout(hud, text, tone = '') {
  if (!hud?.callout) return;
  hud.callout.textContent = String(text || '');
  hud.callout.dataset.tone = tone;
  hud.callout.classList.remove('is-live');
  void hud.callout.offsetWidth;
  hud.callout.classList.toggle('is-live', !!text);
}

export function updateCrashHud(session) {
  const hud = session?.hud;
  if (!hud?.root) return;
  const score = session.scoreSnapshot || {};
  const phase = session.crashState?.phase || 'LOADING';
  hud.root.dataset.phase = phase;
  hud.score.textContent = formatScore(score.score);
  hud.chain.textContent = `CHAIN ${score.chain || 0}`;
  hud.chainHint.textContent = score.specials?.at?.(-1)?.replaceAll?.('-', ' ').toUpperCase?.() || (score.chain ? `${score.classes || 0} CLASSES · ${formatSeconds(score.chainDuration)}` : 'ENTER AT AN ANGLE');
  hud.speed.textContent = String(Math.round((session.playerSpeed || 0) * 3.6)).padStart(3, '0');
  const charge = Math.max(0, Math.min(1, score.boomCharge || 0));
  hud.boomFill.style.width = `${charge * 100}%`;
  hud.boom.classList.toggle('is-ready', charge >= 0.999 && !score.boomUsed);
  hud.boom.classList.toggle('is-used', !!score.boomUsed);
  hud.boomLabel.textContent = score.boomUsed ? 'SPENT' : charge >= 0.999 ? 'READY' : `${Math.round(charge * 100)}%`;
  hud.boomButton.disabled = charge < 0.999 || !!score.boomUsed;
  hud.cinematic.hidden = !['LOADING', 'INTRO'].includes(phase);
  hud.countdown.hidden = phase !== 'COUNTDOWN';
  if (phase === 'COUNTDOWN') hud.countdownValue.textContent = Math.max(1, Math.ceil(session.countdown || 0));
  hud.replay.hidden = phase !== 'REPLAY';
  hud.results.hidden = phase !== 'RESULTS';
  if (phase === 'REPLAY') {
    const replay = session.replaySnapshot || {};
    const duration = Math.max(0.001, (replay.end || 0) - (replay.start || 0));
    const progress = Math.max(0, Math.min(1, ((replay.time || 0) - (replay.start || 0)) / duration));
    hud.replayFill.style.width = `${progress * 100}%`;
    const highlight = Math.max(0, Math.min(1, ((replay.highlightTime || replay.start || 0) - (replay.start || 0)) / duration));
    hud.replayMarker.style.left = `${highlight * 100}%`;
    hud.replayShot.textContent = String(replay.shot || 'director').replaceAll('_', ' ').toUpperCase();
    hud.replaySpeed.textContent = `${Number(replay.speed || 1).toFixed(replay.speed < 1 ? 2 : 0)}×`;
    hud.root.querySelectorAll('[data-replay-speed]').forEach((entry) => entry.classList.toggle('is-active', Number(entry.dataset.replaySpeed) === Number(replay.speed)));
  }
}

export function showCrashResults(session, result) {
  const hud = session?.hud;
  if (!hud?.results) return;
  hud.results.querySelector('h2').textContent = result.medal;
  hud.results.querySelector('.kkc-result-score').textContent = formatScore(result.score);
  hud.results.querySelector('[data-result="vehicles"]').textContent = result.vehicles;
  hud.results.querySelector('[data-result="impact"]').textContent = formatScore(result.largestImpact?.value || 0);
  hud.results.querySelector('[data-result="chain"]').textContent = formatSeconds(result.chainDuration);
  hud.results.querySelector('[data-result="classes"]').textContent = result.classes;
  hud.results.querySelector('[data-result="lanes"]').textContent = result.lanesBlocked;
  hud.results.querySelector('[data-result="specials"]').textContent = result.specials.length ? result.specials.map((entry) => entry.replaceAll('-', ' ').toUpperCase()).join(' · ') : 'NONE';
  hud.results.querySelector('.kkc-result-note').textContent = result.isPersonalBest
    ? `NEW PERSONAL BEST · BEST IMPACT AT ${Number(result.highlightTime || 0).toFixed(2)} SEC`
    : `PERSONAL BEST ${formatScore(result.record?.score)} · RETRY FROM A SHARPER ENTRY ANGLE`;
}

export function disposeCrashHud(hud) {
  if (!hud?.root?.isConnected) return false;
  hud.root.remove();
  return true;
}
