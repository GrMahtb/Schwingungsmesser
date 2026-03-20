'use strict';

/* =========================================================
   KONFIG
========================================================= */
const WINDOW_LEN = 600;             // Live-Chart: ~10 s @ 60 Hz
const HP_ALPHA   = 0.97;            // Highpass (Drift weg)
const LEAK_V     = 0.985;           // Drift-Dämpfung v
const LEAK_P     = 0.995;           // Drift-Dämpfung s
const EVT_THR    = 0.1;             // mm/s Event-Schwelle

const COLORS = { x:'#ff4444', y:'#00cc66', z:'#4499ff', t:'#ffed00' };
const DIN_GUIDES = [0.3, 1.0, 3.0, 10.0];

/* =========================================================
   STATE
========================================================= */
let running = false;
let startTime = null;
let durTimer = null;
let rafId = null;

// Vor Start gewählte Einheit (Anzeige)
let activeUnit  = 'vel'; // 'vel'|'acc'|'disp'|'freq'
// Während einer Messung fixierte Anzeige-Einheit
let measureUnit = 'vel';

let savedAll = null;   // alle Einheiten der letzten Messung
let savedData = null;  // default = measureUnit aus letzter Messung
let rec = null;

let noDataTimer = null;
let motionEventCount = 0;

// Sensor raw (m/s²)
let rawX = 0, rawY = 0, rawZ = 0;

// Integrationszustand
const intg = { vx:0, vy:0, vz:0, px:0, py:0, pz:0, prev:null };

// Highpass state
const hp = { x:0, y:0, z:0, px:0, py:0, pz:0 };

// Live-Chart Buffer (zeigt IMMER measureUnit)
const buf = {
  x: new Float32Array(WINDOW_LEN),
  y: new Float32Array(WINDOW_LEN),
  z: new Float32Array(WINDOW_LEN),
  t: new Float32Array(WINDOW_LEN),
  ptr: 0,
  len: 0
};

// Statistik (immer vel total mm/s)
let peakTotal = 0, rmsAcc = 0, rmsCnt = 0, evtCount = 0;

// Sichtbarkeit
const vis = { x:true, y:true, z:true, t:true };

// iOS
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent);

/* =========================================================
   DOM
========================================================= */
const $ = (id) => document.getElementById(id);

const dom = {
  statusBar: $('statusBar'),

  mainNum: $('mainNum'),
  mainSub: $('mainSub'),

  xVal: $('xVal'),
  yVal: $('yVal'),
  zVal: $('zVal'),
  tVal: $('tVal'),

  peakVal: $('peakVal'),
  rmsVal: $('rmsVal'),
  evtVal: $('evtVal'),
  durVal: $('durVal'),

  debugPanel: $('debugPanel'),

  liveChart: $('liveChart'),
  liveAxis: $('liveAxis'),

  resultChart: $('resultChart'),
  resAxis: $('resAxis'),
  resMeta: $('resMeta'),
  results: $('results'),

  dinNote: $('dinNote'),

  startBtn: $('startBtn'),
  resetBtn: $('resetBtn'),
  iosPermBtn: $('iosPermBtn'),

  installBanner: $('installBanner'),
  installBtn: $('installBtn'),

  exportUnit: $('exportUnit'), // optional
  csvBtn: $('csvBtn'),
  pdfBtn: $('pdfBtn'),
};

const liveCtx = dom.liveChart.getContext('2d');
const resCtx  = dom.resultChart.getContext('2d');

/* =========================================================
   FEHLER -> StatusBar
========================================================= */
window.addEventListener('error', (e) => {
  if (!dom.statusBar) return;
  dom.statusBar.hidden = false;
  dom.statusBar.className = 'statusBar is-error';
  dom.statusBar.textContent = `JS Fehler: ${e.message} (Zeile ${e.lineno})`;
});

/* =========================================================
   HELPER
========================================================= */
function unitLabel(mode) {
  if (mode === 'acc')  return 'm/s²';
  if (mode === 'disp') return 'mm';
  if (mode === 'freq') return 'Hz';
  return 'mm/s';
}
function yAxisText(mode) {
  if (mode === 'acc')  return 'a (m/s²)';
  if (mode === 'disp') return 's (mm)';
  if (mode === 'freq') return 'f (Hz)';
  return 'v (mm/s)';
}
function fmtTime(ms) {
  const mm = String(Math.floor(ms/60000)).padStart(2,'0');
  const ss = String(Math.floor(ms/1000)%60).padStart(2,'0');
  return `${mm}:${ss}`;
}
function setStatus(msg, cls) {
  dom.statusBar.textContent = msg;
  dom.statusBar.className = 'statusBar' + (cls ? ' ' + cls : '');
  dom.statusBar.hidden = !msg;
}

/* =========================================================
   CANVAS RESIZE
========================================================= */
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

/* =========================================================
   TABS
========================================================= */
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

/* =========================================================
   UNIT BUTTONS (nur vor Start umschaltbar)
========================================================= */
function updateUnitLabelsUI() {
  const u = unitLabel(activeUnit);

  // X/Y/Z/Total
  ['unitX','unitY','unitZ','unitT'].forEach(id => {
    const el = $(id); if (el) el.textContent = u;
  });

  // Peak/RMS immer mm/s
  const up = $('unitPeak'); if (up) up.textContent = 'mm/s';
  const ur = $('unitRms');  if (ur) ur.textContent = 'mm/s';

  dom.mainSub.textContent = `${u} (Total)`;
}

document.querySelectorAll('.unitBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (running) return; // während Messung nicht umschalten
    activeUnit = btn.dataset.unit;

    document.querySelectorAll('.unitBtn').forEach(b =>
      b.classList.toggle('is-active', b === btn));

    updateUnitLabelsUI();

    // Live-Diagramm leeren (da Anzeige-Einheit wechselt)
    buf.ptr = 0; buf.len = 0;
    buf.x.fill(0); buf.y.fill(0); buf.z.fill(0); buf.t.fill(0);
    drawLive();
  });
});

/* =========================================================
   AXIS TOGGLES
========================================================= */
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

/* =========================================================
   DIN 4150-2 Highlight
========================================================= */
const dinRows   = ['n0','n1','n2','n3','n4'];
const dinBounds = [0, 0.3, 1.0, 3.0, 10.0];
function updateDIN(vMms) {
  let row = 0;
  for (let i = dinBounds.length - 1; i >= 0; i--) {
    if (vMms >= dinBounds[i]) { row = i; break; }
  }
  dinRows.forEach((id, i) => $(id).classList.toggle('is-active', i === row));
}

/* =========================================================
   IMU PROCESSING: Highpass + Integration
   (vereinfachte Drift-Unterdrückung)
========================================================= */
function processIMU(ax, ay, az, dt) {
  // Highpass
  hp.x = HP_ALPHA * (hp.x + ax - hp.px);
  hp.y = HP_ALPHA * (hp.y + ay - hp.py);
  hp.z = HP_ALPHA * (hp.z + az - hp.pz);
  hp.px = ax; hp.py = ay; hp.pz = az;

  // v (m/s)
  intg.vx = (intg.vx + hp.x * dt) * LEAK_V;
  intg.vy = (intg.vy + hp.y * dt) * LEAK_V;
  intg.vz = (intg.vz + hp.z * dt) * LEAK_V;

  // s (m)
  intg.px = (intg.px + intg.vx * dt) * LEAK_P;
  intg.py = (intg.py + intg.vy * dt) * LEAK_P;
  intg.pz = (intg.pz + intg.vz * dt) * LEAK_P;
}

/* =========================================================
   FREQ (dominant) – einfache Autokorrelation auf Total(acc)
========================================================= */
const FREQ_BUF = new Float32Array(256);
let freqPtr = 0, freqLen = 0;

function pushFreqSample(v) {
  FREQ_BUF[freqPtr] = v;
  freqPtr = (freqPtr + 1) % FREQ_BUF.length;
  if (freqLen < FREQ_BUF.length) freqLen++;
}

function dominantFreqAutocorr(fs, fmin = 1, fmax = 25) {
  const n = freqLen;
  if (n < 64 || fs <= 0) return 0;

  // series
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s[i] = FREQ_BUF[(freqPtr - n + i + FREQ_BUF.length) % FREQ_BUF.length];
  }

  // mean remove
  let mean = 0;
  for (let i = 0; i < n; i++) mean += s[i];
  mean /= n;

  const minLag = Math.max(2, Math.floor(fs / fmax));
  const maxLag = Math.min(n - 2, Math.floor(fs / fmin));
  if (maxLag <= minLag) return 0;

  let bestLag = 0, bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) {
      sum += (s[i] - mean) * (s[i + lag] - mean);
    }
    if (sum > bestVal) { bestVal = sum; bestLag = lag; }
  }
  return bestLag > 0 ? fs / bestLag : 0;
}

/* =========================================================
   LIVE CHART (ein Plot, X/Y/Z/Total einblendbar)
========================================================= */
function drawLive() {
  const cvs = dom.liveChart;
  const ctx = liveCtx;
  const W = cvs.getBoundingClientRect().width  || 300;
  const H = cvs.getBoundingClientRect().height || 200;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  // Axis labels (immer)
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '11px system-ui, Arial';
  ctx.textAlign = 'right';
  ctx.fillText('t [s]', W - 4, H - 6);
  ctx.save();
  ctx.translate(14, H/2 + 18);
  ctx.rotate(-Math.PI/2);
  ctx.textAlign = 'center';
  ctx.fillText(`${yAxisText(measureUnit)}`, 0, 0);
  ctx.restore();

  if (buf.len < 2) return;

  // range
  let mn = Infinity, mx = -Infinity;
  ['x','y','z','t'].forEach(s => {
    if (!vis[s]) return;
    for (let i = 0; i < buf.len; i++) {
      const idx = (buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN;
      const v = buf[s][idx];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  });
  if (!isFinite(mn)) { mn = -1; mx = 1; }
  const rng = (mx - mn) || 1;
  const yMin = mn - rng*0.12, yMax = mx + rng*0.12;

  // DIN lines subtle (nur vel)
  if (measureUnit === 'vel') {
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(255,237,0,0.14)';
    ctx.lineWidth = 1;
    for (const g of DIN_GUIDES) {
      const y = H - ((g - yMin)/(yMax - yMin))*H;
      if (y > 0 && y < H) {
        ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // zero line
  const y0 = H - ((0 - yMin) / (yMax - yMin)) * H;
  ctx.strokeStyle = '#2a2a2d';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();

  // series
  ['x','y','z','t'].forEach(s => {
    if (!vis[s]) return;
    ctx.strokeStyle = COLORS[s];
    ctx.lineWidth = s === 't' ? 2.5 : 1.5;
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

/* =========================================================
   RESULT CHART
========================================================= */
function drawResult(data) {
  const cvs = dom.resultChart;
  const ctx = resCtx;
  const W = cvs.getBoundingClientRect().width  || 300;
  const H = cvs.getBoundingClientRect().height || 220;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  const unitMode = data.unit || 'vel';

  let mn = Infinity, mx = -Infinity;
  ['x','y','z','t'].forEach(s => {
    data[s].forEach(v => { if (v < mn) mn = v; if (v > mx) mx = v; });
  });
  if (!isFinite(mn)) { mn = -1; mx = 1; }
  const rng = (mx - mn) || 1;
  const yMin = mn - rng*0.12, yMax = mx + rng*0.12;

  // DIN lines
  if (unitMode === 'vel') {
    ctx.save();
    ctx.setLineDash([4,6]);
    ctx.strokeStyle = 'rgba(255,237,0,0.18)';
    ctx.lineWidth = 1;
    for (const g of DIN_GUIDES) {
      const y = H - ((g - yMin)/(yMax - yMin))*H;
      if (y > 0 && y < H) {
        ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // zero
  const y0 = H - ((0 - yMin)/(yMax - yMin))*H;
  ctx.strokeStyle = '#2a2a2d';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0,y0); ctx.lineTo(W,y0); ctx.stroke();

  ['x','y','z','t'].forEach(s => {
    ctx.strokeStyle = COLORS[s];
    ctx.lineWidth   = s === 't' ? 2.5 : 1.5;
    ctx.beginPath();
    data[s].forEach((v, i) => {
      const xp = (i/(data[s].length-1))*W;
      const yp = H - ((v - yMin)/(yMax - yMin))*H;
      i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
    });
    ctx.stroke();
  });

  // axis labels
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '11px system-ui, Arial';
  ctx.textAlign = 'right';
  ctx.fillText('t [s]', W - 4, H - 6);

  ctx.save();
  ctx.translate(14, H/2 + 18);
  ctx.rotate(-Math.PI/2);
  ctx.textAlign = 'center';
  ctx.fillText(yAxisText(unitMode), 0, 0);
  ctx.restore();

  dom.resAxis.innerHTML = '<span>Anfang</span><span>Ende</span>';
}

/* =========================================================
   SENSOR
========================================================= */
function onMotion(e) {
  motionEventCount++;

  const a = (e.acceleration && e.acceleration.x != null)
    ? e.acceleration
    : e.accelerationIncludingGravity;

  if (!a) return;

  rawX = Number(a.x) || 0;
  rawY = Number(a.y) || 0;
  rawZ = Number(a.z) || 0;
}
window.addEventListener('devicemotion', onMotion, { passive:true });

/* =========================================================
   RESET / START / STOP
========================================================= */
function resetState() {
  running = false;

  if (rafId)      { cancelAnimationFrame(rafId); rafId = null; }
  if (durTimer)   { clearInterval(durTimer); durTimer = null; }
  if (noDataTimer){ clearTimeout(noDataTimer); noDataTimer = null; }

  startTime = null;
  motionEventCount = 0;

  peakTotal = 0; rmsAcc = 0; rmsCnt = 0; evtCount = 0;

  // reset display buffer
  buf.ptr = 0; buf.len = 0;
  buf.x.fill(0); buf.y.fill(0); buf.z.fill(0); buf.t.fill(0);

  // reset freq buf
  freqPtr = 0; freqLen = 0;
  FREQ_BUF.fill(0);

  // integrator + hp
  intg.vx = intg.vy = intg.vz = 0;
  intg.px = intg.py = intg.pz = 0;
  intg.prev = null;

  hp.x = hp.y = hp.z = 0;
  hp.px = hp.py = hp.pz = 0;

  rawX = rawY = rawZ = 0;

  rec = null;
  savedAll = null;
  savedData = null;

  dom.startBtn.textContent = 'Start';
  dom.startBtn.classList.add('btn--accent');
  dom.startBtn.classList.remove('btn--stop');

  dom.mainNum.textContent = '0.00';
  dom.mainSub.textContent = `${unitLabel(activeUnit)} (Total)`;

  dom.xVal.textContent = dom.yVal.textContent = dom.zVal.textContent = dom.tVal.textContent = '0.00';
  dom.peakVal.textContent = dom.rmsVal.textContent = '0.00';
  dom.evtVal.textContent = '0';
  dom.durVal.textContent = '00:00';

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

  running = true;
  startTime = Date.now();
  motionEventCount = 0;

  // Anzeige-Einheit fixieren
  measureUnit = activeUnit;

  // lock unit buttons
  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = true);

  rec = {
    startTs: startTime,
    t0: performance.now(),
    units: {
      vel:  { x:[], y:[], z:[], t:[] },
      acc:  { x:[], y:[], z:[], t:[] },
      disp: { x:[], y:[], z:[], t:[] },
      freq: { x:[], y:[], z:[], t:[] }
    }
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

  if (rafId)      { cancelAnimationFrame(rafId); rafId = null; }
  if (durTimer)   { clearInterval(durTimer); durTimer = null; }
  if (noDataTimer){ clearTimeout(noDataTimer); noDataTimer = null; }

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = false);

  dom.startBtn.textContent = 'Start';
  dom.startBtn.classList.add('btn--accent');
  dom.startBtn.classList.remove('btn--stop');
  setStatus('Messung abgeschlossen ✓', 'is-done');

  if (rec) {
    savedAll = {
      startTs: rec.startTs,
      durationSec: (performance.now() - rec.t0) / 1000,
      units: rec.units
    };

    // default Ergebnis = Einheit, die beim Start gewählt war
    const d = savedAll.units[measureUnit] || savedAll.units.vel;
    savedData = {
      unit: measureUnit,
      startTs: savedAll.startTs,
      durationSec: savedAll.durationSec,
      x: d.x, y: d.y, z: d.z, t: d.t
    };

    dom.results.hidden = false;
    dom.resMeta.textContent =
      `${new Date(savedAll.startTs).toLocaleString('de-DE')} · ` +
      `Dauer: ${savedAll.durationSec.toFixed(1)} s · Punkte: ${d.t.length}`;

    setTimeout(() => {
      resizeCanvas(dom.resultChart);
      drawResult(savedData);
    }, 80);
  }

  rec = null;
}

// Start-Button: iOS Permission direkt im Klick
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

/* =========================================================
   LOOP
========================================================= */
function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  const now = performance.now();
  const dt = Math.min((now - (intg.prev ?? now)) / 1000, 0.05);
  intg.prev = now;

  // IMU -> hp + v + s
  processIMU(rawX, rawY, rawZ, dt);

  // acc (m/s²) = highpass output
  const ax = hp.x, ay = hp.y, az = hp.z;
  const accT = Math.sqrt(ax*ax + ay*ay + az*az);

  // vel (mm/s)
  const velX = intg.vx * 1000;
  const velY = intg.vy * 1000;
  const velZ = intg.vz * 1000;
  const velT = Math.sqrt(velX*velX + velY*velY + velZ*velZ);

  // disp (mm)
  const dispX = intg.px * 1000;
  const dispY = intg.py * 1000;
  const dispZ = intg.pz * 1000;
  const dispT = Math.sqrt(dispX*dispX + dispY*dispY + dispZ*dispZ);

  // freq (Hz) aus Total(acc)
  const fs = dt > 0 ? (1 / dt) : 60;
  pushFreqSample(accT);
  const fT = dominantFreqAutocorr(fs, 1, 25);

  // parallel record ALL units
  const U = rec.units;
  U.acc.x.push(ax);   U.acc.y.push(ay);   U.acc.z.push(az);   U.acc.t.push(accT);
  U.vel.x.push(velX); U.vel.y.push(velY); U.vel.z.push(velZ); U.vel.t.push(velT);
  U.disp.x.push(dispX); U.disp.y.push(dispY); U.disp.z.push(dispZ); U.disp.t.push(dispT);
  // freq pro Achse hier vereinfacht = Total (du kannst später pro Achse erweitern)
  U.freq.x.push(fT); U.freq.y.push(fT); U.freq.z.push(fT); U.freq.t.push(fT);

  // statistics based on velT
  if (velT > peakTotal) peakTotal = velT;
  rmsAcc += velT * velT; rmsCnt++;
  if (velT > EVT_THR) evtCount++;

  dom.peakVal.textContent = peakTotal.toFixed(2);
  dom.rmsVal.textContent  = rmsCnt ? Math.sqrt(rmsAcc / rmsCnt).toFixed(2) : '0.00';
  dom.evtVal.textContent  = String(evtCount);

  // choose display values (measureUnit fixed)
  let vx, vy, vz, vt, dec;
  if (measureUnit === 'acc') {
    vx=ax; vy=ay; vz=az; vt=accT; dec=3;
  } else if (measureUnit === 'disp') {
    vx=dispX; vy=dispY; vz=dispZ; vt=dispT; dec=2;
  } else if (measureUnit === 'freq') {
    vx=fT; vy=fT; vz=fT; vt=fT; dec=1;
  } else { // vel
    vx=velX; vy=velY; vz=velZ; vt=velT; dec=2;
  }

  // update live buffer
  buf.x[buf.ptr] = vx; buf.y[buf.ptr] = vy; buf.z[buf.ptr] = vz; buf.t[buf.ptr] = vt;
  buf.ptr = (buf.ptr + 1) % WINDOW_LEN;
  if (buf.len < WINDOW_LEN) buf.len++;

  // tiles
  dom.xVal.textContent = vx.toFixed(dec);
  dom.yVal.textContent = vy.toFixed(dec);
  dom.zVal.textContent = vz.toFixed(dec);
  dom.tVal.textContent = vt.toFixed(dec);

  dom.mainNum.textContent = vt.toFixed(dec);
  dom.mainSub.textContent = `${unitLabel(measureUnit)} (Total)`;

  // DIN
  if (measureUnit === 'vel') updateDIN(velT);

  drawLive();

  dom.debugPanel.textContent =
    `unit(display)=${measureUnit}\n` +
    `accT=${accT.toFixed(3)} m/s²\n` +
    `velT=${velT.toFixed(2)} mm/s | peak=${peakTotal.toFixed(2)} mm/s\n` +
    `freq≈${fT.toFixed(1)} Hz | dt=${(dt*1000).toFixed(1)} ms`;
}

/* =========================================================
   EXPORT: Welche Einheit exportieren?
========================================================= */
function getExportUnitKey() {
  // Dropdown optional
  const v = dom.exportUnit?.value;
  if (v === 'acc' || v === 'disp' || v === 'freq' || v === 'vel') return v;
  // fallback: aktuelle Anzeige-Einheit der letzten Messung
  return savedData?.unit || 'vel';
}

/* =========================================================
   CSV EXPORT (pro Einheit)
========================================================= */
function exportCSV() {
  if (!savedAll) { setStatus('Keine Messdaten – erst messen!', 'is-error'); return; }

  const key = getExportUnitKey();
  const d = savedAll.units[key];
  if (!d || d.t.length < 2) { setStatus('Keine Daten für diese Einheit.', 'is-error'); return; }

  const unit = unitLabel(key);
  const n = d.t.length;
  const dt = savedAll.durationSec / Math.max(1, n - 1);

  let csv = `# HTB Schwingungsmesser Export\n`;
  csv += `# Start: ${new Date(savedAll.startTs).toLocaleString('de-DE')}\n`;
  csv += `# Dauer: ${savedAll.durationSec.toFixed(2)} s\n`;
  csv += `# Einheit: ${unit}\n#\n`;
  csv += `i;time_s;x_${unit};y_${unit};z_${unit};total_${unit}\n`;

  for (let i = 0; i < n; i++) {
    csv += `${i};${(i*dt).toFixed(4)};${d.x[i]};${d.y[i]};${d.z[i]};${d.t[i]}\n`;
  }

  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `HTB_${key}_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* =========================================================
   PDF EXPORT (wissenschaftlich: X/Y/Z untereinander)
========================================================= */
function plotScientificPNG({ series, title, yLabel, color, durationSec }) {
  const W = 1200, H = 260;
  const mL = 70, mR = 18, mT = 30, mB = 50;
  const pw = W - mL - mR, ph = H - mT - mB;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0,0,W,H);

  let mn = Infinity, mx = -Infinity;
  for (const v of series) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!isFinite(mn) || !isFinite(mx)) { mn=-1; mx=1; }
  if (mn === mx) { mn -= 1; mx += 1; }
  const pad = (mx-mn)*0.1;
  mn -= pad; mx += pad;

  const yOf = (v) => mT + ph - ((v - mn) / (mx - mn)) * ph;

  // grid
  ctx.strokeStyle = '#e9e9e9';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const x = mL + (i/10)*pw;
    ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT+ph); ctx.stroke();
  }
  for (let j = 0; j <= 6; j++) {
    const y = mT + (j/6)*ph;
    ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL+pw, y); ctx.stroke();
  }

  // axes
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(mL, mT); ctx.lineTo(mL, mT+ph); ctx.lineTo(mL+pw, mT+ph);
  ctx.stroke();

  // title
  ctx.fillStyle = '#111';
  ctx.font = 'bold 14px Arial';
  ctx.fillText(title, mL, 20);

  // y label
  ctx.save();
  ctx.translate(16, mT + ph/2 + 20);
  ctx.rotate(-Math.PI/2);
  ctx.font = '12px Arial';
  ctx.fillStyle = '#333';
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();

  // x label
  ctx.fillStyle = '#333';
  ctx.font = '12px Arial';
  ctx.fillText('t [s]', mL+pw-30, H-8);

  // line
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const n = series.length;
  for (let i = 0; i < n; i++) {
    const x = mL + (i/(n-1))*pw;
    const y = yOf(series[i]);
    i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  }
  ctx.stroke();

  return c.toDataURL('image/png', 1.0);
}

function exportPDF() {
  if (!savedAll) { setStatus('Keine Messdaten – erst messen!', 'is-error'); return; }

  const key = getExportUnitKey();
  const d = savedAll.units[key];
  if (!d || d.t.length < 2) { setStatus('Keine Daten für diese Einheit.', 'is-error'); return; }

  const unit = unitLabel(key);
  const yLab = yAxisText(key);
  const dur  = savedAll.durationSec;

  const imgX = plotScientificPNG({ series: d.x, title: 'X-Achse', yLabel: yLab, color:'#ff4444', durationSec: dur });
  const imgY = plotScientificPNG({ series: d.y, title: 'Y-Achse', yLabel: yLab, color:'#00cc66', durationSec: dur });
  const imgZ = plotScientificPNG({ series: d.z, title: 'Z-Achse', yLabel: yLab, color:'#4499ff', durationSec: dur });

  const w = window.open('', '_blank');
  if (!w) { setStatus('Popup blockiert – Popups erlauben!', 'is-error'); return; }

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
  Dauer: ${dur.toFixed(1)} s · Einheit: ${unit} · Punkte: ${d.t.length}
</div>
<div class="plot"><img src="${imgX}" alt="X"></div>
<div class="plot"><img src="${imgY}" alt="Y"></div>
<div class="plot"><img src="${imgZ}" alt="Z"></div>
<script>setTimeout(()=>window.print(),250);<\/script>
</body></html>`);
  w.document.close();
}

/* =========================================================
   BUTTON WIRING EXPORT
========================================================= */
dom.csvBtn?.addEventListener('click', exportCSV);
dom.pdfBtn?.addEventListener('click', exportPDF);

/* =========================================================
   iOS PERMISSION BUTTON (optional)
========================================================= */
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

/* =========================================================
   INIT
========================================================= */
updateUnitLabelsUI();
applyToggle('x', true);
applyToggle('y', true);
applyToggle('z', true);
applyToggle('t', true);
resetState();
