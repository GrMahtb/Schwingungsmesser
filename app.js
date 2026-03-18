'use strict';

/* ═══════════════════════════════════════════════
   KONSTANTEN & GLOBALE ZUSTÄNDE
═══════════════════════════════════════════════ */
const SAMPLE_RATE   = 60;          // Hz (requestAnimationFrame)
const WINDOW_SEC    = 10;          // Sekunden Live-Fenster
const WINDOW_LEN    = SAMPLE_RATE * WINDOW_SEC;

const COLORS = { x:'#ff4444', y:'#00cc66', z:'#4499ff', t:'#ffed00' };

let sensor       = null;
let running      = false;
let startTime    = null;
let durTimer     = null;
let rafId        = null;

// Rohbeschleunigungen (m/s²)
let rawX = 0, rawY = 0, rawZ = 0;

// Puffer für Ringbuffer-Verlauf
const buf = {
  x: new Float32Array(WINDOW_LEN),
  y: new Float32Array(WINDOW_LEN),
  z: new Float32Array(WINDOW_LEN),
  t: new Float32Array(WINDOW_LEN),
  ptr: 0,
  len: 0,
};

// Integrationsakkumulatoren
const intg = {
  vx:0, vy:0, vz:0,  // Geschwindigkeit (m/s)
  px:0, py:0, pz:0,  // Position (m)
  prev: null,
};

// Peak / RMS
let peakTotal = 0;
let rmsAcc    = 0;
let rmsCnt    = 0;
let evtCount  = 0;
const EVT_THRESHOLD = 0.1;  // mm/s

// Sichtbarkeit der Achsen
const visible = { x:true, y:true, z:true, t:true };

// Aktive Einheit: 'vel' | 'acc' | 'disp'
let activeUnit = 'vel';

// Gespeicherte Messung für Ergebnis-Chart
let savedData = null;

/* ═══════════════════════════════════════════════
   DOM-REFERENZEN
═══════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const dom = {
  statusBar  : $('statusBar'),
  mainNum    : $('mainNum'),
  mainSub    : $('mainSub'),
  xVal       : $('xVal'),
  yVal       : $('yVal'),
  zVal       : $('zVal'),
  tVal       : $('tVal'),
  peakVal    : $('peakVal'),
  rmsVal     : $('rmsVal'),
  evtVal     : $('evtVal'),
  durVal     : $('durVal'),
  debugPanel : $('debugPanel'),
  liveChart  : $('liveChart'),
  liveAxis   : $('liveAxis'),
  resultChart: $('resultChart'),
  resAxis    : $('resAxis'),
  resMeta    : $('resMeta'),
  dinNote    : $('dinNote'),
  results    : $('results'),
  startBtn   : $('startBtn'),
  resetBtn   : $('resetBtn'),
  iosPermBtn : $('iosPermBtn'),
  installBanner: $('installBanner'),
  installBtn : $('installBtn'),
};

/* ═══════════════════════════════════════════════
   TABS
═══════════════════════════════════════════════ */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('is-active', b === btn));
    document.querySelectorAll('.pane').forEach(p => {
      const active = p.id === `tab-${target}`;
      p.classList.toggle('is-active', active);
      p.hidden = !active;
    });
  });
});

/* ═══════════════════════════════════════════════
   EINHEITEN-SWITCH
═══════════════════════════════════════════════ */
document.querySelectorAll('.unitBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeUnit = btn.dataset.unit;
    document.querySelectorAll('.unitBtn').forEach(b =>
      b.classList.toggle('is-active', b === btn));
    updateUnitLabels();
  });
});

function updateUnitLabels() {
  const labels = { vel:'mm/s', acc:'m/s²', disp:'mm' };
  const u = labels[activeUnit];
  ['unitX','unitY','unitZ','unitT','unitPeak','unitRms'].forEach(id => {
    const el = $(id);
    if (el) el.textContent = u;
  });
  dom.mainSub.textContent = `${u} (Total)`;
}

/* ═══════════════════════════════════════════════
   ACHSEN-TOGGLES (Tiles + Legende)
═══════════════════════════════════════════════ */
function applySeriesToggle(series, on) {
  visible[series] = on;
  // Tiles
  document.querySelectorAll(`.tile[data-series="${series}"]`).forEach(el =>
    el.classList.toggle('is-off', !on));
  // Legend-Buttons
  document.querySelectorAll(`.legendBtn[data-series="${series}"]`).forEach(el =>
    el.classList.toggle('is-off', !on));
  // DIN-Hinweis wenn Total ausgeblendet
  dom.dinNote.hidden = visible.t;
}

document.querySelectorAll('[data-series]').forEach(btn => {
  if (!btn.classList.contains('tile') && !btn.classList.contains('legendBtn')) return;
  btn.addEventListener('click', () => {
    const s = btn.dataset.series;
    applySeriesToggle(s, !visible[s]);
  });
});

/* ═══════════════════════════════════════════════
   STATUS-BAR HELPER
═══════════════════════════════════════════════ */
function setStatus(msg, cls) {
  dom.statusBar.textContent = msg;
  dom.statusBar.className   = 'statusBar' + (cls ? ' ' + cls : '');
  dom.statusBar.hidden      = !msg;
}

/* ═══════════════════════════════════════════════
   IOS-PERMISSION
═══════════════════════════════════════════════ */
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
if (isIOS && typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function') {
  dom.iosPermBtn.hidden = false;
  dom.iosPermBtn.addEventListener('click', async () => {
    try {
      const res = await DeviceMotionEvent.requestPermission();
      if (res === 'granted') {
        dom.iosPermBtn.hidden = true;
        setStatus('Erlaubnis erteilt – drücke Start', '');
      } else {
        setStatus('Erlaubnis verweigert!', 'is-error');
      }
    } catch (e) {
      setStatus('Fehler: ' + e.message, 'is-error');
    }
  });
}

/* ═══════════════════════════════════════════════
   INSTALL PWA (Android/Chrome)
═══════════════════════════════════════════════ */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  dom.installBanner.hidden = false;
});
dom.installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') dom.installBanner.hidden = true;
  deferredPrompt = null;
});
window.addEventListener('appinstalled', () => {
  dom.installBanner.hidden = true;
  deferredPrompt = null;
});

/* ═══════════════════════════════════════════════
   LIVE-CHART SETUP
═══════════════════════════════════════════════ */
const liveCtx  = dom.liveChart.getContext('2d');
const resCtx   = dom.resultChart.getContext('2d');

function resizeCanvas(cvs) {
  const dpr = window.devicePixelRatio || 1;
  const rect = cvs.getBoundingClientRect();
  cvs.width  = rect.width  * dpr;
  cvs.height = rect.height * dpr;
  cvs.getContext('2d').scale(dpr, dpr);
}

function initCanvases() {
  resizeCanvas(dom.liveChart);
  resizeCanvas(dom.resultChart);
  drawLive();
}

window.addEventListener('resize', initCanvases);

/* ═══════════════════════════════════════════════
   KONVERTIERUNG (abhängig von activeUnit)
═══════════════════════════════════════════════ */
function convert(velMs) {
  // velMs in m/s → Zielwert
  if (activeUnit === 'vel')  return velMs * 1000;        // → mm/s
  if (activeUnit === 'acc')  return velMs;               // m/s² (Rohbeschleunigung, wird separat behandelt)
  if (activeUnit === 'disp') return velMs * 1000;        // mm (aus Integration, wird separat behandelt)
  return velMs * 1000;
}

/* ═══════════════════════════════════════════════
   INTEGRATION: acc → vel → disp
═══════════════════════════════════════════════ */
function integrate(ax, ay, az, dt) {
  if (intg.prev === null) { intg.prev = performance.now(); return; }

  // Tiefpass (α = 0.15) um DC-Drift zu dämpfen
  const α = 0.15;
  ax = ax * α + (intg.vx > 0 ? 1 : -1) * 0 * (1 - α); // einfacher Drift-Guard
  // Trapez-Integration
  intg.vx += ax * dt;
  intg.vy += ay * dt;
  intg.vz += az * dt;

  // Leakage um Drift zu reduzieren
  const leak = 0.998;
  intg.vx *= leak; intg.vy *= leak; intg.vz *= leak;

  intg.px += intg.vx * dt;
  intg.py += intg.vy * dt;
  intg.pz += intg.vz * dt;
  intg.px *= leak; intg.py *= leak; intg.pz *= leak;
}

/* ═══════════════════════════════════════════════
   DIN-4150-2 BEWERTUNG
═══════════════════════════════════════════════ */
const dinRows = ['n0','n1','n2','n3','n4'];
const dinBounds = [0, 0.3, 1.0, 3.0, 10.0];

function updateDIN(velMms) {
  let active = 0;
  for (let i = dinBounds.length - 1; i >= 0; i--) {
    if (velMms >= dinBounds[i]) { active = i; break; }
  }
  dinRows.forEach((id, i) =>
    $(id).classList.toggle('is-active', i === active));
}

/* ═══════════════════════════════════════════════
   SENSOR-LOOP (RAF)
═══════════════════════════════════════════════ */
function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  const now = performance.now();
  const dt  = Math.min((now - (intg.prev ?? now)) / 1000, 0.05); // max 50ms
  intg.prev = now;

  const ax = rawX, ay = rawY, az = rawZ;
  integrate(ax, ay, az, dt);

  // Werte je nach Einheit
  let vx, vy, vz, vt;
  if (activeUnit === 'acc') {
    vx = ax; vy = ay; vz = az;
    vt = Math.sqrt(ax*ax + ay*ay + az*az);
  } else if (activeUnit === 'disp') {
    vx = intg.px * 1000;
    vy = intg.py * 1000;
    vz = intg.pz * 1000;
    vt = Math.sqrt(vx*vx + vy*vy + vz*vz);
  } else {
    // Geschwindigkeit
    vx = intg.vx * 1000;
    vy = intg.vy * 1000;
    vz = intg.vz * 1000;
    vt = Math.sqrt(vx*vx + vy*vy + vz*vz);
  }

  // Ringbuffer
  buf.x[buf.ptr] = vx;
  buf.y[buf.ptr] = vy;
  buf.z[buf.ptr] = vz;
  buf.t[buf.ptr] = vt;
  buf.ptr = (buf.ptr + 1) % WINDOW_LEN;
  if (buf.len < WINDOW_LEN) buf.len++;

  // Peak & RMS (immer auf mm/s Total)
  const velMms = Math.sqrt(
    (intg.vx*intg.vx + intg.vy*intg.vy + intg.vz*intg.vz)) * 1000;
  if (velMms > peakTotal) peakTotal = velMms;
  rmsAcc += velMms * velMms;
  rmsCnt++;
  if (velMms > EVT_THRESHOLD) evtCount++;

  // DOM
  dom.mainNum.textContent = vt.toFixed(2);
  dom.xVal.textContent    = vx.toFixed(2);
  dom.yVal.textContent    = vy.toFixed(2);
  dom.zVal.textContent    = vz.toFixed(2);
  dom.tVal.textContent    = vt.toFixed(2);

  const dispUnit = { vel:'mm/s', acc:'m/s²', disp:'mm' }[activeUnit];
  dom.mainSub.textContent = `${dispUnit} (Total)`;

  dom.peakVal.textContent = peakTotal.toFixed(2);
  dom.rmsVal.textContent  = rmsCnt ? Math.sqrt(rmsAcc / rmsCnt).toFixed(2) : '0.00';
  dom.evtVal.textContent  = evtCount;

  updateDIN(velMms);
  drawLive();

  // Debug
  dom.debugPanel.textContent =
    `ax=${ax.toFixed(3)} ay=${ay.toFixed(3)} az=${az.toFixed(3)} m/s²\n` +
    `vx=${(intg.vx*1000).toFixed(3)} vy=${(intg.vy*1000).toFixed(3)} vz=${(intg.vz*1000).toFixed(3)} mm/s\n` +
    `Total=${velMms.toFixed(3)} mm/s | Peak=${peakTotal.toFixed(3)} mm/s\n` +
    `Events=${evtCount} | dt=${(dt*1000).toFixed(1)} ms`;
}

/* ═══════════════════════════════════════════════
   LIVE CHART ZEICHNEN
═══════════════════════════════════════════════ */
function drawLive() {
  const cvs = dom.liveChart;
  const ctx = liveCtx;
  const W   = cvs.getBoundingClientRect().width  || cvs.width;
  const H   = cvs.getBoundingClientRect().height || cvs.height;

  ctx.clearRect(0, 0, W, H);

  if (buf.len < 2) {
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, W, H);
    return;
  }

  // Wertebereich bestimmen
  let mn = Infinity, mx = -Infinity;
  ['x','y','z','t'].forEach(s => {
    if (!visible[s]) return;
    for (let i = 0; i < buf.len; i++) {
      const v = buf[s][(buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  });
  if (!isFinite(mn)) { mn = -1; mx = 1; }
  const range = mx - mn || 1;
  const pad   = range * 0.12;
  const yMin  = mn - pad, yMax = mx + pad;

  // Hintergrund
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  // Null-Linie
  const y0 = H - ((0 - yMin) / (yMax - yMin)) * H;
  ctx.strokeStyle = '#2a2a2d';
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();

  // Serien zeichnen
  ['x','y','z','t'].forEach(s => {
    if (!visible[s]) return;
    ctx.strokeStyle = COLORS[s];
    ctx.lineWidth   = s === 't' ? 2.5 : 1.5;
    ctx.beginPath();
    for (let i = 0; i < buf.len; i++) {
      const idx = (buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN;
      const xp  = (i / (WINDOW_LEN - 1)) * W;
      const yp  = H - ((buf[s][idx] - yMin) / (yMax - yMin)) * H;
      i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
    }
    ctx.stroke();
  });

  // Zeitachse
  dom.liveAxis.innerHTML = '';
  for (let i = 0; i <= 10; i += 2) {
    const span = document.createElement('span');
    span.textContent = `-${10 - i}s`;
    dom.liveAxis.appendChild(span);
  }
}

/* ═══════════════════════════════════════════════
   ERGEBNIS-CHART
═══════════════════════════════════════════════ */
function drawResult(data) {
  const cvs = dom.resultChart;
  const ctx = resCtx;
  const W   = cvs.getBoundingClientRect().width  || cvs.width;
  const H   = cvs.getBoundingClientRect().height || cvs.height;

  ctx.clearRect(0, 0, W, H);

  let mn = Infinity, mx = -Infinity;
  ['x','y','z','t'].forEach(s => {
    data[s].forEach(v => { if (v < mn) mn = v; if (v > mx) mx = v; });
  });
  const range = mx - mn || 1;
  const pad   = range * 0.12;
  const yMin  = mn - pad, yMax = mx + pad;

  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  const y0 = H - ((0 - yMin) / (yMax - yMin)) * H;
  ctx.strokeStyle = '#2a2a2d';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();

  ['x','y','z','t'].forEach(s => {
    ctx.strokeStyle = COLORS[s];
    ctx.lineWidth   = s === 't' ? 2.5 : 1.5;
    ctx.beginPath();
    data[s].forEach((v, i) => {
      const xp = (i / (data[s].length - 1)) * W;
      const yp = H - ((v - yMin) / (yMax - yMin)) * H;
      i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
    });
    ctx.stroke();
  });

  dom.resAxis.innerHTML = '';
  ['Anfang','Ende'].forEach(l => {
    const span = document.createElement('span');
    span.textContent = l;
    dom.resAxis.appendChild(span);
  });
}