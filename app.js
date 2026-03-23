'use strict';

/* ══════════════════════════════════════════════
   KONFIGURATION
══════════════════════════════════════════════ */
const WINDOW_LEN = 600;   // 10s bei ~60fps
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
const hp   = { x:0, y:0, z:0, px:0, py:0, pz:0 };

let peakTotal = 0, rmsAcc = 0, rmsCnt = 0, evtCount = 0;

/* ══════════════════════════════════════════════
   iOS ERKENNUNG
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
  results:       $('results'),
  startBtn:      $('startBtn'),
  resetBtn:      $('resetBtn'),
  iosPermBtn:    $('iosPermBtn'),
  installBanner: $('installBanner'),
  installBtn:    $('installBtn'),
  exportUnit:    $('exportUnit'),
};

const liveCtx = dom.liveChart.getContext('2d');
const resCtx  = dom.resultChart.getContext('2d');

/* ══════════════════════════════════════════════
   GLOBALER FEHLER-HANDLER
══════════════════════════════════════════════ */
window.addEventListener('error', (e) => {
  dom.statusBar.hidden = false;
  dom.statusBar.className = 'statusBar is-error';
  dom.statusBar.textContent = `JS Fehler: ${e.message} (Zeile ${e.lineno})`;
});

/* ══════════════════════════════════════════════
   HELPER
══════════════════════════════════════════════ */
function unitLabel(u) {
  u = u || activeUnit;
  return u === 'acc' ? 'm/s²' : u === 'disp' ? 'mm' : 'mm/s';
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
   TABS  ← Haupt-Fix
══════════════════════════════════════════════ */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    // Alle Tabs: is-active entfernen, dann aktiven setzen
    document.querySelectorAll('.tab').forEach(b =>
      b.classList.toggle('is-active', b === btn)
    );
    // Alle Panes verstecken, dann aktiven zeigen
    document.querySelectorAll('.pane').forEach(p => {
      const isActive = (p.id === `tab-${btn.dataset.tab}`);
      p.classList.toggle('is-active', isActive);
      p.hidden = !isActive;
    });
    // Canvas nach Tab-Switch neu messen (Transition braucht Zeit)
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
      b.classList.toggle('is-active', b === btn)
    );
    updateUnitLabels();
  });
});

/* ══════════════════════════════════════════════
   ÖNORM S 9020 Bewertung
══════════════════════════════════════════════ */
const oenormRows   = ['n0','n1','n2','n3','n4'];
const oenormBounds = [0, 5, 10, 20, 30];   // mm/s Spitzenwert

function updateOENORM(vMms) {
  let row = 0;
  for (let i = oenormBounds.length - 1; i >= 0; i--) {
    if (vMms >= oenormBounds[i]) { row = i; break; }
  }
  oenormRows.forEach((id, i) =>
    $(id).classList.toggle('is-active', i === row)
  );
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
   LIVE CHART – 3 Panels: X / Y / Z untereinander
══════════════════════════════════════════════ */
function drawLive() {
  const cvs = dom.liveChart;
  const ctx = liveCtx;
  const W = cvs.getBoundingClientRect().width  || 300;
  const H = cvs.getBoundingClientRect().height || 360;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  const axes   = ['x', 'y', 'z'];
  const labels = ['X', 'Y', 'Z'];
  const panH   = H / 3;                 // Höhe je Panel
  const mL = 52, mR = 8, mT = 18, mB = 24;

  axes.forEach((s, pi) => {
    const offY = pi * panH;            // Y-Offset dieses Panels
    const pw   = W - mL - mR;
    const ph   = panH - mT - mB;

    // Panel-Hintergrund (abwechselnd leicht unterschiedlich)
    ctx.fillStyle = pi % 2 === 0 ? '#0b0b0c' : '#0e0e10';
    ctx.fillRect(0, offY, W, panH);

    // Separator-Linie zwischen Panels
    if (pi > 0) {
      ctx.strokeStyle = '#2a2a2d';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, offY);
      ctx.lineTo(W, offY);
      ctx.stroke();
    }

    // Daten-Bereich berechnen
    if (buf.len < 2) {
      // Leer – nur Label
      ctx.fillStyle = '#4a4a52';
      ctx.font = 'bold 11px system-ui';
      ctx.fillText(labels[pi], mL + 4, offY + mT + 12);
      return;
    }

    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < buf.len; i++) {
      const v = buf[s][(buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!isFinite(mn)) { mn = -1; mx = 1; }
    if (mn === mx)     { mn -= 0.5; mx += 0.5; }
    const rng  = mx - mn;
    const yMin = mn - rng * 0.1;
    const yMax = mx + rng * 0.1;
    const span = yMax - yMin || 1;

    const toY = (v) => offY + mT + ph - ((v - yMin) / span) * ph;

    // Gitternetz (horizontal, 5 Linien)
    ctx.strokeStyle = '#1e1e22';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const gy = offY + mT + (g / 4) * ph;
      ctx.beginPath(); ctx.moveTo(mL, gy); ctx.lineTo(mL + pw, gy); ctx.stroke();
    }
    // Gitternetz (vertikal, 5 Linien)
    for (let g = 0; g <= 5; g++) {
      const gx = mL + (g / 5) * pw;
      ctx.beginPath(); ctx.moveTo(gx, offY + mT); ctx.lineTo(gx, offY + mT + ph); ctx.stroke();
    }

    // Nulllinie
    const y0 = toY(0);
    if (y0 >= offY + mT && y0 <= offY + mT + ph) {
      ctx.strokeStyle = '#3a3a42';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(mL, y0); ctx.lineTo(mL + pw, y0); ctx.stroke();
    }

    // Y-Achsen-Ticks (3 Ticks: min, 0, max)
    ctx.fillStyle = '#6c6c74';
    ctx.font = '9px system-ui';
    ctx.textAlign = 'right';
    [[yMin, offY + mT + ph], [0, y0], [yMax, offY + mT]].forEach(([v, ypx]) => {
      if (ypx >= offY + mT - 4 && ypx <= offY + mT + ph + 4) {
        ctx.fillText(v.toFixed(2), mL - 3, ypx + 3);
      }
    });
    ctx.textAlign = 'left';

    // Achsenbeschriftung (Label links oben im Panel)
    ctx.fillStyle = COLORS[s];
    ctx.font = 'bold 11px system-ui';
    ctx.fillText(labels[pi], 4, offY + mT + 10);

    // Einheit
    ctx.fillStyle = '#6c6c74';
    ctx.font = '9px system-ui';
    ctx.fillText(unitLabel(), 4, offY + mT + 22);

    // Zeitachse (nur beim letzten Panel)
    if (pi === axes.length - 1) {
      ctx.fillStyle = '#6c6c74';
      ctx.font = '9px system-ui';
      ctx.textAlign = 'center';
      ['-10s', '-8s', '-6s', '-4s', '-2s', '0s'].forEach((lbl, li) => {
        const tx = mL + (li / 5) * pw;
        ctx.fillText(lbl, tx, offY + mT + ph + 16);
      });
      ctx.textAlign = 'left';
    }

    // Kurve zeichnen
    ctx.strokeStyle = COLORS[s];
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < buf.len; i++) {
      const idx = (buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN;
      const xp  = mL + (i / (WINDOW_LEN - 1)) * pw;
      const yp  = toY(buf[s][idx]);
      i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
    }
    ctx.stroke();
  });

  // Zeitachse-Label unten (außerhalb der Panels)
  dom.liveAxis.innerHTML = '';  // wird im Canvas gezeichnet, kein HTML nötig
}

/* ══════════════════════════════════════════════
   RESULT CHART – 3 Panels: X / Y / Z
══════════════════════════════════════════════ */
function drawResult(data) {
  const cvs = dom.resultChart;
  const ctx = resCtx;
  const W = cvs.getBoundingClientRect().width  || 300;
  const H = cvs.getBoundingClientRect().height || 360;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  const axes   = ['x', 'y', 'z'];
  const labels = ['X', 'Y', 'Z'];
  const panH   = H / 3;
  const mL = 52, mR = 8, mT = 18, mB = 24;

  axes.forEach((s, pi) => {
    const offY   = pi * panH;
    const pw     = W - mL - mR;
    const ph     = panH - mT - mB;
    const series = data[s];
    if (!series || series.length < 2) return;

    ctx.fillStyle = pi % 2 === 0 ? '#0b0b0c' : '#0e0e10';
    ctx.fillRect(0, offY, W, panH);

    if (pi > 0) {
      ctx.strokeStyle = '#2a2a2d';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, offY); ctx.lineTo(W, offY); ctx.stroke();
    }

    let mn = Infinity, mx = -Infinity;
    series.forEach(v => { if (v < mn) mn = v; if (v > mx) mx = v; });
    if (mn === mx) { mn -= 0.5; mx += 0.5; }
    const pad  = (mx - mn) * 0.1;
    const yMin = mn - pad, yMax = mx + pad;
    const span = yMax - yMin || 1;
    const toY  = (v) => offY + mT + ph - ((v - yMin) / span) * ph;

    // Grid
    ctx.strokeStyle = '#1e1e22'; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const gy = offY + mT + (g / 4) * ph;
      ctx.beginPath(); ctx.moveTo(mL, gy); ctx.lineTo(mL + pw, gy); ctx.stroke();
    }
    for (let g = 0; g <= 5; g++) {
      const gx = mL + (g / 5) * pw;
      ctx.beginPath(); ctx.moveTo(gx, offY + mT); ctx.lineTo(gx, offY + mT + ph); ctx.stroke();
    }

    // Nulllinie
    const y0 = toY(0);
    if (y0 >= offY + mT && y0 <= offY + mT + ph) {
      ctx.strokeStyle = '#3a3a42'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(mL, y0); ctx.lineTo(mL + pw, y0); ctx.stroke();
    }

    // Y-Ticks
    ctx.fillStyle = '#6c6c74'; ctx.font = '9px system-ui'; ctx.textAlign = 'right';
    [[yMin, offY + mT + ph], [0, y0], [yMax, offY + mT]].forEach(([v, ypx]) => {
      if (ypx >= offY + mT - 4 && ypx <= offY + mT + ph + 4)
        ctx.fillText(v.toFixed(2), mL - 3, ypx + 3);
    });
    ctx.textAlign = 'left';

    // Label
    ctx.fillStyle = COLORS[s]; ctx.font = 'bold 11px system-ui';
    ctx.fillText(labels[pi], 4, offY + mT + 10);
    ctx.fillStyle = '#6c6c74'; ctx.font = '9px system-ui';
    ctx.fillText(unitLabel(data.unit), 4, offY + mT + 22);

    // Zeitachse (letztes Panel)
    if (pi === axes.length - 1) {
      ctx.fillStyle = '#6c6c74'; ctx.font = '9px system-ui'; ctx.textAlign = 'center';
      [0, 0.2, 0.4, 0.6, 0.8, 1.0].forEach((frac, li) => {
        const t  = (frac * data.durationSec).toFixed(1);
        const tx = mL + frac * pw;
        ctx.fillText(`${t}s`, tx, offY + mT + ph + 16);
      });
      ctx.textAlign = 'left';
    }

    // Kurve
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
   RESET / START / STOP
══════════════════════════════════════════════ */
function resetState() {
  running = false;
  if (rafId)      { cancelAnimationFrame(rafId);   rafId      = null; }
  if (durTimer)   { clearInterval(durTimer);        durTimer   = null; }
  if (noDataTimer){ clearTimeout(noDataTimer);      noDataTimer = null; }

  startTime = null; evtCount = 0; peakTotal = 0;
  rmsAcc = 0; rmsCnt = 0; motionEventCount = 0;

  buf.ptr = 0; buf.len = 0;
  buf.x.fill(0); buf.y.fill(0); buf.z.fill(0); buf.t.fill(0);

  intg.vx = intg.vy = intg.vz = 0;
  intg.px = intg.py = intg.pz = 0;
  intg.prev = null;

  hp.x = hp.y = hp.z = 0;
  hp.px = hp.py = hp.pz = 0;

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
  dom.evtVal.textContent   = '0';
  dom.durVal.textContent   = '00:00';
  dom.results.hidden       = true;
  dom.resMeta.textContent  = '—';
  dom.debugPanel.textContent = 'Warte auf Sensor-Daten …';

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = false);
  oenormRows.forEach(id => $(id).classList.remove('is-active'));
  setStatus('', '');
  drawLive();
}

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
    unit: activeUnit,
    t0: performance.now(), startTs: startTime,
    x: [], y: [], z: [], t: [], velTotal: []
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

  if (rafId)      { cancelAnimationFrame(rafId);   rafId      = null; }
  if (durTimer)   { clearInterval(durTimer);        durTimer   = null; }
  if (noDataTimer){ clearTimeout(noDataTimer);      noDataTimer = null; }

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

    dom.results.hidden = false;
    dom.resMeta.textContent =
      `${new Date(savedData.startTs).toLocaleString('de-DE')} · ` +
      `Dauer: ${savedData.durationSec.toFixed(1)} s · ` +
      `Punkte: ${savedData.t.length}`;

    // Export-Dropdown auf aktuelle Einheit vorauswählen
    if (dom.exportUnit) dom.exportUnit.value = savedData.unit;

    setTimeout(() => { resizeCanvas(dom.resultChart); drawResult(savedData); }, 80);
  }
  rec = null;
}

dom.startBtn.addEventListener('click', () => running ? stopMeasurement() : startMeasurement());
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

  processIMU(rawX, rawY, rawZ, dt);

  const { vx, vy, vz, vt } = getValues();

  buf.x[buf.ptr] = vx; buf.y[buf.ptr] = vy;
  buf.z[buf.ptr] = vz; buf.t[buf.ptr] = vt;
  buf.ptr = (buf.ptr + 1) % WINDOW_LEN;
  if (buf.len < WINDOW_LEN) buf.len++;

  const velTotal = Math.sqrt(intg.vx*intg.vx + intg.vy*intg.vy + intg.vz*intg.vz) * 1000;
  if (velTotal > peakTotal) peakTotal = velTotal;
  rmsAcc += velTotal * velTotal; rmsCnt++;
  if (velTotal > EVT_THR) evtCount++;

  const u = unitLabel();
  dom.xVal.textContent    = vx.toFixed(2);
  dom.yVal.textContent    = vy.toFixed(2);
  dom.zVal.textContent    = vz.toFixed(2);
  dom.tVal.textContent    = vt.toFixed(2);
  dom.peakVal.textContent = peakTotal.toFixed(2);
  dom.rmsVal.textContent  = rmsCnt ? Math.sqrt(rmsAcc / rmsCnt).toFixed(2) : '0.00';
  dom.evtVal.textContent  = evtCount;

  dom.mainNum.textContent = vt.toFixed(2);
  dom.mainSub.textContent = `${u} (Total)`;

  if (activeUnit === 'vel') updateOENORM(velTotal);

  drawLive();

  dom.debugPanel.textContent =
    `raw  ax=${rawX.toFixed(3)} ay=${rawY.toFixed(3)} az=${rawZ.toFixed(3)} m/s²\n` +
    `hp   ax=${hp.x.toFixed(3)} ay=${hp.y.toFixed(3)} az=${hp.z.toFixed(3)} m/s²\n` +
    `vel  x=${(intg.vx*1000).toFixed(2)} y=${(intg.vy*1000).toFixed(2)} z=${(intg.vz*1000).toFixed(2)} mm/s\n` +
    `velTotal=${velTotal.toFixed(2)} mm/s | Peak=${peakTotal.toFixed(2)} mm/s\n` +
    `Events=${evtCount} | dt=${(dt*1000).toFixed(1)} ms | unit=${activeUnit}`;

  if (rec && rec.t.length < MAX_REC) {
    rec.x.push(vx); rec.y.push(vy); rec.z.push(vz); rec.t.push(vt);
    rec.velTotal.push(velTotal);
  }
}

/* ══════════════════════════════════════════════
   EXPORT HELPER – konvertiert Daten in gewählte Einheit
══════════════════════════════════════════════ */
function getExportData() {
  if (!savedData) return null;
  const targetUnit = dom.exportUnit ? dom.exportUnit.value : savedData.unit;

  // Wenn Einheit gleich wie aufgezeichnet, direkt zurückgeben
  if (targetUnit === savedData.unit) return { ...savedData, unit: targetUnit };

  // Sonst: Re-Berechnung aus Rohdaten nicht möglich (wir haben nur die konvertierten Werte)
  // Daher Hinweis und Originaldaten nehmen
  return { ...savedData, unit: savedData.unit };
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

  let csv = `# HTB Schwingungsmesser Export\n`;
  csv += `# Start: ${new Date(data.startTs).toLocaleString('de-DE')}\n`;
  csv += `# Dauer: ${data.durationSec.toFixed(2)} s\n`;
  csv += `# Einheit: ${u}\n`;
  csv += `# Norm: ÖNORM S 9020\n#\n`;
  csv += `i;time_s;x_${u};y_${u};z_${u};total_${u}\n`;

  for (let i = 0; i < n; i++) {
    csv += `${i};${(i*dt).toFixed(4)};` +
           `${data.x[i].toFixed(6)};${data.y[i].toFixed(6)};` +
           `${data.z[i].toFixed(6)};${data.t[i].toFixed(6)}\n`;
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
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
  const mL = 72, mR = 18, mT = 30, mB = 48;
  const pw = W - mL - mR, ph = H - mT - mB;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // Weißer Hintergrund
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = '#e0e0e0'; ctx.lineWidth = 1;
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
  const pad  = (mx - mn) * 0.1;
  mn -= pad; mx += pad;
  const yOf = (v) => mT + ph - ((v - mn) / (mx - mn)) * ph;

  // Achsenlinien
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(mL, mT); ctx.lineTo(mL, mT+ph); ctx.lineTo(mL+pw, mT+ph);
  ctx.stroke();

  // Nulllinie
  const y0 = yOf(0);
  if (y0 >= mT && y0 <= mT + ph) {
    ctx.strokeStyle = '#aaa'; ctx.lineWidth = 1;
    ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(mL, y0); ctx.lineTo(mL+pw, y0); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Titel
  ctx.fillStyle = '#111'; ctx.font = 'bold 16px Arial';
  ctx.fillText(title, mL, 20);

  // Y-Einheit (rotiert)
  ctx.save();
  ctx.translate(14, mT + ph/2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#333'; ctx.font = '12px Arial'; ctx.textAlign = 'center';
  ctx.fillText(unit, 0, 0);
  ctx.restore();

  // Y-Ticks (7 Werte)
  ctx.fillStyle = '#333'; ctx.font = '11px Arial'; ctx.textAlign = 'right';
  for (let j = 0; j <= 6; j++) {
    const vv = mn + (j/6)*(mx-mn);
    const yy = yOf(vv);
    ctx.fillText(vv.toFixed(3), mL - 5, yy + 4);
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(mL-3, yy); ctx.lineTo(mL, yy); ctx.stroke();
  }

  // X-Ticks (Zeit)
  ctx.textAlign = 'center'; ctx.fillStyle = '#333'; ctx.font = '11px Arial';
  for (let i = 0; i <= 10; i++) {
    const t  = durationSec * (i/10);
    const xp = mL + (i/10)*pw;
    ctx.fillText(t.toFixed(1), xp, H - 28);
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(xp, mT+ph); ctx.lineTo(xp, mT+ph+4); ctx.stroke();
  }
  ctx.fillStyle = '#333'; ctx.font = '12px Arial';
  ctx.fillText('t [s]', mL + pw/2, H - 10);

  // Messlinie
  ctx.strokeStyle = color; ctx.lineWidth = 2.5;
  ctx.beginPath();
  const n = series.length;
  for (let i = 0; i < n; i++) {
    const xp = mL + (i/(n-1))*pw;
    const yp = yOf(series[i]);
    i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
  }
  ctx.stroke();

  return c.toDataURL('image/png', 1.0);
}

function exportPDF() {
  if (!savedData) {
    setStatus('Keine Messdaten vorhanden – erst messen!', 'is-error');
    return;
  }

  const expUnit = dom.exportUnit ? dom.exportUnit.value : savedData.unit;
  const unit    = unitLabel(expUnit);
  const dur     = savedData.durationSec;

  const imgX = plotToDataURL({ series: savedData.x, title: 'X-Achse', unit, color: '#e53333', durationSec: dur });
  const imgY = plotToDataURL({ series: savedData.y, title: 'Y-Achse', unit, color: '#00aa55', durationSec: dur });
  const imgZ = plotToDataURL({ series: savedData.z, title: 'Z-Achse', unit, color: '#3377dd', durationSec: dur });

  // Bewertung berechnen
  const peakMms = Math.max(...savedData.t);
  let oenormKlasse = 'I';
  if      (peakMms >= 30) oenormKlasse = 'V';
  else if (peakMms >= 20) oenormKlasse = 'IV';
  else if (peakMms >= 10) oenormKlasse = 'III';
  else if (peakMms >=  5) oenormKlasse = 'II';

  const w = window.open('', '_blank');
  if (!w) { setStatus('Popup blockiert – bitte Popups erlauben!', 'is-error'); return; }

  w.document.open();
  w.document.write(`<!doctype html><html><head>
<meta charset="utf-8"/>
<title>HTB Schwingungsmesser – Messbericht</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  body { font-family: Arial, sans-serif; background: #fff; color: #111; margin: 0; padding: 0 12mm; }
  .header { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #111; padding: 8px 0 10px; margin-bottom: 10px; }
  .header-title { font-size: 18px; font-weight: bold; }
  .header-sub   { font-size: 11px; color: #555; margin-top: 3px; }
  .meta { font-size: 10px; color: #333; line-height: 1.7; margin-bottom: 10px;
          border: 1px solid #ddd; border-radius: 4px; padding: 8px 12px; background: #fafafa; }
  .plot { margin: 8px 0; page-break-inside: avoid; }
  .plot img { width: 100%; border: 1px solid #ccc; border-radius: 3px; }
  .norm { margin-top: 10px; font-size: 10px; border: 1px solid #ddd; border-radius: 4px;
          padding: 8px 12px; background: #fffdf0; }
  .norm b { color: #b8860b; }
  .footer { margin-top: 14px; font-size: 9px; color: #999; text-align: center;
            border-top: 1px solid #eee; padding-top: 6px; }
</style>
</head><body>
<div class="header">
  <div>
    <div class="header-title">HTB Baugesellschaft m.b.H. – Schwingungsmessbericht</div>
    <div class="header-sub">HTB Schwingungsmesser PWA · Messung mit Smartphone-Sensor</div>
  </div>
</div>

<div class="meta">
  <b>Datum / Start:</b> ${new Date(savedData.startTs).toLocaleString('de-DE')}<br/>
  <b>Messdauer:</b> ${dur.toFixed(2)} s &nbsp;·&nbsp;
  <b>Datenpunkte:</b> ${savedData.t.length} &nbsp;·&nbsp;
  <b>Einheit:</b> ${unit}<br/>
  <b>Peak (Total):</b> ${peakMms.toFixed(3)} mm/s
</div>

<div class="plot"><img src="${imgX}" alt="X-Achse"></div>
<div class="plot"><img src="${imgY}" alt="Y-Achse"></div>
<div class="plot"><img src="${imgZ}" alt="Z-Achse"></div>

<div class="norm">
  <b>Bewertung nach ÖNORM S 9020:</b><br/>
  Spitzenwert (Total, mm/s): <b>${peakMms.toFixed(3)} mm/s</b> → <b>Klasse ${oenormKlasse}</b><br/>
  <br/>
  Klasse I: &lt; 5 mm/s – keine Schäden &nbsp;|&nbsp;
  Klasse II: 5–10 mm/s – leichte kos. Schäden möglich &nbsp;|&nbsp;
  Klasse III: 10–20 mm/s – leichte Schäden &nbsp;|&nbsp;
  Klasse IV: 20–30 mm/s – mittlere Schäden &nbsp;|&nbsp;
  Klasse V: &gt; 30 mm/s – schwere Schäden<br/>
  <br/>
  <i>Hinweis: Smartphone-Sensoren sind nicht kalibriert. Ergebnisse dienen der Orientierung
  und ersetzen keine normgerechte Messung mit kalibrierten Geräten.</i>
</div>

<div class="footer">
  © HTB Baugesellschaft m.b.H. – Alle Angaben ohne Gewähr · Erstellt: ${new Date().toLocaleString('de-DE')}
</div>

<script>setTimeout(() => window.print(), 300);<\/script>
</body></html>`);
  w.document.close();
}
$('pdfBtn').addEventListener('click', exportPDF);

/* ══════════════════════════════════════════════
   iOS Sensor Permission
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
        setStatus('Sensorerlaubnis erteilt – jetzt Start drücken.', 'is-done');
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

  if (IS_STANDALONE) { dom.installBanner.hidden = true; return; }

  if (IS_IOS) {
    dom.installBanner.hidden = false;
    dom.installBtn.textContent = 'Anleitung';
    dom.installBtn.onclick = () =>
      setStatus('iPhone: Safari → Teilen (□↑) → „Zum Home-Bildschirm"', 'is-error');
    return;
  }

  dom.installBanner.hidden  = true;
  dom.installBtn.disabled   = true;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredPrompt = e;
    dom.installBanner.hidden = false;
    dom.installBtn.disabled  = false;
  });

  dom.installBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!deferredPrompt) {
      setStatus('Chrome-Menü (⋮) → „App installieren"', 'is-error'); return;
    }
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    dom.installBanner.hidden = true;
    dom.installBtn.disabled  = true;
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    dom.installBanner.hidden = true;
    dom.installBtn.disabled  = true;
  });
})();

/* ══════════════════════════════════════════════
   SERVICE WORKER
══════════════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('sw.js').catch(() => {})
  );
}

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
updateUnitLabels();
resetState();
