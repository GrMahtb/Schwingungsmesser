'use strict';
console.log('APP VERSION v2026-03-26-event-driven loaded');

// ===================== KONFIG =====================
const SAMPLE_RATE = 100; // Erhöht: Android liefert oft 100 Hz, besser als 60
const WIN_SEC     = 30;
const WINDOW_LEN  = WIN_SEC * SAMPLE_RATE;

const FREQ_WIN_SEC = 2;
const FREQ_WIN     = FREQ_WIN_SEC * SAMPLE_RATE;
const FREQ_UPDATE_EVERY_N_FRAMES = 10;

const COLORS = { x:'#ff4444', y:'#00cc66', z:'#4499ff' };

// Leak-Faktor: jetzt als "pro Sekunde" definiert, wird per dt skaliert.
// 0.406 /s = entspricht dem alten 0.985^60 (gleiche Zeitkonstante ~1.1 s)
const LEAK_V_PER_SEC = 0.406;

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
      { id:'n0', range:'< 0.31 m/s²',      label:'Klasse I – keine Schäden zu erwarten' },
      { id:'n1', range:'0.31 – 0.63 m/s²', label:'Klasse II – leichte kosmetische Schäden möglich' },
      { id:'n2', range:'0.63 – 1.26 m/s²', label:'Klasse III – leichte Schäden möglich' },
      { id:'n3', range:'1.26 – 1.89 m/s²', label:'Klasse IV – mittlere Schäden möglich' },
      { id:'n4', range:'> 1.89 m/s²',      label:'Klasse V – schwere Schäden möglich' },
    ]
  },
  hz: {
    hint: 'Hz: dominante Frequenz (Zero‑Crossing) aus vel(t) der letzten 2 s.',
    bounds: null,
    rows: [
      { id:'n0', range:'1 – 8 Hz',  label:'Typisch: Pfahlrammung / langsame Erschütterung' },
      { id:'n1', range:'2 – 15 Hz', label:'Typisch: Bagger, Abbruch, Schwerlast‑Verkehr' },
      { id:'n2', range:'8 – 25 Hz', label:'Typisch: Verdichter / Rüttelplatte' },
      { id:'n3', range:'> 25 Hz',   label:'Oft Rauschen / Sensor-Artefakt (bei 60 fps)' },
      { id:'n4', range:'< 1 Hz',    label:'DC / Drift – keine Schwingung' },
    ]
  },
};

// ===================== iOS / PWA =====================
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent);
const IS_STANDALONE =
  window.matchMedia('(display-mode: standalone)').matches ||
  navigator.standalone === true;

// ===================== DOM =====================
const $ = (id) => document.getElementById(id);

const dom = {
  statusBar:     $('statusBar'),
  startBtn:      $('startBtn'),
  resetBtn:      $('resetBtn'),
  iosPermBtn:    $('iosPermBtn'),
  filterSelect:  $('filterSelect'),
  filterLabel:   $('filterLabel'),
  mainNum:       $('mainNum'),
  mainSub:       $('mainSub'),
  xVal:          $('xVal'),
  yVal:          $('yVal'),
  zVal:          $('zVal'),
  tVal:          $('tVal'),
  peakVal:       $('peakVal'),
  rmsVal:        $('rmsVal'),
  freqVal:       $('freqVal'),
  durVal:        $('durVal'),
  liveTimer:     $('liveTimer'),
  liveChart:     $('liveChart'),
  resultChart:   $('resultChart'),
  debugPanel:    $('debugPanel'),
  oenormHint:    $('oenormUnitHint'),
  oenormTable:   $('oenormTable'),
  results:       $('results'),
  resMeta:       $('resMeta'),
  exportUnit:    $('exportUnit'),
  csvBtn:        $('csvBtn'),
  pdfBtn:        $('pdfBtn'),
  installBanner: $('installBanner'),
  installBtn:    $('installBtn'),
};

const liveCtx = dom.liveChart?.getContext('2d');
const resCtx  = dom.resultChart?.getContext('2d');

// ===================== HELPER =====================
function setStatus(msg, cls) {
  if (!dom.statusBar) return;
  dom.statusBar.textContent = msg || '';
  dom.statusBar.className   = 'statusBar' + (cls ? ' ' + cls : '');
  dom.statusBar.hidden      = !msg;
}

function fmtTime(ms) {
  const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function unitLabel(u) {
  if (u === 'acc') return 'm/s²';
  if (u === 'hz')  return 'Hz';
  return 'mm/s';
}

function resizeCanvas(cvs) {
  if (!cvs) return;
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
window.addEventListener('resize', () => setTimeout(initCanvases, 80));

// ===================== TABS =====================
function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b =>
        b.classList.toggle('is-active', b === btn)
      );
      document.querySelectorAll('.pane').forEach(p => {
        const on = (p.id === `tab-${btn.dataset.tab}`);
        p.classList.toggle('is-active', on);
        p.hidden = !on;
      });
      setTimeout(initCanvases, 120);
    });
  });
}

// ===================== ÖNORM TABLE =====================
function buildOenormTable() {
  const cfg = OENORM[activeUnit] || OENORM.vel;
  if (dom.oenormHint)  dom.oenormHint.textContent = cfg.hint;

  let html = '<tbody>';
  cfg.rows.forEach(r =>
    html += `<tr id="${r.id}"><td>${r.range}</td><td>${r.label}</td></tr>`
  );
  html += '</tbody>';
  if (dom.oenormTable) dom.oenormTable.innerHTML = html;
}

function updateOenormHighlight(val) {
  const cfg = OENORM[activeUnit] || OENORM.vel;

  if (!cfg.bounds) {
    let activeId = null;
    if      (val < 1)   activeId = 'n4';
    else if (val <= 8)  activeId = 'n0';
    else if (val <= 15) activeId = 'n1';
    else if (val <= 25) activeId = 'n2';
    else                activeId = 'n3';

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

// ===================== STATE =====================
let running          = false;
let startTime        = null;
let rafId            = null;
let durTimer         = null;
let noDataTimer      = null;
let activeUnit       = 'vel';
let activeFilter     = dom.filterSelect?.value || 'hp1';
let motionEventCount = 0;
let rawX = 0, rawY = 0, rawZ = 0; // nur für Debug-Panel

// Filter-Zustand
const hp = { x:0, y:0, z:0, px:0, py:0, pz:0 };
const lp = { x:0, y:0, z:0 };

// Integrator
const intg = { vx:0, vy:0, vz:0 };

// Ringbuffer
const ring = {
  ptr: 0, len: 0,
  vel: {
    x: new Float32Array(WINDOW_LEN),
    y: new Float32Array(WINDOW_LEN),
    z: new Float32Array(WINDOW_LEN),
    t: new Float32Array(WINDOW_LEN),
  },
  acc: {
    x: new Float32Array(WINDOW_LEN),
    y: new Float32Array(WINDOW_LEN),
    z: new Float32Array(WINDOW_LEN),
    t: new Float32Array(WINDOW_LEN),
  },
  hz: {
    x: new Float32Array(WINDOW_LEN),
    y: new Float32Array(WINDOW_LEN),
    z: new Float32Array(WINDOW_LEN),
    t: new Float32Array(WINDOW_LEN),
  },
};

// Frequenz-Fenster für Zero-Crossing
const freqWin = {
  ptr: 0, len: 0,
  x: new Float32Array(FREQ_WIN),
  y: new Float32Array(FREQ_WIN),
  z: new Float32Array(FREQ_WIN),
  t: new Float32Array(FREQ_WIN),
};

let hzNow = { x:0, y:0, z:0, t:0 };
let hzFrameCounter = 0;

// Stats
const stats = {
  vel: { peak:0, sum2:0, cnt:0 },
  acc: { peak:0, sum2:0, cnt:0 },
  hz:  { peak:0, sum:0,  cnt:0 },
};

// Letzte Werte für Anzeige
let last = {
  vel: { x:0, y:0, z:0, t:0, rms:0, peak:0 },
  acc: { x:0, y:0, z:0, t:0, rms:0, peak:0 },
  hz:  { x:0, y:0, z:0, t:0, rms:0, peak:0 },
};

let savedData = null;
let rec       = null;

// ===================== FILTER + INTEGRATION =====================
function applyFilter(ax, ay, az) {
  const cfg = FILTERS[activeFilter] || FILTERS.hp1;

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

  if (cfg.lpAlpha >= 0.999) return { fx, fy, fz };
  const a = cfg.lpAlpha;
  lp.x = a * lp.x + (1 - a) * fx;
  lp.y = a * lp.y + (1 - a) * fy;
  lp.z = a * lp.z + (1 - a) * fz;
  return { fx: lp.x, fy: lp.y, fz: lp.z };
}

function integrate(fx, fy, fz, dt) {
  // Leak-Faktor wird per dt skaliert → Zeitkonstante unabhängig von Sample-Rate
  const leak = Math.pow(LEAK_V_PER_SEC, dt);
  intg.vx = (intg.vx + fx * dt) * leak;
  intg.vy = (intg.vy + fy * dt) * leak;
  intg.vz = (intg.vz + fz * dt) * leak;
}

// Zero-Crossing Frequenz-Schätzung
function estimateHzFromWindow(arr, len, ptr) {
  if (len < 10) return 0;

  let meanAbs = 0;
  for (let i = 0; i < len; i++) {
    meanAbs += Math.abs(arr[(ptr - len + i + FREQ_WIN) % FREQ_WIN]);
  }
  meanAbs /= len;
  if (meanAbs < 0.15) return 0;

  const eps = 0.05;
  let crossings = 0;
  let prev = arr[(ptr - len + FREQ_WIN) % FREQ_WIN];

  for (let i = 1; i < len; i++) {
    const cur = arr[(ptr - len + i + FREQ_WIN) % FREQ_WIN];
    const p = Math.abs(prev) < eps ? 0 : prev;
    const c = Math.abs(cur)  < eps ? 0 : cur;
    if ((p < 0 && c > 0) || (p > 0 && c < 0)) crossings++;
    prev = cur;
  }
  return (crossings / 2) / FREQ_WIN_SEC;
}

// ===================== DISPLAY =====================
function renderFromLast() {
  if (!dom.mainNum) return;

  const u    = unitLabel(activeUnit);
  const pack = last[activeUnit];

  ['unitX','unitY','unitZ','unitT','unitPeak','unitRms'].forEach(id => {
    const el = $(id);
    if (el) el.textContent = u;
  });

  dom.xVal.textContent    = pack.x.toFixed(2);
  dom.yVal.textContent    = pack.y.toFixed(2);
  dom.zVal.textContent    = pack.z.toFixed(2);
  dom.tVal.textContent    = pack.t.toFixed(2);
  dom.peakVal.textContent = pack.peak.toFixed(2);
  dom.rmsVal.textContent  = pack.rms.toFixed(2);

  dom.mainNum.textContent = pack.t.toFixed(2);
  dom.mainSub.textContent = (activeUnit === 'hz')
    ? 'Hz (Total dominant)'
    : `${u} (Total)`;

  if (dom.freqVal) dom.freqVal.textContent = hzNow.t ? hzNow.t.toFixed(1) : '—';

  updateOenormHighlight(activeUnit === 'hz' ? pack.t : pack.peak);
}

function setUnitUI() {
  buildOenormTable();
  renderFromLast();
  drawLive();
}

// ===================== DRAW – 3 PANELS =====================
function drawMultiPanel(ctx, kind, source) {
  const cvs = ctx.canvas;
  const W   = cvs.getBoundingClientRect().width  || 320;
  const H   = cvs.getBoundingClientRect().height || 540;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  const axes   = ['x', 'y', 'z'];
  const labels = ['X', 'Y', 'Z'];
  const panH   = H / 3;
  const mL = 60, mR = 10, mT = 18, mB = 28;

  axes.forEach((s, pi) => {
    const offY = pi * panH;
    const pw   = W - mL - mR;
    const ph   = panH - mT - mB;

    ctx.fillStyle = (pi % 2 === 0) ? '#0b0b0c' : '#0d0d0f';
    ctx.fillRect(0, offY, W, panH);

    if (pi > 0) {
      ctx.strokeStyle = '#2a2a2d';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(0, offY); ctx.lineTo(W, offY);
      ctx.stroke();
    }

    const n = source.len;
    if (n < 2) {
      ctx.fillStyle = COLORS[s];
      ctx.font      = 'bold 11px system-ui';
      ctx.fillText(labels[pi], 6, offY + mT + 10);
      return;
    }

    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = source.get(kind, s, i);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!isFinite(mn)) { mn = -1; mx = 1; }
    if (mn === mx)     { mn -= 0.5; mx += 0.5; }

    const pad  = (mx - mn) * 0.10;
    const yMin = mn - pad;
    const yMax = mx + pad;
    const span = (yMax - yMin) || 1;
    const toY  = (v) => offY + mT + ph - ((v - yMin) / span) * ph;

    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      ctx.strokeStyle = '#1e1e22';
      const gy = offY + mT + (g / 4) * ph;
      ctx.beginPath(); ctx.moveTo(mL, gy); ctx.lineTo(mL + pw, gy); ctx.stroke();
    }
    for (let g = 0; g <= 6; g++) {
      ctx.strokeStyle = '#1a1a1e';
      const gx = mL + (g / 6) * pw;
      ctx.beginPath();
      ctx.moveTo(gx, offY + mT); ctx.lineTo(gx, offY + mT + ph);
      ctx.stroke();
    }

    const y0 = toY(0);
    if (y0 >= offY + mT && y0 <= offY + mT + ph) {
      ctx.strokeStyle = '#3a3a42';
      ctx.beginPath(); ctx.moveTo(mL, y0); ctx.lineTo(mL + pw, y0); ctx.stroke();
    }

    ctx.fillStyle   = '#6c6c74';
    ctx.font        = '9px system-ui';
    ctx.textAlign   = 'right';
    const yMid = (yMin + yMax) / 2;
    [yMax, yMid, yMin].forEach(v => {
      const yy = toY(v);
      ctx.fillText(v.toFixed(2), mL - 4, yy + 3);
    });
    ctx.textAlign = 'left';

    ctx.fillStyle = COLORS[s];
    ctx.font      = 'bold 11px system-ui';
    ctx.fillText(labels[pi], 6, offY + mT + 10);

    ctx.fillStyle = '#6c6c74';
    ctx.font      = '9px system-ui';
    ctx.fillText(unitLabel(kind), 6, offY + mT + 22);

    if (pi === 2) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#6c6c74';
      ctx.font      = '9px system-ui';
      for (let g = 0; g <= 6; g++) {
        const sec = -WIN_SEC + (g / 6) * WIN_SEC;
        const gx  = mL + (g / 6) * pw;
        ctx.fillText(`${sec.toFixed(0)}s`, gx, offY + mT + ph + 18);
      }
      ctx.textAlign = 'left';
    }

    ctx.strokeStyle = COLORS[s];
    ctx.lineWidth   = 1.8;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v  = source.get(kind, s, i);
      const xp = mL + (i / (n - 1)) * pw;
      const yp = toY(v);
      i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
    }
    ctx.stroke();
  });
}

function drawLive() {
  if (!liveCtx) return;
  const kind = activeUnit;
  const src  = {
    len: ring.len,
    get: (k, axis, i) => {
      const idx = (ring.ptr - ring.len + i + WINDOW_LEN) % WINDOW_LEN;
      return ring[k][axis][idx];
    }
  };
  drawMultiPanel(liveCtx, kind, src);
}

function drawResult(data) {
  if (!resCtx || !data) return;
  const kind = dom.exportUnit?.value || 'vel';
  const src  = {
    len: data.n,
    get: (k, axis, i) => data[k][axis][i],
  };
  drawMultiPanel(resCtx, kind, src);
}

// ===================== SENSOR =====================
// *** KERNÄNDERUNG: Alle Physik-Berechnungen passieren hier,
//     synchron zum echten Sensor-Takt (e.interval), NICHT im RAF-Loop! ***
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

  // Nur rechnen wenn Messung aktiv
  if (!running) return;

  // *** dt aus e.interval: echter Sensor-Takt, unabhängig von Bildschirm-FPS ***
  const dt = Math.min((e.interval > 0 ? e.interval : 16.67) / 1000, 0.05);

  // Filtern
  const { fx, fy, fz } = applyFilter(rawX, rawY, rawZ);

  // Integration → Geschwindigkeit (mm/s) mit zeitkonstanten-stabilem Leak
  integrate(fx, fy, fz, dt);
  const velX = intg.vx * 1000;
  const velY = intg.vy * 1000;
  const velZ = intg.vz * 1000;
  const velT = Math.sqrt(velX*velX + velY*velY + velZ*velZ);

  // Beschleunigung (m/s²)
  const accX = fx, accY = fy, accZ = fz;
  const accT = Math.sqrt(accX*accX + accY*accY + accZ*accZ);

  // Frequenz-Fenster befüllen
  freqWin.x[freqWin.ptr] = velX;
  freqWin.y[freqWin.ptr] = velY;
  freqWin.z[freqWin.ptr] = velZ;
  freqWin.t[freqWin.ptr] = velT;
  freqWin.ptr = (freqWin.ptr + 1) % FREQ_WIN;
  if (freqWin.len < FREQ_WIN) freqWin.len++;

  // Frequenz schätzen (nicht bei jedem Event)
  hzFrameCounter++;
  if (hzFrameCounter >= FREQ_UPDATE_EVERY_N_FRAMES) {
    hzFrameCounter = 0;
    hzNow = {
      x: estimateHzFromWindow(freqWin.x, freqWin.len, freqWin.ptr),
      y: estimateHzFromWindow(freqWin.y, freqWin.len, freqWin.ptr),
      z: estimateHzFromWindow(freqWin.z, freqWin.len, freqWin.ptr),
      t: estimateHzFromWindow(freqWin.t, freqWin.len, freqWin.ptr),
    };
  }

  // Ringbuffer befüllen
  ring.vel.x[ring.ptr]=velX; ring.vel.y[ring.ptr]=velY;
  ring.vel.z[ring.ptr]=velZ; ring.vel.t[ring.ptr]=velT;
  ring.acc.x[ring.ptr]=accX; ring.acc.y[ring.ptr]=accY;
  ring.acc.z[ring.ptr]=accZ; ring.acc.t[ring.ptr]=accT;
  ring.hz.x[ring.ptr]=hzNow.x; ring.hz.y[ring.ptr]=hzNow.y;
  ring.hz.z[ring.ptr]=hzNow.z; ring.hz.t[ring.ptr]=hzNow.t;
  ring.ptr = (ring.ptr + 1) % WINDOW_LEN;
  if (ring.len < WINDOW_LEN) ring.len++;

  // Stats
  stats.vel.peak  = Math.max(stats.vel.peak, velT);
  stats.vel.sum2 += velT * velT;
  stats.vel.cnt++;
  stats.acc.peak  = Math.max(stats.acc.peak, accT);
  stats.acc.sum2 += accT * accT;
  stats.acc.cnt++;
  stats.hz.peak  = Math.max(stats.hz.peak, hzNow.t);
  stats.hz.sum  += hzNow.t;
  stats.hz.cnt++;

  // Last-Packs für Anzeige (wird vom RAF-Loop gelesen)
  last.vel = {
    x: velX, y: velY, z: velZ, t: velT,
    peak: stats.vel.peak,
    rms:  Math.sqrt(stats.vel.sum2 / Math.max(1, stats.vel.cnt)),
  };
  last.acc = {
    x: accX, y: accY, z: accZ, t: accT,
    peak: stats.acc.peak,
    rms:  Math.sqrt(stats.acc.sum2 / Math.max(1, stats.acc.cnt)),
  };
  last.hz = {
    x: hzNow.x, y: hzNow.y, z: hzNow.z, t: hzNow.t,
    peak: stats.hz.peak,
    rms:  stats.hz.cnt ? (stats.hz.sum / stats.hz.cnt) : 0,
  };

  // Debug-Panel
  if (dom.debugPanel) {
    dom.debugPanel.textContent =
      `raw  ax=${rawX.toFixed(3)} ay=${rawY.toFixed(3)} az=${rawZ.toFixed(3)} m/s²\n` +
      `filt fx=${accX.toFixed(3)} fy=${accY.toFixed(3)} fz=${accZ.toFixed(3)} m/s²  filter=${activeFilter}\n` +
      `vel  x=${velX.toFixed(2)} y=${velY.toFixed(2)} z=${velZ.toFixed(2)} total=${velT.toFixed(2)} mm/s\n` +
      `hz   x=${hzNow.x.toFixed(2)} y=${hzNow.y.toFixed(2)} z=${hzNow.z.toFixed(2)} t=${hzNow.t.toFixed(2)} Hz\n` +
      `dt=${(dt*1000).toFixed(1)} ms  (Sensor e.interval)`;
  }

  // Recording
  if (rec && rec.vel.t.length < 12000) {
    rec.vel.x.push(velX); rec.vel.y.push(velY);
    rec.vel.z.push(velZ); rec.vel.t.push(velT);
    rec.acc.x.push(accX); rec.acc.y.push(accY);
    rec.acc.z.push(accZ); rec.acc.t.push(accT);
    rec.hz.x.push(hzNow.x); rec.hz.y.push(hzNow.y);
    rec.hz.z.push(hzNow.z); rec.hz.t.push(hzNow.t);
  }
}
window.addEventListener('devicemotion', onMotion, { passive: true });

// ===================== RESET / START / STOP =====================
function resetAll() {
  running = false;
  if (rafId)       { cancelAnimationFrame(rafId);  rafId       = null; }
  if (durTimer)    { clearInterval(durTimer);       durTimer    = null; }
  if (noDataTimer) { clearTimeout(noDataTimer);     noDataTimer = null; }

  startTime        = null;
  motionEventCount = 0;

  ring.ptr = 0; ring.len = 0;
  ['vel', 'acc', 'hz'].forEach(k => {
    ring[k].x.fill(0); ring[k].y.fill(0);
    ring[k].z.fill(0); ring[k].t.fill(0);
  });

  freqWin.ptr = 0; freqWin.len = 0;
  freqWin.x.fill(0); freqWin.y.fill(0);
  freqWin.z.fill(0); freqWin.t.fill(0);
  hzNow         = { x:0, y:0, z:0, t:0 };
  hzFrameCounter = 0;

  hp.x=hp.y=hp.z=0; hp.px=hp.py=hp.pz=0;
  lp.x=lp.y=lp.z=0;
  intg.vx=intg.vy=intg.vz=0;

  stats.vel = { peak:0, sum2:0, cnt:0 };
  stats.acc = { peak:0, sum2:0, cnt:0 };
  stats.hz  = { peak:0, sum:0,  cnt:0 };

  last.vel = { x:0, y:0, z:0, t:0, rms:0, peak:0 };
  last.acc = { x:0, y:0, z:0, t:0, rms:0, peak:0 };
  last.hz  = { x:0, y:0, z:0, t:0, rms:0, peak:0 };

  savedData = null;
  rec       = null;

  if (dom.startBtn) {
    dom.startBtn.textContent = 'Start';
    dom.startBtn.classList.add('btn--accent');
    dom.startBtn.classList.remove('btn--stop');
  }

  if (dom.results) dom.results.hidden = true;
  if (dom.resMeta) dom.resMeta.textContent = '—';

  if (dom.durVal)    dom.durVal.textContent    = '00:00';
  if (dom.liveTimer) dom.liveTimer.textContent = '00:00';
  if (dom.freqVal)   dom.freqVal.textContent   = '—';

  if (dom.mainNum) dom.mainNum.textContent = '0.00';
  if (dom.mainSub) dom.mainSub.textContent = `${unitLabel(activeUnit)} (Total)`;

  if (dom.debugPanel) dom.debugPanel.textContent = 'Warte auf Sensor-Daten …';

  setStatus('', '');
  buildOenormTable();
  renderFromLast();
  drawLive();
}

function startMeasurement() {
  if (running) return;

  if (IS_IOS &&
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function' &&
      motionEventCount === 0) {
    setStatus('iPhone: erst "iOS Sensorerlaubnis" drücken.', 'is-error');
    return;
  }

  resetAll();
  running   = true;
  startTime = Date.now();

  if (dom.startBtn) {
    dom.startBtn.textContent = 'Stop';
    dom.startBtn.classList.remove('btn--accent');
    dom.startBtn.classList.add('btn--stop');
  }

  setStatus('MESSUNG LÄUFT …', 'is-running');

  rec = {
    startTs: startTime,
    filter:  activeFilter,
    t0:      performance.now(),
    vel: { x:[], y:[], z:[], t:[] },
    acc: { x:[], y:[], z:[], t:[] },
    hz:  { x:[], y:[], z:[], t:[] },
  };

  durTimer = setInterval(() => {
    const s = fmtTime(Date.now() - startTime);
    if (dom.durVal)    dom.durVal.textContent    = s;
    if (dom.liveTimer) dom.liveTimer.textContent = s;
  }, 250);

  noDataTimer = setTimeout(() => {
    if (motionEventCount === 0)
      setStatus('Keine Sensor-Daten (iOS: Permission nötig).', 'is-error');
  }, 2000);

  rafId = requestAnimationFrame(loop);
}

function stopMeasurement() {
  if (!running) return;
  running = false;

  if (rafId)    { cancelAnimationFrame(rafId);  rafId    = null; }
  if (durTimer) { clearInterval(durTimer);       durTimer = null; }

  setStatus('Messung abgeschlossen ✓', 'is-done');

  if (dom.startBtn) {
    dom.startBtn.textContent = 'Start';
    dom.startBtn.classList.add('btn--accent');
    dom.startBtn.classList.remove('btn--stop');
  }

  if (rec && rec.vel.t.length > 10) {
    const durationSec = (performance.now() - rec.t0) / 1000;

    savedData = {
      n: rec.vel.t.length,
      startTs:     rec.startTs,
      durationSec,
      filter:      rec.filter,
      vel:         rec.vel,
      acc:         rec.acc,
      hz:          rec.hz,
    };

    if (dom.results) dom.results.hidden = false;
    if (dom.resMeta) {
      dom.resMeta.textContent =
        `${new Date(savedData.startTs).toLocaleString('de-DE')} · ` +
        `Dauer: ${savedData.durationSec.toFixed(1)} s · ` +
        `Punkte: ${savedData.n} · ` +
        `Filter: ${FILTERS[savedData.filter]?.label || savedData.filter}`;
    }

    if (dom.exportUnit) dom.exportUnit.value = activeUnit;
    setTimeout(() => { initCanvases(); drawResult(savedData); }, 120);
  }
  rec = null;
}

dom.startBtn?.addEventListener('click', () =>
  running ? stopMeasurement() : startMeasurement()
);
dom.resetBtn?.addEventListener('click', resetAll);

// ===================== LOOP (nur Anzeige!) =====================
// *** Keine Physik mehr hier – nur noch Zeichnen und Display-Update ***
function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  renderFromLast();
  drawLive();

  if (dom.filterLabel)
    dom.filterLabel.textContent = FILTERS[activeFilter]?.label || activeFilter;
}

// ===================== UNIT / FILTER EVENTS =====================
document.querySelectorAll('.unitBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeUnit = btn.dataset.unit;
    document.querySelectorAll('.unitBtn')
      .forEach(b => b.classList.toggle('is-active', b === btn));
    setUnitUI();
  });
});

dom.filterSelect?.addEventListener('change', () => {
  activeFilter = dom.filterSelect.value;
  hp.x=hp.y=hp.z=0; hp.px=hp.py=hp.pz=0;
  lp.x=lp.y=lp.z=0;
  if (dom.filterLabel)
    dom.filterLabel.textContent = FILTERS[activeFilter]?.label || activeFilter;
});

dom.exportUnit?.addEventListener('change', () => {
  if (savedData) drawResult(savedData);
});

// ===================== CSV EXPORT =====================
function exportCSV() {
  if (!savedData) return;

  const expUnit = dom.exportUnit?.value || 'vel';
  const u       = unitLabel(expUnit);
  const n       = savedData.n;
  const dt      = savedData.durationSec / Math.max(1, n - 1);
  const src     = savedData[expUnit];

  let csv = `# HTB Schwingungsmesser Export\n`;
  csv += `# Start: ${new Date(savedData.startTs).toLocaleString('de-DE')}\n`;
  csv += `# Dauer: ${savedData.durationSec.toFixed(2)} s\n`;
  csv += `# Filter: ${FILTERS[savedData.filter]?.label || savedData.filter}\n`;
  csv += `# Einheit: ${expUnit} (${u})\n#\n`;
  csv += `i;time_s;x_${u};y_${u};z_${u};total_${u}\n`;

  for (let i = 0; i < n; i++) {
    csv +=
      `${i};${(i * dt).toFixed(4)};` +
      `${src.x[i].toFixed(6)};${src.y[i].toFixed(6)};` +
      `${src.z[i].toFixed(6)};${src.t[i].toFixed(6)}\n`;
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `HTB_Messung_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
dom.csvBtn?.addEventListener('click', exportCSV);

// ===================== PDF EXPORT =====================
function plotToDataURL({ series, title, unit, color, durationSec }) {
  const W = 1200, H = 260;
  const mL = 74, mR = 18, mT = 30, mB = 50;
  const pw = W - mL - mR, ph = H - mT - mB;

  const c   = document.createElement('canvas');
  c.width   = W; c.height = H;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  let mn = Infinity, mx = -Infinity;
  for (const v of series) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!isFinite(mn) || !isFinite(mx)) { mn = -1; mx = 1; }
  if (mn === mx) { mn -= 1; mx += 1; }
  const pad = (mx - mn) * 0.10;
  mn -= pad; mx += pad;
  const yOf = (v) => mT + ph - ((v - mn) / (mx - mn)) * ph;

  ctx.strokeStyle = '#e6e6e6';
  ctx.lineWidth   = 1;
  for (let i = 0; i <= 10; i++) {
    const x = mL + (i / 10) * pw;
    ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT + ph); ctx.stroke();
  }
  for (let j = 0; j <= 6; j++) {
    const y = mT + (j / 6) * ph;
    ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL + pw, y); ctx.stroke();
  }

  ctx.strokeStyle = '#111';
  ctx.lineWidth   = 1.2;
  ctx.beginPath();
  ctx.moveTo(mL, mT); ctx.lineTo(mL, mT + ph); ctx.lineTo(mL + pw, mT + ph);
  ctx.stroke();

  ctx.fillStyle = '#111';
  ctx.font      = 'bold 14px Arial';
  ctx.fillText(title, mL, 18);

  ctx.fillStyle = '#333';
  ctx.font      = '12px Arial';
  ctx.fillText(unit, 12, mT + 12);

  for (let j = 0; j <= 6; j++) {
    const vv = mn + (j / 6) * (mx - mn);
    ctx.fillText(vv.toFixed(3), 10, yOf(vv) + 4);
  }

  ctx.textAlign = 'center';
  for (let i = 0; i <= 5; i++) {
    const t = durationSec * (i / 5);
    const x = mL + (i / 5) * pw;
    ctx.fillText(t.toFixed(1), x, H - 18);
  }
  ctx.textAlign = 'left';
  ctx.fillText('t [s]', mL + pw - 38, H - 4);

  ctx.strokeStyle = color;
  ctx.lineWidth   = 2;
  ctx.beginPath();
  const n = series.length;
  for (let i = 0; i < n; i++) {
    const x = mL + (i / (n - 1)) * pw;
    const y = yOf(series[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  return c.toDataURL('image/png', 1.0);
}

function exportPDF() {
  if (!savedData) {
    setStatus('Keine Messdaten vorhanden – erst messen!', 'is-error');
    return;
  }

  const expUnit = dom.exportUnit?.value || 'vel';
  const unit    = unitLabel(expUnit);
  const dur     = savedData.durationSec;
  const src     = savedData[expUnit];

  const imgX = plotToDataURL({ series:src.x, title:'X-Achse', unit, color:COLORS.x, durationSec:dur });
  const imgY = plotToDataURL({ series:src.y, title:'Y-Achse', unit, color:COLORS.y, durationSec:dur });
  const imgZ = plotToDataURL({ series:src.z, title:'Z-Achse', unit, color:COLORS.z, durationSec:dur });

  const w = window.open('', '_blank');
  if (!w) { setStatus('Popup blockiert – bitte Popups erlauben!', 'is-error'); return; }

  w.document.open();
  w.document.write(`<!doctype html><html><head>
<meta charset="utf-8"/>
<title>HTB Schwingungsmesser – Messbericht</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  body { font-family: Arial, sans-serif; background:#fff; color:#111; margin:0; padding:12mm; }
  h1 { font-size:16px; margin:0 0 6px; }
  .meta {
    font-size:11px; color:#333; line-height:1.5;
    margin-bottom:12px; border-bottom:1px solid #ddd; padding-bottom:8px;
  }
  .plot { margin:10px 0; page-break-inside:avoid; }
  .plot img { width:100%; border:1px solid #ddd; border-radius:4px; }
  .footer {
    margin-top:16px; font-size:9px; color:#999;
    text-align:center; border-top:1px solid #eee; padding-top:6px;
  }
</style>
</head><body>
<h1>HTB Schwingungsmesser – Messbericht</h1>
<div class="meta">
  <b>Start:</b> ${new Date(savedData.startTs).toLocaleString('de-DE')}<br/>
  <b>Dauer:</b> ${dur.toFixed(2)} s &nbsp;·&nbsp;
  <b>Einheit:</b> ${unit} &nbsp;·&nbsp;
  <b>Punkte:</b> ${savedData.n}<br/>
  <b>Filter:</b> ${FILTERS[savedData.filter]?.label || savedData.filter}<br/>
  <b>Hinweis:</b> Smartphone-Sensoren sind nicht kalibriert –
  Werte dienen der Orientierung, kein Ersatz für kalibrierte Messtechnik.
</div>
<div class="plot"><img src="${imgX}" alt="X-Achse"></div>
<div class="plot"><img src="${imgY}" alt="Y-Achse"></div>
<div class="plot"><img src="${imgZ}" alt="Z-Achse"></div>
<div class="footer">
  &copy; HTB Baugesellschaft m.b.H. &nbsp;·&nbsp;
  Erstellt: ${new Date().toLocaleString('de-DE')}
</div>
<script>setTimeout(() => window.print(), 250);<\/script>
</body></html>`);
  w.document.close();
}
dom.pdfBtn?.addEventListener('click', exportPDF);

// ===================== iOS PERMISSION =====================
if (IS_IOS &&
    typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function') {
  if (dom.iosPermBtn) dom.iosPermBtn.hidden = false;
  dom.iosPermBtn?.addEventListener('click', async () => {
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

// ===================== PWA INSTALL =====================
(() => {
  let deferredPrompt = null;
  if (!dom.installBanner || !dom.installBtn) return;
  if (IS_STANDALONE) { dom.installBanner.hidden = true; return; }

  if (IS_IOS) {
    dom.installBanner.hidden   = false;
    dom.installBtn.textContent = 'Anleitung';
    dom.installBtn.onclick     = () =>
      setStatus('iPhone: Safari → Teilen (□↑) → "Zum Home‑Bildschirm"', 'is-error');
    return;
  }

  dom.installBanner.hidden  = true;
  dom.installBtn.disabled   = true;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    dom.installBanner.hidden = false;
    dom.installBtn.disabled  = false;
  });

  dom.installBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!deferredPrompt) {
      setStatus('Chrome-Menü (⋮) → "App installieren"', 'is-error');
      return;
    }
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt            = null;
    dom.installBanner.hidden  = true;
    dom.installBtn.disabled   = true;
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt            = null;
    dom.installBanner.hidden  = true;
    dom.installBtn.disabled   = true;
  });
})();

// ===================== SERVICE WORKER =====================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ===================== INIT =====================
initTabs();
if (dom.filterLabel)
  dom.filterLabel.textContent = FILTERS[activeFilter]?.label || activeFilter;
buildOenormTable();
setUnitUI();
resetAll();
setTimeout(initCanvases, 150);
