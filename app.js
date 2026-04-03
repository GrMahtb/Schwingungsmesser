'use strict';
console.log('APP VERSION v2026-03-25 loaded');

// ===================== KONFIG =====================
const SAMPLE_RATE = 60;
const WIN_SEC = 30;
const WINDOW_LEN = WIN_SEC * SAMPLE_RATE;
const FREQ_WIN_SEC = 2;
const FREQ_WIN = FREQ_WIN_SEC * SAMPLE_RATE;
const FREQ_UPDATE_EVERY_N_FRAMES = 10;
const COLORS = { x:'#ff4444', y:'#00cc66', z:'#4499ff' };
const LEAK_V = 0.985;
const LS_KEY = 'htb_vibro_sessions'; // localStorage Key

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

// ===================== DATEINAME HELPER =====================
function getDatePrefix() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// ===================== JOB-INFO LESEN =====================
function getJobInfo() {
  return {
    site:   document.getElementById('jobSite')?.value.trim()   || '',
    date:   document.getElementById('jobDate')?.value          || '',
    author: document.getElementById('jobAuthor')?.value.trim() || '',
  };
}

// Datum/Uhrzeit im Eingabefeld vorbelegen
(function initDateField() {
  const el = document.getElementById('jobDate');
  if (!el) return;
  // Aktuelle Ortszeit als Default
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);
  el.value = local;
})();

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
  storageHint:   $('storageHint'),
  savedList:     $('savedList'),
  clearStorage:  $('clearStorageBtn'),
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
      if (btn.dataset.tab === 'app') renderSavedList();
      setTimeout(initCanvases, 120);
    });
  });
}

// ===================== ÖNORM TABLE =====================
function buildOenormTable() {
  const cfg = OENORM[activeUnit] || OENORM.vel;
  if (dom.oenormHint) dom.oenormHint.textContent = cfg.hint;
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
let rawX = 0, rawY = 0, rawZ = 0;

const hp   = { x:0, y:0, z:0, px:0, py:0, pz:0 };
const lp   = { x:0, y:0, z:0 };
const intg = { vx:0, vy:0, vz:0, prev:null };

const ring = {
  ptr: 0, len: 0,
  vel: { x: new Float32Array(WINDOW_LEN), y: new Float32Array(WINDOW_LEN), z: new Float32Array(WINDOW_LEN), t: new Float32Array(WINDOW_LEN) },
  acc: { x: new Float32Array(WINDOW_LEN), y: new Float32Array(WINDOW_LEN), z: new Float32Array(WINDOW_LEN), t: new Float32Array(WINDOW_LEN) },
  hz:  { x: new Float32Array(WINDOW_LEN), y: new Float32Array(WINDOW_LEN), z: new Float32Array(WINDOW_LEN), t: new Float32Array(WINDOW_LEN) },
};

const freqWin = {
  ptr: 0, len: 0,
  x: new Float32Array(FREQ_WIN), y: new Float32Array(FREQ_WIN),
  z: new Float32Array(FREQ_WIN), t: new Float32Array(FREQ_WIN),
};

let hzNow = { x:0, y:0, z:0, t:0 };
let hzFrameCounter = 0;

const stats = {
  vel: { peak:0, sum2:0, cnt:0 },
  acc: { peak:0, sum2:0, cnt:0 },
  hz:  { peak:0, sum:0,  cnt:0 },
};

let last = {
  vel: { x:0, y:0, z:0, t:0, rms:0, peak:0 },
  acc: { x:0, y:0, z:0, t:0, rms:0, peak:0 },
  hz:  { x:0, y:0, z:0, t:0, rms:0, peak:0 },
};

let savedData = null;
let rec       = null;

// ===================== LOCALSTORAGE – PERSISTENZ =====================
const MAX_SESSIONS = 10; // max. gespeicherte Messungen

function saveToStorage(data) {
  try {
    let sessions = loadFromStorage();
    // Nur komprimiert speichern (jede 5. Probe) um Speicher zu schonen
    const compress = (arr) => Array.from(arr).filter((_, i) => i % 5 === 0);
    sessions.unshift({
      id:          Date.now(),
      startTs:     data.startTs,
      durationSec: data.durationSec,
      filter:      data.filter,
      job:         getJobInfo(),
      n:           data.n,
      vel: { x: compress(data.vel.x), y: compress(data.vel.y), z: compress(data.vel.z), t: compress(data.vel.t) },
      acc: { x: compress(data.acc.x), y: compress(data.acc.y), z: compress(data.acc.z), t: compress(data.acc.t) },
      hz:  { x: compress(data.hz.x),  y: compress(data.hz.y),  z: compress(data.hz.z),  t: compress(data.hz.t)  },
    });
    // Maximal MAX_SESSIONS behalten
    sessions = sessions.slice(0, MAX_SESSIONS);
    localStorage.setItem(LS_KEY, JSON.stringify(sessions));
    updateStorageHint(sessions.length);
  } catch (e) {
    console.warn('localStorage voll oder nicht verfügbar:', e);
  }
}

function loadFromStorage() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  } catch { return []; }
}

function updateStorageHint(count) {
  if (dom.storageHint) {
    dom.storageHint.textContent = count > 0
      ? `💾 ${count} Messung(en) im Gerätespeicher gespeichert (Tab „App" → Gespeicherte Messungen)`
      : '';
  }
}

function renderSavedList() {
  if (!dom.savedList) return;
  const sessions = loadFromStorage();
  if (!sessions.length) {
    dom.savedList.innerHTML = '<p class="hint">Noch keine Messungen gespeichert.</p>';
    return;
  }
  dom.savedList.innerHTML = sessions.map((s, i) => {
    const dt  = new Date(s.startTs).toLocaleString('de-DE');
    const dur = s.durationSec?.toFixed(1) ?? '?';
    const job = s.job?.site ? ` · ${s.job.site}` : '';
    const aut = s.job?.author ? ` · ${s.job.author}` : '';
    return `<div class="saved-item">
      <b>#${i + 1}</b> ${dt}${job}${aut}<br>
      <small>Dauer: ${dur} s · Filter: ${FILTERS[s.filter]?.label || s.filter} · ${s.n} Punkte</small>
      <div class="buttons" style="margin-top:4px">
        <button class="btn btn--ok btn--sm" onclick="loadSession(${i})">Laden</button>
        <button class="btn btn--ghost btn--sm" onclick="deleteSession(${i})">Löschen</button>
      </div>
    </div>`;
  }).join('');
}

window.loadSession = function(i) {
  const sessions = loadFromStorage();
  const s = sessions[i];
  if (!s) return;
  // Komprimierte Arrays zu normalem savedData-Format konvertieren
  savedData = {
    n:           s.vel.t.length,
    startTs:     s.startTs,
    durationSec: s.durationSec,
    filter:      s.filter,
    vel: { x: s.vel.x, y: s.vel.y, z: s.vel.z, t: s.vel.t },
    acc: { x: s.acc.x, y: s.acc.y, z: s.acc.z, t: s.acc.t },
    hz:  { x: s.hz.x,  y: s.hz.y,  z: s.hz.z,  t: s.hz.t  },
  };
  // Job-Info zurückladen
  if (s.job) {
    if ($('jobSite'))   $('jobSite').value   = s.job.site   || '';
    if ($('jobDate'))   $('jobDate').value   = s.job.date   || '';
    if ($('jobAuthor')) $('jobAuthor').value = s.job.author || '';
    // Details aufklappen
    const det = document.getElementById('jobDetails');
    if (det) det.open = true;
  }
  if (dom.results) dom.results.hidden = false;
  if (dom.resMeta) {
    dom.resMeta.textContent =
      `${new Date(s.startTs).toLocaleString('de-DE')} · Dauer: ${s.durationSec?.toFixed(1)} s · ` +
      `Punkte: ${s.n} · Filter: ${FILTERS[s.filter]?.label || s.filter}`;
  }
  // Zum Messen-Tab wechseln
  document.querySelector('[data-tab="messen"]')?.click();
  setStatus(`Messung #${i+1} geladen ✓`, 'is-done');
  setTimeout(() => { initCanvases(); drawResult(savedData); }, 150);
};

window.deleteSession = function(i) {
  let sessions = loadFromStorage();
  sessions.splice(i, 1);
  localStorage.setItem(LS_KEY, JSON.stringify(sessions));
  updateStorageHint(sessions.length);
  renderSavedList();
};

dom.clearStorage?.addEventListener('click', () => {
  if (!confirm('Alle gespeicherten Messungen löschen?')) return;
  localStorage.removeItem(LS_KEY);
  updateStorageHint(0);
  renderSavedList();
});

// Beim Start: Anzahl gespeicherter Messungen anzeigen
updateStorageHint(loadFromStorage().length);

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
  intg.vx = (intg.vx + fx * dt) * LEAK_V;
  intg.vy = (intg.vy + fy * dt) * LEAK_V;
  intg.vz = (intg.vz + fz * dt) * LEAK_V;
}

function estimateHzFromWindow(arr, len, ptr) {
  if (len < 10) return 0;
  let meanAbs = 0;
  for (let i = 0; i < len; i++)
    meanAbs += Math.abs(arr[(ptr - len + i + FREQ_WIN) % FREQ_WIN]);
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
    const el = $(id); if (el) el.textContent = u;
  });
  dom.xVal.textContent    = pack.x.toFixed(2);
  dom.yVal.textContent    = pack.y.toFixed(2);
  dom.zVal.textContent    = pack.z.toFixed(2);
  dom.tVal.textContent    = pack.t.toFixed(2);
  dom.peakVal.textContent = pack.peak.toFixed(2);
  dom.rmsVal.textContent  = pack.rms.toFixed(2);
  dom.mainNum.textContent = pack.t.toFixed(2);
  dom.mainSub.textContent = (activeUnit === 'hz') ? 'Hz (Total dominant)' : `${u} (Total)`;
  if (dom.freqVal) dom.freqVal.textContent = hzNow.t ? hzNow.t.toFixed(1) : '—';
  updateOenormHighlight(activeUnit === 'hz' ? pack.t : pack.peak);
}

function setUnitUI() {
  buildOenormTable();
  renderFromLast();
  drawLive();
}

// ===================== DRAW =====================
function drawMultiPanel(ctx, kind, source) {
  const cvs = ctx.canvas;
  const W   = cvs.getBoundingClientRect().width  || 320;
  const H   = cvs.getBoundingClientRect().height || 540;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);
  const axes = ['x', 'y', 'z'], labels = ['X', 'Y', 'Z'];
  const panH = H / 3, mL = 60, mR = 10, mT = 18, mB = 28;

  axes.forEach((s, pi) => {
    const offY = pi * panH;
    const pw = W - mL - mR, ph = panH - mT - mB;
    ctx.fillStyle = (pi % 2 === 0) ? '#0b0b0c' : '#0d0d0f';
    ctx.fillRect(0, offY, W, panH);
    if (pi > 0) {
      ctx.strokeStyle = '#2a2a2d'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, offY); ctx.lineTo(W, offY); ctx.stroke();
    }
    const n = source.len;
    if (n < 2) {
      ctx.fillStyle = COLORS[s]; ctx.font = 'bold 11px system-ui';
      ctx.fillText(labels[pi], 6, offY + mT + 10); return;
    }
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = source.get(kind, s, i);
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
    if (!isFinite(mn)) { mn = -1; mx = 1; }
    if (mn === mx)     { mn -= 0.5; mx += 0.5; }
    const pad = (mx - mn) * 0.10, yMin = mn - pad, yMax = mx + pad;
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
      ctx.beginPath(); ctx.moveTo(gx, offY + mT); ctx.lineTo(gx, offY + mT + ph); ctx.stroke();
    }
    const y0 = toY(0);
    if (y0 >= offY + mT && y0 <= offY + mT + ph) {
      ctx.strokeStyle = '#3a3a42';
      ctx.beginPath(); ctx.moveTo(mL, y0); ctx.lineTo(mL + pw, y0); ctx.stroke();
    }
    ctx.fillStyle = '#6c6c74'; ctx.font = '9px system-ui'; ctx.textAlign = 'right';
    const yMid = (yMin + yMax) / 2;
    [yMax, yMid, yMin].forEach(v => {
      ctx.fillText(v.toFixed(2), mL - 4, toY(v) + 3);
    });
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS[s]; ctx.font = 'bold 11px system-ui';
    ctx.fillText(labels[pi], 6, offY + mT + 10);
    ctx.fillStyle = '#6c6c74'; ctx.font = '9px system-ui';
    ctx.fillText(unitLabel(kind), 6, offY + mT + 22);
    if (pi === 2) {
      ctx.textAlign = 'center'; ctx.fillStyle = '#6c6c74'; ctx.font = '9px system-ui';
      for (let g = 0; g <= 6; g++) {
        const sec = -WIN_SEC + (g / 6) * WIN_SEC;
        ctx.fillText(`${sec.toFixed(0)}s`, mL + (g / 6) * pw, offY + mT + ph + 18);
      }
      ctx.textAlign = 'left';
    }
    ctx.strokeStyle = COLORS[s]; ctx.lineWidth = 1.8; ctx.beginPath();
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
  drawMultiPanel(liveCtx, activeUnit, {
    len: ring.len,
    get: (k, axis, i) => {
      const idx = (ring.ptr - ring.len + i + WINDOW_LEN) % WINDOW_LEN;
      return ring[k][axis][idx];
    }
  });
}

function drawResult(data) {
  if (!resCtx || !data) return;
  const kind = dom.exportUnit?.value || 'vel';
  drawMultiPanel(resCtx, kind, {
    len: data.n,
    get: (k, axis, i) => data[k][axis][i],
  });
}

// ===================== SENSOR =====================
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

// ===================== RESET / START / STOP =====================
function resetAll() {
  running = false;
  if (rafId)       { cancelAnimationFrame(rafId);  rafId       = null; }
  if (durTimer)    { clearInterval(durTimer);       durTimer    = null; }
  if (noDataTimer) { clearTimeout(noDataTimer);     noDataTimer = null; }
  startTime = null; motionEventCount = 0;
  ring.ptr = 0; ring.len = 0;
  ['vel','acc','hz'].forEach(k => {
    ring[k].x.fill(0); ring[k].y.fill(0);
    ring[k].z.fill(0); ring[k].t.fill(0);
  });
  freqWin.ptr = 0; freqWin.len = 0;
  freqWin.x.fill(0); freqWin.y.fill(0);
  freqWin.z.fill(0); freqWin.t.fill(0);
  hzNow = { x:0, y:0, z:0, t:0 }; hzFrameCounter = 0;
  hp.x=hp.y=hp.z=0; hp.px=hp.py=hp.pz=0;
  lp.x=lp.y=lp.z=0;
  intg.vx=intg.vy=intg.vz=0; intg.prev=null;
  stats.vel = { peak:0, sum2:0, cnt:0 };
  stats.acc = { peak:0, sum2:0, cnt:0 };
  stats.hz  = { peak:0, sum:0,  cnt:0 };
  last.vel = { x:0, y:0, z:0, t:0, rms:0, peak:0 };
  last.acc = { x:0, y:0, z:0, t:0, rms:0, peak:0 };
  last.hz  = { x:0, y:0, z:0, t:0, rms:0, peak:0 };
  savedData = null; rec = null;
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
  running = true; startTime = Date.now();
  if (dom.startBtn) {
    dom.startBtn.textContent = 'Stop';
    dom.startBtn.classList.remove('btn--accent');
    dom.startBtn.classList.add('btn--stop');
  }
  setStatus('MESSUNG LÄUFT …', 'is-running');
  rec = {
    startTs: startTime, filter: activeFilter, t0: performance.now(),
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
  if (rafId)    { cancelAnimationFrame(rafId); rafId = null; }
  if (durTimer) { clearInterval(durTimer);     durTimer = null; }
  setStatus('Messung abgeschlossen ✓', 'is-done');
  if (dom.startBtn) {
    dom.startBtn.textContent = 'Start';
    dom.startBtn.classList.add('btn--accent');
    dom.startBtn.classList.remove('btn--stop');
  }
  if (rec && rec.vel.t.length > 10) {
    const durationSec = (performance.now() - rec.t0) / 1000;
    savedData = {
      n: rec.vel.t.length, startTs: rec.startTs,
      durationSec, filter: rec.filter,
      vel: rec.vel, acc: rec.acc, hz: rec.hz,
    };
    // ▼ Automatisch im localStorage speichern
    saveToStorage(savedData);
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

// ===================== LOOP =====================
function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);
  const now = performance.now();
  const dt  = Math.min((now - (intg.prev ?? now)) / 1000, 0.05);
  intg.prev = now;
  const { fx, fy, fz } = applyFilter(rawX, rawY, rawZ);
  integrate(fx, fy, fz, dt);
  const velX = intg.vx * 1000, velY = intg.vy * 1000, velZ = intg.vz * 1000;
  const velT = Math.sqrt(velX*velX + velY*velY + velZ*velZ);
  const accX = fx, accY = fy, accZ = fz;
  const accT = Math.sqrt(accX*accX + accY*accY + accZ*accZ);

  freqWin.x[freqWin.ptr]=velX; freqWin.y[freqWin.ptr]=velY;
  freqWin.z[freqWin.ptr]=velZ; freqWin.t[freqWin.ptr]=velT;
  freqWin.ptr = (freqWin.ptr + 1) % FREQ_WIN;
  if (freqWin.len < FREQ_WIN) freqWin.len++;

  if (++hzFrameCounter >= FREQ_UPDATE_EVERY_N_FRAMES) {
    hzFrameCounter = 0;
    hzNow = {
      x: estimateHzFromWindow(freqWin.x, freqWin.len, freqWin.ptr),
      y: estimateHzFromWindow(freqWin.y, freqWin.len, freqWin.ptr),
      z: estimateHzFromWindow(freqWin.z, freqWin.len, freqWin.ptr),
      t: estimateHzFromWindow(freqWin.t, freqWin.len, freqWin.ptr),
    };
  }

  ring.vel.x[ring.ptr]=velX; ring.vel.y[ring.ptr]=velY;
  ring.vel.z[ring.ptr]=velZ; ring.vel.t[ring.ptr]=velT;
  ring.acc.x[ring.ptr]=accX; ring.acc.y[ring.ptr]=accY;
  ring.acc.z[ring.ptr]=accZ; ring.acc.t[ring.ptr]=accT;
  ring.hz.x[ring.ptr]=hzNow.x; ring.hz.y[ring.ptr]=hzNow.y;
  ring.hz.z[ring.ptr]=hzNow.z; ring.hz.t[ring.ptr]=hzNow.t;
  ring.ptr = (ring.ptr + 1) % WINDOW_LEN;
  if (ring.len < WINDOW_LEN) ring.len++;

  stats.vel.peak  = Math.max(stats.vel.peak, velT);
  stats.vel.sum2 += velT * velT; stats.vel.cnt++;
  stats.acc.peak  = Math.max(stats.acc.peak, accT);
  stats.acc.sum2 += accT * accT; stats.acc.cnt++;
  stats.hz.peak  = Math.max(stats.hz.peak, hzNow.t);
  stats.hz.sum  += hzNow.t; stats.hz.cnt++;

  last.vel = { x:velX, y:velY, z:velZ, t:velT, peak:stats.vel.peak, rms:Math.sqrt(stats.vel.sum2/Math.max(1,stats.vel.cnt)) };
  last.acc = { x:accX, y:accY, z:accZ, t:accT, peak:stats.acc.peak, rms:Math.sqrt(stats.acc.sum2/Math.max(1,stats.acc.cnt)) };
  last.hz  = { x:hzNow.x, y:hzNow.y, z:hzNow.z, t:hzNow.t, peak:stats.hz.peak, rms:stats.hz.cnt?(stats.hz.sum/stats.hz.cnt):0 };

  renderFromLast();
  drawLive();
  if (dom.filterLabel) dom.filterLabel.textContent = FILTERS[activeFilter]?.label || activeFilter;
  if (dom.debugPanel) {
    dom.debugPanel.textContent =
      `raw  ax=${rawX.toFixed(3)} ay=${rawY.toFixed(3)} az=${rawZ.toFixed(3)} m/s²\n` +
      `filt fx=${accX.toFixed(3)} fy=${accY.toFixed(3)} fz=${accZ.toFixed(3)} m/s²  filter=${activeFilter}\n` +
      `vel  x=${velX.toFixed(2)} y=${velY.toFixed(2)} z=${velZ.toFixed(2)} total=${velT.toFixed(2)} mm/s\n` +
      `hz   x=${hzNow.x.toFixed(2)} y=${hzNow.y.toFixed(2)} z=${hzNow.z.toFixed(2)} t=${hzNow.t.toFixed(2)} Hz\n` +
      `dt=${(dt*1000).toFixed(1)} ms`;
  }
  if (rec && rec.vel.t.length < 12000) {
    rec.vel.x.push(velX); rec.vel.y.push(velY); rec.vel.z.push(velZ); rec.vel.t.push(velT);
    rec.acc.x.push(accX); rec.acc.y.push(accY); rec.acc.z.push(accZ); rec.acc.t.push(accT);
    rec.hz.x.push(hzNow.x); rec.hz.y.push(hzNow.y); rec.hz.z.push(hzNow.z); rec.hz.t.push(hzNow.t);
  }
}

// ===================== UNIT / FILTER EVENTS =====================
document.querySelectorAll('.unitBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeUnit = btn.dataset.unit;
    document.querySelectorAll('.unitBtn').forEach(b => b.classList.toggle('is-active', b === btn));
    setUnitUI();
  });
});
dom.filterSelect?.addEventListener('change', () => {
  activeFilter = dom.filterSelect.value;
  hp.x=hp.y=hp.z=0; hp.px=hp.py=hp.pz=0; lp.x=lp.y=lp.z=0;
  if (dom.filterLabel) dom.filterLabel.textContent = FILTERS[activeFilter]?.label || activeFilter;
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
  const job     = getJobInfo();

  let csv = `# HTB Schwingungsmesser Export\n`;
  csv += `# Baustelle: ${job.site}\n`;
  csv += `# Datum/Uhrzeit: ${job.date}\n`;
  csv += `# Verfasser: ${job.author}\n`;
  csv += `# Start: ${new Date(savedData.startTs).toLocaleString('de-DE')}\n`;
  csv += `# Dauer: ${savedData.durationSec.toFixed(2)} s\n`;
  csv += `# Filter: ${FILTERS[savedData.filter]?.label || savedData.filter}\n`;
  csv += `# Einheit: ${expUnit} (${u})\n#\n`;
  csv += `i;time_s;x_${u};y_${u};z_${u};total_${u}\n`;
  for (let i = 0; i < n; i++) {
    csv += `${i};${(i * dt).toFixed(4)};${src.x[i].toFixed(6)};${src.y[i].toFixed(6)};${src.z[i].toFixed(6)};${src.t[i].toFixed(6)}\n`;
  }

  // Dateiname: JJJJMMTT_HTB_Messung_...
  const prefix = getDatePrefix();
  const sitePart = job.site ? `_${job.site.replace(/[^a-zA-Z0-9äöüÄÖÜ]/g, '_').slice(0,20)}` : '';
  const filename = `${prefix}_HTB_Messung${sitePart}.csv`;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
dom.csvBtn?.addEventListener('click', exportCSV);

// ===================== PDF EXPORT (direkt, kein Druckdialog) =====================
function plotToDataURL({ series, title, unit, color, durationSec }) {
  const W = 1200, H = 260;
  const mL = 74, mR = 18, mT = 30, mB = 50;
  const pw = W - mL - mR, ph = H - mT - mB;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  let mn = Infinity, mx = -Infinity;
  for (const v of series) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!isFinite(mn) || !isFinite(mx)) { mn = -1; mx = 1; }
  if (mn === mx) { mn -= 1; mx += 1; }
  const pad = (mx - mn) * 0.10; mn -= pad; mx += pad;
  const yOf = (v) => mT + ph - ((v - mn) / (mx - mn)) * ph;
  ctx.strokeStyle = '#e6e6e6'; ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const x = mL + (i / 10) * pw;
    ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT + ph); ctx.stroke();
  }
  for (let j = 0; j <= 6; j++) {
    const y = mT + (j / 6) * ph;
    ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL + pw, y); ctx.stroke();
  }
  ctx.strokeStyle = '#111'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(mL, mT); ctx.lineTo(mL, mT + ph); ctx.lineTo(mL + pw, mT + ph); ctx.stroke();
  ctx.fillStyle = '#111'; ctx.font = 'bold 14px Arial'; ctx.fillText(title, mL, 18);
  ctx.fillStyle = '#333'; ctx.font = '12px Arial'; ctx.fillText(unit, 12, mT + 12);
  for (let j = 0; j <= 6; j++) {
    const vv = mn + (j / 6) * (mx - mn);
    ctx.fillText(vv.toFixed(3), 10, yOf(vv) + 4);
  }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 5; i++) {
    const t = durationSec * (i / 5), x = mL + (i / 5) * pw;
    ctx.fillText(t.toFixed(1), x, H - 18);
  }
  ctx.textAlign = 'left'; ctx.fillText('t [s]', mL + pw - 38, H - 4);
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
  const nn = series.length;
  for (let i = 0; i < nn; i++) {
    const x = mL + (i / (nn - 1)) * pw, y = yOf(series[i]);
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

  // Prüfen ob jsPDF verfügbar
  if (typeof window.jspdf === 'undefined') {
    setStatus('jsPDF nicht geladen – PDF nicht verfügbar.', 'is-error');
    return;
  }

  const { jsPDF } = window.jspdf;
  const expUnit = dom.exportUnit?.value || 'vel';
  const unit    = unitLabel(expUnit);
  const dur     = savedData.durationSec;
  const src     = savedData[expUnit];
  const job     = getJobInfo();

  // Chart-Bilder rendern
  const imgX = plotToDataURL({ series: src.x, title:'X-Achse', unit, color: COLORS.x, durationSec: dur });
  const imgY = plotToDataURL({ series: src.y, title:'Y-Achse', unit, color: COLORS.y, durationSec: dur });
  const imgZ = plotToDataURL({ series: src.z, title:'Z-Achse', unit, color: COLORS.z, durationSec: dur });

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = 210, margin = 14, contentW = pageW - 2 * margin;
  let y = 14;

  // Titel
  doc.setFontSize(16); doc.setFont('helvetica', 'bold');
  doc.text('HTB Schwingungsmesser – Messbericht', margin, y); y += 8;

  // Metadaten
  doc.setFontSize(9); doc.setFont('helvetica', 'normal');
  doc.setTextColor(80);

  const lines = [
    [`Baustelle:`,     job.site   || '—'],
    [`Datum / Uhrzeit:`, job.date ? job.date.replace('T',' ') : '—'],
    [`Verfasser:`,     job.author || '—'],
    [`Messung Start:`, new Date(savedData.startTs).toLocaleString('de-DE')],
    [`Dauer:`,         `${dur.toFixed(2)} s`],
    [`Einheit:`,       unit],
    [`Punkte:`,        String(savedData.n)],
    [`Filter:`,        FILTERS[savedData.filter]?.label || savedData.
