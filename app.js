'use strict';

/* ══════════════════════════════════════════════
   KONFIGURATION
══════════════════════════════════════════════ */
const WINDOW_LEN  = 600;       // 10 s @ ~60 Hz
const MAX_REC     = 36000;
const COLORS      = { x:'#32ff6a', y:'#4aa6ff', z:'#ffe95a', t:'#ffed00' };
const FREQ_MIN_HZ = 1.0;
const FREQ_MAX_HZ = 25.0;
const GRAV_TAU_S  = 0.6;
const DIN_GUIDES  = [0.3, 1.0, 3.0, 10.0];
const EVT_THR     = 0.1;       // mm/s Event-Schwelle

/* ══════════════════════════════════════════════
   RING BUFFER HELPERS (4 parallele Verläufe)
══════════════════════════════════════════════ */
function makeRing() {
  return {
    x: new Float32Array(WINDOW_LEN),
    y: new Float32Array(WINDOW_LEN),
    z: new Float32Array(WINDOW_LEN),
    t: new Float32Array(WINDOW_LEN),
    ptr: 0, len: 0
  };
}

function ringReset(r) {
  r.ptr = 0; r.len = 0;
  r.x.fill(0); r.y.fill(0); r.z.fill(0); r.t.fill(0);
}

function ringPush(r, x, y, z, t) {
  r.x[r.ptr] = x; r.y[r.ptr] = y;
  r.z[r.ptr] = z; r.t[r.ptr] = t;
  r.ptr = (r.ptr + 1) % WINDOW_LEN;
  if (r.len < WINDOW_LEN) r.len++;
}

function ringRead(r, arr, i) {
  return arr[(r.ptr - r.len + i + WINDOW_LEN) % WINDOW_LEN];
}

// 4 parallele Ringe – alle werden immer beschrieben
const rings = {
  acc:  makeRing(),   // m/s²
  vel:  makeRing(),   // mm/s
  disp: makeRing(),   // mm
  freq: makeRing()    // Hz
};

let liveRing = rings.vel; // welcher Ring wird angezeigt

/* ══════════════════════════════════════════════
   ZUSTAND
══════════════════════════════════════════════ */
let running = false, startTime = null, durTimer = null, rafId = null;
let savedData = null, rec = null;
let savedAll = null;
let activeUnit = 'vel';
let noDataTimer = null, motionEventCount = 0;
let fsEst = 60, lastFreqUpdate = 0;
let fX = 0, fY = 0, fZ = 0, fT = 0;

let igX=0, igY=0, igZ=0;
let accX=0, accY=0, accZ=0, hasAcc=false;
let gyrX=0, gyrY=0, gyrZ=0;

const sig = {
  x: new Float32Array(256), y: new Float32Array(256),
  z: new Float32Array(256), t: new Float32Array(256),
  ptr: 0, len: 0
};

const intg = { vx:0, vy:0, vz:0, px:0, py:0, pz:0, prev:null };
const filt = {
  gX:0, gY:0, gZ:0,
  hpX:0, hpY:0, hpZ:0,
  prevX:0, prevY:0, prevZ:0,
  lpX:0, lpY:0, lpZ:0
};

let peakTotal=0, rmsAcc=0, rmsCnt=0, evtCount=0;
const vis = { x:true, y:true, z:true, t:true };

/* ══════════════════════════════════════════════
   iOS / PWA ERKENNUNG
══════════════════════════════════════════════ */
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent);
const IS_STANDALONE =
  window.matchMedia('(display-mode: standalone)').matches ||
  navigator.standalone === true;

/* ══════════════════════════════════════════════
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

window.addEventListener('error', (e) => {
  if (!dom.statusBar) return;
  dom.statusBar.hidden = false;
  dom.statusBar.className = 'statusBar is-error';
  dom.statusBar.textContent = `JS Fehler: ${e.message} (Zeile ${e.lineno})`;
});

/* ══════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════ */
function unitLabel(mode = activeUnit) {
  if (mode === 'acc')  return 'm/s²';
  if (mode === 'disp') return 'mm';
  if (mode === 'freq') return 'Hz';
  return 'mm/s';
}

function unitTextFor(mode) {
  if (mode === 'acc')  return 'a (m/s²)';
  if (mode === 'disp') return 's (mm)';
  if (mode === 'freq') return 'f (Hz)';
  return 'v (mm/s)';
}

function liveTitleFor(mode, axis) {
  if (mode === 'acc')  return `Beschleunigung ${axis}`;
  if (mode === 'disp') return `Verschiebung ${axis}`;
  if (mode === 'freq') return `Frequenz ${axis}`;
  return `Geschwindigkeit ${axis}`;
}

function axisMetaFromUnit(mode) {
  if (mode === 'acc')  return { ySymbol:'a', yUnit:'m/s²' };
  if (mode === 'disp') return { ySymbol:'s', yUnit:'mm' };
  if (mode === 'freq') return { ySymbol:'f', yUnit:'Hz' };
  return { ySymbol:'v', yUnit:'mm/s' };
}

function fmtTime(ms) {
  const mm = String(Math.floor(ms / 60000)).padStart(2,'0');
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2,'0');
  return `${mm}:${ss}`;
}

function setStatus(msg, cls) {
  dom.statusBar.textContent = msg;
  dom.statusBar.className   = 'statusBar' + (cls ? ' '+cls : '');
  dom.statusBar.hidden      = !msg;
}

/* ══════════════════════════════════════════════
   CANVAS
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

/* ══════════════════════════════════════════════
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

/* ══════════════════════════════════════════════
   UNIT SWITCH
══════════════════════════════════════════════ */
function updateUnitLabels() {
  const u = unitLabel(activeUnit);
  ['unitX','unitY','unitZ','unitT'].forEach(id => {
    const el = $(id); if (el) el.textContent = u;
  });
  const up = $('unitPeak'); if (up) up.textContent = 'mm/s';
  const ur = $('unitRms');  if (ur) ur.textContent = 'mm/s';
  dom.mainSub.textContent = `${u} (Total)`;
}

document.querySelectorAll('.unitBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeUnit = btn.dataset.unit;
    document.querySelectorAll('.unitBtn').forEach(b =>
      b.classList.toggle('is-active', b === btn));
    updateUnitLabels();

    // Nur Anzeige wechseln – Messung läuft unverändert weiter
    liveRing = rings[activeUnit] || rings.vel;
    drawLive();
    if (savedData) drawResult(savedData);
  });
});

/* ══════════════════════════════════════════════
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

/* ══════════════════════════════════════════════
   DIN 4150-2
══════════════════════════════════════════════ */
const dinRows   = ['n0','n1','n2','n3','n4'];
const dinBounds = [0, 0.3, 1.0, 3.0, 10.0];
function updateDIN(vMms) {
  let row = 0;
  for (let i = dinBounds.length-1; i >= 0; i--) {
    if (vMms >= dinBounds[i]) { row = i; break; }
  }
  dinRows.forEach((id,i) => $(id).classList.toggle('is-active', i === row));
}

/* ══════════════════════════════════════════════
   FILTER (Gravity + Bandpass)
══════════════════════════════════════════════ */
function clampBand(fcMin, fcMax, fs) {
  const nyq = Math.max(1, fs / 2);
  const hi  = Math.min(fcMax, nyq * 0.85);
  const lo  = Math.max(0.2, Math.min(fcMin, hi * 0.8));
  return { lo, hi };
}

function updateFs(dt) {
  if (!dt || dt <= 0) return;
  fsEst = 0.9 * fsEst + 0.1 * (1 / dt);
}

function filterLinearAcc(igAx, igAy, igAz, linAx, linAy, linAz, dt) {
  // Gravity-Lowpass
  const aG = dt / (GRAV_TAU_S + dt);
  filt.gX += aG * (igAx - filt.gX);
  filt.gY += aG * (igAy - filt.gY);
  filt.gZ += aG * (igAz - filt.gZ);

  // Lineare Beschleunigung
  let lx = hasAcc ? linAx : igAx - filt.gX;
  let ly = hasAcc ? linAy : igAy - filt.gY;
  let lz = hasAcc ? linAz : igAz - filt.gZ;

  // Bandpass
  const { lo, hi } = clampBand(FREQ_MIN_HZ, FREQ_MAX_HZ, fsEst);

  const tauHP = 1 / (2 * Math.PI * lo);
  const aHP   = tauHP / (tauHP + dt);
  filt.hpX = aHP * (filt.hpX + lx - filt.prevX);
  filt.hpY = aHP * (filt.hpY + ly - filt.prevY);
  filt.hpZ = aHP * (filt.hpZ + lz - filt.prevZ);
  filt.prevX = lx; filt.prevY = ly; filt.prevZ = lz;

  const tauLP = 1 / (2 * Math.PI * hi);
  const aLP   = dt / (tauLP + dt);
  filt.lpX += aLP * (filt.hpX - filt.lpX);
  filt.lpY += aLP * (filt.hpY - filt.lpY);
  filt.lpZ += aLP * (filt.hpZ - filt.lpZ);

  return { ax: filt.lpX, ay: filt.lpY, az: filt.lpZ };
}

/* ══════════════════════════════════════════════
   FREQUENZSCHÄTZUNG (Autokorrelation)
══════════════════════════════════════════════ */
function pushSig(ax, ay, az) {
  const t = Math.sqrt(ax*ax + ay*ay + az*az);
  sig.x[sig.ptr] = ax; sig.y[sig.ptr] = ay;
  sig.z[sig.ptr] = az; sig.t[sig.ptr] = t;
  sig.ptr = (sig.ptr + 1) % 256;
  if (sig.len < 256) sig.len++;
}

function readSigSeries(arr) {
  const out = new Float32Array(sig.len);
  for (let i = 0; i < sig.len; i++)
    out[i] = arr[(sig.ptr - sig.len + i + 256) % 256];
  return out;
}

function dominantFreqAutocorr(series, fs, fmin, fmax) {
  const n = series.length;
  if (n < 32 || fs <= 0) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += series[i];
  mean /= n;
  const minLag = Math.max(2, Math.floor(fs / fmax));
  const maxLag = Math.min(n-2, Math.floor(fs / fmin));
  if (maxLag <= minLag) return 0;
  let bestLag = 0, bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < n-lag; i++)
      sum += (series[i]-mean) * (series[i+lag]-mean);
    if (sum > bestVal) { bestVal = sum; bestLag = lag; }
  }
  return bestLag > 0 ? fs / bestLag : 0;
}

/* ══════════════════════════════════════════════
   EINZELNES PANEL ZEICHNEN
══════════════════════════════════════════════ */
function drawPanel({ ctx, x, y, w, h, ring, color, title, mode }) {
  ctx.save();

  // Hintergrund + Rahmen
  ctx.fillStyle = '#111113';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(x, y, w, h);

  // Min/Max symmetrisch
  let mx = 0;
  for (let i = 0; i < ring.len; i++) {
    const v = Math.abs(ringRead(ring, ring.x, i));
    if (v > mx) mx = v;
  }
  if (mx === 0) mx = 1;
  const yMin = -mx * 1.2;
  const yMax =  mx * 1.2;
  const yOf = (v) => y + h - ((v - yMin) / (yMax - yMin)) * h;

  // Gitternetz
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 7]);
  for (let i = 1; i <= 4; i++) {
    const gx = x + (i/5)*w;
    ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx, y+h); ctx.stroke();
  }
  for (let j = 1; j <= 3; j++) {
    const gy = y + (j/4)*h;
    ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x+w, gy); ctx.stroke();
  }

  // DIN-Grenzlinien (nur vel, sehr dezent)
  if (mode === 'vel') {
    ctx.strokeStyle = 'rgba(255,237,0,0.15)';
    ctx.setLineDash([4, 6]);
    for (const g of DIN_GUIDES) {
      const yg = yOf(g);
      if (yg > y && yg < y+h) {
        ctx.beginPath(); ctx.moveTo(x, yg); ctx.lineTo(x+w, yg); ctx.stroke();
      }
      const ygn = yOf(-g);
      if (ygn > y && ygn < y+h) {
        ctx.beginPath(); ctx.moveTo(x, ygn); ctx.lineTo(x+w, ygn); ctx.stroke();
      }
    }
  }

  // Null-Linie
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, yOf(0)); ctx.lineTo(x+w, yOf(0)); ctx.stroke();

  // Kurve
  if (ring.len >= 2) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < ring.len; i++) {
      const xp = x + (i / (WINDOW_LEN - 1)) * w;
      const yp = yOf(ringRead(ring, ring.x, i));
      i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
    }
    ctx.stroke();
  }

  // Y-Ticks
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '10px system-ui, Arial';
  ctx.textAlign = 'right';
  for (const v of [mx, mx/2, 0, -mx/2, -mx]) {
    const yp = yOf(v);
    if (yp > y+6 && yp < y+h-4)
      ctx.fillText(v.toFixed(v === 0 ? 0 : 2), x+40, yp+4);
  }

  // X-Ticks
  ctx.textAlign = 'center';
  for (const t of [0,2,4,6,8,10]) {
    ctx.fillText(`${t}`, x + (t/10)*w, y+h-4);
  }

  // Titel
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 13px system-ui, Arial';
  ctx.textAlign = 'center';
  ctx.fillText(title, x + w/2, y + 18);

  // Y-Label (rotiert)
  ctx.save();
  ctx.translate(x + 10, y + h/2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '11px system-ui, Arial';
  ctx.textAlign = 'center';
  ctx.fillText(unitTextFor(mode), 0, 0);
  ctx.restore();

  // X-Label
  ctx.fillStyle = 'rgba(255,255,255,0.50)';
  ctx.font = '11px system-ui, Arial';
  ctx.textAlign = 'right';
  ctx.fillText('t (s)', x+w-4, y+h-4);

  ctx.restore();
}

/* ══════════════════════════════════════════════
   LIVE CHART — 3 PANELS (X / Y / Z)
   Zeigt immer liveRing (= aktive Einheit)
══════════════════════════════════════════════ */
function drawLive() {
  const cvs = dom.liveChart;
  const ctx = liveCtx;
  const W   = cvs.getBoundingClientRect().width  || 300;
  const H   = cvs.getBoundingClientRect().height || 560;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  const pad    = 12;
  const gap    = 14;
  const left   = 46;
  const panelH = (H - pad*2 - gap*2) / 3;
  const pw     = W - left - pad;
  const mode   = activeUnit;
  const ring   = liveRing;

  // Temporäres Ring-Objekt für jede Achse (zeigt nur eine Achse pro Panel)
  function makeAxisRing(mainArr) {
    return {
      x: mainArr,
      y: mainArr, z: mainArr, t: mainArr,
      ptr: ring.ptr, len: ring.len
    };
  }

  const ringX = { ...ring, x: ring.x };
  const ringY = { ...ring, x: ring.y };
  const ringZ = { ...ring, x: ring.z };

  drawPanel({ ctx, x:left, y: pad + 0*(panelH+gap), w:pw, h:panelH,
    ring: ringX, color: COLORS.x, title: liveTitleFor(mode,'x'), mode });

  drawPanel({ ctx, x:left, y: pad + 1*(panelH+gap), w:pw, h:panelH,
    ring: ringY, color: COLORS.y, title: liveTitleFor(mode,'y'), mode });

  drawPanel({ ctx, x:left, y: pad + 2*(panelH+gap), w:pw, h:panelH,
    ring: ringZ, color: COLORS.z, title: liveTitleFor(mode,'z'), mode });
}

/* ══════════════════════════════════════════════
   RESULT CHART
══════════════════════════════════════════════ */
function drawResult(data) {
  const cvs = dom.resultChart;
  const ctx = resCtx;
  const W   = cvs.getBoundingClientRect().width  || 300;
  const H   = cvs.getBoundingClientRect().height || 220;

  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0,0,W,H);

  const unitMode = data.unit || activeUnit;
  let mn=Infinity, mx=-Infinity;
  ['x','y','z','t'].forEach(s => {
    data[s].forEach(v => { if(v<mn) mn=v; if(v>mx) mx=v; });
  });
  if (!isFinite(mn)) { mn=-1; mx=1; }
  const rng = (mx-mn)||1;
  const yMin = mn - rng*0.12, yMax = mx + rng*0.12;

  if (unitMode === 'vel') {
    ctx.save(); ctx.setLineDash([4,6]);
    ctx.strokeStyle = 'rgba(255,237,0,0.18)'; ctx.lineWidth = 1;
    for (const g of DIN_GUIDES) {
      const yg = H - ((g-yMin)/(yMax-yMin))*H;
      if (yg>0 && yg<H) {
        ctx.beginPath(); ctx.moveTo(0,yg); ctx.lineTo(W,yg); ctx.stroke();
      }
    }
    ctx.restore();
  }

  ctx.setLineDash([]);
  const y0 = H - ((0-yMin)/(yMax-yMin))*H;
  ctx.strokeStyle = '#2a2a2d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0,y0); ctx.lineTo(W,y0); ctx.stroke();

  ['x','y','z','t'].forEach(s => {
    ctx.strokeStyle = COLORS[s];
    ctx.lineWidth   = s==='t' ? 2.5 : 1.5;
    ctx.beginPath();
    data[s].forEach((v,i) => {
      const xp = (i/(data[s].length-1))*W;
      const yp = H - ((v-yMin)/(yMax-yMin))*H;
      i===0 ? ctx.moveTo(xp,yp) : ctx.lineTo(xp,yp);
    });
    ctx.stroke();
  });

  const { ySymbol, yUnit } = axisMetaFromUnit(unitMode);
  ctx.fillStyle = 'rgba(255,255,255,0.50)';
  ctx.font = '11px system-ui, Arial';
  ctx.textAlign = 'right';
  ctx.fillText('t [s]', W-4, H-5);
  ctx.save();
  ctx.translate(13, H/2+20);
  ctx.rotate(-Math.PI/2);
  ctx.textAlign = 'center';
  ctx.fillText(`${ySymbol} [${yUnit}]`, 0, 0);
  ctx.restore();

  dom.resAxis.innerHTML = '<span>Anfang</span><span>Ende</span>';
}
/* ══════════════════════════════════════════════
   SENSOR
══════════════════════════════════════════════ */
function onMotion(e) {
  motionEventCount++;

  // accelerationIncludingGravity (immer)
  const ig = e.accelerationIncludingGravity;
  if (ig && ig.x != null) {
    igX = Number(ig.x) || 0;
    igY = Number(ig.y) || 0;
    igZ = Number(ig.z) || 0;
  }

  // linear acceleration (wenn verfügbar)
  const a = e.acceleration;
  if (a && a.x != null && a.y != null && a.z != null) {
    accX = Number(a.x) || 0;
    accY = Number(a.y) || 0;
    accZ = Number(a.z) || 0;
    hasAcc = true;
  } else {
    hasAcc = false;
  }

  // gyro (optional)
  const r = e.rotationRate;
  if (r && r.alpha != null) {
    gyrX = Number(r.alpha) || 0;
    gyrY = Number(r.beta)  || 0;
    gyrZ = Number(r.gamma) || 0;
  }
}
window.addEventListener('devicemotion', onMotion, { passive: true });

/* ══════════════════════════════════════════════
   RESET / START / STOP
══════════════════════════════════════════════ */
function resetState() {
  running = false;
  if (rafId)       { cancelAnimationFrame(rafId); rafId = null; }
  if (durTimer)    { clearInterval(durTimer); durTimer = null; }
  if (noDataTimer) { clearTimeout(noDataTimer); noDataTimer = null; }

  startTime = null;
  motionEventCount = 0;

  // stats
  peakTotal = 0; rmsAcc = 0; rmsCnt = 0; evtCount = 0;

  // sampling + freq
  fsEst = 60;
  lastFreqUpdate = 0;
  fX = fY = fZ = fT = 0;

  // rings
   function snapshotRing(ring) {
  const n = ring.len;
  const x = new Array(n), y = new Array(n), z = new Array(n), t = new Array(n);

  for (let i = 0; i < n; i++) {
    const idx = (ring.ptr - ring.len + i + WINDOW_LEN) % WINDOW_LEN;
    x[i] = ring.x[idx];
    y[i] = ring.y[idx];
    z[i] = ring.z[idx];
    t[i] = ring.t[idx];
  }
  return { n, x, y, z, t };
}

function unitLabelFromKey(k){
  return k === 'acc' ? 'm/s²' : k === 'disp' ? 'mm' : k === 'freq' ? 'Hz' : 'mm/s';
}

function yAxisTextFromKey(k){
  return k === 'acc' ? 'a (m/s²)' : k === 'disp' ? 's (mm)' : k === 'freq' ? 'f (Hz)' : 'v (mm/s)';
}
  ringReset(rings.acc);
  ringReset(rings.vel);
  ringReset(rings.disp);
  ringReset(rings.freq);
  liveRing = rings[activeUnit] || rings.vel;

  // sig
  sig.ptr = 0; sig.len = 0;
  sig.x.fill(0); sig.y.fill(0); sig.z.fill(0); sig.t.fill(0);

  // integrator
  intg.vx = intg.vy = intg.vz = 0;
  intg.px = intg.py = intg.pz = 0;
  intg.prev = null;

  // filter
  filt.gX = filt.gY = filt.gZ = 0;
  filt.hpX = filt.hpY = filt.hpZ = 0;
  filt.prevX = filt.prevY = filt.prevZ = 0;
  filt.lpX = filt.lpY = filt.lpZ = 0;

  // raw
  igX = igY = igZ = 0;
  accX = accY = accZ = 0;
  gyrX = gyrY = gyrZ = 0;
  hasAcc = false;

  // measurement data
  rec = null;
  savedData = null;

  // UI
  dom.startBtn.textContent = 'Start';
  dom.startBtn.classList.add('btn--accent');
  dom.startBtn.classList.remove('btn--stop');

  dom.mainNum.textContent = '0.00';
  dom.mainSub.textContent = `${unitLabel(activeUnit)} (Total)`;
  dom.xVal.textContent = '0.00';
  dom.yVal.textContent = '0.00';
  dom.zVal.textContent = '0.00';
  dom.tVal.textContent = '0.00';

  dom.peakVal.textContent = '0.00';
  dom.rmsVal.textContent  = '0.00';
  dom.evtVal.textContent  = '0';
  dom.durVal.textContent  = '00:00';

  dom.results.hidden = true;
  dom.resMeta.textContent = '—';

  dom.debugPanel.textContent = 'Warte auf Sensor-Daten …';

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = false);
  dinRows.forEach(id => $(id).classList.remove('is-active'));

  setStatus('', '');
  drawLive();
}

function startMeasurement() {
  if (running) return;

  // nicht die Unit zurücksetzen – wir messen parallel sowieso alles
  running = true;
  startTime = Date.now();
  motionEventCount = 0;

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = true);

  // Recording enthält nur die aktuell gewählte Anzeige-Einheit beim STOP
  rec = {
    t0: performance.now(),
    startTs: startTime
  };

  dom.startBtn.textContent = 'Stop';
  dom.startBtn.classList.remove('btn--accent');
  dom.startBtn.classList.add('btn--stop');

  setStatus('MESSUNG LÄUFT …', 'is-running');

  durTimer = setInterval(() => {
    dom.durVal.textContent = fmtTime(Date.now() - startTime);
  }, 250);

  noDataTimer = setTimeout(() => {
    if (motionEventCount === 0) {
      setStatus('Keine Sensor-Daten. iPhone: Sensorerlaubnis nötig.', 'is-error');
    }
  }, 2000);

  rafId = requestAnimationFrame(loop);
}

function stopMeasurement() {
  if (!running) return;
  running = false;

  if (rafId)       { cancelAnimationFrame(rafId); rafId = null; }
  if (durTimer)    { clearInterval(durTimer); durTimer = null; }
  if (noDataTimer) { clearTimeout(noDataTimer); noDataTimer = null; }

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = false);

  dom.startBtn.textContent = 'Start';
  dom.startBtn.classList.add('btn--accent');
  dom.startBtn.classList.remove('btn--stop');
  setStatus('Messung abgeschlossen ✓', 'is-done');

  // Speichere den aktuell ausgewählten Ring als Ergebnis
  const r = rings[activeUnit] || rings.vel;
  const n = r.len;

  if (rec && n > 5) {
    const x = new Array(n), y = new Array(n), z = new Array(n), t = new Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = ringRead(r, r.x, i);
      y[i] = ringRead(r, r.y, i);
      z[i] = ringRead(r, r.z, i);
      t[i] = ringRead(r, r.t, i);
    }

    savedData = {
      unit: activeUnit,
      startTs: rec.startTs,
      durationSec: (performance.now() - rec.t0) / 1000,
      x, y, z, t
    };

    dom.results.hidden = false;
    dom.resMeta.textContent =
      `${new Date(savedData.startTs).toLocaleString('de-DE')} · ` +
      `Dauer: ${savedData.durationSec.toFixed(1)} s · ` +
      `Punkte: ${n}`;

    setTimeout(() => {
      resizeCanvas(dom.resultChart);
      drawResult(savedData);
    }, 80);
  }
   // Alle Einheiten parallel sichern (letzte Messung)
if (typeof rings !== 'undefined' && rings.vel) {
  const sVel  = snapshotRing(rings.vel);
  const sAcc  = snapshotRing(rings.acc);
  const sDisp = snapshotRing(rings.disp);
  const sFreq = snapshotRing(rings.freq);

  const durationSec = (performance.now() - rec.t0) / 1000;

  savedAll = {
    startTs: rec.startTs,
    durationSec,
    units: {
      vel:  { unitKey:'vel',  ...sVel  },
      acc:  { unitKey:'acc',  ...sAcc  },
      disp: { unitKey:'disp', ...sDisp },
      freq: { unitKey:'freq', ...sFreq }
    }
  };
}

  rec = null;
}

/* Start-Button: iOS Permission beim Klick */
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
   LOOP – berechnet ALLE Einheiten parallel,
   zeigt aber nur activeUnit an.
══════════════════════════════════════════════ */
function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  const now = performance.now();
  const dt  = Math.min((now - (intg.prev ?? now)) / 1000, 0.05);
  intg.prev = now;
  if (dt > 0) updateFs(dt);

  // Filter (linear, bandpass)
  const { ax, ay, az } = filterLinearAcc(igX, igY, igZ, accX, accY, accZ, dt);

  // Integration (v in m/s, s in m)
  const leakV = 0.985, leakP = 0.995;
  intg.vx = (intg.vx + ax * dt) * leakV;
  intg.vy = (intg.vy + ay * dt) * leakV;
  intg.vz = (intg.vz + az * dt) * leakV;

  intg.px = (intg.px + intg.vx * dt) * leakP;
  intg.py = (intg.py + intg.vy * dt) * leakP;
  intg.pz = (intg.pz + intg.vz * dt) * leakP;

  // Totals
  const accT  = Math.sqrt(ax*ax + ay*ay + az*az);
  const velX  = intg.vx * 1000, velY = intg.vy * 1000, velZ = intg.vz * 1000; // mm/s
  const velT  = Math.sqrt(velX*velX + velY*velY + velZ*velZ);
  const dispX = intg.px * 1000, dispY = intg.py * 1000, dispZ = intg.pz * 1000; // mm
  const dispT = Math.sqrt(dispX*dispX + dispY*dispY + dispZ*dispZ);

  // Frequenzen (alle 0.5 s aktualisieren)
  pushSig(ax, ay, az);
  if (now - lastFreqUpdate > 500 && sig.len >= 64) {
    lastFreqUpdate = now;
    const flo = FREQ_MIN_HZ;
    const fhi = Math.min(FREQ_MAX_HZ, fsEst/2 * 0.85);
    fX = dominantFreqAutocorr(readSigSeries(sig.x), fsEst, flo, fhi);
    fY = dominantFreqAutocorr(readSigSeries(sig.y), fsEst, flo, fhi);
    fZ = dominantFreqAutocorr(readSigSeries(sig.z), fsEst, flo, fhi);
    fT = dominantFreqAutocorr(readSigSeries(sig.t), fsEst, flo, fhi);
  }

  // 1) alle Ringe parallel füllen
  ringPush(rings.acc,  ax,    ay,    az,    accT);
  ringPush(rings.vel,  velX,  velY,  velZ,  velT);
  ringPush(rings.disp, dispX, dispY, dispZ, dispT);
  ringPush(rings.freq, fX,    fY,    fZ,    fT);

  // 2) Anzeige-Ring setzen
  liveRing = rings[activeUnit] || rings.vel;

  // 3) UI aus Anzeige-Ring
  const r = liveRing;
  const last = (r.ptr - 1 + WINDOW_LEN) % WINDOW_LEN;
  const ux = r.x[last], uy = r.y[last], uz = r.z[last], ut = r.t[last];

  const dec = (activeUnit === 'freq') ? 1 : 2;

  dom.xVal.textContent = ux.toFixed(dec);
  dom.yVal.textContent = uy.toFixed(dec);
  dom.zVal.textContent = uz.toFixed(dec);
  dom.tVal.textContent = ut.toFixed(dec);

  // Stats immer vel (mm/s)
  if (velT > peakTotal) peakTotal = velT;
  rmsAcc += velT * velT; rmsCnt++;
  if (velT > EVT_THR) evtCount++;

  dom.peakVal.textContent = peakTotal.toFixed(2);
  dom.rmsVal.textContent  = rmsCnt ? Math.sqrt(rmsAcc / rmsCnt).toFixed(2) : '0.00';
  dom.evtVal.textContent  = evtCount;

  // Main
  const u = unitLabel(activeUnit);
  dom.mainNum.textContent = ut.toFixed(dec);
  dom.mainSub.textContent = `${u} (Total)`;

  if (activeUnit === 'vel') updateDIN(velT);

  drawLive();

  // Debug
  const { lo, hi } = clampBand(FREQ_MIN_HZ, FREQ_MAX_HZ, fsEst);
  dom.debugPanel.textContent =
    `acc lin: ${ax.toFixed(3)} ${ay.toFixed(3)} ${az.toFixed(3)} m/s²\n` +
    `velT: ${velT.toFixed(2)} mm/s | Peak: ${peakTotal.toFixed(2)} mm/s\n` +
    `freq: X=${fX.toFixed(1)} Y=${fY.toFixed(1)} Z=${fZ.toFixed(1)} T=${fT.toFixed(1)} Hz\n` +
    `fs≈${fsEst.toFixed(1)} Hz | Band ${lo.toFixed(1)}–${hi.toFixed(1)} Hz\n` +
    `unit=${activeUnit}`;
}
// Alle Einheiten parallel sichern (letzte Messung)
if (typeof rings !== 'undefined' && rings.vel) {
  const sVel  = snapshotRing(rings.vel);
  const sAcc  = snapshotRing(rings.acc);
  const sDisp = snapshotRing(rings.disp);
  const sFreq = snapshotRing(rings.freq);

  const durationSec = (performance.now() - rec.t0) / 1000;

  savedAll = {
    startTs: rec.startTs,
    durationSec,
    units: {
      vel:  { unitKey:'vel',  ...sVel  },
      acc:  { unitKey:'acc',  ...sAcc  },
      disp: { unitKey:'disp', ...sDisp },
      freq: { unitKey:'freq', ...sFreq }
    }
  };
}

/* ══════════════════════════════════════════════
   CSV EXPORT (exportiert die gespeicherte Einheit)
══════════════════════════════════════════════ */
function exportCSV() {
  if (!savedAll) { setStatus('Keine Messdaten – erst messen!', 'is-error'); return; }

  const unitKey = $('exportUnit')?.value || 'vel';
  const d = savedAll.units[unitKey];
  if (!d || d.n < 2) { setStatus('Keine Daten für diese Einheit.', 'is-error'); return; }

  const unit = unitLabelFromKey(unitKey);
  const dt = savedAll.durationSec / Math.max(1, d.n - 1);

  let csv = '';
  csv += `# HTB Schwingungsmesser Export\n`;
  csv += `# Start: ${new Date(savedAll.startTs).toLocaleString('de-DE')}\n`;
  csv += `# Dauer: ${savedAll.durationSec.toFixed(2)} s\n`;
  csv += `# Einheit: ${unit}\n#\n`;
  csv += `i;time_s;x_${unit};y_${unit};z_${unit};total_${unit}\n`;

  for (let i = 0; i < d.n; i++) {
    csv += `${i};${(i*dt).toFixed(4)};${d.x[i].toFixed(6)};${d.y[i].toFixed(6)};${d.z[i].toFixed(6)};${d.t[i].toFixed(6)}\n`;
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `HTB_${unitKey}_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
$('csvBtn').addEventListener('click', exportCSV);
$('pdfBtn').addEventListener('click', exportPDF);

/* ══════════════════════════════════════════════
   PDF EXPORT (einfach: Ergebnis-Chart als Screenshot)
   Wenn du wieder die wissenschaftliche 3-Plot-Version willst,
   sag: "PDF 3 Plots".
══════════════════════════════════════════════ */
function exportPDF() {
  if (!savedAll) { setStatus('Keine Messdaten – erst messen!', 'is-error'); return; }

  const unitKey = $('exportUnit')?.value || 'vel';
  const d = savedAll.units[unitKey];
  if (!d || d.n < 2) { setStatus('Keine Daten für diese Einheit.', 'is-error'); return; }

  const unit = unitLabelFromKey(unitKey);
  const yLabel = yAxisTextFromKey(unitKey);
  const dur = savedAll.durationSec;

  const imgX = plotScientificPNG({ series: d.x, title: 'X-Achse', yLabel, color: '#ff4444', durationSec: dur });
  const imgY = plotScientificPNG({ series: d.y, title: 'Y-Achse', yLabel, color: '#00cc66', durationSec: dur });
  const imgZ = plotScientificPNG({ series: d.z, title: 'Z-Achse', yLabel, color: '#4499ff', durationSec: dur });

  const w = window.open('', '_blank');
  if (!w) { setStatus('Popup blockiert – bitte Popups erlauben!', 'is-error'); return; }

  w.document.open();
  w.document.write(`<!doctype html><html><head>
<meta charset="utf-8"/>
<title>HTB Export</title>
<style>
  @page { size:A4 portrait; margin:12mm; }
  body{ font-family: Arial, sans-serif; margin:0; padding:12mm; color:#111; background:#fff; }
  h1{ font-size:16px; margin:0 0 6px; }
  .meta{ font-size:11px; color:#444; line-height:1.5; margin-bottom:10px; border-bottom:1px solid #ddd; padding-bottom:6px; }
  .plot{ margin:10px 0; page-break-inside:avoid; }
  .plot img{ width:100%; border:1px solid #ddd; }
</style>
</head><body>
<h1>HTB Schwingungsmesser – Export</h1>
<div class="meta">
  Start: ${new Date(savedAll.startTs).toLocaleString('de-DE')}<br/>
  Dauer: ${dur.toFixed(1)} s · Einheit: ${unit} · Punkte: ${d.n}
</div>

<div class="plot"><img src="${imgX}" alt="X"></div>
<div class="plot"><img src="${imgY}" alt="Y"></div>
<div class="plot"><img src="${imgZ}" alt="Z"></div>

<script>setTimeout(()=>window.print(),250);<\/script>
</body></html>`);
  w.document.close();
}
$('pdfBtn').addEventListener('click', exportPDF);
function exportCSV() {
  if (!savedAll) { setStatus('Keine Messdaten – erst messen!', 'is-error'); return; }

  const unitKey = $('exportUnit')?.value || 'vel';
  const d = savedAll.units[unitKey];
  if (!d || d.n < 2) { setStatus('Keine Daten für diese Einheit.', 'is-error'); return; }

  const unit = unitLabelFromKey(unitKey);
  const dt = savedAll.durationSec / Math.max(1, d.n - 1);

  let csv = '';
  csv += `# HTB Schwingungsmesser Export\n`;
  csv += `# Start: ${new Date(savedAll.startTs).toLocaleString('de-DE')}\n`;
  csv += `# Dauer: ${savedAll.durationSec.toFixed(2)} s\n`;
  csv += `# Einheit: ${unit}\n#\n`;
  csv += `i;time_s;x_${unit};y_${unit};z_${unit};total_${unit}\n`;

  for (let i = 0; i < d.n; i++) {
    csv += `${i};${(i*dt).toFixed(4)};${d.x[i].toFixed(6)};${d.y[i].toFixed(6)};${d.z[i].toFixed(6)};${d.t[i].toFixed(6)}\n`;
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `HTB_${unitKey}_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
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
    deferredPrompt = null;
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
