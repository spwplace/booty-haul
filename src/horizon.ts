// Section 1: "How Far Can You See?" — Perception physics canvas
// Side-view diagram with exaggerated Earth curvature showing line-of-sight detection

export interface HorizonState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  obsHeight: number;     // feet
  tgtHeight: number;     // feet
  weatherMul: number;    // 0–1
  running: boolean;
  animT: number;
}

// Detection distance formula: d = 1.17 × (√h_obs + √h_target) nautical miles
function detectionNm(hObs: number, hTgt: number): number {
  return 1.17 * (Math.sqrt(hObs) + Math.sqrt(hTgt));
}

function horizonNm(h: number): number {
  return 1.17 * Math.sqrt(h);
}

function surveilledArea(rangeNm: number): number {
  return Math.PI * rangeNm * rangeNm;
}

export function initHorizon(): HorizonState {
  const canvas = document.getElementById('horizon-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;

  const state: HorizonState = {
    canvas, ctx,
    obsHeight: 100,
    tgtHeight: 80,
    weatherMul: 1.0,
    running: false,
    animT: 0,
  };

  // Controls
  const obsSlider = document.getElementById('obs-height') as HTMLInputElement;
  const tgtSlider = document.getElementById('tgt-height') as HTMLInputElement;
  const weatherSel = document.getElementById('weather-horizon') as HTMLSelectElement;
  const obsVal = document.getElementById('obs-height-val')!;
  const tgtVal = document.getElementById('tgt-height-val')!;

  obsSlider.addEventListener('input', () => {
    state.obsHeight = +obsSlider.value;
    obsVal.textContent = obsSlider.value + ' ft';
    updateStats(state);
  });
  tgtSlider.addEventListener('input', () => {
    state.tgtHeight = +tgtSlider.value;
    tgtVal.textContent = tgtSlider.value + ' ft';
    updateStats(state);
  });
  weatherSel.addEventListener('change', () => {
    state.weatherMul = +weatherSel.value;
    updateStats(state);
  });

  resize(state);
  window.addEventListener('resize', () => resize(state));
  updateStats(state);

  return state;
}

function resize(s: HorizonState) {
  const parent = s.canvas.parentElement!;
  const dpr = window.devicePixelRatio || 1;
  const w = parent.clientWidth;
  const h = Math.round(w * 0.42);
  s.canvas.width = w * dpr;
  s.canvas.height = h * dpr;
  s.canvas.style.width = w + 'px';
  s.canvas.style.height = h + 'px';
  s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function updateStats(s: HorizonState) {
  const rawDist = detectionNm(s.obsHeight, s.tgtHeight);
  const effDist = rawDist * s.weatherMul;
  const obsHorizon = horizonNm(s.obsHeight) * s.weatherMul;
  const area = surveilledArea(effDist);

  const statsEl = document.getElementById('horizon-stats')!;
  statsEl.innerHTML =
    stat('Observer horizon', obsHorizon.toFixed(1) + ' nm') +
    stat('Detection range', effDist.toFixed(1) + ' nm') +
    stat('Surveilled area', Math.round(area).toLocaleString() + ' sq nm');

  // Update callout dynamically
  const callout = document.getElementById('horizon-callout')!;
  if (s.obsHeight >= 80 && s.weatherMul >= 0.7) {
    callout.textContent = `From ${s.obsHeight} ft up, you're watching ${Math.round(area).toLocaleString()} square nautical miles of ocean. That's ${area > 1500 ? 'larger than Rhode Island' : area > 500 ? 'a vast expanse' : 'still a significant area'}.`;
  } else if (s.weatherMul < 0.4) {
    callout.textContent = `In poor weather, effective range drops to ${effDist.toFixed(1)} nm — just ${Math.round(area).toLocaleString()} sq nm. Weather is the great equalizer.`;
  } else {
    callout.textContent = `From ${s.obsHeight} ft up with ${effDist.toFixed(1)} nm range, you survey ${Math.round(area).toLocaleString()} sq nm — ${area > 1000 ? 'an enormous area' : 'a respectable patch'} of ocean.`;
  }
}

function stat(label: string, value: string): string {
  return `<span class="stat"><span class="stat-label">${label}:</span> <span class="stat-value">${value}</span></span>`;
}

export function drawHorizon(s: HorizonState, dt: number) {
  s.animT += dt;
  const { ctx, canvas } = s;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  // Background — ocean/sky gradient
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0a1628');
  bg.addColorStop(0.45, '#0e1e3a');
  bg.addColorStop(0.55, '#0b1630');
  bg.addColorStop(1, '#070c1a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Parameters
  const rawDist = detectionNm(s.obsHeight, s.tgtHeight);
  const effDist = rawDist * s.weatherMul;
  const obsHorizon = horizonNm(s.obsHeight);

  // Exaggerated Earth curvature — draw an arc at the bottom
  const earthR = w * 2.5; // exaggerated curvature radius
  const earthCY = h * 0.62 + earthR; // center of earth circle
  const earthCX = w * 0.5;

  // Water surface (arc)
  ctx.beginPath();
  const arcAngle = Math.asin((w * 0.6) / earthR);
  ctx.arc(earthCX, earthCY, earthR, Math.PI + Math.PI / 2 - arcAngle, Math.PI + Math.PI / 2 + arcAngle);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  const waterGrad = ctx.createLinearGradient(0, h * 0.55, 0, h);
  waterGrad.addColorStop(0, '#0b1a35');
  waterGrad.addColorStop(1, '#060e20');
  ctx.fillStyle = waterGrad;
  ctx.fill();

  // Water surface line
  ctx.beginPath();
  ctx.arc(earthCX, earthCY, earthR, Math.PI + Math.PI / 2 - arcAngle, Math.PI + Math.PI / 2 + arcAngle);
  ctx.strokeStyle = 'rgba(100,140,200,0.15)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Observer ship (left side)
  const obsX = w * 0.15;
  const waterYAtObs = earthCY - Math.sqrt(earthR * earthR - (obsX - earthCX) * (obsX - earthCX));
  const obsFootY = waterYAtObs;

  // Observer height scale: map feet to pixels (exaggerated for visibility)
  const heightScale = h * 0.003; // pixels per foot
  const obsTopY = obsFootY - s.obsHeight * heightScale;

  // Draw observer ship hull
  drawShipHull(ctx, obsX, obsFootY, 30);

  // Draw mast
  ctx.beginPath();
  ctx.moveTo(obsX, obsFootY - 8);
  ctx.lineTo(obsX, obsTopY);
  ctx.strokeStyle = '#8a7a5a';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Crow's nest / observation point
  ctx.beginPath();
  ctx.arc(obsX, obsTopY, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd866';
  ctx.fill();
  ctx.strokeStyle = '#aa9050';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Observer label
  ctx.fillStyle = '#ffd866';
  ctx.font = 'bold 9px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(`${s.obsHeight} ft`, obsX, obsTopY - 10);

  // Target ship (right side, at detection distance)
  // Map detection distance to canvas: max detection ~30nm maps across canvas
  const maxDisplayNm = 35;
  const distFrac = Math.min(effDist / maxDisplayNm, 0.85);
  const tgtX = obsX + distFrac * (w * 0.75);
  const waterYAtTgt = earthCY - Math.sqrt(Math.max(0, earthR * earthR - (tgtX - earthCX) * (tgtX - earthCX)));
  const tgtFootY = waterYAtTgt;
  const tgtTopY = tgtFootY - s.tgtHeight * heightScale;

  // Draw target ship
  drawShipHull(ctx, tgtX, tgtFootY, 24);

  // Target mast
  ctx.beginPath();
  ctx.moveTo(tgtX, tgtFootY - 6);
  ctx.lineTo(tgtX, tgtTopY);
  ctx.strokeStyle = '#6a7a8a';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Target top
  ctx.beginPath();
  ctx.arc(tgtX, tgtTopY, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(230,230,255,0.6)';
  ctx.fill();

  ctx.fillStyle = 'rgba(230,230,255,0.5)';
  ctx.font = '9px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(`${s.tgtHeight} ft`, tgtX, tgtTopY - 8);

  // Line of sight — from observer top to target top
  ctx.beginPath();
  ctx.moveTo(obsX, obsTopY);
  ctx.lineTo(tgtX, tgtTopY);
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = s.weatherMul >= 0.7 ? 'rgba(255,216,102,0.5)' : 'rgba(255,216,102,0.25)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  // Horizon tangent point (where LOS grazes Earth)
  const horizonFrac = Math.min(obsHorizon / maxDisplayNm, 0.85);
  const horizonX = obsX + horizonFrac * (w * 0.75);
  const waterYAtHz = earthCY - Math.sqrt(Math.max(0, earthR * earthR - (horizonX - earthCX) * (horizonX - earthCX)));

  // Horizon marker
  ctx.beginPath();
  ctx.arc(horizonX, waterYAtHz, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,216,102,0.3)';
  ctx.fill();

  // Distance label
  const midX = (obsX + tgtX) / 2;
  const midY = Math.min(obsTopY, tgtTopY) - 20;
  ctx.fillStyle = '#ffd866';
  ctx.font = 'bold 11px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(`${effDist.toFixed(1)} nm`, midX, midY);

  // Distance bracket
  ctx.beginPath();
  ctx.moveTo(obsX, midY + 5);
  ctx.lineTo(obsX, midY + 10);
  ctx.lineTo(tgtX, midY + 10);
  ctx.lineTo(tgtX, midY + 5);
  ctx.strokeStyle = 'rgba(255,216,102,0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Inset: top-down detection circle (top right corner)
  const insetR = Math.min(w, h) * 0.15;
  const insetCX = w - insetR - 16;
  const insetCY = insetR + 16;

  // Inset background
  ctx.beginPath();
  ctx.arc(insetCX, insetCY, insetR + 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(6,10,18,0.8)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,216,102,0.15)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Detection circle
  ctx.beginPath();
  ctx.arc(insetCX, insetCY, insetR * 0.8, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,216,102,0.06)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,216,102,0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Ship dot in center
  ctx.beginPath();
  ctx.arc(insetCX, insetCY, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd866';
  ctx.fill();

  // Inset label
  ctx.fillStyle = 'rgba(255,216,102,0.5)';
  ctx.font = '8px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('DETECTION', insetCX, insetCY + insetR + 14);
  ctx.fillText('CIRCLE', insetCX, insetCY + insetR + 24);

  // Weather overlay
  if (s.weatherMul < 0.7) {
    const fogAlpha = (1 - s.weatherMul) * 0.3;
    ctx.fillStyle = `rgba(80,90,110,${fogAlpha})`;
    ctx.fillRect(0, 0, w, h);

    if (s.weatherMul <= 0.08) {
      // Storm effect — rain lines
      ctx.strokeStyle = 'rgba(150,170,200,0.08)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 30; i++) {
        const rx = ((i * 37 + s.animT * 80) % w);
        const ry = ((i * 53 + s.animT * 120) % h);
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx - 4, ry + 12);
        ctx.stroke();
      }
    }
  }

  // Labels
  ctx.fillStyle = 'rgba(100,140,200,0.25)';
  ctx.font = '9px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText('SKY', 10, 20);
  ctx.fillText('SEA', 10, obsFootY + 20);
}

function drawShipHull(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const hw = size / 2;
  ctx.beginPath();
  ctx.moveTo(x - hw, y - 5);
  ctx.lineTo(x - hw * 0.7, y + 3);
  ctx.quadraticCurveTo(x, y + 6, x + hw * 0.7, y + 3);
  ctx.lineTo(x + hw, y - 5);
  ctx.closePath();
  ctx.fillStyle = '#2a2418';
  ctx.fill();
  ctx.strokeStyle = '#4a3a28';
  ctx.lineWidth = 1;
  ctx.stroke();
}
