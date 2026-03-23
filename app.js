'use strict';
console.log('APP VERSION 2026-03-23 18:40 MULTIPANEL');
/* ===================== KONFIG ===================== */
const WINDOW_LEN = 600;            // ~10s @ 60Hz
const EVT_THR    = 0.1;            // mm/s
const DIN_GUIDES = [0.3, 1.0, 3.0, 10.0]; // (wenn du später ÖNORM willst, ersetzen)
const COLORS = { x:'#32ff6a', y:'#4aa6ff', z:'#ffe95a' };

const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent);

/* Filter für acc (Bandpass grob “Baustelle”): HP 1 Hz + LP 25 Hz */
const BP_FC_LOW  = 1.0;   // Hz
const BP_FC_HIGH = 25.0;  // Hz

/* ===================== DOM ===================== */
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
  resultChart: $('resultChart'),
  resAxis: $('resAxis'),
  resMeta: $('resMeta'),
  results: $('results'),

  dinNote: $('dinNote'),

  startBtn: $('startBtn'),
  resetBtn: $('resetBtn'),
  iosPermBtn: $('iosPermBtn'),

  exportUnit: $('exportUnit'),
  csvBtn: $('csvBtn'),
  pdfBtn: $('pdfBtn'),
};

const liveCtx = dom.liveChart?.getContext('2d');
const resCtx  = dom.resultChart?.getContext('2d');

/* ===================== ERROR ===================== */
window.addEventListener('error', (e) => {
  if (!dom.statusBar) return;
  dom.statusBar.hidden = false;
  dom.statusBar.className = 'statusBar is-error';
  dom.statusBar.textContent = `JS Fehler: ${e.message} (Zeile ${e.lineno})`;
});

/* ===================== STATE ===================== */
let running = false;
let startTime = null;
let durTimer = null;
let rafId = null;

let activeUnit  = 'vel';   // vor Start
let measureUnit = 'vel';   // fixiert während Messung

let motionEventCount = 0;
let noDataTimer = null;

// raw acc (m/s²)
let rawX = 0, rawY = 0, rawZ = 0;

// sampling estimate
let fsEst = 60;

// simple bandpass filter states
const bp = {
  // HP
  hx:0, hy:0, hz:0,
  px:0, py:0, pz:0,
  // LP
  lx:0, ly:0, lz:0,
};

const intg = { vx:0, vy:0, vz:0, px:0, py:0, pz:0, prev:null };

// Live buffer (zeigt measureUnit)
const buf = {
  x: new Float32Array(WINDOW_LEN),
  y: new Float32Array(WINDOW_LEN),
  z: new Float32Array(WINDOW_LEN),
  ptr: 0,
  len: 0
};

// stats (immer vel total mm/s)
let peakTotal=0, rmsAcc=0, rmsCnt=0, evtCount=0;

// Parallel export storage
let rec = null;
let savedAll = null;

/* ===================== HELPERS ===================== */
function setStatus(msg, cls) {
  if (!dom.statusBar) return;
  dom.statusBar.textContent = msg;
  dom.statusBar.className   = 'statusBar' + (cls ? ' ' + cls : '');
  dom.statusBar.hidden      = !msg;
}

function fmtTime(ms) {
  const mm = String(Math.floor(ms/60000)).padStart(2,'0');
  const ss = String(Math.floor(ms/1000)%60).padStart(2,'0');
  return `${mm}:${ss}`;
}

function unitLabel(mode){
  if (mode === 'acc') return 'm/s²';
  if (mode === 'disp') return 'mm';
  if (mode === 'freq') return 'Hz';
  return 'mm/s';
}

function yAxisText(mode){
  if (mode === 'acc') return 'a (m/s²)';
  if (mode === 'disp') return 's (mm)';
  if (mode === 'freq') return 'f (Hz)';
  return 'v (mm/s)';
}

function resizeCanvas(cvs) {
  const dpr  = window.devicePixelRatio || 1;
  const rect = cvs.getBoundingClientRect();
  if (!rect.width) return;
  cvs.width  = Math.floor(rect.width  * dpr);
  cvs.height = Math.floor(rect.height * dpr);
  cvs.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}
function initCanvases(){
  if (dom.liveChart) resizeCanvas(dom.liveChart);
  if (dom.resultChart) resizeCanvas(dom.resultChart);
  drawLive();
}
window.addEventListener('resize', () => setTimeout(initCanvases, 60));
setTimeout(initCanvases, 150);

function bandpass1(ax, ay, az, dt){
  // HP coeff
  const tauHP = 1 / (2 * Math.PI * BP_FC_LOW);
  const aHP = tauHP / (tauHP + dt);

  bp.hx = aHP * (bp.hx + ax - bp.px);
  bp.hy = aHP * (bp.hy + ay - bp.py);
  bp.hz = aHP * (bp.hz + az - bp.pz);
  bp.px = ax; bp.py = ay; bp.pz = az;

  // LP coeff
  const tauLP = 1 / (2 * Math.PI * BP_FC_HIGH);
  const aLP = dt / (tauLP + dt);

  bp.lx = bp.lx + aLP * (bp.hx - bp.lx);
  bp.ly = bp.ly + aLP * (bp.hy - bp.ly);
  bp.lz = bp.lz + aLP * (bp.hz - bp.lz);

  return { ax: bp.lx, ay: bp.ly, az: bp.lz };
}

/* ===================== UNIT BUTTONS ===================== */
document.querySelectorAll('.unitBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (running) return;
    activeUnit = btn.dataset.unit;

    document.querySelectorAll('.unitBtn').forEach(b =>
      b.classList.toggle('is-active', b === btn));

    const u = unitLabel(activeUnit);
    ['unitX','unitY','unitZ','unitT'].forEach(id => {
      const el = $(id); if (el) el.textContent = u;
    });
    const up = $('unitPeak'); if (up) up.textContent = 'mm/s';
    const ur = $('unitRms');  if (ur) ur.textContent = 'mm/s';
    if (dom.mainSub) dom.mainSub.textContent = `${u} (Total)`;
  });
});

/* ===================== SENSOR ===================== */
function onMotion(e){
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

/* ===================== START/STOP ===================== */
function resetState(){
  running = false;
  if (rafId){ cancelAnimationFrame(rafId); rafId = null; }
  if (durTimer){ clearInterval(durTimer); durTimer = null; }
  if (noDataTimer){ clearTimeout(noDataTimer); noDataTimer = null; }

  startTime = null;
  motionEventCount = 0;

  peakTotal=0; rmsAcc=0; rmsCnt=0; evtCount=0;

  buf.ptr=0; buf.len=0;
  buf.x.fill(0); buf.y.fill(0); buf.z.fill(0);

  // filter state
  bp.hx=bp.hy=bp.hz=0;
  bp.px=bp.py=bp.pz=0;
  bp.lx=bp.ly=bp.lz=0;

  intg.vx=intg.vy=intg.vz=0;
  intg.px=intg.py=intg.pz=0;
  intg.prev=null;

  fsEst = 60;
  rec = null;
  savedAll = null;

  if (dom.startBtn){
    dom.startBtn.textContent = 'Start';
    dom.startBtn.classList.add('btn--accent');
    dom.startBtn.classList.remove('btn--stop');
  }

  if (dom.mainNum) dom.mainNum.textContent = '0.00';
  if (dom.mainSub) dom.mainSub.textContent = `${unitLabel(activeUnit)} (Total)`;

  dom.xVal && (dom.xVal.textContent='0.00');
  dom.yVal && (dom.yVal.textContent='0.00');
  dom.zVal && (dom.zVal.textContent='0.00');
  dom.tVal && (dom.tVal.textContent='0.00');

  dom.peakVal && (dom.peakVal.textContent='0.00');
  dom.rmsVal  && (dom.rmsVal.textContent='0.00');
  dom.evtVal  && (dom.evtVal.textContent='0');
  dom.durVal  && (dom.durVal.textContent='00:00');

  dom.results && (dom.results.hidden = true);
  dom.resMeta && (dom.resMeta.textContent = '—');

  dom.debugPanel && (dom.debugPanel.textContent = 'Warte auf Sensor-Daten …');

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = false);
  setStatus('', '');

  drawLive();
}

function startMeasurement(){
  if (running) return;

  running = true;
  startTime = Date.now();
  motionEventCount = 0;
  measureUnit = activeUnit;

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
    dom.durVal && (dom.durVal.textContent = fmtTime(Date.now()-startTime));
  }, 250);

  noDataTimer = setTimeout(() => {
    if (motionEventCount === 0) setStatus('Keine Sensor-Daten. iPhone: Sensorerlaubnis nötig.', 'is-error');
  }, 2000);

  rafId = requestAnimationFrame(loop);
}

function stopMeasurement(){
  if (!running) return;
  running = false;

  if (rafId){ cancelAnimationFrame(rafId); rafId=null; }
  if (durTimer){ clearInterval(durTimer); durTimer=null; }
  if (noDataTimer){ clearTimeout(noDataTimer); noDataTimer=null; }

  document.querySelectorAll('.unitBtn').forEach(b => b.disabled = false);

  dom.startBtn.textContent='Start';
  dom.startBtn.classList.add('btn--accent');
  dom.startBtn.classList.remove('btn--stop');
  setStatus('Messung abgeschlossen ✓', 'is-done');

  if (rec){
    savedAll = {
      startTs: rec.startTs,
      durationSec: (performance.now() - rec.t0) / 1000,
      units: rec.units
    };

    dom.results && (dom.results.hidden = false);
    dom.resMeta && (dom.resMeta.textContent =
      `${new Date(savedAll.startTs).toLocaleString('de-DE')} · Dauer: ${savedAll.durationSec.toFixed(1)} s · Punkte: ${rec.units.vel.t.length}`
    );
  }

  rec = null;
}

/* iOS Permission inline */
dom.startBtn?.addEventListener('click', async () => {
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

dom.resetBtn?.addEventListener('click', () => resetState());

/* optional iOS Button */
if (IS_IOS &&
    typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function' &&
    dom.iosPermBtn) {
  dom.iosPermBtn.hidden = false;
  dom.iosPermBtn.addEventListener('click', async () => {
    const res = await DeviceMotionEvent.requestPermission();
    setStatus(res === 'granted' ? 'Sensorerlaubnis erteilt – drücke Start.' : 'Sensorerlaubnis verweigert!', res === 'granted' ? 'is-done' : 'is-error');
  });
}

/* ===================== LOOP ===================== */
function loop(){
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  const now = performance.now();
  const dt = Math.min((now - (intg.prev ?? now))/1000, 0.05);
  intg.prev = now;
  if (dt > 0) fsEst = 0.9*fsEst + 0.1*(1/dt);

  // bandpass linear acc (m/s²)
  const { ax, ay, az } = bandpass1(rawX, rawY, rawZ, dt);
  const accT = Math.sqrt(ax*ax + ay*ay + az*az);

  // integrate -> vel (m/s), disp (m)
  intg.vx = (intg.vx + ax*dt) * 0.985;
  intg.vy = (intg.vy + ay*dt) * 0.985;
  intg.vz = (intg.vz + az*dt) * 0.985;

  intg.px = (intg.px + intg.vx*dt) * 0.995;
  intg.py = (intg.py + intg.vy*dt) * 0.995;
  intg.pz = (intg.pz + intg.vz*dt) * 0.995;

  const velX = intg.vx*1000, velY=intg.vy*1000, velZ=intg.vz*1000;
  const velT = Math.sqrt(velX*velX + velY*velY + velZ*velZ);

  const dispX=intg.px*1000, dispY=intg.py*1000, dispZ=intg.pz*1000;
  const dispT=Math.sqrt(dispX*dispX + dispY*dispY + dispZ*dispZ);

  // freq (autocorr total acc) – vereinfacht
  // wir schätzen fT nur alle 0.5s neu
  let freqVal = 0;
  if (now - lastFreqUpdate > 500) {
    lastFreqUpdate = now;
    // simple rough estimate via zero-cross on accT would be too noisy; keep placeholder:
    // (Du kannst hier später FFT einsetzen)
    freqVal = Math.min(25, Math.max(0, accT * 2)); // sehr grobe Proxy
  }
  const f = freqVal;

  // record all units
  const U = rec.units;
  U.acc.x.push(ax);   U.acc.y.push(ay);   U.acc.z.push(az);   U.acc.t.push(accT);
  U.vel.x.push(velX); U.vel.y.push(velY); U.vel.z.push(velZ); U.vel.t.push(velT);
  U.disp.x.push(dispX); U.disp.y.push(dispY); U.disp.z.push(dispZ); U.disp.t.push(dispT);
  U.freq.x.push(f); U.freq.y.push(f); U.freq.z.push(f); U.freq.t.push(f);

  // stats (vel)
  if (velT > peakTotal) peakTotal = velT;
  rmsAcc += velT*velT; rmsCnt++;
  if (velT > EVT_THR) evtCount++;

  dom.peakVal && (dom.peakVal.textContent = peakTotal.toFixed(2));
  dom.rmsVal  && (dom.rmsVal.textContent  = (rmsCnt ? Math.sqrt(rmsAcc/rmsCnt).toFixed(2) : '0.00'));
  dom.evtVal  && (dom.evtVal.textContent  = String(evtCount));

  // display selected (fixed) unit
  let vx,vy,vz,vt,dec;
  if (measureUnit==='acc'){ vx=ax; vy=ay; vz=az; vt=accT; dec=3; }
  else if (measureUnit==='disp'){ vx=dispX; vy=dispY; vz=dispZ; vt=dispT; dec=2; }
  else if (measureUnit==='freq'){ vx=f; vy=f; vz=f; vt=f; dec=1; }
  else { vx=velX; vy=velY; vz=velZ; vt=velT; dec=2; }

  // live buffer
  buf.x[buf.ptr]=vx; buf.y[buf.ptr]=vy; buf.z[buf.ptr]=vz;
  buf.ptr=(buf.ptr+1)%WINDOW_LEN;
  if (buf.len<WINDOW_LEN) buf.len++;

  dom.xVal && (dom.xVal.textContent=vx.toFixed(dec));
  dom.yVal && (dom.yVal.textContent=vy.toFixed(dec));
  dom.zVal && (dom.zVal.textContent=vz.toFixed(dec));
  dom.tVal && (dom.tVal.textContent=vt.toFixed(dec));

  dom.mainNum && (dom.mainNum.textContent=vt.toFixed(dec));
  dom.mainSub && (dom.mainSub.textContent=`${unitLabel(measureUnit)} (Total)`);

  drawLive();

  dom.debugPanel && (dom.debugPanel.textContent =
    `unit(display)=${measureUnit}\n` +
    `accT=${accT.toFixed(3)} m/s²\n` +
    `velT=${velT.toFixed(2)} mm/s | peak=${peakTotal.toFixed(2)}\n` +
    `fs≈${fsEst.toFixed(1)} Hz | dt=${(dt*1000).toFixed(1)} ms`
  );
}

/* ===================== PDF/CSV EXPORT (mit Achsenwerten!) ===================== */
function getExportKey(){
  const v = dom.exportUnit?.value;
  if (v === 'vel' || v === 'acc' || v === 'disp' || v === 'freq') return v;
  return 'vel';
}

function exportCSV(){
  if (!savedAll){ setStatus('Keine Messdaten – erst messen!', 'is-error'); return; }
  const key = getExportKey();
  const d = savedAll.units[key];
  if (!d || d.t.length < 2){ setStatus('Keine Daten für diese Einheit.', 'is-error'); return; }

  const unit = unitLabel(key);
  const n = d.t.length;
  const dt = savedAll.durationSec / Math.max(1, n-1);

  let csv = `# HTB Export\n# Einheit: ${unit}\n#\n`;
  csv += `i;time_s;x_${unit};y_${unit};z_${unit};total_${unit}\n`;

  for (let i=0;i<n;i++){
    csv += `${i};${(i*dt).toFixed(4)};${d.x[i]};${d.y[i]};${d.z[i]};${d.t[i]}\n`;
  }

  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=`HTB_${key}_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function plotScientificPNG({ series, title, yLabel, color, durationSec }) {
  const W=1200,H=280,mL=80,mR=20,mT=32,mB=58,pw=W-mL-mR,ph=H-mT-mB;
  const c=document.createElement('canvas'); c.width=W; c.height=H;
  const ctx=c.getContext('2d');

  ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);

  // min/max
  let mn=Infinity,mx=-Infinity;
  for (const v of series){ mn=Math.min(mn,v); mx=Math.max(mx,v); }
  if (!isFinite(mn)||!isFinite(mx)){ mn=-1; mx=1; }
  if (mn===mx){ mn-=1; mx+=1; }
  const pad=(mx-mn)*0.1; mn-=pad; mx+=pad;
  const yOf=(v)=> mT+ph-((v-mn)/(mx-mn))*ph;

  // grid
  ctx.strokeStyle='#e9e9e9'; ctx.lineWidth=1;
  for(let i=0;i<=10;i++){
    const x=mL+(i/10)*pw; ctx.beginPath(); ctx.moveTo(x,mT); ctx.lineTo(x,mT+ph); ctx.stroke();
  }
  for(let j=0;j<=6;j++){
    const y=mT+(j/6)*ph; ctx.beginPath(); ctx.moveTo(mL,y); ctx.lineTo(mL+pw,y); ctx.stroke();
  }

  // axes
  ctx.strokeStyle='#111'; ctx.lineWidth=1.2;
  ctx.beginPath(); ctx.moveTo(mL,mT); ctx.lineTo(mL,mT+ph); ctx.lineTo(mL+pw,mT+ph); ctx.stroke();

  // y ticks (Werte links!)
  ctx.fillStyle='#333'; ctx.font='11px Arial'; ctx.textAlign='right';
  for(let j=0;j<=6;j++){
    const vv = mn + (j/6)*(mx-mn);
    const yy = yOf(vv);
    ctx.fillText(vv.toFixed(2), mL-8, yy+4);
  }

  // x ticks (Zeit unten!)
  ctx.textAlign='center';
  for(let i=0;i<=5;i++){
    const t = durationSec*(i/5);
    const x = mL+(i/5)*pw;
    ctx.fillText(t.toFixed(1), x, H-22);
  }

  // labels
  ctx.fillStyle='#111'; ctx.font='bold 14px Arial'; ctx.textAlign='left';
  ctx.fillText(title, mL, 20);

  ctx.save();
  ctx.translate(18, mT+ph/2+20);
  ctx.rotate(-Math.PI/2);
  ctx.font='12px Arial'; ctx.fillStyle='#333'; ctx.textAlign='center';
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();

  ctx.fillStyle='#333'; ctx.font='12px Arial'; ctx.textAlign='right';
  ctx.fillText('t [s]', mL+pw, H-6);

  // line
  ctx.strokeStyle=color; ctx.lineWidth=2;
  ctx.beginPath();
  const n=series.length;
  for(let i=0;i<n;i++){
    const x=mL+(i/(n-1))*pw;
    const y=yOf(series[i]);
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  }
  ctx.stroke();

  return c.toDataURL('image/png',1.0);
}

function exportPDF(){
  if (!savedAll){ setStatus('Keine Messdaten – erst messen!', 'is-error'); return; }
  const key=getExportKey();
  const d=savedAll.units[key];
  if (!d || d.t.length < 2){ setStatus('Keine Daten für diese Einheit.', 'is-error'); return; }

  const unit=unitLabel(key);
  const yLab=yAxisText(key);
  const dur=savedAll.durationSec;

  const imgX = plotScientificPNG({ series:d.x, title:'X-Achse', yLabel:yLab, color:'#ff4444', durationSec:dur });
  const imgY = plotScientificPNG({ series:d.y, title:'Y-Achse', yLabel:yLab, color:'#00cc66', durationSec:dur });
  const imgZ = plotScientificPNG({ series:d.z, title:'Z-Achse', yLabel:yLab, color:'#4499ff', durationSec:dur });

  const w=window.open('','_blank');
  if(!w){ setStatus('Popup blockiert – Popups erlauben!', 'is-error'); return; }

  w.document.open();
  w.document.write(`<!doctype html><html><head>
<meta charset="utf-8"/>
<title>HTB Export</title>
<style>
  @page{ size:A4 portrait; margin:12mm; }
  body{ font-family:Arial,sans-serif; margin:0; padding:12mm; background:#fff; color:#111; }
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

/* wire export */
dom.csvBtn?.addEventListener('click', exportCSV);
dom.pdfBtn?.addEventListener('click', exportPDF);

/* init */
resetState();
/* ===================== FEHLENDE VARIABLEN ===================== */
let lastFreqUpdate = 0;
const EVT_THR = 0.1; // mm/s

/* ===================== TABS ===================== */
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

/* ===================== AXIS TOGGLES ===================== */
const vis = { x:true, y:true, z:true, t:true };

function applyToggle(s, on) {
  vis[s] = on;
  document.querySelectorAll(`[data-series="${s}"]`).forEach(el =>
    el.classList.toggle('is-off', !on));
  if (dom.dinNote) dom.dinNote.hidden = vis.t;
}
document.querySelectorAll('.tile[data-series], .legendBtn[data-series]').forEach(btn => {
  btn.addEventListener('click', () =>
    applyToggle(btn.dataset.series, !vis[btn.dataset.series]));
});

/* ===================== ÖNORM S9020 BEWERTUNG ===================== */
/* Richtwerte vres,max (mm/s) nach ÖNORM S9020 (2015):
   Industriebauten:           30 mm/s
   Wohngebäude modern:        20 mm/s
   Wohngebäude traditionell:  10 mm/s
   Empfindliche Gebäude:       5 mm/s
   Denkmalgeschützt:           3 mm/s
*/
const oenormRows   = ['n0','n1','n2','n3','n4'];
const oenormBounds = [0, 5, 10, 20, 30];  // mm/s

function updateOENORM(vMms) {
  // Highlight der passenden Zeile (aktuelle Messung)
  let row = 0;
  for (let i = oenormBounds.length - 1; i >= 0; i--) {
    if (vMms >= oenormBounds[i]) { row = i; break; }
  }
  oenormRows.forEach((id, i) => {
    const el = $(id);
    if (el) el.classList.toggle('is-active', i === row);
  });
}

/* ===================== LIVE CHART: EINZELNES PANEL ===================== */
function drawPanel({ ctx, x, y, w, h, arr, title, mode, color }) {
  ctx.save();

  // Hintergrund
  ctx.fillStyle = '#111113';
  ctx.fillRect(x, y, w, h);

  // Rahmen
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(x, y, w, h);

  // Min/Max aus Buffer
  let mx = 0;
  for (let i = 0; i < buf.len; i++) {
    const idx = (buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN;
    mx = Math.max(mx, Math.abs(arr[idx]));
  }
  if (mx === 0 || !isFinite(mx)) mx = 1;

  const yMin = -mx * 1.2;
  const yMax =  mx * 1.2;
  const yOf  = (v) => y + h - ((v - yMin) / (yMax - yMin)) * h;

  // Gitternetz
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 7]);
  for (let i = 1; i <= 4; i++) {
    const gx = x + (i/5)*w;
    ctx.beginPath(); ctx.moveTo(gx,y); ctx.lineTo(gx,y+h); ctx.stroke();
  }
  for (let j = 1; j <= 3; j++) {
    const gy = y + (j/4)*h;
    ctx.beginPath(); ctx.moveTo(x,gy); ctx.lineTo(x+w,gy); ctx.stroke();
  }

  // ÖNORM S9020 Grenzlinien (nur vel, dezent gelb)
  if (mode === 'vel') {
    ctx.strokeStyle = 'rgba(255,237,0,0.18)';
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1;
    for (const g of [5, 10, 20, 30]) {
      const yg  = yOf(g);
      const ygn = yOf(-g);
      if (yg > y && yg < y+h) {
        ctx.beginPath(); ctx.moveTo(x,yg); ctx.lineTo(x+w,yg); ctx.stroke();
      }
      if (ygn > y && ygn < y+h) {
        ctx.beginPath(); ctx.moveTo(x,ygn); ctx.lineTo(x+w,ygn); ctx.stroke();
      }
    }
  }

  // Null-Linie
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.lineWidth = 1;
  const y0 = yOf(0);
  if (y0 > y && y0 < y+h) {
    ctx.beginPath(); ctx.moveTo(x,y0); ctx.lineTo(x+w,y0); ctx.stroke();
  }

  // Kurve
  if (buf.len >= 2) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < buf.len; i++) {
      const idx = (buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN;
      const xp  = x + (i / (WINDOW_LEN - 1)) * w;
      const yp  = yOf(arr[idx]);
      i === 0 ? ctx.moveTo(xp, yp) : ctx.lineTo(xp, yp);
    }
    ctx.stroke();
  }

  // Y-Ticks (Zahlenwerte links)
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '10px system-ui, Arial';
  ctx.textAlign = 'right';
  const tickVals = [mx, mx/2, 0, -mx/2, -mx];
  for (const v of tickVals) {
    const yp = yOf(v);
    if (yp > y+4 && yp < y+h-4) {
      ctx.fillText(v === 0 ? '0' : v.toFixed(2), x + 42, yp + 4);
    }
  }

  // X-Ticks (Zeit unten)
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '10px system-ui, Arial';
  for (const t of [0, 2, 4, 6, 8, 10]) {
    ctx.fillText(`${t}`, x + (t/10)*w, y + h - 4);
  }

  // Titel (oben zentriert)
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 12px system-ui, Arial';
  ctx.textAlign = 'center';
  ctx.fillText(title, x + w/2, y + 16);

  // Y-Achsen-Label (rotiert links)
  ctx.save();
  ctx.translate(x + 10, y + h/2);
  ctx.rotate(-Math.PI/2);
  ctx.fillStyle = 'rgba(255,255,255,0.50)';
  ctx.font = '10px system-ui, Arial';
  ctx.textAlign = 'center';
  ctx.fillText(yAxisText(mode), 0, 0);
  ctx.restore();

  // X-Label rechts unten
  ctx.fillStyle = 'rgba(255,255,255,0.40)';
  ctx.font = '10px system-ui, Arial';
  ctx.textAlign = 'right';
  ctx.fillText('t (s)', x + w - 3, y + h - 4);

  ctx.restore();
}

/* ===================== LIVE CHART: 3 PANELS ===================== */
function drawLive() {
  if (!dom.liveChart || !liveCtx) return;

  const cvs = dom.liveChart;
  const ctx = liveCtx;
  const W   = cvs.getBoundingClientRect().width  || 300;
  const H   = cvs.getBoundingClientRect().height || 560;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  const pad    = 10;
  const gap    = 10;
  const left   = 48;  // Platz für Y-Ticks
  const right  = 8;
  const panelH = Math.floor((H - pad*2 - gap*2) / 3);
  const pw     = W - left - right;

  const mode  = running ? measureUnit : activeUnit;
  const label = {
    vel:  ['v X (mm/s)', 'v Y (mm/s)', 'v Z (mm/s)'],
    acc:  ['a X (m/s²)', 'a Y (m/s²)', 'a Z (m/s²)'],
    disp: ['s X (mm)',   's Y (mm)',   's Z (mm)'],
    freq: ['f X (Hz)',   'f Y (Hz)',   'f Z (Hz)']
  };
  const titles = label[mode] || label.vel;

  drawPanel({ ctx, x:left, y: pad + 0*(panelH+gap), w:pw, h:panelH,
    arr: buf.x, title: titles[0], mode, color: COLORS.x });

  drawPanel({ ctx, x:left, y: pad + 1*(panelH+gap), w:pw, h:panelH,
    arr: buf.y, title: titles[1], mode, color: COLORS.y });

  drawPanel({ ctx, x:left, y: pad + 2*(panelH+gap), w:pw, h:panelH,
    arr: buf.z, title: titles[2], mode, color: COLORS.z });
}

/* ===================== RESULT CHART ===================== */
function drawResult(data) {
  if (!dom.resultChart || !resCtx) return;

  const cvs = dom.resultChart;
  const ctx = resCtx;
  const W   = cvs.getBoundingClientRect().width  || 300;
  const H   = cvs.getBoundingClientRect().height || 220;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);

  let mn=Infinity, mx=-Infinity;
  ['x','y','z','t'].forEach(s => {
    (data[s] || []).forEach(v => { mn=Math.min(mn,v); mx=Math.max(mx,v); });
  });
  if (!isFinite(mn)) { mn=-1; mx=1; }
  const rng=(mx-mn)||1;
  const yMin=mn-rng*0.12, yMax=mx+rng*0.12;

  // zero
  const y0 = H - ((0-yMin)/(yMax-yMin))*H;
  ctx.strokeStyle='#2a2a2d'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(0,y0); ctx.lineTo(W,y0); ctx.stroke();

  const c = { x:'#32ff6a', y:'#4aa6ff', z:'#ffe95a', t:'#ffed00' };
  ['x','y','z','t'].forEach(s => {
    const series = data[s] || [];
    if (series.length < 2) return;
    ctx.strokeStyle = c[s];
    ctx.lineWidth   = s==='t' ? 2.5 : 1.5;
    ctx.beginPath();
    series.forEach((v, i) => {
      const xp = (i/(series.length-1))*W;
      const yp = H - ((v-yMin)/(yMax-yMin))*H;
      i===0 ? ctx.moveTo(xp,yp) : ctx.lineTo(xp,yp);
    });
    ctx.stroke();
  });

  if (dom.resAxis) dom.resAxis.innerHTML = '<span>Anfang</span><span>Ende</span>';
}

/* ===================== PWA INSTALL ===================== */
(() => {
  const IS_STANDALONE = window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true;

  const banner    = $('installBanner');
  const installBtn = $('installBtn');
  if (!banner || !installBtn) return;

  if (IS_STANDALONE) { banner.hidden = true; return; }

  let deferredPrompt = null;

  if (IS_IOS) {
    banner.hidden = false;
    installBtn.textContent = 'Anleitung';
    installBtn.onclick = () =>
      setStatus('iPhone: Safari → Teilen (□↑) → „Zum Home-Bildschirm"', 'is-error');
    return;
  }

  banner.hidden = true;
  installBtn.disabled = true;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    banner.hidden = false;
    installBtn.disabled = false;
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) {
      setStatus('Chrome-Menü (⋮) → „App installieren"', 'is-error');
      return;
    }
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    banner.hidden = true;
    installBtn.disabled = true;
  });

  window.addEventListener('appinstalled', () => {
    banner.hidden = true;
    installBtn.disabled = true;
  });
})();

/* ===================== SERVICE WORKER ===================== */
// if ('serviceWorker' in navigator) {
//   window.addEventListener('load', () => {
//     navigator.serviceWorker.register('sw.js').catch(() => {});
//   });
// }
/* ===================== INIT ===================== */
applyToggle('x', true);
applyToggle('y', true);
applyToggle('z', true);
applyToggle('t', true);
resetState();
