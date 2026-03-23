'use strict';

const APP_VERSION = 'multipanel-oeNormS9020-export-v1';

const WINDOW_LEN = 600;
const EVT_THR = 0.1;              // mm/s
const OENORM_GUIDES = [5, 10, 20, 30]; // mm/s (Richtwerte v_res,max)

const COLORS = { x:'#32ff6a', y:'#4aa6ff', z:'#ffe95a' };
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent);

// Bandpass (baustellentypisch)
const BP_FC_LOW  = 1.0;   // Hz
const BP_FC_HIGH = 25.0;  // Hz

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

  results: $('results'),
  resMeta: $('resMeta'),

  startBtn: $('startBtn'),
  resetBtn: $('resetBtn'),
  iosPermBtn: $('iosPermBtn'),

  exportUnit: $('exportUnit'),
  csvBtn: $('csvBtn'),
  pdfBtn: $('pdfBtn'),

  installBanner: $('installBanner'),
  installBtn: $('installBtn')
};

const liveCtx = dom.liveChart?.getContext('2d');

window.addEventListener('error', (e) => {
  if (!dom.statusBar) return;
  dom.statusBar.hidden = false;
  dom.statusBar.className = 'statusBar is-error';
  dom.statusBar.textContent = `JS Fehler: ${e.message} (Zeile ${e.lineno})`;
});

/* ---------------- STATE ---------------- */
let running = false;
let activeUnit  = 'vel';
let measureUnit = 'vel';

let startTime = null;
let durTimer = null;
let rafId = null;

let motionEventCount = 0;
let noDataTimer = null;

// raw acc (m/s²)
let rawX = 0, rawY = 0, rawZ = 0;

// sampling estimate
let fsEst = 60;

// filter states (HP+LP)
const bp = { hx:0, hy:0, hz:0, px:0, py:0, pz:0, lx:0, ly:0, lz:0 };

// integrator
const intg = { vx:0, vy:0, vz:0, px:0, py:0, pz:0, prev:null };

// live ring buffers for displayed unit
const buf = {
  x: new Float32Array(WINDOW_LEN),
  y: new Float32Array(WINDOW_LEN),
  z: new Float32Array(WINDOW_LEN),
  ptr: 0,
  len: 0
};

// stats (always vel)
let peakTotal = 0, rmsAcc = 0, rmsCnt = 0, evtCount = 0;

// export store of last measurement (all units)
let rec = null;
let savedAll = null;

/* ---------------- HELPERS ---------------- */
function setStatus(msg, cls) {
  if (!dom.statusBar) return;
  dom.statusBar.textContent = msg;
  dom.statusBar.className = 'statusBar' + (cls ? ' ' + cls : '');
  dom.statusBar.hidden = !msg;
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
  drawLive();
}
window.addEventListener('resize', () => setTimeout(initCanvases, 60));
setTimeout(initCanvases, 150);

function bandpass1(ax, ay, az, dt){
  const tauHP = 1 / (2 * Math.PI * BP_FC_LOW);
  const aHP = tauHP / (tauHP + dt);

  bp.hx = aHP * (bp.hx + ax - bp.px);
  bp.hy = aHP * (bp.hy + ay - bp.py);
  bp.hz = aHP * (bp.hz + az - bp.pz);
  bp.px = ax; bp.py = ay; bp.pz = az;

  const tauLP = 1 / (2 * Math.PI * BP_FC_HIGH);
  const aLP = dt / (tauLP + dt);

  bp.lx = bp.lx + aLP * (bp.hx - bp.lx);
  bp.ly = bp.ly + aLP * (bp.hy - bp.ly);
  bp.lz = bp.lz + aLP * (bp.hz - bp.lz);

  return { ax: bp.lx, ay: bp.ly, az: bp.lz };
}

/* ---------------- ÖNORM highlight ---------------- */
const rows = ['n0','n1','n2','n3','n4'];
const bounds = [0, 5, 10, 20, 30];
function updateOENORM(vResMaxMmS){
  let row = 0;
  for (let i=bounds.length-1;i>=0;i--){
    if (vResMaxMmS >= bounds[i]) { row = i; break; }
  }
  rows.forEach((id,i)=> {
    const el = $(id);
    if (el) el.classList.toggle('is-active', i===row);
  });
}

/* ---------------- UNIT buttons ---------------- */
document.querySelectorAll('.unitBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (running) return;
    activeUnit = btn.dataset.unit;
    document.querySelectorAll('.unitBtn').forEach(b => b.classList.toggle('is-active', b===btn));

    const u = unitLabel(activeUnit);
    ['unitX','unitY','unitZ','unitT'].forEach(id => { const el=$(id); if (el) el.textContent = u; });
    const up = $('unitPeak'); if (up) up.textContent='mm/s';
    const ur = $('unitRms'); if (ur) ur.textContent='mm/s';
    dom.mainSub && (dom.mainSub.textContent = `${u} (Total)`);
  });
});

/* ---------------- SENSOR ---------------- */
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

/* ---------------- MULTI PANEL DRAW ---------------- */
function drawPanel(ctx, x, y, w, h, arr, title, color, mode){
  ctx.save();

  ctx.fillStyle = '#111113';
  ctx.fillRect(x,y,w,h);

  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x,y,w,h);

  let mx = 0;
  for (let i=0;i<buf.len;i++){
    const idx = (buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN;
    mx = Math.max(mx, Math.abs(arr[idx]));
  }
  if (!isFinite(mx) || mx === 0) mx = 1;

  const yMin = -mx*1.2, yMax = mx*1.2;
  const yOf = (v) => y + h - ((v - yMin)/(yMax-yMin))*h;

  // grid
  ctx.setLineDash([4,6]);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for (let i=1;i<=4;i++){
    const gx = x + (i/5)*w;
    ctx.beginPath(); ctx.moveTo(gx,y); ctx.lineTo(gx,y+h); ctx.stroke();
  }
  for (let j=1;j<=3;j++){
    const gy = y + (j/4)*h;
    ctx.beginPath(); ctx.moveTo(x,gy); ctx.lineTo(x+w,gy); ctx.stroke();
  }

  // ÖNORM guide lines (only vel)
  if (mode === 'vel'){
    ctx.setLineDash([4,6]);
    ctx.strokeStyle = 'rgba(255,237,0,0.14)';
    for (const g of OENORM_GUIDES){
      const yg = yOf(g);
      const ygn = yOf(-g);
      if (yg>y && yg<y+h){ ctx.beginPath(); ctx.moveTo(x,yg); ctx.lineTo(x+w,yg); ctx.stroke(); }
      if (ygn>y && ygn<y+h){ ctx.beginPath(); ctx.moveTo(x,ygn); ctx.lineTo(x+w,ygn); ctx.stroke(); }
    }
  }

  // zero line
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath(); ctx.moveTo(x,yOf(0)); ctx.lineTo(x+w,yOf(0)); ctx.stroke();

  // curve
  if (buf.len >= 2){
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    for (let i=0;i<buf.len;i++){
      const idx = (buf.ptr - buf.len + i + WINDOW_LEN) % WINDOW_LEN;
      const xp = x + (i/(WINDOW_LEN-1))*w;
      const yp = yOf(arr[idx]);
      i===0 ? ctx.moveTo(xp,yp) : ctx.lineTo(xp,yp);
    }
    ctx.stroke();
  }

  // y ticks
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '10px system-ui, Arial';
  ctx.textAlign = 'right';
  for (const v of [mx, mx/2, 0, -mx/2, -mx]){
    const yy = yOf(v);
    if (yy>y+4 && yy<y+h-4) ctx.fillText(v===0?'0':v.toFixed(2), x+42, yy+4);
  }

  // title
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 12px system-ui, Arial';
  ctx.textAlign = 'center';
  ctx.fillText(title, x+w/2, y+16);

  // y label
  ctx.save();
  ctx.translate(x+10, y+h/2);
  ctx.rotate(-Math.PI/2);
  ctx.fillStyle = 'rgba(255,255,255,0.50)';
  ctx.font = '10px system-ui, Arial';
  ctx.textAlign = 'center';
  ctx.fillText(yAxisText(mode), 0, 0);
  ctx.restore();

  ctx.restore();
}

function drawLive(){
  if (!dom.liveChart || !liveCtx) return;

  const ctx = liveCtx;
  const W = dom.liveChart.getBoundingClientRect().width || 300;
  const H = dom.liveChart.getBoundingClientRect().height || 560;

  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0,0,W,H);

  const pad=10, gap=10, left=48, right=8;
  const panelH = Math.floor((H - pad*2 - gap*2)/3);
  const pw = W - left - right;

  const mode = running ? measureUnit : activeUnit;
  const u = unitLabel(mode);

  drawPanel(ctx, left, pad + 0*(panelH+gap), pw, panelH, buf.x, `X (${u})`, COLORS.x, mode);
  drawPanel(ctx, left, pad + 1*(panelH+gap), pw, panelH, buf.y, `Y (${u})`, COLORS.y, mode);
  drawPanel(ctx, left, pad + 2*(panelH+gap), pw, panelH, buf.z, `Z (${u})`, COLORS.z, mode);
}

/* ---------------- RESET / START / LOOP ---------------- */
function resetState(){
  running=false;
  if (rafId){ cancelAnimationFrame(rafId); rafId=null; }
  if (durTimer){ clearInterval(durTimer); durTimer=null; }
  if (noDataTimer){ clearTimeout(noDataTimer); noDataTimer=null; }

  startTime=null;
  motionEventCount=0;

  peakTotal=0; rmsAcc=0; rmsCnt=0; evtCount=0;

  buf.ptr=0; buf.len=0;
  buf.x.fill(0); buf.y.fill(0); buf.z.fill(0);

  bp.hx=bp.hy=bp.hz=0; bp.px=bp.py=bp.pz=0; bp.lx=bp.ly=bp.lz=0;
  intg.vx=intg.vy=intg.vz=0; intg.px=intg.py=intg.pz=0; intg.prev=null;
  fsEst=60;

  savedAll=null;
  rec=null;

  dom.startBtn.textContent='Start';
  dom.startBtn.classList.add('btn--accent');
  dom.startBtn.classList.remove('btn--stop');

  dom.mainNum.textContent='0.00';
  dom.mainSub.textContent=`${unitLabel(activeUnit)} (Total)`;
  dom.xVal.textContent=dom.yVal.textContent=dom.zVal.textContent=dom.tVal.textContent='0.00';
  dom.peakVal.textContent=dom.rmsVal.textContent='0.00';
  dom.evtVal.textContent='0';
  dom.durVal.textContent='00:00';

  rows.forEach(id => { const el=$(id); if (el) el.classList.remove('is-active'); });

  dom.results.hidden = true;
  dom.resMeta.textContent = '—';
  dom.debugPanel.textContent = `Warte auf Sensor-Daten …\n${APP_VERSION}`;

  setStatus('', '');
  drawLive();
}

function startMeasurement(){
  if (running) return;

  running=true;
  startTime=Date.now();
  motionEventCount=0;
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

  dom.startBtn.textContent='Stop';
  dom.startBtn.classList.remove('btn--accent');
  dom.startBtn.classList.add('btn--stop');
  setStatus('MESSUNG LÄUFT …', 'is-running');

  durTimer=setInterval(()=> dom.durVal.textContent = fmtTime(Date.now()-startTime), 250);

  noDataTimer=setTimeout(()=>{
    if (motionEventCount===0) setStatus('Keine Sensor-Daten. iPhone: Sensorerlaubnis nötig.', 'is-error');
  },2000);

  rafId=requestAnimationFrame(loop);
}

function stopMeasurement(){
  if (!running) return;
  running=false;

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
      durationSec: (performance.now()-rec.t0)/1000,
      units: rec.units
    };
    dom.results.hidden = false;
    dom.resMeta.textContent =
      `${new Date(savedAll.startTs).toLocaleString('de-DE')} · Dauer: ${savedAll.durationSec.toFixed(1)} s · Punkte: ${rec.units.vel.t.length}`;
  }
  rec=null;
}

dom.startBtn.addEventListener('click', async () => {
  try{
    if (IS_IOS && typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function'){
      const res = await DeviceMotionEvent.requestPermission();
      if (res !== 'granted'){ setStatus('iPhone: Sensorerlaubnis verweigert.', 'is-error'); return; }
    }
    running ? stopMeasurement() : startMeasurement();
  }catch(err){
    setStatus('Fehler: ' + err.message, 'is-error');
  }
});
dom.resetBtn.addEventListener('click', resetState);

function loop(){
  if (!running) return;
  rafId=requestAnimationFrame(loop);

  const now=performance.now();
  const dt=Math.min((now-(intg.prev??now))/1000, 0.05);
  intg.prev=now;
  if (dt>0) fsEst = 0.9*fsEst + 0.1*(1/dt);

  // bandpass acc
  const {ax,ay,az} = bandpass1(rawX, rawY, rawZ, dt);
  const accT = Math.sqrt(ax*ax+ay*ay+az*az);

  // integrate
  intg.vx = (intg.vx + ax*dt) * 0.985;
  intg.vy = (intg.vy + ay*dt) * 0.985;
  intg.vz = (intg.vz + az*dt) * 0.985;

  intg.px = (intg.px + intg.vx*dt) * 0.995;
  intg.py = (intg.py + intg.vy*dt) * 0.995;
  intg.pz = (intg.pz + intg.vz*dt) * 0.995;

  const velX=intg.vx*1000, velY=intg.vy*1000, velZ=intg.vz*1000;
  const velT=Math.sqrt(velX*velX+velY*velY+velZ*velZ);

  const dispX=intg.px*1000, dispY=intg.py*1000, dispZ=intg.pz*1000;
  const dispT=Math.sqrt(dispX*dispX+dispY*dispY+dispZ*dispZ);

  // sehr einfache Hz-Anzeige (Proxy) – stabil, nicht FFT:
  const freq = Math.min(25, Math.max(0, accT*2));

  // record all
  const U = rec.units;
  U.acc.x.push(ax); U.acc.y.push(ay); U.acc.z.push(az); U.acc.t.push(accT);
  U.vel.x.push(velX); U.vel.y.push(velY); U.vel.z.push(velZ); U.vel.t.push(velT);
  U.disp.x.push(dispX); U.disp.y.push(dispY); U.disp.z.push(dispZ); U.disp.t.push(dispT);
  U.freq.x.push(freq); U.freq.y.push(freq); U.freq.z.push(freq); U.freq.t.push(freq);

  // stats vel
  if (velT>peakTotal) peakTotal=velT;
  rmsAcc += velT*velT; rmsCnt++;
  if (velT>EVT_THR) evtCount++;

  dom.peakVal.textContent = peakTotal.toFixed(2);
  dom.rmsVal.textContent  = rmsCnt ? Math.sqrt(rmsAcc/rmsCnt).toFixed(2) : '0.00';
  dom.evtVal.textContent  = String(evtCount);

  // ÖNORM highlight on resultant vel
  updateOENORM(velT);

  // display (fixed)
  let vx,vy,vz,vt,dec;
  if (measureUnit==='acc'){ vx=ax; vy=ay; vz=az; vt=accT; dec=3; }
  else if (measureUnit==='disp'){ vx=dispX; vy=dispY; vz=dispZ; vt=dispT; dec=2; }
  else if (measureUnit==='freq'){ vx=freq; vy=freq; vz=freq; vt=freq; dec=1; }
  else { vx=velX; vy=velY; vz=velZ; vt=velT; dec=2; }

  buf.x[buf.ptr]=vx; buf.y[buf.ptr]=vy; buf.z[buf.ptr]=vz;
  buf.ptr=(buf.ptr+1)%WINDOW_LEN;
  if (buf.len<WINDOW_LEN) buf.len++;

  dom.xVal.textContent=vx.toFixed(dec);
  dom.yVal.textContent=vy.toFixed(dec);
  dom.zVal.textContent=vz.toFixed(dec);
  dom.tVal.textContent=vt.toFixed(dec);
  dom.mainNum.textContent=vt.toFixed(dec);
  dom.mainSub.textContent=`${unitLabel(measureUnit)} (Total)`;

  drawLive();

  dom.debugPanel.textContent =
    `Version: ${APP_VERSION}\n` +
    `unit(display)=${measureUnit}\n` +
    `accT=${accT.toFixed(3)} m/s²\n` +
    `velT=${velT.toFixed(2)} mm/s | peak=${peakTotal.toFixed(2)}\n` +
    `fs≈${fsEst.toFixed(1)} Hz | dt=${(dt*1000).toFixed(1)} ms`;
}

/* ---------------- EXPORTS ---------------- */
function getExportKey(){
  const v = dom.exportUnit?.value;
  if (v === 'vel' || v === 'acc' || v === 'disp' || v === 'freq') return v;
  return 'vel';
}

function exportCSV(){
  if (!savedAll){ setStatus('Keine Messdaten – erst messen!', 'is-error'); return; }
  const key=getExportKey();
  const d=savedAll.units[key];
  if (!d || d.t.length<2){ setStatus('Keine Daten für diese Einheit.', 'is-error'); return; }

  const unit=unitLabel(key);
  const n=d.t.length;
  const dt=savedAll.durationSec/Math.max(1,n-1);

  let csv=`# HTB Export\n# Einheit: ${unit}\n#\n`;
  csv += `i;time_s;x_${unit};y_${unit};z_${unit};total_${unit}\n`;
  for(let i=0;i<n;i++){
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

  let mn=Infinity,mx=-Infinity;
  for(const v of series){ mn=Math.min(mn,v); mx=Math.max(mx,v); }
  if(!isFinite(mn)||!isFinite(mx)){ mn=-1; mx=1; }
  if(mn===mx){ mn-=1; mx+=1; }
  const pad=(mx-mn)*0.1; mn-=pad; mx+=pad;
  const yOf=(v)=> mT+ph-((v-mn)/(mx-mn))*ph;

  ctx.strokeStyle='#e9e9e9'; ctx.lineWidth=1;
  for(let i=0;i<=10;i++){ const x=mL+(i/10)*pw; ctx.beginPath(); ctx.moveTo(x,mT); ctx.lineTo(x,mT+ph); ctx.stroke(); }
  for(let j=0;j<=6;j++){ const y=mT+(j/6)*ph; ctx.beginPath(); ctx.moveTo(mL,y); ctx.lineTo(mL+pw,y); ctx.stroke(); }

  ctx.strokeStyle='#111'; ctx.lineWidth=1.2;
  ctx.beginPath(); ctx.moveTo(mL,mT); ctx.lineTo(mL,mT+ph); ctx.lineTo(mL+pw,mT+ph); ctx.stroke();

  ctx.fillStyle='#333'; ctx.font='11px Arial'; ctx.textAlign='right';
  for(let j=0;j<=6;j++){
    const vv=mn+(j/6)*(mx-mn);
    ctx.fillText(vv.toFixed(2), mL-8, yOf(vv)+4);
  }

  ctx.textAlign='center';
  for(let i=0;i<=5;i++){
    const t=durationSec*(i/5);
    ctx.fillText(t.toFixed(1), mL+(i/5)*pw, H-22);
  }

  ctx.fillStyle='#111'; ctx.font='bold 14px Arial'; ctx.textAlign='left';
  ctx.fillText(title, mL, 20);

  ctx.save();
  ctx.translate(18, mT+ph/2+20); ctx.rotate(-Math.PI/2);
  ctx.fillStyle='#333'; ctx.font='12px Arial'; ctx.textAlign='center';
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();

  ctx.fillStyle='#333'; ctx.font='12px Arial'; ctx.textAlign='right';
  ctx.fillText('t [s]', mL+pw, H-6);

  ctx.strokeStyle=color; ctx.lineWidth=2;
  ctx.beginPath();
  for(let i=0;i<series.length;i++){
    const x=mL+(i/(series.length-1))*pw;
    const y=yOf(series[i]);
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  }
  ctx.stroke();

  return c.toDataURL('image/png',1.0);
}

function exportPDF(){
  if(!savedAll){ setStatus('Keine Messdaten – erst messen!', 'is-error'); return; }
  const key=getExportKey();
  const d=savedAll.units[key];
  if(!d || d.t.length<2){ setStatus('Keine Daten für diese Einheit.', 'is-error'); return; }

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

dom.csvBtn?.addEventListener('click', exportCSV);
dom.pdfBtn?.addEventListener('click', exportPDF);

/* ---------------- PWA INSTALL ---------------- */
(() => {
  const IS_STANDALONE =
    window.matchMedia('(display-mode: standalone)').matches ||
    navigator.standalone === true;

  if (!dom.installBanner || !dom.installBtn) return;

  if (IS_STANDALONE) {
    dom.installBanner.hidden = true;
    return;
  }

  let deferredPrompt = null;

  if (IS_IOS) {
    dom.installBanner.hidden = false;
    dom.installBtn.textContent = 'Anleitung';
    dom.installBtn.onclick = () => setStatus('iPhone: Safari → Teilen → „Zum Home‑Bildschirm“', 'is-error');
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

  dom.installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) { setStatus('Chrome-Menü (⋮) → „App installieren“', 'is-error'); return; }
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    dom.installBanner.hidden = true;
    dom.installBtn.disabled = true;
  });
})();

/* ---------------- SERVICE WORKER ---------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

resetState();
console.log('APP', APP_VERSION);
