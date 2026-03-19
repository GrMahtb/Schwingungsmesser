'use strict';

/* ══════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════ */
const WINDOW_LEN  = 600;
const MAX_REC     = 36000;
const COLORS      = { x:'#32ff6a', y:'#4aa6ff', z:'#ffe95a', t:'#ffed00' };
const FREQ_MIN_HZ = 1.0;
const FREQ_MAX_HZ = 25.0;
const GRAV_TAU_S  = 0.6;
const DIN_GUIDES  = [0.3, 1.0, 3.0, 10.0];
const EVT_THR     = 0.1;

/* ══════════════════════════════════════════════
   STATE
══════════════════════════════════════════════ */
let running = false, startTime = null, durTimer = null, rafId = null;
let savedData = null, rec = null;
let activeUnit = 'vel';
let noDataTimer = null, motionEventCount = 0;
let fsEst = 60, lastFreqUpdate = 0;
let fX = 0, fY = 0, fZ = 0, fT = 0;

let igX=0, igY=0, igZ=0;
let accX=0, accY=0, accZ=0, hasAcc=false;
let gyrX=0, gyrY=0, gyrZ=0;

const buf = {
  x: new Float32Array(WINDOW_LEN),
  y: new Float32Array(WINDOW_LEN),
  z: new Float32Array(WINDOW_LEN),
  t: new Float32Array(WINDOW_LEN),
  ptr: 0, len: 0
};

const sig = {
  x: new Float32Array(256),
  y: new Float32Array(256),
  z: new Float32Array(256),
  t: new Float32Array(256),
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
   iOS / PWA
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
  if (mode === 'acc')  return `Lineare Beschleunigung ${axis}`;
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

function readBuf(arr, i) {
  return arr[(buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN];
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
   FILTER
══════════════════════════════════════════════ */
function clampBand(fcMin, fcMax, fs) {
  const nyq = Math.max(1, fs / 2);
  const hi = Math.min(fcMax, nyq * 0.85);
  const lo = Math.max(0.2, Math.min(fcMin, hi * 0.8));
  return { lo, hi };
}

function updateFs(dt) {
  if (!dt || dt <= 0) return;
  fsEst = 0.9 * fsEst + 0.1 * (1 / dt);
}

function filterLinearAcc(igAx, igAy, igAz, linAx, linAy, linAz, dt) {
  const aG = dt / (GRAV_TAU_S + dt);
  filt.gX += aG * (igAx - filt.gX);
  filt.gY += aG * (igAy - filt.gY);
  filt.gZ += aG * (igAz - filt.gZ);

  let lx = hasAcc ? linAx : igAx - filt.gX;
  let ly = hasAcc ? linAy : igAy - filt.gY;
  let lz = hasAcc ? linAz : igAz - filt.gZ;

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
   FREQUENZSCHÄTZUNG
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
  for (let i = 0; i < sig.len; i++) {
    out[i] = arr[(sig.ptr - sig.len + i + 256) % 256];
  }
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
    for (let i = 0; i < n-lag; i++) {
      sum += (series[i]-mean) * (series[i+lag]-mean);
    }
    if (sum > bestVal) { bestVal = sum; bestLag = lag; }
  }
  return bestLag > 0 ? fs / bestLag : 0;
}

/* ══════════════════════════════════════════════
   SINGLE PANEL (für Live-Chart)
══════════════════════════════════════════════ */
function drawPanel({ ctx, x, y, w, h, seriesArr, color, title, mode }) {
  ctx.save();

  // Hintergrund
  ctx.fillStyle = '#111113';
  ctx.fillRect(x, y, w, h);

  // Rahmen
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(x, y, w, h);

  // Min/Max symmetrisch um 0
  let mx = 0;
  for (let i = 0; i < buf.len; i++) {
    const v = Math.abs(readBuf(seriesArr, i));
    if (v > mx) mx = v;
  }
  if (mx === 0) mx = 1;
  const yMin = -mx * 1.2;
  const yMax =  mx * 1.2;

  const yOf = (v) => y + h - ((v - yMin) / (yMax - yMin)) * h;

  // Gitternetz
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([5, 7]);

  // vertikal (5 Linien)
  for (let i = 1; i <= 4; i++) {
    const gx = x + (i/5)*w;
    ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx, y+h); ctx.stroke();
  }
  // horizontal (4 Linien)
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
  const yn = yOf(0);
  ctx.beginPath(); ctx.moveTo(x, yn); ctx.lineTo(x+w, yn); ctx.stroke();

  // Kurve
  if (buf.len >= 2) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < buf.len; i++) {
      const xp = x + (i / (WINDOW_LEN - 1)) * w;
      const yp = yOf(readBuf(seriesArr, i));
      i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
    }
    ctx.stroke();
  }

  // Y-Achse: Tick-Werte
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '10px system-ui, Arial';
  ctx.textAlign = 'right';
  const topVal =  mx;
  const midVal =  mx / 2;
  const ticks = [topVal, midVal, 0, -midVal, -topVal];
  for (const v of ticks) {
    const yp = yOf(v);
    if (yp > y+6 && yp < y+h-4) {
      ctx.fillText(v.toFixed(v === 0 ? 0 : 2), x+36, yp+4);
    }
  }

  // X-Achse: Ticks (0 .. 10 s)
  ctx.textAlign = 'center';
  const timeLabels = [0, 2, 4, 6, 8, 10];
  for (const t of timeLabels) {
    const xp = x + (t/10) * w;
    ctx.fillText(`${t}`, xp, y+h-4);
  }

  // Titel (oben zentriert)
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 13px system-ui, Arial';
  ctx.textAlign = 'center';
  ctx.fillText(title, x + w/2, y + 18);

  // Y-Label (links, rotiert)
  ctx.save();
  ctx.translate(x + 10, y + h/2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.60)';
  ctx.font = '11px system-ui, Arial';
  ctx.textAlign = 'center';
  ctx.fillText(unitTextFor(mode), 0, 0);
  ctx.restore();

  // X-Label (unten, rechts)
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '11px system-ui, Arial';
  ctx.textAlign = 'right';
  ctx.fillText('t (s)', x+w-4, y+h-4);

  ctx.restore();
}

/* ══════════════════════════════════════════════
   LIVE CHART — 3 PANELS (X / Y / Z)
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
  const left   = 44;           // Platz für Y-Label + Ticks links
  const panelH = (H - pad*2 - gap*2) / 3;
  const pw     = W - left - pad;
  const mode   = activeUnit;

  const lenBackup = buf.len;
  if (buf.len < 2) buf.len = 2;

  drawPanel({ ctx, x:left, y: pad + 0*(panelH+gap), w:pw, h:panelH,
    seriesArr:buf.x, color:COLORS.x, title:liveTitleFor(mode,'x'), mode });

  drawPanel({ ctx, x:left, y: pad + 1*(panelH+gap), w:pw, h:panelH,
    seriesArr:buf.y, color:COLORS.y, title:liveTitleFor(mode,'y'), mode });

  drawPanel({ ctx, x:left, y: pad + 2*(panelH+gap), w:pw, h:panelH,
    seriesArr:buf.z, color:COLORS.z, title:liveTitleFor(mode,'z'), mode });

  buf.len = lenBackup;
}

/* ══════════════════════════════════════════════
   RESULT CHART (wie bisher, einzeln)
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
  const yMin = mn - rng*0.12;
  const yMax = mx + rng*0.12;

  // DIN-Linien
  if (unitMode === 'vel') {
    ctx.save(); ctx.setLineDash([4,6]);
    ctx.strokeStyle = 'rgba(255,237,0,0.18)'; ctx.lineWidth = 1;
    for (const g of DIN_GUIDES) {
      const yg = H - ((g-yMin)/(yMax-yMin))*H;
      if (yg>0 && yg<H) { ctx.beginPath(); ctx.moveTo(0,yg); ctx.lineTo(W,yg); ctx.stroke(); }
    }
    ctx.restore();
  }

  // Null-Linie
  ctx.setLineDash([]);
  ctx.strokeStyle = '#2a2a2d'; ctx.lineWidth = 1;
  const y0 = H - ((0-yMin)/(yMax-yMin))*H;
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

  // Achsenbeschriftung
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

  const ig = e.accelerationIncludingGravity;
  if (ig && ig.x != null) {
    igX = Number(ig.x) || 0;
    igY = Number(ig.y) || 0;
    igZ = Number(ig.z) || 0;
  }

  const a = e.acceleration;
  if (a && a.x != null && a.y != null && a.z != null) {
    accX = Number(a.x) || 0;
    accY = Number(a.y) || 0;
    accZ = Number(a.z) || 0;
    hasAcc = true;
  } else {
    hasAcc = false;
  }

  const r = e.rotationRate;
  if (r && r.alpha != null) {
    gyrX = Number(r.alpha) || 0;
    gyrY = Number(r.beta)  || 0;
    gyrZ = Number(r.gamma) || 0;
  }
}
window.addEventListener('devicemotion', onMotion, { passive:true });

/* ══════════════════════════════════════════════
   RESET / START / STOP
══════════════════════════════════════════════ */
function resetState() {
  running = false;
  if (rafId)       { cancelAnimationFrame(rafId); rafId = null; }
  if (durTimer)    { clearInterval(durTimer); durTimer = null; }
  if (noDataTimer) { clearTimeout(noDataTimer); noDataTimer = null; }

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
    setTimeout(() => { resizeCanvas(dom.resultChart); drawResult(savedData); }, 80);
  }

  rec = null;
}

/* Start-Button (iOS permission beim Klick) */
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

  // Filter + Gravity komp.
  const { ax, ay, az } = filterLinearAcc(igX, igY, igZ, accX, accY, accZ, dt);

  // Integrationen
  const leakV = 0.985, leakP = 0.995;
  intg.vx = (intg.vx + ax * dt) * leakV;
  intg.vy = (intg.vy + ay * dt) * leakV;
  intg.vz = (intg.vz + az * dt) * leakV;

  intg.px = (intg.px + intg.vx * dt) * leakP;
  intg.py = (intg.py + intg.vy * dt) * leakP;
  intg.pz = (intg.pz + intg.vz * dt) * leakP;

  const velTotal = Math.sqrt(intg.vx*intg.vx + intg.vy*intg.vy + intg.vz*intg.vz) * 1000;

  // Frequenzen
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

  // Anzeige nach Unit
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
    vx = intg.vx*1000; vy = intg.vy*1000; vz = intg.vz*1000;
    vt = velTotal;
  }

  // Ringbuffer
  buf.x[buf.ptr] = vx; buf.y[buf.ptr] = vy;
  buf.z[buf.ptr] = vz; buf.t[buf.ptr] = vt;
  buf.ptr = (buf.ptr + 1) % WINDOW_LEN;
  if (buf.len < WINDOW_LEN) buf.len++;

  // Statistik (vel)
  if (velTotal > peakTotal) peakTotal = velTotal;
  rmsAcc += velTotal * velTotal; rmsCnt++;
  if (velTotal > EVT_THR) evtCount++;

  // UI
  const dec = activeUnit === 'freq' ? 1 : 2;
  dom.xVal.textContent = vx.toFixed(dec);
  dom.yVal.textContent = vy.toFixed(dec);
  dom.zVal.textContent = vz.toFixed(dec);
  dom.tVal.textContent = vt.toFixed(dec);

  dom.peakVal.textContent = peakTotal.toFixed(2);
  dom.rmsVal.textContent  = rmsCnt ? Math.sqrt(rmsAcc / rmsCnt).toFixed(2) : '0.00';
  dom.evtVal.textContent  = evtCount;

  // Main
  const u = unitLabel(activeUnit);
  let main = vt, sub = `${u} (Total)`;
  if (!vis.t) {
    const cand = [];
    if (vis.x) cand.push({k:'X', v:Math.abs(vx)});
    if (vis.y) cand.push({k:'Y', v:Math.abs(vy)});
    if (vis.z) cand.push({k:'Z', v:Math.abs(vz)});
    if (cand.length) { cand.sort((a,b)=>b.v-a.v); main=cand[0].v; sub=`${u} (${cand[0].k})`; }
    else { main=0; sub=`${u} (–)`; }
  }
  dom.mainNum.textContent = main.toFixed(dec);
  dom.mainSub.textContent = sub;

  if (activeUnit === 'vel') updateDIN(velTotal);

  drawLive();

  const { lo, hi } = clampBand(FREQ_MIN_HZ, FREQ_MAX_HZ, fsEst);
  dom.debugPanel.textContent =
    `lin ax=${ax.toFixed(3)} ay=${ay.toFixed(3)} az=${az.toFixed(3)} m/s²\n` +
    `velTotal=${velTotal.toFixed(2)} mm/s | Peak=${peakTotal.toFixed(2)} mm/s\n` +
    `freq X=${fX.toFixed(1)} Y=${fY.toFixed(1)} Z=${fZ.toFixed(1)} T=${fT.toFixed(1)} Hz\n` +
    `fs≈${fsEst.toFixed(1)} Hz | Band ${lo.toFixed(1)}–${hi.toFixed(1)} Hz\n` +
    `Events=${evtCount} | unit=${activeUnit}`;

  // Recording
  if (rec && rec.t.length < MAX_REC) {
    rec.x.push(vx); rec.y.push(vy); rec.z.push(vz); rec.t.push(vt);
    rec.velTotal.push(velTotal);
  }
}

/* ══════════════════════════════════════════════
   CSV
══════════════════════════════════════════════ */
function exportCSV() {
  if (!savedData) return;
  const u  = unitLabel(savedData.unit);
  const n  = savedData.t.length;
  const dt = savedData.durationSec / Math.max(1, n - 1);

  let csv = `# HTB Schwingungsmesser Export\n`;
  csv += `# Start: ${new Date(savedData.startTs).toLocaleString('de-DE')}\n`;
  csv += `# Dauer: ${savedData.durationSec.toFixed(2)} s\n`;
  csv += `# Einheit: ${u}\n#\n`;
  csv += `i;time_s;x_${u};y_${u};z_${u};total_${u}\n`;

  for (let i=0;i<n;i++){
    csv += `${i};${(i*dt).toFixed(4)};${savedData.x[i].toFixed(6)};${savedData.y[i].toFixed(6)};${savedData.z[i].toFixed(6)};${savedData.t[i].toFixed(6)}\n`;
  }

  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `HTB_Messung_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
$('csvBtn').addEventListener('click', exportCSV);

/* ══════════════════════════════════════════════
   PDF – nutzt dein bestehendes PDF aus der vorherigen Version
   (wenn du willst, sag "PDF nochmal", dann gebe ich ihn hier komplett rein)
══════════════════════════════════════════════ */
$('pdfBtn').addEventListener('click', () => setStatus('PDF-Block bitte aus deiner vorherigen Version beibehalten.', 'is-error'));

/* ══════════════════════════════════════════════
   iOS Permission Button (optional)
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
      } else setStatus('Sensorerlaubnis verweigert!', 'is-error');
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
