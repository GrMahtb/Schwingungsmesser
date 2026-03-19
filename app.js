'use strict';

/* ═════════════════════════════════════════════=
   CONFIG
   Hinweis: Mit RAF ~60 Hz ist Nyquist ~30 Hz.
   Realistische Baustellen-Schwingungen: ca. 1..25 Hz (typisch).
══════════════════════════════════════════════ */
const WINDOW_LEN = 600;          // 10 s @ ~60 Hz
const MAX_REC    = 36000;

const COLORS = { x:'#ff4444', y:'#00cc66', z:'#4499ff', t:'#ffed00' };

// Filterband (Baustelle) – wird dynamisch gegen fs/2 geclamped
const FREQ_MIN_HZ = 1.0;
const FREQ_MAX_HZ = 25.0;

// Gravity Lowpass (für iOS accIncludingGravity -> linear acc)
const GRAV_TAU_S  = 0.6;

// DIN 4150-2 Grenzen (mm/s)
const DIN_GUIDES = [0.3, 1.0, 3.0, 10.0];

// Event-Schwelle / Peak / RMS auf Velocity-Total (mm/s)
const EVT_THR = 0.1;

/* ═════════════════════════════════════════════=
   STATE
══════════════════════════════════════════════ */
let running = false;
let startTime = null;
let durTimer = null;
let rafId = null;

let savedData = null;
let rec = null;

let activeUnit = 'vel'; // 'vel' | 'acc' | 'disp' | 'freq'
let noDataTimer = null;
let motionEventCount = 0;

// Sensor-Rohdaten
let accX=0, accY=0, accZ=0, hasAcc=false;
let igX=0, igY=0, igZ=0; // accelerationIncludingGravity
let gyrX=0, gyrY=0, gyrZ=0; // rotationRate (deg/s) optional

// Sampling estimate
let fsEst = 60;

// Live ring buffer (Werte im jeweils aktiven Modus; bei freq = Hz)
const buf = {
  x: new Float32Array(WINDOW_LEN),
  y: new Float32Array(WINDOW_LEN),
  z: new Float32Array(WINDOW_LEN),
  t: new Float32Array(WINDOW_LEN),
  ptr: 0, len: 0
};

// Integrator state (m/s, m)
const intg = { vx:0, vy:0, vz:0, px:0, py:0, pz:0, prev:null };

// Filter state
const filt = {
  gX:0, gY:0, gZ:0,              // gravity estimate (m/s²)
  hpX:0, hpY:0, hpZ:0,
  prevX:0, prevY:0, prevZ:0,      // previous linear acc (for HP)
  lpX:0, lpY:0, lpZ:0             // lowpass output (bandpass end)
};

// Stats (immer auf vel total mm/s)
let peakTotal = 0, rmsAcc = 0, rmsCnt = 0, evtCount = 0;

// Sichtbarkeit
const vis = { x:true, y:true, z:true, t:true };

/* ═════════════════════════════════════════════=
   iOS / Standalone
══════════════════════════════════════════════ */
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent);
const IS_STANDALONE =
  window.matchMedia('(display-mode: standalone)').matches ||
  navigator.standalone === true;

/* ═════════════════════════════════════════════=
   DOM
══════════════════════════════════════════════ */
const $ = (id) => document.getElementById(id);

const dom = {
  statusBar:     $('statusBar'),
  mainNum:       $('mainNum'),
  mainSub:       $('mainSub'),
  xVal:          $('xVal'),
  yVal:          $('yVal'),
  zVal:          $('zVal'),
  tVal:          $('tVal'),
  peakVal:       $('peakVal'),
  rmsVal:        $('rmsVal'),
  evtVal:        $('evtVal'),
  durVal:        $('durVal'),
  debugPanel:    $('debugPanel'),
  liveChart:     $('liveChart'),
  liveAxis:      $('liveAxis'),
  resultChart:   $('resultChart'),
  resAxis:       $('resAxis'),
  resMeta:       $('resMeta'),
  dinNote:       $('dinNote'),
  results:       $('results'),
  startBtn:      $('startBtn'),
  resetBtn:      $('resetBtn'),
  iosPermBtn:    $('iosPermBtn'),
  installBanner: $('installBanner'),
  installBtn:    $('installBtn'),
};

const liveCtx = dom.liveChart.getContext('2d');
const resCtx  = dom.resultChart.getContext('2d');

/* ═════════════════════════════════════════════=
   ERROR -> StatusBar
══════════════════════════════════════════════ */
window.addEventListener('error', (e) => {
  if (!dom.statusBar) return;
  dom.statusBar.hidden = false;
  dom.statusBar.className = 'statusBar is-error';
  dom.statusBar.textContent = `JS Fehler: ${e.message} (Zeile ${e.lineno})`;
});

/* ═════════════════════════════════════════════=
   HELPERS
══════════════════════════════════════════════ */
function unitLabel(mode = activeUnit) {
  if (mode === 'acc')  return 'm/s²';
  if (mode === 'disp') return 'mm';
  if (mode === 'freq') return 'Hz';
  return 'mm/s';
}

function axisMetaFromUnit(mode) {
  if (mode === 'acc')  return { ySymbol:'a', yUnit:'m/s²' };
  if (mode === 'disp') return { ySymbol:'s', yUnit:'mm' };
  if (mode === 'freq') return { ySymbol:'f', yUnit:'Hz' };
  return { ySymbol:'v', yUnit:'mm/s' };
}

function fmtTime(ms) {
  const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function setStatus(msg, cls) {
  dom.statusBar.textContent = msg;
  dom.statusBar.className   = 'statusBar' + (cls ? ' ' + cls : '');
  dom.statusBar.hidden      = !msg;
}

/* ═════════════════════════════════════════════=
   CANVAS RESIZE
══════════════════════════════════════════════ */
function resizeCanvas(cvs) {
  const dpr  = window.devicePixelRatio || 1;
  const rect = cvs.getBoundingClientRect();
  if (!rect.width) return;
  cvs.width  = Math.floor(rect.width  * dpr);
  cvs.height = Math.floor(rect.height * dpr);
  cvs.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}
function initCanvases() {
  resizeCanvas(dom.liveChart);
  resizeCanvas(dom.resultChart);
  drawLive();
  if (savedData) drawResult(savedData);
}
window.addEventListener('resize', initCanvases);
setTimeout(initCanvases, 150);

/* ═════════════════════════════════════════════=
   TABS
══════════════════════════════════════════════ */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b =>
      b.classList.toggle('is-active', b === btn));
    document.querySelectorAll('.pane').forEach(p => {
      const on = p.id === `tab-${btn.dataset.tab}`;
      p.classList.toggle('is-active', on);
      p.hidden = !on;
    });
    setTimeout(initCanvases, 60);
  });
});

/* ═════════════════════════════════════════════=
   UNIT SWITCH
══════════════════════════════════════════════ */
function updateUnitLabels() {
  const u = unitLabel(activeUnit);

  // X/Y/Z/Total Einheit
  ['unitX','unitY','unitZ','unitT'].forEach(id => {
    const el = $(id); if (el) el.textContent = u;
  });

  // Peak/RMS bleiben immer mm/s (DIN basiert darauf)
  const up = $('unitPeak'); if (up) up.textContent = 'mm/s';
  const ur = $('unitRms');  if (ur) ur.textContent = 'mm/s';

  // Untertitel sofort passend setzen (auch wenn nicht gemessen wird)
  dom.mainSub.textContent = `${u} (Total)`;
}
document.querySelectorAll('.unitBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeUnit = btn.dataset.unit;

    document.querySelectorAll('.unitBtn').forEach(b =>
      b.classList.toggle('is-active', b === btn));

    updateUnitLabels();

    // Charts sofort neu zeichnen → Achsenbeschriftung + Labels aktualisiert
    drawLive();
    if (savedData) drawResult(savedData);
  });
});

/* ═════════════════════════════════════════════=
   AXIS TOGGLES
══════════════════════════════════════════════ */
function applyToggle(s, on) {
  vis[s] = on;
  document.querySelectorAll(`[data-series="${s}"]`).forEach(el =>
    el.classList.toggle('is-off', !on));
  dom.dinNote.hidden = vis.t;
}
document.querySelectorAll('.tile[data-series], .legendBtn[data-series]').forEach(btn => {
  btn.addEventListener('click', () =>
    applyToggle(btn.dataset.series, !vis[btn.dataset.series]));
});

/* ═════════════════════════════════════════════=
   DIN 4150-2 Highlight
══════════════════════════════════════════════ */
const dinRows   = ['n0','n1','n2','n3','n4'];
const dinBounds = [0, 0.3, 1.0, 3.0, 10.0];
function updateDIN(vMms) {
  let row = 0;
  for (let i = dinBounds.length - 1; i >= 0; i--) {
    if (vMms >= dinBounds[i]) { row = i; break; }
  }
  dinRows.forEach((id, i) => $(id).classList.toggle('is-active', i === row));
}

/* ═════════════════════════════════════════════=
   FILTER CHAIN
   - linear acc: use e.acceleration if available, else ig - gravityLPF
   - bandpass: HP(FREQ_MIN) then LP(FREQ_MAX)
══════════════════════════════════════════════ */
function clampBand(fcMin, fcMax, fs) {
  // Nyquist margin
  const nyq = Math.max(1, fs / 2);
  const hi = Math.min(fcMax, nyq * 0.85);
  const lo = Math.max(0.2, Math.min(fcMin, hi * 0.8));
  return { lo, hi };
}

function updateFs(dt) {
  if (!dt || dt <= 0) return;
  const f = 1 / dt;
  // smooth
  fsEst = 0.9 * fsEst + 0.1 * f;
}

function filterLinearAcc(igAx, igAy, igAz, linAxMaybe, linAyMaybe, linAzMaybe, dt) {
  // gravity estimate always from includingGravity
  const aG = dt / (GRAV_TAU_S + dt);
  filt.gX += aG * (igAx - filt.gX);
  filt.gY += aG * (igAy - filt.gY);
  filt.gZ += aG * (igAz - filt.gZ);

  // linear acceleration source
  let lx, ly, lz;
  if (hasAcc) {
    lx = linAxMaybe; ly = linAyMaybe; lz = linAzMaybe;
  } else {
    lx = igAx - filt.gX;
    ly = igAy - filt.gY;
    lz = igAz - filt.gZ;
  }

  // band edges
  const { lo, hi } = clampBand(FREQ_MIN_HZ, FREQ_MAX_HZ, fsEst);

  // First-order HP coefficients
  const tauHP = 1 / (2 * Math.PI * lo);
  const aHP = tauHP / (tauHP + dt);

  // HP
  filt.hpX = aHP * (filt.hpX + lx - filt.prevX);
  filt.hpY = aHP * (filt.hpY + ly - filt.prevY);
  filt.hpZ = aHP * (filt.hpZ + lz - filt.prevZ);
  filt.prevX = lx; filt.prevY = ly; filt.prevZ = lz;

  // First-order LP coefficients
  const tauLP = 1 / (2 * Math.PI * hi);
  const aLP = dt / (tauLP + dt);

  filt.lpX = filt.lpX + aLP * (filt.hpX - filt.lpX);
  filt.lpY = filt.lpY + aLP * (filt.hpY - filt.lpY);
  filt.lpZ = filt.lpZ + aLP * (filt.hpZ - filt.lpZ);

  return { ax: filt.lpX, ay: filt.lpY, az: filt.lpZ };
}

/* ═════════════════════════════════════════════=
   FREQUENCY ESTIMATION (dominant) via autocorr
══════════════════════════════════════════════ */
const FREQ_BUF = 256;
const sig = {
  x: new Float32Array(FREQ_BUF),
  y: new Float32Array(FREQ_BUF),
  z: new Float32Array(FREQ_BUF),
  t: new Float32Array(FREQ_BUF),
  ptr: 0,
  len: 0
};

let lastFreqUpdate = 0;
let fX = 0, fY = 0, fZ = 0, fT = 0;

function pushSig(ax, ay, az) {
  const t = Math.sqrt(ax*ax + ay*ay + az*az);
  sig.x[sig.ptr] = ax;
  sig.y[sig.ptr] = ay;
  sig.z[sig.ptr] = az;
  sig.t[sig.ptr] = t;
  sig.ptr = (sig.ptr + 1) % FREQ_BUF;
  if (sig.len < FREQ_BUF) sig.len++;
}

function readSigSeries(arr) {
  const out = new Float32Array(sig.len);
  for (let i = 0; i < sig.len; i++) {
    const idx = (sig.ptr - sig.len + i + FREQ_BUF) % FREQ_BUF;
    out[i] = arr[idx];
  }
  return out;
}

function dominantFreqAutocorr(series, fs, fmin, fmax) {
  const n = series.length;
  if (n < 32 || fs <= 0) return 0;

  // remove mean
  let mean = 0;
  for (let i = 0; i < n; i++) mean += series[i];
  mean /= n;

  const minLag = Math.max(2, Math.floor(fs / fmax));
  const maxLag = Math.min(n - 2, Math.floor(fs / fmin));
  if (maxLag <= minLag) return 0;

  let bestLag = 0;
  let bestVal = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) {
      const a = series[i] - mean;
      const b = series[i + lag] - mean;
      sum += a * b;
    }
    if (sum > bestVal) {
      bestVal = sum;
      bestLag = lag;
    }
  }
  if (bestLag <= 0) return 0;
  return fs / bestLag;
}

/* ═════════════════════════════════════════════=
   CHART HELPERS: labels + DIN lines (subtle)
══════════════════════════════════════════════ */
function drawAxisLabels(ctx, W, H, mode) {
  const { ySymbol, yUnit } = axisMetaFromUnit(mode);

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.50)';
  ctx.font = '11px system-ui, Arial, sans-serif';

  // x label
  ctx.fillText('t [s]', W - 38, H - 6);

  // y label rotated
  ctx.translate(13, H / 2 + 28);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(`${ySymbol} [${yUnit}]`, 0, 0);

  ctx.restore();
}

function drawDinGuides(ctx, W, H, yMin, yMax, mode) {
  if (mode !== 'vel') return;
  if (yMax <= yMin) return;

  const yOf = (v) => H - ((v - yMin) / (yMax - yMin)) * H;

  ctx.save();
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,237,0,0.18)';

  for (const g of DIN_GUIDES) {
    if (g >= yMin && g <= yMax) {
      const y = yOf(g);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    const ng = -g;
    if (ng >= yMin && ng <= yMax) {
      const y = yOf(ng);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }
  ctx.restore();
}

/* ═════════════════════════════════════════════=
   LIVE CHART
══════════════════════════════════════════════ */
function liveTitleFor(mode, axisName) {
  if (mode === 'acc')  return `Lineare Beschleunigung ${axisName}`;
  if (mode === 'disp') return `Verschiebung ${axisName}`;
  if (mode === 'freq') return `Frequenz ${axisName}`;
  return `Geschwindigkeit ${axisName}`; // vel
}

function unitTextFor(mode) {
  if (mode === 'acc')  return 'a (m/s²)';
  if (mode === 'disp') return 's (mm)';
  if (mode === 'freq') return 'f (Hz)';
  return 'v (mm/s)';
}

function readBuf(arr, i) {
  const idx = (buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN;
  return arr[idx];
}

function drawPanel({ ctx, x, y, w, h, seriesArr, color, title, mode }) {
  // Rahmen + Hintergrund
  ctx.save();
  ctx.fillStyle = '#151516';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);

  // Min/Max (pro Panel separat)
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < buf.len; i++) {
    const v = readBuf(seriesArr, i);
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!isFinite(mn)) { mn = -1; mx = 1; }
  // Symmetrisch um 0 (wie Mess-Apps üblich)
  const a = Math.max(Math.abs(mn), Math.abs(mx)) || 1;
  const yMin = -a * 1.15;
  const yMax =  a * 1.15;

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.setLineDash([6, 8]);
  ctx.lineWidth = 1;

  // vertikale Gridlinien (6 Stück)
  for (let i = 1; i < 6; i++) {
    const gx = x + (i / 6) * w;
    ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); ctx.stroke();
  }
  // horizontale Gridlinien (4 Stück)
  for (let j = 1; j < 4; j++) {
    const gy = y + (j / 4) * h;
    ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); ctx.stroke();
  }

  // Null-Linie
  ctx.setLineDash([]);
  const y0 = y + h - ((0 - yMin) / (yMax - yMin)) * h;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x + w, y0); ctx.stroke();

  // DIN-Linien (unauffällig) nur in vel
  if (mode === 'vel') {
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(255,237,0,0.14)';
    for (const g of DIN_GUIDES) {
      const yg = y + h - ((g - yMin) / (yMax - yMin)) * h;
      if (yg >= y && yg <= y + h) {
        ctx.beginPath(); ctx.moveTo(x, yg); ctx.lineTo(x + w, yg); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Kurve
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 0; i < buf.len; i++) {
    const v = readBuf(seriesArr, i);
    const xp = x + (i / (WINDOW_LEN - 1)) * w;
    const yp = y + h - ((v - yMin) / (yMax - yMin)) * h;
    i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
  }
  ctx.stroke();

  // Titel + Achsentexte
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = '14px system-ui, -apple-system, Segoe UI, Arial';
  ctx.textAlign = 'center';
  ctx.fillText(title, x + w / 2, y + 18);

  // y-Achse Text links
  ctx.save();
  ctx.translate(x + 12, y + h / 2 + 30);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.70)';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial';
  ctx.fillText(unitTextFor(mode), 0, 0);
  ctx.restore();

  // x-Achse Text unten
  ctx.textAlign = 'center';
  ctx.fillText('t (s)', x + w / 2, y + h - 8);

  ctx.restore();
}
function drawLive() {
  const cvs = dom.liveChart;
  const ctx = liveCtx;

  const W = cvs.getBoundingClientRect().width  || 300;
  const H = cvs.getBoundingClientRect().height || 560;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  // Layout: 3 Panels
  const pad = 14;
  const gap = 18;
  const panelH = (H - pad * 2 - gap * 2) / 3;
  const x = pad;
  const w = W - pad * 2;

  const mode = activeUnit; // acc/vel/disp/freq

  // Farben wie im Screenshot: X grün, Y blau, Z gelb (optional)
  const cX = '#32ff6a';
  const cY = '#4aa6ff';
  const cZ = '#ffe95a';

  // Wenn noch keine Daten: trotzdem 3 leere Frames mit Labels
  const lenBackup = buf.len;
  if (buf.len < 2) {
    buf.len = 2; // damit drawPanel nicht leer läuft
  }

  drawPanel({
    ctx, x, y: pad + 0 * (panelH + gap), w, h: panelH,
    seriesArr: buf.x, color: cX,
    title: liveTitleFor(mode, 'x'), mode
  });

  drawPanel({
    ctx, x, y: pad + 1 * (panelH + gap), w, h: panelH,
    seriesArr: buf.y, color: cY,
    title: liveTitleFor(mode, 'y'), mode
  });

  drawPanel({
    ctx, x, y: pad + 2 * (panelH + gap), w, h: panelH,
    seriesArr: buf.z, color: cZ,
    title: liveTitleFor(mode, 'z'), mode
  });

  // buf.len wiederherstellen (falls wir es oben temporär geändert haben)
  buf.len = lenBackup;

  // HTML-Achse unterhalb (optional – kann bleiben)
  if (dom.liveAxis) {
    dom.liveAxis.innerHTML =
      ['-10s','-8s','-6s','-4s','-2s','0s'].map(t => `<span>${t}</span>`).join('');
  }
}

  drawAxisLabels(ctx, W, H, activeUnit);

  dom.liveAxis.innerHTML =
    ['-10s','-8s','-6s','-4s','-2s','0s'].map(t => `<span>${t}</span>`).join('');
}

/* ═════════════════════════════════════════════=
   RESULT CHART
══════════════════════════════════════════════ */
function drawResult(data) {
  const cvs = dom.resultChart;
  const ctx = resCtx;
  const W = cvs.getBoundingClientRect().width  || 300;
  const H = cvs.getBoundingClientRect().height || 220;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  const unitMode = data.unit || activeUnit;

  let mn = Infinity, mx = -Infinity;
  ['x','y','z','t'].forEach(s => {
    data[s].forEach(v => { if (v < mn) mn = v; if (v > mx) mx = v; });
  });
  if (!isFinite(mn)) { mn = -1; mx = 1; }
  const rng  = (mx - mn) || 1;
  const yMin = mn - rng*0.12;
  const yMax = mx + rng*0.12;

  drawDinGuides(ctx, W, H, yMin, yMax, unitMode);

  const y0 = H - ((0 - yMin) / (yMax - yMin)) * H;
  ctx.strokeStyle = '#2a2a2d';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();

  ['x','y','z','t'].forEach(s => {
    ctx.strokeStyle = COLORS[s];
    ctx.lineWidth   = (s === 't') ? 2.5 : 1.5;
    ctx.beginPath();
    data[s].forEach((v, i) => {
      const xp = (i / (data[s].length - 1)) * W;
      const yp = H - ((v - yMin) / (yMax - yMin)) * H;
      i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
    });
    ctx.stroke();
  });

  drawAxisLabels(ctx, W, H, unitMode);

  dom.resAxis.innerHTML = '<span>Anfang</span><span>Ende</span>';
}
/* ══════════════════════════════════════════════
   SENSOR EVENTS
══════════════════════════════════════════════ */
function onMotion(e) {
  motionEventCount++;

  // accelerationIncludingGravity (immer verfügbar)
  const ig = e.accelerationIncludingGravity;
  if (ig && ig.x != null) {
    igX = Number(ig.x) || 0;
    igY = Number(ig.y) || 0;
    igZ = Number(ig.z) || 0;
  }

  // linear acceleration (ohne Gravitation, wo verfügbar)
  const a = e.acceleration;
  if (a && a.x != null && a.y != null && a.z != null) {
    accX   = Number(a.x) || 0;
    accY   = Number(a.y) || 0;
    accZ   = Number(a.z) || 0;
    hasAcc = true;
  } else {
    hasAcc = false;
  }

  // Gyroskop (optional, für spätere Fusion)
  const r = e.rotationRate;
  if (r && r.alpha != null) {
    gyrX = Number(r.alpha) || 0;
    gyrY = Number(r.beta)  || 0;
    gyrZ = Number(r.gamma) || 0;
  }
}
window.addEventListener('devicemotion', onMotion, { passive: true });

/* ══════════════════════════════════════════════
   RESET
══════════════════════════════════════════════ */
function resetState() {
  running = false;
  if (rafId)       { cancelAnimationFrame(rafId); rafId = null; }
  if (durTimer)    { clearInterval(durTimer);      durTimer = null; }
  if (noDataTimer) { clearTimeout(noDataTimer);    noDataTimer = null; }

  startTime = null;
  evtCount = 0; peakTotal = 0;
  rmsAcc = 0; rmsCnt = 0;
  motionEventCount = 0;
  fsEst = 60;
  lastFreqUpdate = 0;
  fX = fY = fZ = fT = 0;

  buf.ptr = 0; buf.len = 0;
  buf.x.fill(0); buf.y.fill(0); buf.z.fill(0); buf.t.fill(0);

  sig.ptr = 0; sig.len = 0;
  sig.x.fill(0); sig.y.fill(0); sig.z.fill(0); sig.t.fill(0);

  intg.vx = intg.vy = intg.vz = 0;
  intg.px = intg.py = intg.pz = 0;
  intg.prev = null;

  filt.gX = filt.gY = filt.gZ = 0;
  filt.hpX = filt.hpY = filt.hpZ = 0;
  filt.prevX = filt.prevY = filt.prevZ = 0;
  filt.lpX = filt.lpY = filt.lpZ = 0;

  igX = igY = igZ = 0;
  accX = accY = accZ = 0;
  gyrX = gyrY = gyrZ = 0;
  hasAcc = false;

  rec = null; savedData = null;

  dom.startBtn.textContent = 'Start';
  dom.startBtn.classList.add('btn--accent');
  dom.startBtn.classList.remove('btn--stop');

  dom.mainNum.textContent    = '0.00';
  dom.mainSub.textContent    = `${unitLabel()} (Total)`;
  dom.xVal.textContent       = '0.00';
  dom.yVal.textContent       = '0.00';
  dom.zVal.textContent       = '0.00';
  dom.tVal.textContent       = '0.00';
  dom.peakVal.textContent    = '0.00';
  dom.rmsVal.textContent     = '0.00';
  dom.evtVal.textContent     = '0';
  dom.durVal.textContent     = '00:00';
  dom.results.hidden         = true;
  dom.resMeta.textContent    = '—';
  dom.debugPanel.textContent = 'Warte auf Sensor-Daten …';

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = false);
  dinRows.forEach(id => $(id).classList.remove('is-active'));
  setStatus('', '');
  drawLive();
}

/* ══════════════════════════════════════════════
   START
══════════════════════════════════════════════ */
function startMeasurement() {
  if (running) return;
  resetState();

  running          = true;
  startTime        = Date.now();
  motionEventCount = 0;

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = true);

  rec = {
    unit: activeUnit,
    t0: performance.now(),
    startTs: startTime,
    x: [], y: [], z: [], t: [],
    velTotal: []
  };

  dom.startBtn.textContent = 'Stop';
  dom.startBtn.classList.remove('btn--accent');
  dom.startBtn.classList.add('btn--stop');
  setStatus('MESSUNG LÄUFT …', 'is-running');

  durTimer = setInterval(() => {
    dom.durVal.textContent = fmtTime(Date.now() - startTime);
  }, 250);

  noDataTimer = setTimeout(() => {
    if (motionEventCount === 0)
      setStatus('Keine Sensor-Daten. iPhone: Sensorerlaubnis nötig.', 'is-error');
  }, 2000);

  rafId = requestAnimationFrame(loop);
}

/* ══════════════════════════════════════════════
   STOP
══════════════════════════════════════════════ */
function stopMeasurement() {
  if (!running) return;
  running = false;

  if (rafId)       { cancelAnimationFrame(rafId); rafId = null; }
  if (durTimer)    { clearInterval(durTimer);      durTimer = null; }
  if (noDataTimer) { clearTimeout(noDataTimer);    noDataTimer = null; }

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = false);

  dom.startBtn.textContent = 'Start';
  dom.startBtn.classList.add('btn--accent');
  dom.startBtn.classList.remove('btn--stop');
  setStatus('Messung abgeschlossen ✓', 'is-done');

  if (rec && rec.t.length > 5) {
    savedData = {
      unit: rec.unit,
      startTs: rec.startTs,
      durationSec: (performance.now() - rec.t0) / 1000,
      x: rec.x.slice(), y: rec.y.slice(),
      z: rec.z.slice(), t: rec.t.slice()
    };
    dom.results.hidden      = false;
    dom.resMeta.textContent =
      `${new Date(savedData.startTs).toLocaleString('de-DE')} · ` +
      `Dauer: ${savedData.durationSec.toFixed(1)} s · ` +
      `Punkte: ${savedData.t.length}`;
    setTimeout(() => {
      resizeCanvas(dom.resultChart);
      drawResult(savedData);
    }, 80);
  }
  rec = null;
}

/* ══════════════════════════════════════════════
   START BUTTON (iOS Permission inline)
══════════════════════════════════════════════ */
dom.startBtn.addEventListener('click', async () => {
  try {
    if (IS_IOS &&
        typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      const res = await DeviceMotionEvent.requestPermission();
      if (res !== 'granted') {
        setStatus('iPhone: Sensorerlaubnis verweigert.', 'is-error');
        return;
      }
    }
    running ? stopMeasurement() : startMeasurement();
  } catch (err) {
    setStatus('Fehler: ' + err.message, 'is-error');
  }
});

dom.resetBtn.addEventListener('click', () => resetState());

/* ══════════════════════════════════════════════
   LOOP
══════════════════════════════════════════════ */
function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  const now = performance.now();
  const dt  = Math.min((now - (intg.prev ?? now)) / 1000, 0.05);
  intg.prev = now;

  if (dt > 0) updateFs(dt);

  // --- Filter-Kette ---
  const { ax, ay, az } = filterLinearAcc(
    igX, igY, igZ,
    accX, accY, accZ,
    dt
  );

  // --- Integration: Velocity (m/s) ---
  const LEAK_V = 0.985, LEAK_P = 0.995;
  intg.vx = (intg.vx + ax * dt) * LEAK_V;
  intg.vy = (intg.vy + ay * dt) * LEAK_V;
  intg.vz = (intg.vz + az * dt) * LEAK_V;

  // --- Integration: Displacement (m) ---
  intg.px = (intg.px + intg.vx * dt) * LEAK_P;
  intg.py = (intg.py + intg.vy * dt) * LEAK_P;
  intg.pz = (intg.pz + intg.vz * dt) * LEAK_P;

  // --- Velocity total (mm/s) – immer für Statistik ---
  const velTotal = Math.sqrt(
    intg.vx*intg.vx + intg.vy*intg.vy + intg.vz*intg.vz
  ) * 1000;

  // --- Frequenzschätzung ---
  pushSig(ax, ay, az);
  if (now - lastFreqUpdate > 500 && sig.len >= 64) {
    lastFreqUpdate = now;
    const flo = FREQ_MIN_HZ, fhi = Math.min(FREQ_MAX_HZ, fsEst / 2 * 0.85);
    fX = dominantFreqAutocorr(readSigSeries(sig.x), fsEst, flo, fhi);
    fY = dominantFreqAutocorr(readSigSeries(sig.y), fsEst, flo, fhi);
    fZ = dominantFreqAutocorr(readSigSeries(sig.z), fsEst, flo, fhi);
    fT = dominantFreqAutocorr(readSigSeries(sig.t), fsEst, flo, fhi);
  }

  // --- Werte je Einheit ---
  let vx, vy, vz, vt;

  if (activeUnit === 'acc') {
    vx = ax; vy = ay; vz = az;
    vt = Math.sqrt(ax*ax + ay*ay + az*az);
  } else if (activeUnit === 'disp') {
    vx = intg.px*1000; vy = intg.py*1000; vz = intg.pz*1000;
    vt = Math.sqrt(vx*vx + vy*vy + vz*vz);
  } else if (activeUnit === 'freq') {
    vx = fX; vy = fY; vz = fZ; vt = fT;
  } else {
    // vel (mm/s) – default
    vx = intg.vx*1000; vy = intg.vy*1000; vz = intg.vz*1000;
    vt = velTotal;
  }

  // --- Ring Buffer ---
  buf.x[buf.ptr] = vx; buf.y[buf.ptr] = vy;
  buf.z[buf.ptr] = vz; buf.t[buf.ptr] = vt;
  buf.ptr = (buf.ptr + 1) % WINDOW_LEN;
  if (buf.len < WINDOW_LEN) buf.len++;

  // --- Statistik (immer vel mm/s) ---
  if (velTotal > peakTotal) peakTotal = velTotal;
  rmsAcc += velTotal * velTotal; rmsCnt++;
  if (velTotal > EVT_THR) evtCount++;

  // --- UI Tiles ---
  const decimals = (activeUnit === 'freq') ? 1 : 2;
  dom.xVal.textContent    = vx.toFixed(decimals);
  dom.yVal.textContent    = vy.toFixed(decimals);
  dom.zVal.textContent    = vz.toFixed(decimals);
  dom.tVal.textContent    = vt.toFixed(decimals);
  dom.peakVal.textContent = peakTotal.toFixed(2);
  dom.rmsVal.textContent  = rmsCnt
    ? Math.sqrt(rmsAcc / rmsCnt).toFixed(2)
    : '0.00';
  dom.evtVal.textContent  = evtCount;

  // --- Haupt-Anzeige ---
  const u = unitLabel(activeUnit);
  let main = vt, sub = `${u} (Total)`;
  if (!vis.t) {
    const cand = [];
    if (vis.x) cand.push({ k:'X', v:Math.abs(vx) });
    if (vis.y) cand.push({ k:'Y', v:Math.abs(vy) });
    if (vis.z) cand.push({ k:'Z', v:Math.abs(vz) });
    if (cand.length) {
      cand.sort((a,b) => b.v - a.v);
      main = cand[0].v; sub = `${u} (${cand[0].k})`;
    } else { main = 0; sub = `${u} (–)`; }
  }
  dom.mainNum.textContent = main.toFixed(decimals);
  dom.mainSub.textContent = sub;

  // --- DIN (nur vel) ---
  if (activeUnit === 'vel') updateDIN(velTotal);

  drawLive();

  // --- Debug ---
  const { lo, hi } = clampBand(FREQ_MIN_HZ, FREQ_MAX_HZ, fsEst);
  dom.debugPanel.textContent =
    `ig  ax=${igX.toFixed(3)} ay=${igY.toFixed(3)} az=${igZ.toFixed(3)} m/s²\n` +
    `lin ax=${ax.toFixed(3)} ay=${ay.toFixed(3)} az=${az.toFixed(3)} m/s²\n` +
    `vel x=${(intg.vx*1000).toFixed(2)} y=${(intg.vy*1000).toFixed(2)} z=${(intg.vz*1000).toFixed(2)} mm/s\n` +
    `velTotal=${velTotal.toFixed(2)} mm/s | Peak=${peakTotal.toFixed(2)} mm/s\n` +
    `freq X=${fX.toFixed(1)} Y=${fY.toFixed(1)} Z=${fZ.toFixed(1)} T=${fT.toFixed(1)} Hz\n` +
    `fs≈${fsEst.toFixed(1)} Hz | Band: ${lo.toFixed(1)}–${hi.toFixed(1)} Hz\n` +
    `Events=${evtCount} | dt=${(dt*1000).toFixed(1)} ms | unit=${activeUnit}`;

  // --- Recording ---
  if (rec && rec.t.length < MAX_REC) {
    rec.x.push(vx); rec.y.push(vy);
    rec.z.push(vz); rec.t.push(vt);
    rec.velTotal.push(velTotal);
  }
}

/* ══════════════════════════════════════════════
   CSV EXPORT
══════════════════════════════════════════════ */
function exportCSV() {
  if (!savedData) return;
  const u  = unitLabel(savedData.unit);
  const n  = savedData.t.length;
  const dt = savedData.durationSec / Math.max(1, n - 1);

  let csv = `# HTB Schwingungsmesser Export\n`;
  csv += `# Start: ${new Date(savedData.startTs).toLocaleString('de-DE')}\n`;
  csv += `# Dauer: ${savedData.durationSec.toFixed(2)} s\n`;
  csv += `# Einheit: ${u} | Bandpass: ${FREQ_MIN_HZ}–${FREQ_MAX_HZ} Hz\n#\n`;
  csv += `i;time_s;x_${u};y_${u};z_${u};total_${u}\n`;

  for (let i = 0; i < n; i++) {
    csv += `${i};${(i*dt).toFixed(4)};` +
           `${savedData.x[i].toFixed(6)};${savedData.y[i].toFixed(6)};` +
           `${savedData.z[i].toFixed(6)};${savedData.t[i].toFixed(6)}\n`;
  }

  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download =
    `HTB_Messung_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
$('csvBtn').addEventListener('click', exportCSV);

/* ══════════════════════════════════════════════
   PDF EXPORT
══════════════════════════════════════════════ */
function plotToDataURL({ series, title, unit, color, durationSec, unitMode }) {
  const W = 1200, H = 280;
  const mL = 72, mR = 18, mT = 34, mB = 50;
  const pw = W - mL - mR, ph = H - mT - mB;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // Gitternetz
  ctx.strokeStyle = '#ececec'; ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const x = mL + (i/10)*pw;
    ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT+ph); ctx.stroke();
  }
  for (let j = 0; j <= 6; j++) {
    const y = mT + (j/6)*ph;
    ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL+pw, y); ctx.stroke();
  }

  // Min/Max
  let mn = Infinity, mx = -Infinity;
  for (const v of series) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!isFinite(mn) || !isFinite(mx)) { mn = -1; mx = 1; }
  if (mn === mx) { mn -= 1; mx += 1; }
  const pad = (mx - mn) * 0.1;
  mn -= pad; mx += pad;
  const yOf = (v) => mT + ph - ((v - mn) / (mx - mn)) * ph;

  // DIN-Linien im PDF (nur vel)
  if (unitMode === 'vel') {
    ctx.save();
    ctx.setLineDash([5, 6]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(160,130,0,0.4)';
    ctx.fillStyle = '#999';
    ctx.font = '10px Arial';
    for (const g of DIN_GUIDES) {
      if (g >= mn && g <= mx) {
        const y = yOf(g);
        ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL+pw, y); ctx.stroke();
        ctx.fillText(`${g} mm/s`, mL+pw+3, y+4);
      }
      const ng = -g;
      if (ng >= mn && ng <= mx) {
        const y = yOf(ng);
        ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL+pw, y); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Achsen
  ctx.setLineDash([]);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(mL, mT); ctx.lineTo(mL, mT+ph); ctx.lineTo(mL+pw, mT+ph);
  ctx.stroke();

  // Titel
  ctx.fillStyle = color; ctx.font = 'bold 15px Arial';
  ctx.fillText(title, mL, 22);

  // Y-Label (rotiert)
  ctx.save();
  ctx.fillStyle = '#333'; ctx.font = '12px Arial';
  ctx.translate(14, mT + ph/2 + 20);
  ctx.rotate(-Math.PI/2);
  ctx.fillText(unit, 0, 0);
  ctx.restore();

  // Y-Ticks
  ctx.fillStyle = '#333'; ctx.font = '11px Arial';
  for (let j = 0; j <= 6; j++) {
    const vv = mn + (j/6)*(mx-mn);
    ctx.fillText(vv.toFixed(2), 4, yOf(vv)+4);
  }

  // X-Ticks
  for (let i = 0; i <= 5; i++) {
    const t = durationSec*(i/5);
    const x = mL + (i/5)*pw;
    ctx.fillText(t.toFixed(1), x-8, H-22);
  }
  ctx.fillStyle = '#333'; ctx.font = '12px Arial';
  ctx.fillText('t [s]', mL+pw-28, H-8);

  // Messlinie
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath();
  const n = series.length;
  for (let i = 0; i < n; i++) {
    const x = mL + (i/(n-1))*pw;
    const y = yOf(series[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  return c.toDataURL('image/png', 1.0);
}

function exportPDF() {
  if (!savedData) {
    setStatus('Keine Messdaten – erst messen!', 'is-error');
    return;
  }

  const unit     = unitLabel(savedData.unit);
  const unitMode = savedData.unit || 'vel';
  const dur      = savedData.durationSec;

  const imgX = plotToDataURL({ series:savedData.x, title:'X-Achse', unit, color:'#ff4444', durationSec:dur, unitMode });
  const imgY = plotToDataURL({ series:savedData.y, title:'Y-Achse', unit, color:'#00cc66', durationSec:dur, unitMode });
  const imgZ = plotToDataURL({ series:savedData.z, title:'Z-Achse', unit, color:'#4499ff', durationSec:dur, unitMode });

  const w = window.open('', '_blank');
  if (!w) { setStatus('Popup blockiert – bitte erlauben!', 'is-error'); return; }

  w.document.open();
  w.document.write(`<!doctype html><html><head>
<meta charset="utf-8"/>
<title>HTB Schwingungsmesser</title>
<style>
  @page { size:A4 portrait; margin:10mm; }
  body  { font-family:Arial,sans-serif; background:#fff; color:#111;
          margin:0; padding:10mm; }
  h1    { font-size:15px; margin:0 0 5px; }
  .meta { font-size:10px; color:#444; line-height:1.6; margin-bottom:10px;
          border-bottom:1px solid #ddd; padding-bottom:6px; }
  .plot { margin:8px 0; page-break-inside:avoid; }
  .plot img { width:100%; border:1px solid #ddd; }
</style>
</head><body>
<h1>HTB Schwingungsmesser – Messbericht</h1>
<div class="meta">
  <b>Start:</b> ${new Date(savedData.startTs).toLocaleString('de-DE')} &nbsp;·&nbsp;
  <b>Dauer:</b> ${dur.toFixed(1)} s &nbsp;·&nbsp;
  <b>Einheit:</b> ${unit} &nbsp;·&nbsp;
  <b>Punkte:</b> ${savedData.t.length}<br/>
  <b>Bandpass:</b> ${FREQ_MIN_HZ}–${FREQ_MAX_HZ} Hz (baustellentypisch) &nbsp;·&nbsp;
  Gravity-Kompensation aktiv<br/>
  Smartphone-Sensoren nicht kalibriert – Werte zur Orientierung.
  ${unitMode === 'vel'
    ? '<br/><b>Gestrichelte Linien:</b> DIN 4150-2 Grenzwerte (0.3 / 1.0 / 3.0 / 10.0 mm/s)'
    : ''}
</div>
<div class="plot"><img src="${imgX}" alt="X-Achse"></div>
<div class="plot"><img src="${imgY}" alt="Y-Achse"></div>
<div class="plot"><img src="${imgZ}" alt="Z-Achse"></div>
<script>setTimeout(()=>window.print(),250);<\/script>
</body></html>`);
  w.document.close();
}
$('pdfBtn').addEventListener('click', exportPDF);

/* ══════════════════════════════════════════════
   iOS SENSOR ERLAUBNIS
══════════════════════════════════════════════ */
if (IS_IOS &&
    typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function') {
  dom.iosPermBtn.hidden = false;
  dom.iosPermBtn.addEventListener('click', async () => {
    try {
      const res = await DeviceMotionEvent.requestPermission();
      if (res === 'granted') {
        dom.iosPermBtn.hidden = true;
        setStatus('Sensorerlaubnis erteilt – drücke Start.', 'is-done');
      } else {
        setStatus('Sensorerlaubnis verweigert!', 'is-error');
      }
    } catch (err) {
      setStatus('Fehler: ' + err.message, 'is-error');
    }
  });
}

/* ══════════════════════════════════════════════
   PWA INSTALL
══════════════════════════════════════════════ */
(() => {
  let deferredPrompt = null;

  if (IS_STANDALONE) {
    dom.installBanner.hidden = true;
    return;
  }

  if (IS_IOS) {
    dom.installBanner.hidden = false;
    dom.installBtn.textContent = 'Anleitung';
    dom.installBtn.onclick = () =>
      setStatus('iPhone: Safari → Teilen (□↑) → „Zum Home-Bildschirm"', 'is-error');
    return;
  }

  dom.installBanner.hidden = true;
  dom.installBtn.disabled  = true;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    dom.installBanner.hidden = false;
    dom.installBtn.disabled  = false;
  });

  dom.installBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!deferredPrompt) {
      setStatus('Chrome-Menü (⋮) → „App installieren"', 'is-error');
      return;
    }
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt           = null;
    dom.installBanner.hidden = true;
    dom.installBtn.disabled  = true;
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt           = null;
    dom.installBanner.hidden = true;
    dom.installBtn.disabled  = true;
  });
})();

/* ══════════════════════════════════════════════
   SERVICE WORKER
══════════════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
updateUnitLabels();
applyToggle('x', true);
applyToggle('y', true);
applyToggle('z', true);
applyToggle('t', true);
resetState();
