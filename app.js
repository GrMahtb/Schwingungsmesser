'use strict';

/* ══════════════════════════════════════════════
   KONFIGURATION
══════════════════════════════════════════════ */
const WINDOW_LEN = 600;
const MAX_REC    = 36000;
const COLORS     = { x:'#ff4444', y:'#00cc66', z:'#4499ff', t:'#ffed00' };
const HP_ALPHA   = 0.97;
const LEAK_V     = 0.985;
const LEAK_P     = 0.995;
const EVT_THR    = 0.1;

/* ══════════════════════════════════════════════
   ZUSTAND
══════════════════════════════════════════════ */
let running          = false;
let startTime        = null;
let durTimer         = null;
let rafId            = null;
let savedData        = null;
let rec              = null;
let activeUnit       = 'vel';
let noDataTimer      = null;
let motionEventCount = 0;
let rawX = 0, rawY = 0, rawZ = 0;

const buf = {
  x: new Float32Array(WINDOW_LEN),
  y: new Float32Array(WINDOW_LEN),
  z: new Float32Array(WINDOW_LEN),
  t: new Float32Array(WINDOW_LEN),
  ptr: 0, len: 0
};

const intg = { vx:0, vy:0, vz:0, px:0, py:0, pz:0, prev:null };
const hp   = { x:0,  y:0,  z:0,  px:0, py:0, pz:0 };

let peakTotal = 0, rmsAcc = 0, rmsCnt = 0, evtCount = 0;
const vis = { x:true, y:true, z:true, t:true };

/* ══════════════════════════════════════════════
   DOM (Script ist am Ende von <body> → DOM ist fertig)
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

/* ══════════════════════════════════════════════
   FEHLER → SICHTBAR IM STATUSBAR
══════════════════════════════════════════════ */
window.addEventListener('error', (e) => {
  dom.statusBar.hidden    = false;
  dom.statusBar.className = 'statusBar is-error';
  dom.statusBar.textContent = `JS Fehler: ${e.message} (Zeile ${e.lineno})`;
});

/* ══════════════════════════════════════════════
   HELPER
══════════════════════════════════════════════ */
function unitLabel() {
  return activeUnit === 'acc' ? 'm/s²' : activeUnit === 'disp' ? 'mm' : 'mm/s';
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
   EINHEIT
══════════════════════════════════════════════ */
function updateUnitLabels() {
  const u = unitLabel();
  ['unitX','unitY','unitZ','unitT','unitPeak','unitRms'].forEach(id => {
    const el = $(id); if (el) el.textContent = u;
  });
  dom.mainSub.textContent = `${u} (Total)`;
}

document.querySelectorAll('.unitBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeUnit = btn.dataset.unit;
    document.querySelectorAll('.unitBtn').forEach(b =>
      b.classList.toggle('is-active', b === btn));
    updateUnitLabels();
  });
});

/* ══════════════════════════════════════════════
   ACHSEN TOGGLE
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
  for (let i = dinBounds.length - 1; i >= 0; i--) {
    if (vMms >= dinBounds[i]) { row = i; break; }
  }
  dinRows.forEach((id, i) => $(id).classList.toggle('is-active', i === row));
}

/* ══════════════════════════════════════════════
   HIGH-PASS + INTEGRATION
══════════════════════════════════════════════ */
function processIMU(ax, ay, az, dt) {
  hp.x = HP_ALPHA * (hp.x + ax - hp.px);
  hp.y = HP_ALPHA * (hp.y + ay - hp.py);
  hp.z = HP_ALPHA * (hp.z + az - hp.pz);
  hp.px = ax; hp.py = ay; hp.pz = az;

  intg.vx = (intg.vx + hp.x * dt) * LEAK_V;
  intg.vy = (intg.vy + hp.y * dt) * LEAK_V;
  intg.vz = (intg.vz + hp.z * dt) * LEAK_V;

  intg.px = (intg.px + intg.vx * dt) * LEAK_P;
  intg.py = (intg.py + intg.vy * dt) * LEAK_P;
  intg.pz = (intg.pz + intg.vz * dt) * LEAK_P;
}

function getValues() {
  if (activeUnit === 'acc') {
    const vx = hp.x, vy = hp.y, vz = hp.z;
    return { vx, vy, vz, vt: Math.sqrt(vx*vx + vy*vy + vz*vz) };
  }
  if (activeUnit === 'disp') {
    const vx = intg.px*1000, vy = intg.py*1000, vz = intg.pz*1000;
    return { vx, vy, vz, vt: Math.sqrt(vx*vx + vy*vy + vz*vz) };
  }
  const vx = intg.vx*1000, vy = intg.vy*1000, vz = intg.vz*1000;
  return { vx, vy, vz, vt: Math.sqrt(vx*vx + vy*vy + vz*vz) };
}

/* ══════════════════════════════════════════════
   LIVE CHART
══════════════════════════════════════════════ */
function drawLive() {
  const cvs = dom.liveChart;
  const ctx = liveCtx;
  const W = cvs.getBoundingClientRect().width  || 300;
  const H = cvs.getBoundingClientRect().height || 200;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);
  if (buf.len < 2) return;

  let mn = Infinity, mx = -Infinity;
  ['x','y','z','t'].forEach(s => {
    if (!vis[s]) return;
    for (let i = 0; i < buf.len; i++) {
      const v = buf[s][(buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN];
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
  });
  if (!isFinite(mn)) { mn = -1; mx = 1; }
  const rng = (mx - mn) || 1;
  const yMin = mn - rng*0.12, yMax = mx + rng*0.12;

  const y0 = H - ((0 - yMin) / (yMax - yMin)) * H;
  ctx.strokeStyle = '#2a2a2d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();

  ['x','y','z','t'].forEach(s => {
    if (!vis[s]) return;
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

  dom.liveAxis.innerHTML =
    ['-10s','-8s','-6s','-4s','-2s','0s'].map(t => `<span>${t}</span>`).join('');
}

/* ══════════════════════════════════════════════
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

  let mn = Infinity, mx = -Infinity;
  ['x','y','z','t'].forEach(s => {
    data[s].forEach(v => { if (v < mn) mn = v; if (v > mx) mx = v; });
  });
  const rng = (mx - mn) || 1;
  const yMin = mn - rng*0.12, yMax = mx + rng*0.12;

  const y0 = H - ((0 - yMin) / (yMax - yMin)) * H;
  ctx.strokeStyle = '#2a2a2d'; ctx.lineWidth = 1;
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

  dom.resAxis.innerHTML = '<span>Anfang</span><span>Ende</span>';
}