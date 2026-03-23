'use strict';

/* ══════════════════════════════════════════════
   KONFIGURATION
══════════════════════════════════════════════ */
const SAMPLE_RATE  = 60;               // Ziel-fps ≈ Sensor-Rate
const WIN_SEC      = 30;               // Rückblick-Fenster Sekunden
const WINDOW_LEN   = WIN_SEC * SAMPLE_RATE; // 1800 Samples
const MAX_REC      = WINDOW_LEN * 4;        // max. 2 min Recording
const FREQ_WIN_SEC = 2;               // Fenster für Zero-Crossing Hz-Schätzung
const FREQ_WIN     = FREQ_WIN_SEC * SAMPLE_RATE;

const COLORS = { x:'#ff4444', y:'#00cc66', z:'#4499ff' };

/* ══════════════════════════════════════════════
   FILTER-DEFINITIONEN
   IIR 1. Ordnung: HP + LP hintereinander
   Koeffizienten für fs = 60 Hz
   alpha = exp(-2π·fc/fs)
══════════════════════════════════════════════ */
const FILTERS = {
  raw:   { hpAlpha: 0,     lpAlpha: 1,    label: 'Roh'                },
  hp1:   { hpAlpha: 0.900, lpAlpha: 1,    label: 'HP 1 Hz'            },
  bau:   { hpAlpha: 0.900, lpAlpha: 0.22, label: 'Baustelle 1–25 Hz'  },
  pfahl: { hpAlpha: 0.900, lpAlpha: 0.57, label: 'Pfahlramm. 1–8 Hz'  },
  verd:  { hpAlpha: 0.583, lpAlpha: 0.22, label: 'Verdichter 8–25 Hz' },
  verk:  { hpAlpha: 0.900, lpAlpha: 0.38, label: 'Verkehr 1–15 Hz'    },
};

/* ══════════════════════════════════════════════
   ÖNORM S 9020 – Definitionen je Einheit
══════════════════════════════════════════════ */
const OENORM = {
  vel: {
    hint: 'Spitzenpartikelgeschwindigkeit (PPV) in mm/s – direkte Norm-Grundlage',
    rows: [
      { id:'n0', range:'< 5 mm/s',      label:'Klasse I – keine Schäden zu erwarten'         },
      { id:'n1', range:'5 – 10 mm/s',   label:'Klasse II – leichte kosmetische Schäden mgl.' },
      { id:'n2', range:'10 – 20 mm/s',  label:'Klasse III – leichte Schäden möglich'          },
      { id:'n3', range:'20 – 30 mm/s',  label:'Klasse IV – mittlere Schäden möglich'          },
      { id:'n4', range:'> 30 mm/s',     label:'Klasse V – schwere Schäden möglich'            },
    ],
    bounds: [0, 5, 10, 20, 30],
  },
  acc: {
    hint: 'Beschleunigung m/s² – Richtwerte aus PPV bei Annahme f = 10 Hz (orientierend)',
    rows: [
      { id:'n0', range:'< 0.31 m/s²',   label:'Klasse I – keine Schäden zu erwarten'         },
      { id:'n1', range:'0.31 – 0.63 m/s²', label:'Klasse II – leichte kosm. Schäden mgl.'  },
      { id:'n2', range:'0.63 – 1.26 m/s²', label:'Klasse III – leichte Schäden möglich'     },
      { id:'n3', range:'1.26 – 1.88 m/s²', label:'Klasse IV – mittlere Schäden möglich'     },
      { id:'n4', range:'> 1.88 m/s²',   label:'Klasse V – schwere Schäden möglich'           },
    ],
    bounds: [0, 0.314, 0.628, 1.257, 1.885],
    // a = v·2πf, v=5/10/20/30 mm/s = 0.005/0.01/0.02/0.03 m/s, f=10Hz
  },
  disp: {
    hint: 'Verschiebung mm – Richtwerte aus PPV bei Annahme f = 10 Hz (orientierend)',
    rows: [
      { id:'n0', range:'< 0.080 mm',    label:'Klasse I – keine Schäden zu erwarten'         },
      { id:'n1', range:'0.080 – 0.159 mm', label:'Klasse II – leichte kosm. Schäden mgl.'  },
      { id:'n2', range:'0.159 – 0.318 mm', label:'Klasse III – leichte Schäden möglich'     },
      { id:'n3', range:'0.318 – 0.477 mm', label:'Klasse IV – mittlere Schäden möglich'     },
      { id:'n4', range:'> 0.477 mm',    label:'Klasse V – schwere Schäden möglich'           },
    ],
    bounds: [0, 0.0796, 0.1592, 0.3183, 0.4775],
    // d = v/(2πf), v=0.005/0.01/0.02/0.03 m/s, f=10Hz → ×1000 mm
  },
  hz: {
    hint: 'Dominante Frequenz Hz – Baustellentypische Quellen (ÖNORM gilt für Geschwindigkeit)',
    rows: [
      { id:'n0', range:'1 – 8 Hz',      label:'Typisch: Pfahlrammung, langsame Erschütt.'    },
      { id:'n1', range:'2 – 15 Hz',     label:'Typisch: Bagger, Abbruch, Schwerlastverkehr'  },
      { id:'n2', range:'8 – 25 Hz',     label:'Typisch: Verdichter, Rüttelplatte, Compactor' },
      { id:'n3', range:'> 25 Hz',       label:'Rauschen / Sensor-Artefakt (kein Baustellenwert)' },
      { id:'n4', range:'< 1 Hz',        label:'Unterhalb Messbereich / DC-Drift'              },
    ],
    bounds: null, // Frequenz hat andere Logik
  },
};

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
let activeFilter     = 'hp1';
let noDataTimer      = null;
let motionEventCount = 0;
let rawX = 0, rawY = 0, rawZ = 0;

// Zirkulärer Buffer für Live-Anzeige (gefiltertes Signal)
const buf = {
  x:   new Float32Array(WINDOW_LEN),
  y:   new Float32Array(WINDOW_LEN),
  z:   new Float32Array(WINDOW_LEN),
  t:   new Float32Array(WINDOW_LEN),
  ptr: 0, len: 0
};

// Frequenz-Schätzung: kleine Buffer für Zero-Crossing
const freqBuf = {
  t: new Float32Array(FREQ_WIN),
  ptr: 0, len: 0,
};

// Integration & Filter-Zustand
const intg = { vx:0, vy:0, vz:0, px:0, py:0, pz:0, prev:null };
const hp   = { x:0, y:0, z:0, px:0, py:0, pz:0 };       // Hochpass
const lp   = { x:0, y:0, z:0 };                           // Tiefpass

let peakTotal = 0, rmsAcc = 0, rmsCnt = 0;
let domFreqHz = 0;

/* ══════════════════════════════════════════════
   iOS & STANDALONE ERKENNUNG
══════════════════════════════════════════════ */
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent);
const IS_STANDALONE =
  window.matchMedia('(display-mode: standalone)').matches ||
  navigator.standalone === true;

/* ══════════════════════════════════════════════
   DOM-REFERENZEN
══════════════════════════════════════════════ */
const $ = (id) => document.getElementById(id);

const dom = {
  statusBar:    $('statusBar'),
  mainNum:      $('mainNum'),
  mainSub:      $('mainSub'),
  xVal:         $('xVal'),
  yVal:         $('yVal'),
  zVal:         $('zVal'),
  tVal:         $('tVal'),
  peakVal:      $('peakVal'),
  rmsVal:       $('rmsVal'),
  freqVal:      $('freqVal'),
  durVal:       $('durVal'),
  debugPanel:   $('debugPanel'),
  liveChart:    $('liveChart'),
  liveAxis:     $('liveAxis'),
  resultChart:  $('resultChart'),
  resAxis:      $('resAxis'),
  resMeta:      $('resMeta'),
  results:      $('results'),
  startBtn:     $('startBtn'),
  resetBtn:     $('resetBtn'),
  iosPermBtn:   $('iosPermBtn'),
  installBanner:$('installBanner'),
  installBtn:   $('installBtn'),
  exportUnit:   $('exportUnit'),
  filterSelect: $('filterSelect'),
  oenormTable:  $('oenormTable'),
  oenormHint:   $('oenormUnitHint'),
};

const liveCtx = dom.liveChart.getContext('2d');
const resCtx  = dom.resultChart.getContext('2d');

/* ══════════════════════════════════════════════
   FEHLER-HANDLER
══════════════════════════════════════════════ */
window.addEventListener('error', (e) => {
  dom.statusBar.hidden    = false;
  dom.statusBar.className = 'statusBar is-error';
  dom.statusBar.textContent = `JS Fehler: ${e.message} (Zeile ${e.lineno})`;
});

/* ══════════════════════════════════════════════
   HELPER
══════════════════════════════════════════════ */
function unitLabel(u) {
  u = u || activeUnit;
  if (u === 'acc')  return 'm/s²';
  if (u === 'disp') return 'mm';
  if (u === 'hz')   return 'Hz';
  return 'mm/s';
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

/* ══════════════════════════════════════════════
   TABS
══════════════════════════════════════════════ */
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
    setTimeout(initCanvases, 60);
  });
});

/* ══════════════════════════════════════════════
   FILTER-AUSWAHL
══════════════════════════════════════════════ */
dom.filterSelect.addEventListener('change', () => {
  activeFilter = dom.filterSelect.value;
  // Filter-Zustand zurücksetzen (verhindert Sprünge)
  hp.x = hp.y = hp.z = 0; hp.px = hp.py = hp.pz = 0;
  lp.x = lp.y = lp.z = 0;
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
  buildOenormTable();
}

document.querySelectorAll('.unitBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeUnit = btn.dataset.unit;
    document.querySelectorAll('.unitBtn').forEach(b =>
      b.classList.toggle('is-active', b === btn)
    );
    updateUnitLabels();
  });
});

/* ══════════════════════════════════════════════
   ÖNORM-TABELLE AUFBAUEN (je Einheit)
══════════════════════════════════════════════ */
function buildOenormTable() {
  const cfg = OENORM[activeUnit] || OENORM.vel;
  dom.oenormHint.textContent = cfg.hint;

  let html = '<tbody>';
  cfg.rows.forEach(r => {
    html += `<tr id="${r.id}"><td>${r.range}</td><td>${r.label}</td></tr>`;
  });
  html += '</tbody>';
  dom.oenormTable.innerHTML = html;
}

function updateOenorm(value) {
  const cfg = OENORM[activeUnit] || OENORM.vel;
  if (!cfg.bounds) {
    // Hz-Modus: Frequenz-Klassifizierung
    highlightFreqRow(value);
    return;
  }
  let row = 0;
  for (let i = cfg.bounds.length - 1; i >= 0; i--) {
    if (value >= cfg.bounds[i]) { row = i; break; }
  }
  cfg.rows.forEach((r, i) => {
    const el = $(r.id);
    if (el) el.classList.toggle('is-active', i === row);
  });
}

function highlightFreqRow(hz) {
  // n0 = 1–8, n1 = 2–15, n2 = 8–25, n3 = >25, n4 = <1
  const rows = OENORM.hz.rows;
  let activeId = null;
  if (hz < 1)      activeId = 'n4';
  else if (hz <= 8)  activeId = 'n0';
  else if (hz <= 15) activeId = 'n1';
  else if (hz <= 25) activeId = 'n2';
  else               activeId = 'n3';

  rows.forEach(r => {
    const el = $(r.id);
    if (el) el.classList.toggle('is-active', r.id === activeId);
  });
}

/* ══════════════════════════════════════════════
   FILTER ANWENDEN
   Gibt gefilterte Beschleunigung zurück (m/s²)
══════════════════════════════════════════════ */
function applyFilter(ax, ay, az) {
  const cfg = FILTERS[activeFilter] || FILTERS.hp1;

  // 1. Hochpass (entfernt DC/Gravitation)
  let hpx, hpy, hpz;
  if (cfg.hpAlpha === 0) {
    // Roh: kein HP
    hpx = ax; hpy = ay; hpz = az;
  } else {
    hpx = cfg.hpAlpha * (hp.x + ax - hp.px);
    hpy = cfg.hpAlpha * (hp.y + ay - hp.py);
    hpz = cfg.hpAlpha * (hp.z + az - hp.pz);
    hp.x = hpx; hp.y = hpy; hp.z = hpz;
    hp.px = ax; hp.py = ay; hp.pz = az;
  }

  // 2. Tiefpass (entfernt hochfrequentes Rauschen)
  let fx, fy, fz;
  if (cfg.lpAlpha >= 1) {
    // Kein LP
    fx = hpx; fy = hpy; fz = hpz;
  } else {
    const a = cfg.lpAlpha;
    lp.x = a * lp.x + (1 - a) * hpx;
    lp.y = a * lp.y + (1 - a) * hpy;
    lp.z = a * lp.z + (1 - a) * hpz;
    fx = lp.x; fy = lp.y; fz = lp.z;
  }

  return { fx, fy, fz };
}

/* ══════════════════════════════════════════════
   INTEGRATION (Beschleunigung → Geschw. → Weg)
══════════════════════════════════════════════ */
const LEAK_V = 0.985;
const LEAK_P = 0.995;

function integrate(fx, fy, fz, dt) {
  intg.vx = (intg.vx + fx * dt) * LEAK_V;
  intg.vy = (intg.vy + fy * dt) * LEAK_V;
  intg.vz = (intg.vz + fz * dt) * LEAK_V;

  intg.px = (intg.px + intg.vx * dt) * LEAK_P;
  intg.py = (intg.py + intg.vy * dt) * LEAK_P;
  intg.pz = (intg.pz + intg.vz * dt) * LEAK_P;
}

/* ══════════════════════════════════════════════
   WERTE FÜR GEWÄHLTE EINHEIT
══════════════════════════════════════════════ */
function getDisplayValues(fx, fy, fz) {
  if (activeUnit === 'acc') {
    return { vx: fx, vy: fy, vz: fz,
             vt: Math.sqrt(fx*fx + fy*fy + fz*fz) };
  }
  if (activeUnit === 'disp') {
    const px = intg.px*1000, py = intg.py*1000, pz = intg.pz*1000;
    return { vx: px, vy: py, vz: pz,
             vt: Math.sqrt(px*px + py*py + pz*pz) };
  }
  if (activeUnit === 'hz') {
    // Im Hz-Modus zeigen wir die geschätzten Frequenzen
    // Total = dominante Frequenz, X/Y/Z = je Achse
    const freqT = domFreqHz;
    return { vx: freqT, vy: freqT, vz: freqT, vt: freqT };
  }
  // vel (mm/s) – default
  const vx = intg.vx*1000, vy = intg.vy*1000, vz = intg.vz*1000;
  return { vx, vy, vz, vt: Math.sqrt(vx*vx + vy*vy + vz*vz) };
}

/* ══════════════════════════════════════════════
   ZERO-CROSSING FREQUENZ-SCHÄTZUNG
══════════════════════════════════════════════ */
function estimateFrequency() {
  if (freqBuf.len < 4) return 0;
  let crossings = 0;
  let prev = freqBuf.t[(freqBuf.ptr - freqBuf.len + FREQ_WIN) % FREQ_WIN];
  for (let i = 1; i < freqBuf.len; i++) {
    const cur = freqBuf.t[(freqBuf.ptr - freqBuf.len + i + FREQ_WIN) % FREQ_WIN];
    if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) crossings++;
    prev = cur;
  }
  // f = (Nulldurchgänge/2) / Zeitfenster
  return (crossings / 2) / FREQ_WIN_SEC;
}

/* ══════════════════════════════════════════════
   LIVE CHART – 3 Panels X / Y / Z mit 30s
══════════════════════════════════════════════ */
function drawLive() {
  const cvs = dom.liveChart;
  const ctx = liveCtx;
  const W   = cvs.getBoundingClientRect().width  || 320;
  const H   = cvs.getBoundingClientRect().height || 380;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  const axes   = ['x', 'y', 'z'];
  const labels = ['X', 'Y', 'Z'];
  const panH   = H / 3;
  const mL = 56, mR = 8, mT = 20, mB = 26;

  axes.forEach((s, pi) => {
    const offY = pi * panH;
    const pw   = W - mL - mR;
    const ph   = panH - mT - mB;

    // Panel-BG
    ctx.fillStyle = pi % 2 === 0 ? '#0b0b0c' : '#0d0d0f';
    ctx.fillRect(0, offY, W, panH);

    if (pi > 0) {
      ctx.strokeStyle = '#2a2a2d'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, offY); ctx.lineTo(W, offY); ctx.stroke();
    }

    if (buf.len < 2) {
      ctx.fillStyle = COLORS[s]; ctx.font = 'bold 11px system-ui';
      ctx.fillText(labels[pi], 4, offY + mT + 12);
      return;
    }

    // Min/Max berechnen
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < buf.len; i++) {
      const v = buf[s][(buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN];
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
    if (!isFinite(mn)) { mn = -1; mx = 1; }
    if (mn === mx) { mn -= 0.5; mx += 0.5; }
    const rng  = mx - mn;
    const yMin = mn - rng * 0.08;
    const yMax = mx + rng * 0.08;
    const span = yMax - yMin || 1;
    const toY  = (v) => offY + mT + ph - ((v - yMin) / span) * ph;

    // Grid-Linien
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      ctx.strokeStyle = '#1e1e22';
      const gy = offY + mT + (g / 4) * ph;
      ctx.beginPath(); ctx.moveTo(mL, gy); ctx.lineTo(mL + pw, gy); ctx.stroke();
    }
    // Zeitgitter (6 Linien = alle 5s)
    for (let g = 0; g <= 6; g++) {
      ctx.strokeStyle = '#1a1a1e';
      const gx = mL + (g / 6) * pw;
      ctx.beginPath(); ctx.moveTo(gx, offY + mT); ctx.lineTo(gx, offY + mT + ph); ctx.stroke();
    }

    // Nulllinie
    const y0 = toY(0);
    if (y0 >= offY + mT && y0 <= offY + mT + ph) {
      ctx.strokeStyle = '#3a3a42'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(mL, y0); ctx.lineTo(mL + pw, y0); ctx.stroke();
    }

    // Y-Ticks (4 Werte)
    ctx.fillStyle = '#5a5a62'; ctx.font = '9px system-ui'; ctx.textAlign = 'right';
    [yMin, (yMin+yMax)/2, yMax].forEach(v => {
      const yp = toY(v);
      if (yp >= offY + mT - 2 && yp <= offY + mT + ph + 2)
        ctx.fillText(v.toFixed(2), mL - 3, yp + 3);
    });
    ctx.textAlign = 'left';

    // Achsenlabel + Einheit
    ctx.fillStyle = COLORS[s]; ctx.font = 'bold 11px system-ui';
    ctx.fillText(labels[pi], 4, offY + mT + 10);
    ctx.fillStyle = '#5a5a62'; ctx.font = '9px system-ui';
    ctx.fillText(unitLabel(), 4, offY + mT + 21);

    // Zeitachse (nur letztes Panel)
    if (pi === 2) {
      ctx.fillStyle = '#5a5a62'; ctx.font = '9px system-ui'; ctx.textAlign = 'center';
      // Labels: -30s bis 0s
      for (let g = 0; g <= 6; g++) {
        const sec = -WIN_SEC + (g / 6) * WIN_SEC;
        const gx  = mL + (g / 6) * pw;
        ctx.fillText(`${sec.toFixed(0)}s`, gx, offY + mT + ph + 17);
      }
      ctx.textAlign = 'left';
    }

    // Kurve
    ctx.strokeStyle = COLORS[s]; ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < buf.len; i++) {
      const idx = (buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN;
      const xp  = mL + (i / (WINDOW_LEN - 1)) * pw;
      const yp  = toY(buf[s][idx]);
      i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
    }
    ctx.stroke();
  });
}

/* ══════════════════════════════════════════════
   RESULT CHART – 3 Panels X / Y / Z
══════════════════════════════════════════════ */
function drawResult(data) {
  const cvs  = dom.resultChart;
  const ctx  = resCtx;
  const W    = cvs.getBoundingClientRect().width  || 320;
  const H    = cvs.getBoundingClientRect().height || 380;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c'; ctx.fillRect(0, 0, W, H);

  const axes   = ['x', 'y', 'z'];
  const labels = ['X', 'Y', 'Z'];
  const panH   = H / 3;
  const mL = 56, mR = 8, mT = 20, mB = 26;

  axes.forEach((s, pi) => {
    const offY   = pi * panH;
    const pw     = W - mL - mR;
    const ph     = panH - mT - mB;
    const series = data[s];
    if (!series || series.length < 2) return;

    ctx.fillStyle = pi % 2 === 0 ? '#0b0b0c' : '#0d0d0f';
    ctx.fillRect(0, offY, W, panH);

    if (pi > 0) {
      ctx.strokeStyle = '#2a2a2d'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, offY); ctx.lineTo(W, offY); ctx.stroke();
    }

    let mn = Infinity, mx = -Infinity;
    series.forEach(v => { if (v < mn) mn = v; if (v > mx) mx = v; });
    if (mn === mx) { mn -= 0.5; mx += 0.5; }
    const pad  = (mx - mn) * 0.08;
    const yMin = mn - pad, yMax = mx + pad;
    const span = yMax - yMin || 1;
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
      ctx.beginPath(); ctx.moveTo(gx, offY + mT); ctx.lineTo(gx, offY + mT + ph); ctx.stroke();
    }

    const y0 = toY(0);
    if (y0 >= offY + mT && y0 <= offY + mT + ph) {
      ctx.strokeStyle = '#3a3a42'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(mL, y0); ctx.lineTo(mL + pw, y0); ctx.stroke();
    }

    ctx.fillStyle = '#5a5a62'; ctx.font = '9px system-ui'; ctx.textAlign = 'right';
    [yMin, (yMin+yMax)/2, yMax].forEach(v => {
      const yp = toY(v);
      if (yp >= offY + mT - 2 && yp <= offY + mT + ph + 2)
        ctx.fillText(v.toFixed(2), mL - 3, yp + 3);
    });
    ctx.textAlign = 'left';

    ctx.fillStyle = COLORS[s]; ctx.font = 'bold 11px system-ui';
    ctx.fillText(labels[pi], 4, offY + mT + 10);
    ctx.fillStyle = '#5a5a62'; ctx.font = '9px system-ui';
    ctx.fillText(unitLabel(data.unit), 4, offY + mT + 21);

    if (pi === 2) {
      ctx.fillStyle = '#5a5a62'; ctx.font = '9px system-ui'; ctx.textAlign = 'center';
      for (let g = 0; g <= 6; g++) {
        const t  = (data.durationSec * g / 6).toFixed(1);
        const gx = mL + (g / 6) * pw;
        ctx.fillText(`${t}s`, gx, offY + mT + ph + 17);
      }
      ctx.textAlign = 'left';
    }

    ctx.strokeStyle = COLORS[s]; ctx.lineWidth = 1.8;
    ctx.beginPath();
    series.forEach((v, i) => {
      const xp = mL + (i / (series.length - 1)) * pw;
      const yp = toY(v);
      i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
    });
    ctx.stroke();
  });

  dom.resAxis.innerHTML = '';
}

/* ══════════════════════════════════════════════
   SENSOR
══════════════════════════════════════════════ */
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
window.addEventListener('devicemotion', onMotion, { passive: true });

/* ══════════════════════════════════════════════
   RESET
══════════════════════════════════════════════ */
function resetState() {
  running = false;
  if (rafId)       { cancelAnimationFrame(rafId);  rafId       = null; }
  if (durTimer)    { clearInterval(durTimer);       durTimer    = null; }
  if (noDataTimer) { clearTimeout(noDataTimer);     noDataTimer = null; }

  startTime = null;
  peakTotal = 0; rmsAcc = 0; rmsCnt = 0;
  motionEventCount = 0; domFreqHz = 0;

  buf.ptr = 0; buf.len = 0;
  buf.x.fill(0); buf.y.fill(0); buf.z.fill(0); buf.t.fill(0);
  freqBuf.ptr = 0; freqBuf.len = 0; freqBuf.t.fill(0);

  intg.vx = intg.vy = intg.vz = 0;
  intg.px = intg.py = intg.pz = 0;
  intg.prev = null;

  hp.x = hp.y = hp.z = 0; hp.px = hp.py = hp.pz = 0;
  lp.x = lp.y = lp.z = 0;

  rawX = rawY = rawZ = 0;
  rec = null; savedData = null;

  dom.startBtn.textContent = 'Start';
  dom.startBtn.classList.add('btn--accent');
  dom.startBtn.classList.remove('btn--stop');

  dom.mainNum.textContent  = '0.00';
  dom.mainSub.textContent  = `${unitLabel()} (Total)`;
  dom.xVal.textContent     = '0.00';
  dom.yVal.textContent     = '0.00';
  dom.zVal.textContent     = '0.00';
  dom.tVal.textContent     = '0.00';
  dom.peakVal.textContent  = '0.00';
  dom.rmsVal.textContent   = '0.00';
  dom.freqVal.textContent  = '—';
  dom.durVal.textContent   = '00:00';
  dom.results.hidden       = true;
  dom.resMeta.textContent  = '—';
  dom.debugPanel.textContent = 'Warte auf Sensor-Daten …';

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = false);

  // ÖNORM-Highlighting zurücksetzen
  const cfg = OENORM[activeUnit] || OENORM.vel;
  cfg.rows.forEach(r => { const el = $(r.id); if (el) el.classList.remove('is-active'); });

  setStatus('', '');
  drawLive();
}

/* ══════════════════════════════════════════════
   START / STOP
══════════════════════════════════════════════ */
function startMeasurement() {
  if (running) return;

  if (IS_IOS &&
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function' &&
      motionEventCount === 0) {
    setStatus('iPhone: erst „iOS Sensorerlaubnis" drücken.', 'is-error');
    return;
  }

  resetState();
  running   = true;
  startTime = Date.now();
  motionEventCount = 0;

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = true);

  rec = {
    unit: activeUnit, filter: activeFilter,
    t0: performance.now(), startTs: startTime,
    x: [], y: [], z: [], t: [], freq: []
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

function stopMeasurement() {
  if (!running) return;
  running = false;

  if (rafId)       { cancelAnimationFrame(rafId);  rafId       = null; }
  if (durTimer)    { clearInterval(durTimer);       durTimer    = null; }
  if (noDataTimer) { clearTimeout(noDataTimer);     noDataTimer = null; }

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = false);

  dom.startBtn.textContent = 'Start';
  dom.startBtn.classList.add('btn--accent');
  dom.startBtn.classList.remove('btn--stop');
  setStatus('Messung abgeschlossen ✓', 'is-done');

  if (rec && rec.t.length > 5) {
    savedData = {
      unit: rec.unit, filter: rec.filter,
      startTs: rec.startTs,
      durationSec: (performance.now() - rec.t0) / 1000,
      x: rec.x.slice(), y: rec.y.slice(),
      z: rec.z.slice(), t: rec.t.slice(),
      freq: rec.freq.slice(),
    };

    dom.results.hidden = false;
    dom.resMeta.textContent =
      `${new Date(savedData.startTs).toLocaleString('de-DE')} · ` +
      `Dauer: ${savedData.durationSec.toFixed(1)} s · ` +
      `Punkte: ${savedData.t.length} · ` +
      `Filter: ${FILTERS[savedData.filter]?.label || savedData.filter}`;

    if (dom.exportUnit) dom.exportUnit.value = savedData.unit;
    setTimeout(() => { resizeCanvas(dom.resultChart); drawResult(savedData); }, 80);
  }
  rec = null;
}

dom.startBtn.addEventListener('click', () => running ? stopMeasurement() : startMeasurement());
dom.resetBtn.addEventListener('click', () => resetState());

/* ══════════════════════════════════════════════
   HAUPT-LOOP
══════════════════════════════════════════════ */
function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  const now = performance.now();
  const dt  = Math.min((now - (intg.prev ?? now)) / 1000, 0.05);
  intg.prev = now;

  // 1. Filter
  const { fx, fy, fz } = applyFilter(rawX, rawY, rawZ);

  // 2. Integration
  integrate(fx, fy, fz, dt);

  // 3. Velocity für Peak/RMS/ÖNORM (immer in mm/s)
  const velTotal = Math.sqrt(intg.vx*intg.vx + intg.vy*intg.vy + intg.vz*intg.vz) * 1000;
  if (velTotal > peakTotal) peakTotal = velTotal;
  rmsAcc += velTotal * velTotal; rmsCnt++;

  // 4. Anzeigewerte je Einheit
  const { vx, vy, vz, vt } = getDisplayValues(fx, fy, fz);

  // 5. Buffer befüllen (für Live-Chart immer mm/s, unabhängig von Anzeige-Einheit)
  //    → damit Chart immer konsistent ist
  const bx = intg.vx*1000, by = intg.vy*1000, bz = intg.vz*1000;
  buf.x[buf.ptr] = bx; buf.y[buf.ptr] = by;
  buf.z[buf.ptr] = bz; buf.t[buf.ptr] = velTotal;
  buf.ptr = (buf.ptr + 1) % WINDOW_LEN;
  if (buf.len < WINDOW_LEN) buf.len++;

  // 6. Frequenz-Buffer
  freqBuf.t[freqBuf.ptr] = velTotal;
  freqBuf.ptr = (freqBuf.ptr + 1) % FREQ_WIN;
  if (freqBuf.len < FREQ_WIN) freqBuf.len++;

  // Frequenz alle ~0.5s neu schätzen (alle 30 Frames)
  if (buf.ptr % 30 === 0) {
    domFreqHz = estimateFrequency();
  }

  // 7. UI aktualisieren
  dom.xVal.textContent    = vx.toFixed(2);
  dom.yVal.textContent    = vy.toFixed(2);
  dom.zVal.textContent    = vz.toFixed(2);
  dom.tVal.textContent    = vt.toFixed(2);
  dom.peakVal.textContent = peakTotal.toFixed(2);
  dom.rmsVal.textContent  = rmsCnt ? Math.sqrt(rmsAcc / rmsCnt).toFixed(2) : '0.00';
  dom.freqVal.textContent = domFreqHz > 0 ? domFreqHz.toFixed(1) : '—';
  dom.mainNum.textContent = vt.toFixed(2);
  dom.mainSub.textContent = `${unitLabel()} (Total)`;

  // ÖNORM-Bewertung
  const oenormVal = activeUnit === 'vel'  ? velTotal :
                    activeUnit === 'acc'  ? Math.sqrt(fx*fx+fy*fy+fz*fz) :
                    activeUnit === 'disp' ? Math.sqrt(intg.px*intg.px+intg.py*intg.py+intg.pz*intg.pz)*1000 :
                    domFreqHz;
  updateOenorm(oenormVal);

  drawLive();

  dom.debugPanel.textContent =
    `raw  ax=${rawX.toFixed(3)} ay=${rawY.toFixed(3)} az=${rawZ.toFixed(3)} m/s²\n` +
    `filt fx=${fx.toFixed(3)} fy=${fy.toFixed(3)} fz=${fz.toFixed(3)} m/s²\n` +
    `vel  x=${(intg.vx*1000).toFixed(2)} y=${(intg.vy*1000).toFixed(2)} z=${(intg.vz*1000).toFixed(2)} mm/s\n` +
    `velTotal=${velTotal.toFixed(2)} mm/s | Peak=${peakTotal.toFixed(2)} mm/s\n` +
    `freq=${domFreqHz.toFixed(1)} Hz | dt=${(dt*1000).toFixed(1)} ms | filter=${activeFilter} | unit=${activeUnit}`;

  // Recording
  if (rec && rec.t.length < MAX_REC) {
    rec.x.push(intg.vx*1000);
    rec.y.push(intg.vy*1000);
    rec.z.push(intg.vz*1000);
    rec.t.push(velTotal);
    rec.freq.push(domFreqHz);
  }
}

/* ══════════════════════════════════════════════
   CSV EXPORT
══════════════════════════════════════════════ */
function exportCSV() {
  if (!savedData) return;
  const expUnit = dom.exportUnit ? dom.exportUnit.value : savedData.unit;
  const u       = unitLabel(expUnit);
  const data    = savedData;
  const n       = data.t.length;
  const dt      = data.durationSec / Math.max(1, n - 1);

  // Konvertierung der gespeicherten mm/s Daten in gewünschte Einheit
  function convert(v_mms) {
    if (expUnit === 'acc')  return v_mms / 1000 * (2 * Math.PI * 10); // ~@10Hz
    if (expUnit === 'disp') return (v_mms / 1000) / (2 * Math.PI * 10) * 1000; // mm @10Hz
    if (expUnit === 'hz')   return null; // Hz separat
    return v_mms; // vel mm/s
  }

  let csv = `# HTB Schwingungsmesser Export\n`;
  csv += `# Start: ${new Date(data.startTs).toLocaleString('de-DE')}\n`;
  csv += `# Dauer: ${data.durationSec.toFixed(2)} s\n`;
  csv += `# Einheit: ${u}\n`;
  csv += `# Filter: ${FILTERS[data.filter]?.label || data.filter}\n`;
  csv += `# Norm: ÖNORM S 9020\n`;
  if (expUnit !== 'vel' && expUnit !== 'hz') {
    csv += `# Hinweis: Konvertierung aus mm/s bei Annahme f=10 Hz\n`;
  }
  csv += `#\n`;

  if (expUnit === 'hz') {
    csv += `i;time_s;freq_Hz\n`;
    for (let i = 0; i < n; i++) {
      csv += `${i};${(i*dt).toFixed(4)};${(data.freq[i]||0).toFixed(2)}\n`;
    }
  } else {
    csv += `i;time_s;x_${u};y_${u};z_${u};total_${u}\n`;
    for (let i = 0; i < n; i++) {
      const cx = convert(data.x[i]).toFixed(6);
      const cy = convert(data.y[i]).toFixed(6);
      const cz = convert(data.z[i]).toFixed(6);
      const ct = convert(data.t[i]).toFixed(6);
      csv += `${i};${(i*dt).toFixed(4)};${cx};${cy};${cz};${ct}\n`;
    }
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `HTB_Messung_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
$('csvBtn').addEventListener('click', exportCSV);

/* ══════════════════════════════════════════════
   PDF EXPORT – 3 Plots, A4, wissenschaftlich
══════════════════════════════════════════════ */
function plotToDataURL({ series, title, unit, color, durationSec }) {
  const W = 1200, H = 260;
  const mL = 74, mR = 20, mT = 32, mB = 50;
  const pw = W - mL - mR, ph = H - mT - mB;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = '#e0e0e0'; ctx.lineWidth = 1;
  for (let i = 0; i <= 12; i++) {
    const x = mL + (i/12)*pw;
    ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT+ph); ctx.stroke();
  }
  for (let j = 0; j <= 5; j++) {
    const y = mT + (j/5)*ph;
    ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL+pw, y); ctx.stroke();
  }

  // Min/Max
  let mn = Infinity, mx = -Infinity;
  for (const v of series) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!isFinite(mn)) { mn = -1; mx = 1; }
  if (mn === mx) { mn -= 1; mx += 1; }
  const pad = (mx - mn) * 0.08;
  mn -= pad; mx += pad;
  const yOf = (v) => mT + ph - ((v - mn) / (mx - mn)) * ph;

  // Achsen
  ctx.strokeStyle = '#444'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(mL, mT); ctx.lineTo(mL, mT+ph); ctx.lineTo(mL+pw, mT+ph);
  ctx.stroke();

  // Nulllinie
  const y0 = yOf(0);
  if (y0 >= mT && y0 <= mT+ph) {
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 1;
    ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(mL, y0); ctx.lineTo(mL+pw, y0); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Titel
  ctx.fillStyle = color; ctx.font = 'bold 15px Arial';
  ctx.fillText(title, mL, 22);

  // Y-Einheit (rotiert)
  ctx.save();
  ctx.translate(14, mT + ph/2);
  ctx.rotate(-Math.PI/2);
  ctx.fillStyle = '#555'; ctx.font = '12px Arial'; ctx.textAlign = 'center';
  ctx.fillText(unit, 0, 0);
  ctx.restore();

  // Y-Ticks (6)
  ctx.fillStyle = '#333'; ctx.font = '11px Arial'; ctx.textAlign = 'right';
  for (let j = 0; j <= 5; j++) {
    const vv = mn + (j/5)*(mx-mn);
    const yy = yOf(vv);
    ctx.fillText(vv.toFixed(3), mL-5, yy+4);
    ctx.strokeStyle = '#ccc'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(mL-3, yy); ctx.lineTo(mL, yy); ctx.stroke();
  }

  //
