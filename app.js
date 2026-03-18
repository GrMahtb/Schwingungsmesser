'use strict';

/* ─── KONSTANTEN ─────────────────────────────── */
const WINDOW_LEN    = 600;          // 10 s × 60 Hz
const COLORS        = { x:'#ff4444', y:'#00cc66', z:'#4499ff', t:'#ffed00' };
const EVT_THR       = 0.1;          // mm/s Event-Schwelle
const MAX_REC       = 36000;        // max. Aufnahmepunkte
const HP_ALPHA      = 0.97;         // High-Pass-Filter

/* ─── ZUSTAND ────────────────────────────────── */
let running      = false;
let startTime    = null;
let durTimer     = null;
let rafId        = null;
let savedData    = null;
let deferredPrompt = null;
let activeUnit   = 'vel';           // 'vel' | 'acc' | 'disp'
let rec          = null;
let noDataTimer = null;
let motionEventCount = 0;

function unitLabel(){
  return activeUnit === 'vel' ? 'mm/s' : activeUnit === 'acc' ? 'm/s²' : 'mm';
}
// Roh-Sensor
let rawX = 0, rawY = 0, rawZ = 0;

// Ringbuffer
const buf = {
  x: new Float32Array(WINDOW_LEN),
  y: new Float32Array(WINDOW_LEN),
  z: new Float32Array(WINDOW_LEN),
  t: new Float32Array(WINDOW_LEN),
  ptr: 0, len: 0,
};

// Integration
const intg = { vx:0, vy:0, vz:0, px:0, py:0, pz:0, prev:null };

// High-Pass
const hp = { x:0, y:0, z:0, px:0, py:0, pz:0 };

// Statistik
let peakTotal = 0, rmsAcc = 0, rmsCnt = 0, evtCount = 0;

// Achsen-Sichtbarkeit
const vis = { x:true, y:true, z:true, t:true };

/* ─── DOM ────────────────────────────────────── */
const $ = id => document.getElementById(id);
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
  evtVal:       $('evtVal'),
  durVal:       $('durVal'),
  debugPanel:   $('debugPanel'),
  liveChart:    $('liveChart'),
  liveAxis:     $('liveAxis'),
  resultChart:  $('resultChart'),
  resAxis:      $('resAxis'),
  resMeta:      $('resMeta'),
  dinNote:      $('dinNote'),
  results:      $('results'),
  startBtn:     $('startBtn'),
  resetBtn:     $('resetBtn'),
  iosPermBtn:   $('iosPermBtn'),
  installBanner:$('installBanner'),
  installBtn:   $('installBtn'),
};

const liveCtx = dom.liveChart.getContext('2d');
const resCtx  = dom.resultChart.getContext('2d');

/* ─── CANVAS RESIZE ──────────────────────────── */
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
// Canvas erst nach erstem Paint skalieren
requestAnimationFrame(() => setTimeout(initCanvases, 100));

/* ─── STATUS ─────────────────────────────────── */
function setStatus(msg, cls) {
  dom.statusBar.textContent = msg;
  dom.statusBar.className   = 'statusBar' + (cls ? ' ' + cls : '');
  dom.statusBar.hidden      = !msg;
}

/* ─── TABS ───────────────────────────────────── */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b =>
      b.classList.toggle('is-active', b === btn));
    document.querySelectorAll('.pane').forEach(p => {
      const on = p.id === `tab-${btn.dataset.tab}`;
      p.classList.toggle('is-active', on);
      p.hidden = !on;
    });
  });
});

/* ─── EINHEIT ────────────────────────────────── */
function updateUnitLabels() {
  const u = { vel:'mm/s', acc:'m/s²', disp:'mm' }[activeUnit];
  ['unitX','unitY','unitZ','unitT','unitPeak','unitRms'].forEach(id => {
    const el = $(id); if (el) el.textContent = u;
  });
}

document.querySelectorAll('.unitBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeUnit = btn.dataset.unit;
    document.querySelectorAll('.unitBtn').forEach(b =>
      b.classList.toggle('is-active', b === btn));
    updateUnitLabels();
  });
});

/* ─── ACHSEN-TOGGLE ──────────────────────────── */
function applyToggle(s, on) {
  vis[s] = on;
  document.querySelectorAll(`[data-series="${s}"]`).forEach(el =>
    el.classList.toggle('is-off', !on));
  dom.dinNote.hidden = vis.t;
}

document.querySelectorAll('.tile[data-series], .legendBtn[data-series]').forEach(btn => {
  btn.addEventListener('click', () => applyToggle(btn.dataset.series, !vis[btn.dataset.series]));
});

/* ─── DIN 4150-2 ─────────────────────────────── */
const dinRows   = ['n0','n1','n2','n3','n4'];
const dinBounds = [0, 0.3, 1.0, 3.0, 10.0];

function updateDIN(vMms) {
  let row = 0;
  for (let i = dinBounds.length - 1; i >= 0; i--) {
    if (vMms >= dinBounds[i]) { row = i; break; }
  }
  dinRows.forEach((id, i) => $(id).classList.toggle('is-active', i === row));
}

/* ─── HIGH-PASS + INTEGRATION ────────────────── */
function processIMU(ax, ay, az, dt) {
  // High-pass (entfernt Schwerkraft-DC)
  hp.x = HP_ALPHA * (hp.x + ax - hp.px);
  hp.y = HP_ALPHA * (hp.y + ay - hp.py);
  hp.z = HP_ALPHA * (hp.z + az - hp.pz);
  hp.px = ax; hp.py = ay; hp.pz = az;

  // Velocity (Leaky Integration)
  const lv = 0.985;
  intg.vx = (intg.vx + hp.x * dt) * lv;
  intg.vy = (intg.vy + hp.y * dt) * lv;
  intg.vz = (intg.vz + hp.z * dt) * lv;

  // Displacement (Leaky Integration)
  const lp = 0.995;
  intg.px = (intg.px + intg.vx * dt) * lp;
  intg.py = (intg.py + intg.vy * dt) * lp;
  intg.pz = (intg.pz + intg.vz * dt) * lp;
}

/* ─── WERTE JE EINHEIT ───────────────────────── */
function getValues() {
  if (activeUnit === 'acc') {
    const vx = hp.x, vy = hp.y, vz = hp.z;
    return { vx, vy, vz, vt: Math.sqrt(vx*vx+vy*vy+vz*vz), u:'m/s²' };
  }
  if (activeUnit === 'disp') {
    const vx = intg.px*1000, vy = intg.py*1000, vz = intg.pz*1000;
    return { vx, vy, vz, vt: Math.sqrt(vx*vx+vy*vy+vz*vz), u:'mm' };
  }
  // vel (default)
  const vx = intg.vx*1000, vy = intg.vy*1000, vz = intg.vz*1000;
  return { vx, vy, vz, vt: Math.sqrt(vx*vx+vy*vy+vz*vz), u:'mm/s' };
}

/* ─── LIVE CHART ─────────────────────────────── */
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

  // Nulllinie
  const y0 = H - ((0 - yMin) / (yMax - yMin)) * H;
  ctx.strokeStyle = '#2a2a2d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();

  // Serien
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

  // Zeitachsen-Labels
  dom.liveAxis.innerHTML =
    ['-10s','-8s','-6s','-4s','-2s','0s']
      .map(t => `<span>${t}</span>`).join('');
}

/* ─── ERGEBNIS CHART ─────────────────────────── */
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
    data[s].forEach(v => { if (v<mn) mn=v; if (v>mx) mx=v; });
  });
  const rng = (mx-mn)||1;
  const yMin = mn-rng*0.12, yMax = mx+rng*0.12;

  const y0 = H - ((0-yMin)/(yMax-yMin))*H;
  ctx.strokeStyle='#2a2a2d'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(0,y0); ctx.lineTo(W,y0); ctx.stroke();

  ['x','y','z','t'].forEach(s => {
    ctx.strokeStyle = COLORS[s];
    ctx.lineWidth   = s==='t' ? 2.5 : 1.5;
    ctx.beginPath();
    data[s].forEach((v,i) => {
      const xp = (i/(data[s].length-1))*W;
      const yp = H-((v-yMin)/(yMax-yMin))*H;
      i===0 ? ctx.moveTo(xp,yp) : ctx.lineTo(xp,yp);
    });
    ctx.stroke();
  });

  dom.resAxis.innerHTML = '<span>Anfang</span><span>Ende</span>';
}
/* ─── SENSOR EVENT ───────────────────────────── */
function onMotion(e) {
motionEventCount++;
  const a = (e.acceleration && (e.acceleration.x != null || e.acceleration.y != null || e.acceleration.z != null))
    ? e.acceleration
    : e.accelerationIncludingGravity;

  if (!a) return;
  rawX = Number(a.x) || 0;
  rawY = Number(a.y) || 0;
  rawZ = Number(a.z) || 0;
}
window.addEventListener('devicemotion', onMotion, { passive:true });

/* ─── START/STOP/RESET ───────────────────────── */
function hardResetUI() {
  dom.mainNum.textContent = '0.00';
  dom.mainSub.textContent = `${unitLabel()} (Total)`;

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

  dinRows.forEach(id => $(id).classList.remove('is-active'));
  dom.dinNote.hidden = vis.t;

  drawLive();
  if (savedData) drawResult(savedData);
}

function resetState() {
  running = false;
  startTime = null;
  evtCount = 0;
  peakTotal = 0;
  rmsAcc = 0; rmsCnt = 0;

  buf.ptr = 0; buf.len = 0;
  buf.x.fill(0); buf.y.fill(0); buf.z.fill(0); buf.t.fill(0);

  intg.vx = intg.vy = intg.vz = 0;
  intg.px = intg.py = intg.pz = 0;
  intg.prev = null;

  hp.x = hp.y = hp.z = 0;
  hp.px = hp.py = hp.pz = 0;

  rawX = rawY = rawZ = 0;

  savedData = null;
  rec = null;

  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  if (durTimer) clearInterval(durTimer);
  durTimer = null;

  setStatus('', '');
  hardResetUI();
}

function startMeasurement() {
  if (running) return;

  resetState();
  running = true;
  startTime = Date.now();
  evtCount = 0;

  // Unit-Buttons sperren während Messung
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

  // Dauer-Anzeige
  durTimer = setInterval(() => {
    const ms = Date.now() - startTime;
    dom.durVal.textContent = fmtTime(ms);
  }, 250);

  // „keine Sensordaten“ Hinweis
  clearTimeout(noDataTimer);
  noDataTimer = setTimeout(() => {
    if (motionEventCount === 0) {
      setStatus('Keine Sensor-Daten. Prüfe Berechtigungen / Browser.', 'is-error');
    }
  }, 2000);

  loop();
}

function stopMeasurement() {
  if (!running) return;
  running = false;

  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  if (durTimer) clearInterval(durTimer);
  durTimer = null;

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = false);

  dom.startBtn.textContent = 'Start';
  dom.startBtn.classList.add('btn--accent');
  dom.startBtn.classList.remove('btn--stop');
  setStatus('Messung abgeschlossen', 'is-done');

  if (rec && rec.t.length > 5) {
    savedData = {
      unit: rec.unit,
      startTs: rec.startTs,
      durationSec: (performance.now() - rec.t0) / 1000,
      x: rec.x.slice(),
      y: rec.y.slice(),
      z: rec.z.slice(),
      t: rec.t.slice()
    };

    dom.results.hidden = false;
    dom.resMeta.textContent =
      `${new Date(savedData.startTs).toLocaleString('de-DE')} · Dauer: ${savedData.durationSec.toFixed(1)} s · Punkte: ${savedData.t.length}`;

    drawResult(savedData);
  }

  rec = null;
}

dom.startBtn.addEventListener('click', () => running ? stopMeasurement() : startMeasurement());
dom.resetBtn.addEventListener('click', () => resetState());

/* ─── LOOP OVERRIDE: mit Recording + Statistik ─ */
function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  motionEventCount++;

  const now = performance.now();
  const dt = Math.min((now - (intg.prev ?? now)) / 1000, 0.05);
  intg.prev = now;

  processIMU(rawX, rawY, rawZ, dt);

  // Werte für UI
  const { vx, vy, vz, vt, u } = getValues();

  // Ringbuffer fürs Live-Chart
  buf.x[buf.ptr] = vx;
  buf.y[buf.ptr] = vy;
  buf.z[buf.ptr] = vz;
  buf.t[buf.ptr] = vt;
  buf.ptr = (buf.ptr + 1) % WINDOW_LEN;
  if (buf.len < WINDOW_LEN) buf.len++;

  // Statistik immer auf Velocity-Total (mm/s)
  const velTotal = Math.sqrt(intg.vx*intg.vx + intg.vy*intg.vy + intg.vz*intg.vz) * 1000;
  if (velTotal > peakTotal) peakTotal = velTotal;

  rmsAcc += velTotal * velTotal;
  rmsCnt++;

  if (velTotal > EVT_THR) evtCount++;

  // UI
  dom.xVal.textContent = vx.toFixed(2);
  dom.yVal.textContent = vy.toFixed(2);
  dom.zVal.textContent = vz.toFixed(2);
  dom.tVal.textContent = vt.toFixed(2);

  dom.peakVal.textContent = peakTotal.toFixed(2);
  dom.rmsVal.textContent  = rmsCnt ? Math.sqrt(rmsAcc / rmsCnt).toFixed(2) : '0.00';
  dom.evtVal.textContent  = evtCount;

  // Main (wenn Total aus → größte sichtbare Achse)
  let main = vt;
  let sub  = `${u} (Total)`;
  if (!vis.t) {
    const cand = [];
    if (vis.x) cand.push({k:'X', v:Math.abs(vx)});
    if (vis.y) cand.push({k:'Y', v:Math.abs(vy)});
    if (vis.z) cand.push({k:'Z', v:Math.abs(vz)});
    if (cand.length) {
      cand.sort((a,b)=>b.v-a.v);
      main = cand[0].v;
      sub = `${u} (${cand[0].k})`;
    } else {
      main = 0; sub = `${u} (–)`;
    }
  }
  dom.mainNum.textContent = main.toFixed(2);
  dom.mainSub.textContent = sub;

  // DIN nur sinnvoll bei mm/s
  if (activeUnit === 'vel') updateDIN(velTotal);

  // Debug
  dom.debugPanel.textContent =
    `raw ax=${rawX.toFixed(3)} ay=${rawY.toFixed(3)} az=${rawZ.toFixed(3)} m/s²\n` +
    `hp  ax=${hp.x.toFixed(3)} ay=${hp.y.toFixed(3)} az=${hp.z.toFixed(3)} m/s²\n` +
    `vel x=${(intg.vx*1000).toFixed(2)} y=${(intg.vy*1000).toFixed(2)} z=${(intg.vz*1000).toFixed(2)} mm/s\n` +
    `velTotal=${velTotal.toFixed(2)} mm/s | Peak=${peakTotal.toFixed(2)} mm/s\n` +
    `Events=${evtCount} | dt=${(dt*1000).toFixed(1)} ms | unit=${activeUnit}`;

  drawLive();

  // Recording
  if (rec && rec.t.length < MAX_REC) {
    rec.x.push(vx);
    rec.y.push(vy);
    rec.z.push(vz);
    rec.t.push(vt);
    rec.velTotal.push(velTotal);
  }
}

/* ─── EXPORT (CSV / PDF) ─────────────────────── */
function exportCSV() {
  if (!savedData) return;

  const unit = savedData.unit;
  const unitLabel = unit === 'vel' ? 'mm/s' : unit === 'acc' ? 'm/s²' : 'mm';

  let csv = '';
  csv += `# HTB Schwingungsmesser Export\n`;
  csv += `# Start: ${new Date(savedData.startTs).toLocaleString('de-DE')}\n`;
  csv += `# Dauer: ${savedData.durationSec.toFixed(2)} s\n`;
  csv += `# Einheit: ${unitLabel}\n`;
  csv += `#\n`;
  csv += `i;time_s;x_${unitLabel};y_${unitLabel};z_${unitLabel};total_${unitLabel}\n`;

  const n = savedData.t.length;
  const dt = savedData.durationSec / Math.max(1, (n - 1));

  for (let i = 0; i < n; i++) {
    csv += `${i};${(i*dt).toFixed(4)};${savedData.x[i].toFixed(6)};${savedData.y[i].toFixed(6)};${savedData.z[i].toFixed(6)};${savedData.t[i].toFixed(6)}\n`;
  }

  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `HTB_Messung_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportPDF() {
  if (!savedData) return;
  drawResult(savedData);

  // Einfachster Weg ohne externe Lib: Druckdialog -> „Als PDF speichern“
  const img = dom.resultChart.toDataURL('image/png', 1.0);
  const title = 'HTB Schwingungsmesser – Diagramm';
  const w = window.open('', '_blank');
  if (!w) { setStatus('Popup blockiert – Popups erlauben.', 'is-error'); return; }

  const unitLabel = savedData.unit === 'vel' ? 'mm/s' : savedData.unit === 'acc' ? 'm/s²' : 'mm';

  w.document.open();
  w.document.write(`
<!doctype html>
<html><head><meta charset="utf-8"/>
<title>${title}</title>
<style>
  body{font-family:Arial,sans-serif;margin:24px;}
  h1{font-size:16px;margin:0 0 8px;}
  .meta{font-size:12px;color:#444;margin-bottom:12px;}
  img{width:100%;max-width:1100px;border:1px solid #ddd;}
</style>
</head>
<body>
  <h1>${title}</h1>
  <div class="meta">
    Start: ${new Date(savedData.startTs).toLocaleString('de-DE')}<br/>
    Dauer: ${savedData.durationSec.toFixed(1)} s · Einheit: ${unitLabel} · Punkte: ${savedData.t.length}
  </div>
  <img src="${img}" alt="Diagramm"/>
  <script>setTimeout(()=>window.print(),200);</script>
</body></html>`);
  w.document.close();
}

dom.csvBtn.addEventListener('click', exportCSV);
dom.pdfBtn.addEventListener('click', exportPDF);

/* ─── iOS Permission Button (falls vorhanden) ─ */
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
if (isIOS && typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
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

/* ─── PWA Install Prompt ─────────────────────── */
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

/* ─── Service Worker ─────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ─── INIT ───────────────────────────────────── */
updateUnitLabels();
applyToggle('x', true);
applyToggle('y', true);
applyToggle('z', true);
applyToggle('t', true);
resetState();
