'use strict';

/* ─────────────────────────────────────────────
   Konfiguration (Top-Level ok)
───────────────────────────────────────────── */
const WINDOW_LEN = 600;
const MAX_REC    = 36000;
const COLORS     = { x:'#ff4444', y:'#00cc66', z:'#4499ff', t:'#ffed00' };
const HP_ALPHA   = 0.97;
const LEAK_V     = 0.985;
const LEAK_P     = 0.995;
const EVT_THR    = 0.1;

/* ─────────────────────────────────────────────
   Zustand (Top-Level ok)
───────────────────────────────────────────── */
let running          = false;
let startTime        = null;
let durTimer         = null;
let rafId            = null;
let savedData        = null;
let rec              = null;
let deferredPrompt   = null;
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
const vis = { x:true, y:true, z:true, t:true };

/* ─────────────────────────────────────────────
   Reine Hilfsfunktionen (Top-Level ok)
───────────────────────────────────────────── */
function unitLabel() {
  return activeUnit === 'acc' ? 'm/s²' : activeUnit === 'disp' ? 'mm' : 'mm/s';
}

function fmtTime(ms) {
  const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

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

/* ─────────────────────────────────────────────
   Sensor (Top-Level ok - kein DOM nötig)
───────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────
   Service Worker
───────────────────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ═════════════════════════════════════════════
   ALLES AB HIER BRAUCHT DEN DOM
   → DOMContentLoaded Wrapper
═════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {

  /* ── Fehler-Anzeige ─────────────────────── */
  window.addEventListener('error', (e) => {
    const sb = document.getElementById('statusBar');
    if (!sb) return;
    sb.hidden = false;
    sb.textContent = `JS Fehler: ${e.message} (Zeile ${e.lineno})`;
    sb.className = 'statusBar is-error';
  });

  /* ── DOM Referenzen ─────────────────────── */
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

  /* ── Helpers ────────────────────────────── */
  function setStatus(msg, cls) {
    dom.statusBar.textContent = msg;
    dom.statusBar.className   = 'statusBar' + (cls ? ' ' + cls : '');
    dom.statusBar.hidden      = !msg;
  }

  /* ── Canvas ─────────────────────────────── */
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

  /* ── Tabs ───────────────────────────────── */
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

  /* ── Einheit ────────────────────────────── */
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

  /* ── Achsen Toggle ──────────────────────── */
  const dinRows   = ['n0','n1','n2','n3','n4'];
  const dinBounds = [0, 0.3, 1.0, 3.0, 10.0];

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

  /* ── DIN 4150-2 ─────────────────────────── */
  function updateDIN(vMms) {
    let row = 0;
    for (let i = dinBounds.length - 1; i >= 0; i--) {
      if (vMms >= dinBounds[i]) { row = i; break; }
    }
    dinRows.forEach((id, i) => $(id).classList.toggle('is-active', i === row));
  }

  /* ── Live Chart ─────────────────────────── */
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

  /* ── Result Chart ───────────────────────── */
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

  /* ── Reset ──────────────────────────────── */
  function resetState() {
    running = false;
    if (rafId)      { cancelAnimationFrame(rafId);  rafId = null; }
    if (durTimer)   { clearInterval(durTimer);       durTimer = null; }
    if (noDataTimer){ clearTimeout(noDataTimer);     noDataTimer = null; }

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
    dinRows.forEach(id => $(id).classList.remove('is-active'));
    setStatus('', '');
    drawLive();
  }

  /* ── Start ──────────────────────────────── */
  function startMeasurement() {
    if (running) return;
    resetState();
    running = true;
    startTime = Date.now();
    motionEventCount = 0;

    document.querySelectorAll('.unitBtn').forEach(b => b.disabled = true);

    rec = {
      unit: activeUnit, t0: performance.now(), startTs: startTime,
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
        setStatus('Kein Sensor! Prüfe Berechtigungen / Browser.', 'is-error');
    }, 2000);

    rafId = requestAnimationFrame(loop);
  }

  /* ── Stop ───────────────────────────────── */
  function stopMeasurement() {
    if (!running) return;
    running = false;
    if (rafId)      { cancelAnimationFrame(rafId);  rafId = null; }
    if (durTimer)   { clearInterval(durTimer);       durTimer = null; }
    if (noDataTimer){ clearTimeout(noDataTimer);     noDataTimer = null; }

    document.querySelectorAll('.unitBtn').forEach(b => b.disabled = false);

    dom.startBtn.textContent = 'Start';
    dom.startBtn.classList.add('btn--accent');
    dom.startBtn.classList.remove('btn--stop');
    setStatus('Messung abgeschlossen ✓', 'is-done');

    if (rec && rec.t.length > 5) {
      savedData = {
        unit: rec.unit, startTs: rec.startTs,
        durationSec: (performance.now() - rec.t0) / 1000,
        x: rec.x.slice(), y: rec.y.slice(),
        z: rec.z.slice(), t: rec.t.slice()
      };
      dom.results.hidden = false;
      dom.resMeta.textContent =
        `${new Date(savedData.startTs).toLocaleString('de-DE')} · ` +
        `Dauer: ${savedData.durationSec.toFixed(1)} s · ` +
        `Punkte: ${savedData.t.length}`;
      setTimeout(() => { resizeCanvas(dom.resultChart); drawResult(savedData); }, 80);
    }
    rec = null;
  }

  dom.startBtn.addEventListener('click', () => running ? stopMeasurement() : startMeasurement());
  dom.resetBtn.addEventListener('click', () => resetState());

  /* ── Loop ───────────────────────────────── */
  function loop() {
    if (!running) return;
    rafId = requestAnimationFrame(loop);

    const now = performance.now();
    const dt  = Math.min((now - (intg.prev ?? now)) / 1000, 0.05);
    intg.prev = now;

    processIMU(rawX, rawY, rawZ, dt);
    const { vx, vy, vz, vt } = getValues();
    const u = unitLabel();

    buf.x[buf.ptr] = vx; buf.y[buf.ptr] = vy;
    buf.z[buf.ptr] = vz; buf.t[buf.ptr] = vt;
    buf.ptr = (buf.ptr + 1) % WINDOW_LEN;
    if (buf.len < WINDOW_LEN) buf.len++;

    const velTotal = Math.sqrt(intg.vx*intg.vx + intg.vy*intg.vy + intg.vz*intg.vz) * 1000;
    if (velTotal > peakTotal) peakTotal = velTotal;
    rmsAcc += velTotal * velTotal; rmsCnt++;
    if (velTotal > EVT_THR) evtCount++;

    dom.xVal.textContent    = vx.toFixed(2);
    dom.yVal.textContent    = vy.toFixed(2);
    dom.zVal.textContent    = vz.toFixed(2);
    dom.tVal.textContent    = vt.toFixed(2);
    dom.peakVal.textContent = peakTotal.toFixed(2);
    dom.rmsVal.textContent  = rmsCnt ? Math.sqrt(rmsAcc / rmsCnt).toFixed(2) : '0.00';
    dom.evtVal.textContent  = evtCount;

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
    dom.mainNum.textContent = main.toFixed(2);
    dom.mainSub.textContent = sub;

    if (activeUnit === 'vel') updateDIN(velTotal);
    drawLive();

    dom.debugPanel.textContent =
      `raw ax=${rawX.toFixed(3)} ay=${rawY.toFixed(3)} az=${rawZ.toFixed(3)} m/s²\n` +
      `hp  ax=${hp.x.toFixed(3)} ay=${hp.y.toFixed(3)} az=${hp.z.toFixed(3)} m/s²\n` +
      `vel x=${(intg.vx*1000).toFixed(2)} y=${(intg.vy*1000).toFixed(2)} z=${(intg.vz*1000).toFixed(2)} mm/s\n` +
      `velTotal=${velTotal.toFixed(2)} mm/s | Peak=${peakTotal.toFixed(2)} mm/s\n` +
      `Events=${evtCount} | dt=${(dt*1000).toFixed(1)} ms | unit=${activeUnit}`;

    if (rec && rec.t.length < MAX_REC) {
      rec.x.push(vx); rec.y.push(vy);
      rec.z.push(vz); rec.t.push(vt);
      rec.velTotal.push(velTotal);
    }
  }

  /* ── CSV Export ─────────────────────────── */
  function exportCSV() {
    if (!savedData) return;
    const u  = savedData.unit === 'vel' ? 'mm/s' : savedData.unit === 'acc' ? 'm/s²' : 'mm';
    const n  = savedData.t.length;
    const dt = savedData.durationSec / Math.max(1, n - 1);
    let csv  = `# HTB Schwingungsmesser Export\n`;
    csv += `# Start: ${new Date(savedData.startTs).toLocaleString('de-DE')}\n`;
    csv += `# Dauer: ${savedData.durationSec.toFixed(2)} s\n`;
    csv += `# Einheit: ${u}\n#\n`;
    csv += `i;time_s;x_${u};y_${u};z_${u};total_${u}\n`;
    for (let i = 0; i < n; i++) {
      csv += `${i};${(i*dt).toFixed(4)};${savedData.x[i].toFixed(6)};` +
             `${savedData.y[i].toFixed(6)};${savedData.z[i].toFixed(6)};` +
             `${savedData.t[i].toFixed(6)}\n`;
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

  /* ── PDF Export ─────────────────────────── */
  function plotToDataURL({ series, title, unit, color, durationSec }) {
    const W = 1200, H = 260;
    const mL = 70, mR = 18, mT = 28, mB = 46;
    const pw = W - mL - mR, ph = H - mT - mB;

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = '#e6e6e6'; ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const x = mL + (i/10)*pw;
      ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT+ph); ctx.stroke();
    }
    for (let j = 0; j <= 6; j++) {
      const y = mT + (j/6)*ph;
      ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL+pw, y); ctx.stroke();
    }

    let mn = Infinity, mx = -Infinity;
    for (const v of series) { if (v < mn) mn = v; if (v > mx) mx = v; }
    if (!isFinite(mn) || !isFinite(mx)) { mn = -1; mx = 1; }
    if (mn === mx) { mn -= 1; mx += 1; }
    const pad = (mx - mn) * 0.1;
    mn -= pad; mx += pad;
    const yOf = (v) => mT + ph - ((v - mn) / (mx - mn)) * ph;

    ctx.strokeStyle = '#111'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(mL, mT); ctx.lineTo(mL, mT+ph); ctx.lineTo(mL+pw, mT+ph);
    ctx.stroke();

    ctx.fillStyle = '#111'; ctx.font = 'bold 14px Arial';
    ctx.fillText(title, mL, 18);

    ctx.fillStyle = '#333'; ctx.font = '12px Arial';
    ctx.fillText(unit, 14, mT+12);

    ctx.font = '11px Arial';
    for (let j = 0; j <= 6; j++) {
      const vv = mn + (j/6)*(mx-mn);
      ctx.fillText(vv.toFixed(2), 10, yOf(vv)+4);
    }
    for (let i = 0; i <= 5; i++) {
      const t = durationSec*(i/5);
      const x = mL + (i/5)*pw;
      ctx.fillText(t.toFixed(1), x-8, H-18);
    }
    ctx.fillText('t [s]', mL+pw-30, H-4);

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
    if (!savedData) return;
    const unit = savedData.unit === 'vel' ? 'mm/s' : savedData.unit === 'acc' ? 'm/s²' : 'mm';
    const dur  = savedData.durationSec;

    const imgX = plotToDataURL({ series:savedData.x, title:'X-Achse', unit, color:'#ff4444', durationSec:dur });
    const imgY = plotToDataURL({ series:savedData.y, title:'Y-Achse', unit, color:'#00cc66', durationSec:dur });
    const imgZ = plotToDataURL({ series:savedData.z, title:'Z-Achse', unit, color:'#4499ff', durationSec:dur });

    const w = window.open('', '_blank');
    if (!w) { setStatus('Popup blockiert – bitte erlauben!', 'is-error'); return; }

    w.document.open();
    w.document.write(`<!doctype html><html><head>
<meta charset="utf-8"/>
<title>HTB Schwingungsmesser</title>
<style>
  @page{ size:A4 portrait; margin:12mm; }
  body{ font-family:Arial,sans-serif; background:#fff; color:#111; margin:0; padding:12mm; }
  h1{ font-size:16px; margin:0 0 6px; }
  .meta{ font-size:11px; color:#333; line-height:1.45; margin-bottom:10px; }
  .plot{ margin:10px 0; page-break-inside:avoid; }
  .plot img{ width:100%; border:1px solid #ddd; }
</style>
</head><body>
<h1>HTB Schwingungsmesser – Diagramme</h1>
<div class="meta">
  Start: ${new Date(savedData.startTs).toLocaleString('de-DE')}<br/>
  Dauer: ${dur.toFixed(1)} s · Einheit: ${unit} · Punkte: ${savedData.t.length}<br/>
  Hinweis: Smartphone-Sensoren sind nicht kalibriert.
</div>
<div class="plot"><img src="${imgX}" alt="X"></div>
<div class="plot"><img src="${imgY}" alt="Y"></div>
<div class="plot"><img src="${imgZ}" alt="Z"></div>
<script>setTimeout(()=>window.print(),250);<\/script>
</body></html>`);
    w.document.close();
  }
  $('pdfBtn').addEventListener('click', exportPDF);

  /* ── iOS Permission ─────────────────────── */
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  if (isIOS && typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    dom.iosPermBtn.hidden = false;
    dom.iosPermBtn.addEventListener('click', async () => {
      try {
        const res = await DeviceMotionEvent.requestPermission();
        if (res === 'granted') {
          dom.iosPermBtn.hidden = true;
          setStatus('Erlaubnis erteilt – drücke Start', '');
        } else {
          setStatus('Sensor-Erlaubnis verweigert!', 'is-error');
        }
      } catch (err) {
        setStatus('Fehler: ' + err.message, 'is-error');
      }
    });
  }

  /* ── PWA Install ────────────────────────── */
 // ===== PWA Install (Android/Chrome) =====
(() => {
  const installBanner = document.getElementById('installBanner');
  const installBtn = document.getElementById('installBtn');

  if (!installBanner || !installBtn) return;

  // Standard: Banner aus, Button deaktiviert
  installBanner.hidden = true;
  installBtn.disabled = true;

  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    // Chrome erlaubt prompt() nur, wenn wir das Event vorher "abfangen"
    e.preventDefault();
    deferredPrompt = e;

    // Jetzt erst Banner anzeigen + Button aktivieren
    installBanner.hidden = false;
    installBtn.disabled = false;
  });

  installBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Wenn kein Prompt verfügbar ist -> NICHT weiterleiten, nur Hinweis
    if (!deferredPrompt) {
      // Optional: Statusbar nutzen, falls vorhanden
      const sb = document.getElementById('statusBar');
      if (sb) {
        sb.hidden = false;
        sb.className = 'statusBar is-error';
        sb.textContent = 'Installieren aktuell nicht verfügbar. Öffne Chrome-Menü (⋮) → „App installieren“.';
      }
      return;
    }

    // Prompt anzeigen
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;

    // Danach ist der Prompt "verbraucht"
    deferredPrompt = null;
    installBtn.disabled = true;
    installBanner.hidden = true;

    // (Optional) falls abgelehnt: Hinweis
    if (choice.outcome !== 'accepted') {
      const sb = document.getElementById('statusBar');
      if (sb) {
        sb.hidden = false;
        sb.className = 'statusBar is-error';
        sb.textContent = 'Installation abgebrochen. Du kannst es später erneut versuchen.';
      }
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installBtn.disabled = true;
    installBanner.hidden = true;
  });
})();