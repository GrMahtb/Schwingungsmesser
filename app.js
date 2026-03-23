'use strict';

/* =========================
   KONFIG
========================= */
const SAMPLE_RATE = 60;          // Zielwert (Sensor ist nicht exakt konstant)
const WIN_SEC = 30;
const WINDOW_LEN = WIN_SEC * SAMPLE_RATE; // 1800
const FREQ_WIN_SEC = 2;
const FREQ_WIN = FREQ_WIN_SEC * SAMPLE_RATE;

const COLORS = { x:'#ff4444', y:'#00cc66', z:'#4499ff' };

// simple Leaks gegen Drift
const LEAK_V = 0.985;
const LEAK_P = 0.995;

/* =========================
   FILTER PRESETS
   hpAlpha: 0 => aus, sonst 1st-order Highpass
   lpAlpha: 1 => aus, sonst 1st-order Lowpass y=a*y+(1-a)*x
========================= */
const FILTERS = {
  raw:   { hpAlpha: 0.000, lpAlpha: 1.000, label:'Roh (kein Filter)' },
  hp1:   { hpAlpha: 0.900, lpAlpha: 1.000, label:'HP 1 Hz (Standard)' },
  bau:   { hpAlpha: 0.900, lpAlpha: 0.220, label:'Baustelle 1–25 Hz' },
  pfahl: { hpAlpha: 0.900, lpAlpha: 0.570, label:'Pfahlrammung 1–8 Hz' },
  verd:  { hpAlpha: 0.583, lpAlpha: 0.220, label:'Verdichter 8–25 Hz' },
  verk:  { hpAlpha: 0.900, lpAlpha: 0.380, label:'Verkehr 1–15 Hz' },
};

const OENORM = {
  vel: {
    hint: 'ÖNORM basiert auf Spitzenpartikelgeschwindigkeit (PPV) in mm/s.',
    bounds: [0, 5, 10, 20, 30],
    rows: [
      { id:'n0', range:'< 5 mm/s',     label:'Klasse I – keine Schäden zu erwarten' },
      { id:'n1', range:'5 – 10 mm/s',  label:'Klasse II – leichte kosmetische Schäden möglich' },
      { id:'n2', range:'10 – 20 mm/s', label:'Klasse III – leichte Schäden möglich' },
      { id:'n3', range:'20 – 30 mm/s', label:'Klasse IV – mittlere Schäden möglich' },
      { id:'n4', range:'> 30 mm/s',    label:'Klasse V – schwere Schäden möglich' },
    ]
  },
  acc: {
    hint: 'm/s²: Richtwerte (orientierend) aus mm/s bei Annahme f=10 Hz.',
    bounds: [0, 0.314, 0.628, 1.257, 1.885],
    rows: [
      { id:'n0', range:'< 0.31 m/s²',        label:'Klasse I – keine Schäden zu erwarten' },
      { id:'n1', range:'0.31 – 0.63 m/s²',   label:'Klasse II – leichte kosmetische Schäden möglich' },
      { id:'n2', range:'0.63 – 1.26 m/s²',   label:'Klasse III – leichte Schäden möglich' },
      { id:'n3', range:'1.26 – 1.89 m/s²',   label:'Klasse IV – mittlere Schäden möglich' },
      { id:'n4', range:'> 1.89 m/s²',        label:'Klasse V – schwere Schäden möglich' },
    ]
  },
  disp: {
    hint: 'mm: Richtwerte (orientierend) aus mm/s bei Annahme f=10 Hz.',
    bounds: [0, 0.0796, 0.1592, 0.3183, 0.4775],
    rows: [
      { id:'n0', range:'< 0.080 mm',       label:'Klasse I – keine Schäden zu erwarten' },
      { id:'n1', range:'0.080 – 0.159 mm', label:'Klasse II – leichte kosmetische Schäden möglich' },
      { id:'n2', range:'0.159 – 0.318 mm', label:'Klasse III – leichte Schäden möglich' },
      { id:'n3', range:'0.318 – 0.478 mm', label:'Klasse IV – mittlere Schäden möglich' },
      { id:'n4', range:'> 0.478 mm',       label:'Klasse V – schwere Schäden möglich' },
    ]
  },
  hz: {
    hint: 'Hz: dominante Frequenz (Zero-Crossing) – zur Plausibilisierung (ÖNORM gilt für mm/s).',
    bounds: null,
    rows: [
      { id:'n0', range:'1 – 8 Hz',  label:'Typisch: Pfahlrammung / langsame Erschütterung' },
      { id:'n1', range:'2 – 15 Hz', label:'Typisch: Bagger, Abbruch, Schwerlast-Verkehr' },
      { id:'n2', range:'8 – 25 Hz', label:'Typisch: Verdichter / Rüttelplatte' },
      { id:'n3', range:'> 25 Hz',   label:'Oft Rauschen/Sensor (baustellen-untypisch bei 60fps)' },
      { id:'n4', range:'< 1 Hz',    label:'DC/Drift (nicht als Schwingung interpretieren)' },
    ]
  }
};

/* =========================
   iOS / Standalone
========================= */
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent);
const IS_STANDALONE =
  window.matchMedia('(display-mode: standalone)').matches ||
  navigator.standalone === true;

/* =========================
   DOM
========================= */
const $ = (id) => document.getElementById(id);
const dom = {
  statusBar: $('statusBar'),

  // tabs/panes
  panes: () => document.querySelectorAll('.pane'),
  tabs:  () => document.querySelectorAll('.tab'),

  // controls
  startBtn: $('startBtn'),
  resetBtn: $('resetBtn'),
  iosPermBtn: $('iosPermBtn'),
  filterSelect: $('filterSelect'),

  // unit buttons
  unitBtns: () => document.querySelectorAll('.unitBtn'),

  // values
  mainNum: $('mainNum'),
  mainSub: $('mainSub'),
  xVal: $('xVal'), yVal: $('yVal'), zVal: $('zVal'), tVal: $('tVal'),
  peakVal: $('peakVal'), rmsVal: $('rmsVal'),
  freqVal: $('freqVal'),
  durVal: $('durVal'),

  // charts
  liveChart: $('liveChart'),
  resultChart: $('resultChart'),

  // debug
  debugPanel: $('debugPanel'),

  // oenorm
  oenormHint: $('oenormUnitHint'),
  oenormTable: $('oenormTable'),

  // results/export
  results: $('results'),
  resMeta: $('resMeta'),
  exportUnit: $('exportUnit'),
  csvBtn: $('csvBtn'),

  // pwa
  installBanner: $('installBanner'),
  installBtn: $('installBtn'),
};

const liveCtx = dom.liveChart.getContext('2d');
const resCtx  = dom.resultChart.getContext('2d');

/* =========================
   STATUS
========================= */
function setStatus(msg, cls) {
  if (!dom.statusBar) return;
  dom.statusBar.textContent = msg || '';
  dom.statusBar.className = 'statusBar' + (cls ? ' ' + cls : '');
  dom.statusBar.hidden = !msg;
}

function fmtTime(ms) {
  const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function unitLabel(u) {
  u = u || activeUnit;
  if (u === 'acc') return 'm/s²';
  if (u === 'disp') return 'mm';
  if (u === 'hz') return 'Hz';
  return 'mm/s';
}

/* =========================
   CANVAS RESIZE
========================= */
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
window.addEventListener('resize', () => setTimeout(initCanvases, 50));

/* =========================
   TABS (Click Handler)
========================= */
function initTabs() {
  dom.tabs().forEach(btn => {
    btn.addEventListener('click', () => {
      dom.tabs().forEach(b => b.classList.toggle('is-active', b === btn));
      dom.panes().forEach(p => {
        const on = (p.id === `tab-${btn.dataset.tab}`);
        p.classList.toggle('is-active', on);
        p.hidden = !on;
      });
      setTimeout(initCanvases, 80);
    });
  });
}

/* =========================
   ÖNORM table
========================= */
function buildOenormTable() {
  const cfg = OENORM[activeUnit] || OENORM.vel;
  if (dom.oenormHint) dom.oenormHint.textContent = cfg.hint;

  let html = '<tbody>';
  cfg.rows.forEach(r => html += `<tr id="${r.id}"><td>${r.range}</td><td>${r.label}</td></tr>`);
  html += '</tbody>';
  if (dom.oenormTable) dom.oenormTable.innerHTML = html;
}

function updateOenormHighlight(val) {
  const cfg = OENORM[activeUnit] || OENORM.vel;
  if (!cfg) return;

  // Hz special
  if (!cfg.bounds) {
    let activeId = null;
    if (val < 1) activeId = 'n4';
    else if (val <= 8) activeId = 'n0';
    else if (val <= 15) activeId = 'n1';
    else if (val <= 25) activeId = 'n2';
    else activeId = 'n3';

    cfg.rows.forEach(r => {
      const el = $(r.id);
      if (el) el.classList.toggle('is-active', r.id === activeId);
    });
    return;
  }

  let row = 0;
  for (let i = cfg.bounds.length - 1; i >= 0; i--) {
    if (val >= cfg.bounds[i]) { row = i; break; }
  }
  cfg.rows.forEach((r, i) => {
    const el = $(r.id);
    if (el) el.classList.toggle('is-active', i === row);
  });
}

/* =========================
   STATE
========================= */
let running = false;
let startTime = null;
let rafId = null;
let durTimer = null;
let noDataTimer = null;

let activeUnit = 'vel';
let activeFilter = 'hp1';

let motionEventCount = 0;
let rawX = 0, rawY = 0, rawZ = 0;

// filter state
const hp = { x:0, y:0, z:0, px:0, py:0, pz:0 };
const lp = { x:0, y:0, z:0 };

// integrator
const intg = { vx:0, vy:0, vz:0, px:0, py:0, pz:0, prev:null };

// buffers (wir speichern alle Einheiten parallel, damit Anzeige/Export stabil ist)
const buf = {
  ptr: 0, len: 0,
  vel: { x:new Float32Array(WINDOW_LEN), y:new Float32Array(WINDOW_LEN), z:new Float32Array(WINDOW_LEN), t:new Float32Array(WINDOW_LEN) },
  acc: { x:new Float32Array(WINDOW_LEN), y:new Float32Array(WINDOW_LEN), z:new Float32Array(WINDOW_LEN), t:new Float32Array(WINDOW_LEN) },
  disp:{ x:new Float32Array(WINDOW_LEN), y:new Float32Array(WINDOW_LEN), z:new Float32Array(WINDOW_LEN), t:new Float32Array(WINDOW_LEN) },
};

const freqBuf = { t:new Float32Array(FREQ_WIN), ptr:0, len:0 };
let domFreqHz = 0;

// peaks / rms pro Einheit (Total)
const stats = {
  vel:  { peak:0, sum2:0, cnt:0 },
  acc:  { peak:0, sum2:0, cnt:0 },
  disp: { peak:0, sum2:0, cnt:0 },
  hz:   { peak:0, sum:0,  cnt:0 },
};

let savedData = null;
let rec = null;

/* =========================
   FILTER + INTEGRATION
========================= */
function applyFilter(ax, ay, az) {
  const cfg = FILTERS[activeFilter] || FILTERS.hp1;

  // highpass
  let fx, fy, fz;
  if (cfg.hpAlpha <= 0.0001) {
    fx = ax; fy = ay; fz = az;
  } else {
    fx = cfg.hpAlpha * (hp.x + ax - hp.px);
    fy = cfg.hpAlpha * (hp.y + ay - hp.py);
    fz = cfg.hpAlpha * (hp.z + az - hp.pz);
    hp.x = fx; hp.y = fy; hp.z = fz;
    hp.px = ax; hp.py = ay; hp.pz = az;
  }

  // lowpass
  if (cfg.lpAlpha >= 0.999) return { fx, fy, fz };

  const a = cfg.lpAlpha;
  lp.x = a * lp.x + (1 - a) * fx;
  lp.y = a * lp.y + (1 - a) * fy;
  lp.z = a * lp.z + (1 - a) * fz;
  return { fx: lp.x, fy: lp.y, fz: lp.z };
}

function integrate(fx, fy, fz, dt) {
  intg.vx = (intg.vx + fx * dt) * LEAK_V;
  intg.vy = (intg.vy + fy * dt) * LEAK_V;
  intg.vz = (intg.vz + fz * dt) * LEAK_V;

  intg.px = (intg.px + intg.vx * dt) * LEAK_P;
  intg.py = (intg.py + intg.vy * dt) * LEAK_P;
  intg.pz = (intg.pz + intg.vz * dt) * LEAK_P;
}

function estimateFrequencyHz() {
  if (freqBuf.len < 8) return 0;
  let crossings = 0;
  let prev = freqBuf.t[(freqBuf.ptr - freqBuf.len + FREQ_WIN) % FREQ_WIN];
  for (let i = 1; i < freqBuf.len; i++) {
    const cur = freqBuf.t[(freqBuf.ptr - freqBuf.len + i + FREQ_WIN) % FREQ_WIN];
    if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) crossings++;
    prev = cur;
  }
  return (crossings / 2) / FREQ_WIN_SEC;
}

/* =========================
   UI UPDATE
========================= */
function setUnitUI() {
  const u = unitLabel(activeUnit);
  ['unitX','unitY','unitZ','unitT','unitPeak','unitRms'].forEach(id => {
    const el = $(id);
    if (el) el.textContent = u;
  });
  if (dom.mainSub) dom.mainSub.textContent = `${u} (Total)`;
  buildOenormTable();
}

function showValues({ x, y, z, t, peak, rms }) {
  dom.xVal.textContent = x.toFixed(2);
  dom.yVal.textContent = y.toFixed(2);
  dom.zVal.textContent = z.toFixed(2);
  dom.tVal.textContent = t.toFixed(2);
  dom.peakVal.textContent = peak.toFixed(2);
  dom.rmsVal.textContent = rms.toFixed(2);

  dom.mainNum.textContent = t.toFixed(2);
  dom.mainSub.textContent = `${unitLabel(activeUnit)} (Total)`;
}

/* =========================
   DRAW (3 Panels untereinander)
========================= */
function getCurrentSeriesKind() {
  // fürs Diagramm zeigen wir die Einheit der Anzeige (außer Hz -> vel plotten)
  if (activeUnit === 'hz') return 'vel';
  return activeUnit; // 'vel'|'acc'|'disp'
}

function drawMultiPanel(ctx, seriesKind) {
  const cvs = ctx.canvas;
  const W = cvs.getBoundingClientRect().width || 320;
  const H = cvs.getBoundingClientRect().height || 540;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  const axes = ['x','y','z'];
  const labels = ['X','Y','Z'];
  const panH = H / 3;
  const mL = 56, mR = 8, mT = 20, mB = 28;

  axes.forEach((s, pi) => {
    const offY = pi * panH;
    const pw = W - mL - mR;
    const ph = panH - mT - mB;

    ctx.fillStyle = (pi % 2 === 0) ? '#0b0b0c' : '#0d0d0f';
    ctx.fillRect(0, offY, W, panH);

    if (pi > 0) {
      ctx.strokeStyle = '#2a2a2d';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, offY); ctx.lineTo(W, offY); ctx.stroke();
    }

    if (buf.len < 2) {
      ctx.fillStyle = COLORS[s];
      ctx.font = 'bold 11px system-ui';
      ctx.fillText(labels[pi], 6, offY + mT + 10);
      return;
    }

    // min/max aus buffer
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < buf.len; i++) {
      const idx = (buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN;
      const v = buf[seriesKind][s][idx];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!isFinite(mn)) { mn = -1; mx = 1; }
    if (mn === mx) { mn -= 0.5; mx += 0.5; }
    const pad = (mx - mn) * 0.08;
    const yMin = mn - pad, yMax = mx + pad;
    const span = (yMax - yMin) || 1;

    const toY = (v) => offY + mT + ph - ((v - yMin) / span) * ph;

    // grid
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const gy = offY + mT + (g/4)*ph;
      ctx.strokeStyle = '#1e1e22';
      ctx.beginPath(); ctx.moveTo(mL, gy); ctx.lineTo(mL+pw, gy); ctx.stroke();
    }
    for (let g = 0; g <= 6; g++) {
      const gx = mL + (g/6)*pw;
      ctx.strokeStyle = '#1a1a1e';
      ctx.beginPath(); ctx.moveTo(gx, offY+mT); ctx.lineTo(gx, offY+mT+ph); ctx.stroke();
    }

    // zero line
    const y0 = toY(0);
    if (y0 >= offY+mT && y0 <= offY+mT+ph) {
      ctx.strokeStyle = '#3a3a42';
      ctx.beginPath(); ctx.moveTo(mL, y0); ctx.lineTo(mL+pw, y0); ctx.stroke();
    }

    // labels
    ctx.fillStyle = COLORS[s];
    ctx.font = 'bold 11px system-ui';
    ctx.fillText(labels[pi], 6, offY + mT + 10);

    ctx.fillStyle = '#5a5a62';
    ctx.font = '9px system-ui';
    ctx.fillText(unitLabel(seriesKind), 6, offY + mT + 22);

    // time labels bottom only
    if (pi === 2) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#5a5a62';
      ctx.font = '9px system-ui';
      for (let g = 0; g <= 6; g++) {
        const sec = -WIN_SEC + (g/6)*WIN_SEC;
        const gx = mL + (g/6)*pw;
        ctx.fillText(`${sec.toFixed(0)}s`, gx, offY + mT + ph + 18);
      }
      ctx.textAlign = 'left';
    }

    // curve
    ctx.strokeStyle = COLORS[s];
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < buf.len; i++) {
      const idx = (buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN;
      const xp = mL + (i/(WINDOW_LEN-1))*pw;
      const yp = toY(buf[seriesKind][s][idx]);
      i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
    }
    ctx.stroke();
  });
}

function drawLive() {
  drawMultiPanel(liveCtx, getCurrentSeriesKind());
}

function drawResult(data) {
  // data ist savedData: enthält arrays und unit-keys
  const seriesKind = (data.displayUnit === 'hz') ? 'vel' : data.displayUnit;

  // temporär buf-like Zugriff auf arrays bauen:
  const tmp = {
    len: data.n,
    ptr: data.n % WINDOW_LEN,
    vel: data.vel,
    acc: data.acc,
    disp: data.disp
  };

  // wir nutzen eine vereinfachte renderer-Variante (ohne Ringpuffer)
  const ctx = resCtx;
  const cvs = ctx.canvas;
  const W = cvs.getBoundingClientRect().width || 320;
  const H = cvs.getBoundingClientRect().height || 540;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  const axes = ['x','y','z'];
  const labels = ['X','Y','Z'];
  const panH = H/3;
  const mL = 56, mR = 8, mT = 20, mB = 28;

  axes.forEach((s, pi) => {
    const offY = pi*panH;
    const pw = W - mL - mR;
    const ph = panH - mT - mB;

    ctx.fillStyle = (pi % 2 === 0) ? '#0b0b0c' : '#0d0d0f';
    ctx.fillRect(0, offY, W, panH);

    if (pi > 0) {
      ctx.strokeStyle = '#2a2a2d';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, offY); ctx.lineTo(W, offY); ctx.stroke();
    }

    const arr = tmp[seriesKind][s];
    if (!arr || arr.length < 2) return;

    let mn = Infinity, mx = -Infinity;
    for (const v of arr) { if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mn === mx) { mn -= 0.5; mx += 0.5; }
    const pad = (mx - mn) * 0.08;
    const yMin = mn - pad, yMax = mx + pad;
    const span = (yMax - yMin) || 1;
    const toY = (v) => offY + mT + ph - ((v - yMin)/span)*ph;

    // grid
    ctx.lineWidth = 1;
    for (let g=0; g<=4; g++){
      const gy = offY + mT + (g/4)*ph;
      ctx.strokeStyle = '#1e1e22';
      ctx.beginPath(); ctx.moveTo(mL, gy); ctx.lineTo(mL+pw, gy); ctx.stroke();
    }
    for (let g=0; g<=6; g++){
      const gx = mL + (g/6)*pw;
      ctx.strokeStyle = '#1a1a1e';
      ctx.beginPath(); ctx.moveTo(gx, offY+mT); ctx.lineTo(gx, offY+mT+ph); ctx.stroke();
    }

    const y0 = toY(0);
    if (y0 >= offY+mT && y0 <= offY+mT+ph) {
      ctx.strokeStyle = '#3a3a42';
      ctx.beginPath(); ctx.moveTo(mL, y0); ctx.lineTo(mL+pw, y0); ctx.stroke();
    }

    // labels
    ctx.fillStyle = COLORS[s];
    ctx.font = 'bold 11px system-ui';
    ctx.fillText(labels[pi], 6, offY + mT + 10);

    ctx.fillStyle = '#5a5a62';
    ctx.font = '9px system-ui';
    ctx.fillText(unitLabel(seriesKind), 6, offY + mT + 22);

    if (pi === 2) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#5a5a62';
      ctx.font = '9px system-ui';
      for (let g=0; g<=6; g++){
        const t = (data.durationSec * g / 6).toFixed(1);
        const gx = mL + (g/6)*pw;
        ctx.fillText(`${t}s`, gx, offY + mT + ph + 18);
      }
      ctx.textAlign = 'left';
    }

    // curve
    ctx.strokeStyle = COLORS[s];
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    arr.forEach((v, i) => {
      const xp = mL + (i/(arr.length-1))*pw;
      const yp = toY(v);
      i===0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
    });
    ctx.stroke();
  });
}

/* =========================
   SENSOR
========================= */
function onMotion(e) {
  motionEventCount++;
  const a = (
    e.acceleration &&
    e.acceleration.x != null &&
    e.acceleration.y != null &&
    e.acceleration.z != null
  ) ? e.acceleration : e.accelerationIncludingGravity;

  if (!a) return;
  rawX = Number(a.x) || 0;
  rawY = Number(a.y) || 0;
  rawZ = Number(a.z) || 0;
}
window.addEventListener('devicemotion', onMotion, { passive:true });

/* =========================
   RESET / START / STOP
========================= */
function resetStats() {
  for (const k of ['vel','acc','disp']) {
    stats[k].peak = 0;
    stats[k].sum2 = 0;
    stats[k].cnt = 0;
  }
  stats.hz.peak = 0; stats.hz.sum = 0; stats.hz.cnt = 0;
}

function resetState() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  if (durTimer) clearInterval(durTimer);
  durTimer = null;

  if (noDataTimer) clearTimeout(noDataTimer);
  noDataTimer = null;

  startTime = null;
  motionEventCount = 0;

  buf.ptr = 0; buf.len = 0;
  ['vel','acc','disp'].forEach(kind => {
    buf[kind].x.fill(0); buf[kind].y.fill(0); buf[kind].z.fill(0); buf[kind].t.fill(0);
  });

  freqBuf.ptr = 0; freqBuf.len = 0; freqBuf.t.fill(0);
  domFreqHz = 0;

  hp.x=hp.y=hp.z=0; hp.px=hp.py=hp.pz=0;
  lp.x=lp.y=lp.z=0;

  intg.vx=intg.vy=intg.vz=0;
  intg.px=intg.py=intg.pz=0;
  intg.prev=null;

  resetStats();

  savedData = null;
  rec = null;

  dom.startBtn.textContent = 'Start';
  dom.startBtn.classList.add('btn--accent');
  dom.startBtn.classList.remove('btn--stop');

  dom.results.hidden = true;
  dom.resMeta.textContent = '—';

  dom.durVal.textContent = '00:00';
  dom.freqVal.textContent = '—';

  dom.mainNum.textContent = '0.00';
  dom.mainSub.textContent = `${unitLabel(activeUnit)} (Total)`;

  dom.xVal.textContent = '0.00';
  dom.yVal.textContent = '0.00';
  dom.zVal.textContent = '0.00';
  dom.tVal.textContent = '0.00';
  dom.peakVal.textContent = '0.00';
  dom.rmsVal.textContent = '0.00';

  dom.debugPanel.textContent = 'Warte auf Sensor-Daten …';

  dom.unitBtns().forEach(b => b.disabled = false);

  setStatus('', '');
  buildOenormTable();
  drawLive();
}

function startMeasurement() {
  if (running) return;

  // iOS permission requirement
  if (IS_IOS &&
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function' &&
      motionEventCount === 0) {
    setStatus('iPhone: erst „iOS Sensorerlaubnis" drücken.', 'is-error');
    return;
  }

  resetState();
  running = true;
  startTime = Date.now();

  dom.unitBtns().forEach(b => b.disabled = true);

  rec = {
    startTs: startTime,
    filter: activeFilter,
    // speichern alle Einheiten + freq
    vel: { x:[], y:[], z:[], t:[] },
    acc: { x:[], y:[], z:[], t:[] },
    disp:{ x:[], y:[], z:[], t:[] },
    freq: [],
    t0: performance.now(),
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

  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  if (durTimer) clearInterval(durTimer);
  durTimer = null;

  if (noDataTimer) clearTimeout(noDataTimer);
  noDataTimer = null;

  dom.unitBtns().forEach(b => b.disabled = false);

  dom.startBtn.textContent = 'Start';
  dom.startBtn.classList.add('btn--accent');
  dom.startBtn.classList.remove('btn--stop');

  setStatus('Messung abgeschlossen ✓', 'is-done');

  if (rec && rec.vel.t.length > 10) {
    const durationSec = (performance.now() - rec.t0) / 1000;
    savedData = {
      startTs: rec.startTs,
      durationSec,
      n: rec.vel.t.length,
      filter: rec.filter,
      vel: { x: rec.vel.x, y: rec.vel.y, z: rec.vel.z, t: rec.vel.t },
      acc: { x: rec.acc.x, y: rec.acc.y, z: rec.acc.z, t: rec.acc.t },
      disp:{ x: rec.disp.x,y: rec.disp.y,z: rec.disp.z,t: rec.disp.t },
      freq: rec.freq,
      displayUnit: (dom.exportUnit ? dom.exportUnit.value : activeUnit),
    };

    dom.results.hidden = false;
    dom.resMeta.textContent =
      `${new Date(savedData.startTs).toLocaleString('de-DE')} · ` +
      `Dauer: ${savedData.durationSec.toFixed(1)} s · ` +
      `Punkte: ${savedData.n} · ` +
      `Filter: ${FILTERS[savedData.filter]?.label || savedData.filter}`;

    setTimeout(() => { initCanvases(); drawResult(savedData); }, 80);
  }
  rec = null;
}

dom.startBtn.addEventListener('click', () => running ? stopMeasurement() : startMeasurement());
dom.resetBtn.addEventListener('click', resetState);

/* =========================
   LOOP
========================= */
function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  const now = performance.now();
  const dt = Math.min((now - (intg.prev ?? now)) / 1000, 0.05);
  intg.prev = now;

  const { fx, fy, fz } = applyFilter(rawX, rawY, rawZ);
  integrate(fx, fy, fz, dt);

  // ACC total
  const accT = Math.sqrt(fx*fx + fy*fy + fz*fz);

  // VEL mm/s
  const velX = intg.vx * 1000;
  const velY = intg.vy * 1000;
  const velZ = intg.vz * 1000;
  const velT = Math.sqrt(velX*velX + velY*velY + velZ*velZ);

  // DISP mm
  const dispX = intg.px * 1000;
  const dispY = intg.py * 1000;
  const dispZ = intg.pz * 1000;
  const dispT = Math.sqrt(dispX*dispX + dispY*dispY + dispZ*dispZ);

  // freq buffer uses velT
  freqBuf.t[freqBuf.ptr] = velT;
  freqBuf.ptr = (freqBuf.ptr + 1) % FREQ_WIN;
  if (freqBuf.len < FREQ_WIN) freqBuf.len++;

  if (buf.ptr % 30 === 0) domFreqHz = estimateFrequencyHz();
  if (domFreqHz > stats.hz.peak) stats.hz.peak = domFreqHz;
  stats.hz.sum += domFreqHz; stats.hz.cnt++;

  // store into ring buffer
  buf.acc.x[buf.ptr] = fx;   buf.acc.y[buf.ptr] = fy;   buf.acc.z[buf.ptr] = fz;   buf.acc.t[buf.ptr] = accT;
  buf.vel.x[buf.ptr] = velX; buf.vel.y[buf.ptr] = velY; buf.vel.z[buf.ptr] = velZ; buf.vel.t[buf.ptr] = velT;
  buf.disp.x[buf.ptr]= dispX;buf.disp.y[buf.ptr]= dispY;buf.disp.z[buf.ptr]= dispZ;buf.disp.t[buf.ptr]= dispT;

  buf.ptr = (buf.ptr + 1) % WINDOW_LEN;
  if (buf.len < WINDOW_LEN) buf.len++;

  // stats peak/rms for the three physical units (total)
  // vel
  stats.vel.peak = Math.max(stats.vel.peak, velT);
  stats.vel.sum2 += velT*velT; stats.vel.cnt++;
  // acc
  stats.acc.peak = Math.max(stats.acc.peak, accT);
  stats.acc.sum2 += accT*accT; stats.acc.cnt++;
  // disp
  stats.disp.peak = Math.max(stats.disp.peak, dispT);
  stats.disp.sum2 += dispT*dispT; stats.disp.cnt++;

  // display depending on unit
  if (activeUnit === 'hz') {
    const avgHz = stats.hz.cnt ? (stats.hz.sum / stats.hz.cnt) : 0;
    dom.freqVal.textContent = domFreqHz ? domFreqHz.toFixed(1) : '—';
    showValues({ x:domFreqHz, y:domFreqHz, z:domFreqHz, t:domFreqHz, peak:stats.hz.peak, rms:avgHz });
    updateOenormHighlight(domFreqHz);
  } else if (activeUnit === 'acc') {
    dom.freqVal.textContent = domFreqHz ? domFreqHz.toFixed(1) : '—';
    const rms = stats.acc.cnt ? Math.sqrt(stats.acc.sum2 / stats.acc.cnt) : 0;
    showValues({ x:fx, y:fy, z:fz, t:accT, peak:stats.acc.peak, rms });
    updateOenormHighlight(stats.acc.peak);
  } else if (activeUnit === 'disp') {
    dom.freqVal.textContent = domFreqHz ? domFreqHz.toFixed(1) : '—';
    const rms = stats.disp.cnt ? Math.sqrt(stats.disp.sum2 / stats.disp.cnt) : 0;
    showValues({ x:dispX, y:dispY, z:dispZ, t:dispT, peak:stats.disp.peak, rms });
    updateOenormHighlight(stats.disp.peak);
  } else { // vel
    dom.freqVal.textContent = domFreqHz ? domFreqHz.toFixed(1) : '—';
    const rms = stats.vel.cnt ? Math.sqrt(stats.vel.sum2 / stats.vel.cnt) : 0;
    showValues({ x:velX, y:velY, z:velZ, t:velT, peak:stats.vel.peak, rms });
    updateOenormHighlight(stats.vel.peak);
  }

  drawLive();

  dom.debugPanel.textContent =
    `raw  ax=${rawX.toFixed(3)} ay=${rawY.toFixed(3)} az=${rawZ.toFixed(3)} m/s²\n` +
    `filt fx=${fx.toFixed(3)} fy=${fy.toFixed(3)} fz=${fz.toFixed(3)} m/s² | filter=${activeFilter}\n` +
    `vel  x=${velX.toFixed(2)} y=${velY.toFixed(2)} z=${velZ.toFixed(2)} total=${velT.toFixed(2)} mm/s\n` +
    `disp x=${dispX.toFixed(3)} y=${dispY.toFixed(3)} z=${dispZ.toFixed(3)} total=${dispT.toFixed(3)} mm\n` +
    `freq=${domFreqHz.toFixed(1)} Hz | dt=${(dt*1000).toFixed(1)} ms`;

  // record (limit to avoid runaway)
  if (rec && rec.vel.t.length < 12000) {
    rec.vel.x.push(velX); rec.vel.y.push(velY); rec.vel.z.push(velZ); rec.vel.t.push(velT);
    rec.acc.x.push(fx);   rec.acc.y.push(fy);   rec.acc.z.push(fz);   rec.acc.t.push(accT);
    rec.disp.x.push(dispX);rec.disp.y.push(dispY);rec.disp.z.push(dispZ);rec.disp.t.push(dispT);
    rec.freq.push(domFreqHz);
  }
}

/* =========================
   UNIT BUTTONS / FILTER SELECT
========================= */
dom.unitBtns().forEach(btn => {
  btn.addEventListener('click', () => {
    activeUnit = btn.dataset.unit;
    dom.unitBtns().forEach(b => b.classList.toggle('is-active', b === btn));
    setUnitUI();
  });
});

dom.filterSelect?.addEventListener('change', () => {
  activeFilter = dom.filterSelect.value;
  // reset filter state to avoid jump
  hp.x=hp.y=hp.z=0; hp.px=hp.py=hp.pz=0;
  lp.x=lp.y=lp.z=0;
});

/* =========================
   CSV EXPORT (inkl. Hz)
========================= */
function exportCSV() {
  if (!savedData) return;
  const expUnit = dom.exportUnit ? dom.exportUnit.value : 'vel';
  const u = unitLabel(expUnit);

  const n = savedData.n;
  const dt = savedData.durationSec / Math.max(1, n-1);

  let csv = `# HTB Schwingungsmesser Export\n`;
  csv += `# Start: ${new Date(savedData.startTs).toLocaleString('de-DE')}\n`;
  csv += `# Dauer: ${savedData.durationSec.toFixed(2)} s\n`;
  csv += `# Filter: ${FILTERS[savedData.filter]?.label || savedData.filter}\n`;
  csv += `# ExportUnit: ${expUnit} (${u})\n#\n`;

  if (expUnit === 'hz') {
    csv += `i;time_s;freq_Hz\n`;
    for (let i=0;i<n;i++){
      csv += `${i};${(i*dt).toFixed(4)};${(savedData.freq[i]||0).toFixed(3)}\n`;
    }
  } else {
    const src = savedData[expUnit]; // vel/acc/disp
    csv += `i;time_s;x_${u};y_${u};z_${u};total_${u};freq_Hz\n`;
    for (let i=0;i<n;i++){
      csv += `${i};${(i*dt).toFixed(4)};` +
        `${src.x[i].toFixed(6)};${src.y[i].toFixed(6)};${src.z[i].toFixed(6)};${src.t[i].toFixed(6)};` +
        `${(savedData.freq[i]||0).toFixed(3)}\n`;
    }
  }

  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `HTB_Messung_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
dom.csvBtn?.addEventListener('click', exportCSV);

dom.exportUnit?.addEventListener('change', () => {
  if (!savedData) return;
  savedData.displayUnit = dom.exportUnit.value;
  setTimeout(() => drawResult(savedData), 50);
});

/* =========================
   iOS PERMISSION BUTTON
========================= */
if (IS_IOS &&
    typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function') {
  dom.iosPermBtn.hidden = false;
  dom.iosPermBtn.addEventListener('click', async () => {
    try {
      const res = await DeviceMotionEvent.requestPermission();
      if (res === 'granted') {
        dom.iosPermBtn.hidden = true;
        setStatus('Sensorerlaubnis erteilt – jetzt Start drücken.', 'is-done');
      } else {
        setStatus('Sensorerlaubnis verweigert!', 'is-error');
      }
    } catch (err) {
      setStatus('Fehler: ' + err.message, 'is-error');
    }
  });
}

/* =========================
   PWA INSTALL (Android)
========================= */
(() => {
  let deferredPrompt = null;

  if (IS_STANDALONE) {
    dom.installBanner.hidden = true;
    return;
  }

  if (IS_IOS) {
    dom.installBanner.hidden = false;
    dom.installBtn.textContent = 'Anleitung';
    dom.installBtn.onclick = () => {
      setStatus('iPhone: Safari → Teilen (□↑) → „Zum Home-Bildschirm"', 'is-error');
    };
    return;
  }

  dom.installBanner.hidden = true;
  dom.installBtn.disabled = true;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    dom.installBanner.hidden = false;
    dom.installBtn.disabled = false;
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
    dom.installBtn.disabled = true;
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    dom.installBanner.hidden = true;
    dom.installBtn.disabled = true;
  });
})();

/* =========================
   SERVICE WORKER
========================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* =========================
   INIT
========================= */
initTabs();
buildOenormTable();
setUnitUI();
resetState();
setTimeout(initCanvases, 150);
