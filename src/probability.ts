// Section 4: "The Math" — Probability sandbox
// Chart showing P(at least one encounter) vs. days, rising toward 1.0

export interface ProbState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  laneWidth: number;      // nm
  detectRange: number;    // nm (detection width)
  shipsPerDay: number;
  weatherMul: number;
  animT: number;
}

export function initProbability(): ProbState {
  const canvas = document.getElementById('prob-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;

  const state: ProbState = {
    canvas, ctx,
    laneWidth: 43,
    detectRange: 40,
    shipsPerDay: 2,
    weatherMul: 1.0,
    animT: 0,
  };

  // Controls
  const laneSlider = document.getElementById('prob-lane') as HTMLInputElement;
  const detectSlider = document.getElementById('prob-detect') as HTMLInputElement;
  const shipsSlider = document.getElementById('prob-ships') as HTMLInputElement;
  const weatherSel = document.getElementById('weather-prob') as HTMLSelectElement;
  const laneVal = document.getElementById('prob-lane-val')!;
  const detectVal = document.getElementById('prob-detect-val')!;
  const shipsVal = document.getElementById('prob-ships-val')!;

  laneSlider.addEventListener('input', () => {
    state.laneWidth = +laneSlider.value;
    laneVal.textContent = laneSlider.value + ' nm';
    state.animT = 0;
    updateProbStats(state);
  });
  detectSlider.addEventListener('input', () => {
    state.detectRange = +detectSlider.value;
    detectVal.textContent = detectSlider.value + ' nm';
    state.animT = 0;
    updateProbStats(state);
  });
  shipsSlider.addEventListener('input', () => {
    state.shipsPerDay = +shipsSlider.value;
    shipsVal.textContent = shipsSlider.value;
    state.animT = 0;
    updateProbStats(state);
  });
  weatherSel.addEventListener('change', () => {
    state.weatherMul = +weatherSel.value;
    state.animT = 0;
    updateProbStats(state);
  });

  resize(state);
  window.addEventListener('resize', () => resize(state));
  updateProbStats(state);

  return state;
}

function resize(s: ProbState) {
  const parent = s.canvas.parentElement!;
  const dpr = window.devicePixelRatio || 1;
  const w = parent.clientWidth;
  const h = Math.round(w * 0.45);
  s.canvas.width = w * dpr;
  s.canvas.height = h * dpr;
  s.canvas.style.width = w + 'px';
  s.canvas.style.height = h + 'px';
  s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ── Probability math ──

function pSinglePass(detectWidth: number, laneWidth: number): number {
  return Math.min(1, detectWidth / laneWidth);
}

function pDaily(detectWidth: number, laneWidth: number, shipsPerDay: number): number {
  const pSingle = pSinglePass(detectWidth, laneWidth);
  return 1 - Math.pow(1 - pSingle, shipsPerDay);
}

function pByDay(pDailyVal: number, days: number): number {
  return 1 - Math.pow(1 - pDailyVal, days);
}

function daysToProb(pDailyVal: number, targetProb: number): number {
  if (pDailyVal >= 1) return 1;
  if (pDailyVal <= 0) return Infinity;
  return Math.ceil(Math.log(1 - targetProb) / Math.log(1 - pDailyVal));
}

function updateProbStats(s: ProbState) {
  const effDetect = s.detectRange * s.weatherMul;
  const pSingle = pSinglePass(effDetect, s.laneWidth);
  const pDailyVal = pDaily(effDetect, s.laneWidth, s.shipsPerDay);
  const days50 = daysToProb(pDailyVal, 0.5);
  const days90 = daysToProb(pDailyVal, 0.9);
  const days99 = daysToProb(pDailyVal, 0.99);
  const expectedDays = pDailyVal > 0 ? 1 / pDailyVal : Infinity;

  const statsEl = document.getElementById('prob-stats')!;
  statsEl.innerHTML =
    stat('P(single pass)', (pSingle * 100).toFixed(1) + '%') +
    stat('P(daily)', (pDailyVal * 100).toFixed(1) + '%') +
    stat('50% by day', days50 === Infinity ? '∞' : days50.toString()) +
    stat('90% by day', days90 === Infinity ? '∞' : days90.toString()) +
    stat('99% by day', days99 === Infinity ? '∞' : days99.toString()) +
    stat('Expected days', expectedDays === Infinity ? '∞' : expectedDays.toFixed(1));

  // Update callout
  const callout = document.getElementById('prob-callout')!;
  if (s.laneWidth <= 50 && s.shipsPerDay >= 2 && s.weatherMul >= 0.7) {
    callout.textContent = `At the ${s.laneWidth} nm passage with ${s.shipsPerDay} ships per day, a pirate has a 99% chance of encountering a target within ${days99 === Infinity ? 'never' : days99 + (days99 === 1 ? ' day' : ' days')}. The ocean is big — but the lanes are narrow.`;
  } else if (pDailyVal < 0.05) {
    callout.textContent = `With only ${(pDailyVal * 100).toFixed(1)}% daily probability, you'd expect to wait ${expectedDays === Infinity ? 'forever' : Math.round(expectedDays) + (Math.round(expectedDays) === 1 ? ' day' : ' days')}. This is why open-ocean piracy was rare — the math doesn't work without chokepoints.`;
  } else {
    callout.textContent = `Daily encounter probability: ${(pDailyVal * 100).toFixed(1)}%. You reach 90% confidence by day ${days90 === Infinity ? '∞' : days90}. ${days90 <= 7 ? 'The geography makes piracy viable.' : 'Patience required, but the math is on your side.'}`;
  }
}

function stat(label: string, value: string): string {
  return `<span class="stat"><span class="stat-label">${label}:</span> <span class="stat-value">${value}</span></span>`;
}

export function drawProbability(s: ProbState, dt: number) {
  s.animT += dt;
  const { ctx, canvas } = s;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  // Background
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#080e1e');
  bg.addColorStop(0.5, '#0b1630');
  bg.addColorStop(1, '#070c1a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Chart area
  const margin = { top: 30, right: 24, bottom: 40, left: 50 };
  const cw = w - margin.left - margin.right;
  const ch = h - margin.top - margin.bottom;

  const effDetect = s.detectRange * s.weatherMul;
  const pDailyVal = pDaily(effDetect, s.laneWidth, s.shipsPerDay);

  // Determine x-axis range (days)
  const days99 = daysToProb(pDailyVal, 0.99);
  const maxDays = Math.min(Math.max(days99 * 1.3, 7), 120);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 0.5;

  // Horizontal grid (probability)
  for (let p = 0.1; p <= 1.0; p += 0.1) {
    const y = margin.top + ch * (1 - p);
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + cw, y);
    ctx.stroke();
  }

  // Vertical grid (days)
  const dayStep = maxDays <= 20 ? 2 : maxDays <= 50 ? 5 : 10;
  for (let d = dayStep; d <= maxDays; d += dayStep) {
    const x = margin.left + (d / maxDays) * cw;
    ctx.beginPath();
    ctx.moveTo(x, margin.top);
    ctx.lineTo(x, margin.top + ch);
    ctx.stroke();
  }

  // Axes
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + ch);
  ctx.lineTo(margin.left + cw, margin.top + ch);
  ctx.stroke();

  // Axis labels
  ctx.fillStyle = 'rgba(255,215,0,0.4)';
  ctx.font = '9px system-ui';
  ctx.textAlign = 'center';

  // X axis (days)
  for (let d = dayStep; d <= maxDays; d += dayStep) {
    const x = margin.left + (d / maxDays) * cw;
    ctx.fillText(d.toString(), x, margin.top + ch + 16);
  }
  ctx.fillText('Days', margin.left + cw / 2, margin.top + ch + 32);

  // Y axis (probability)
  ctx.textAlign = 'right';
  for (let p = 0.2; p <= 1.0; p += 0.2) {
    const y = margin.top + ch * (1 - p);
    ctx.fillText((p * 100).toFixed(0) + '%', margin.left - 6, y + 3);
  }

  ctx.save();
  ctx.translate(14, margin.top + ch / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('P(encounter)', 0, 0);
  ctx.restore();

  // ── Draw probability curve ──

  // Animate: curve draws progressively
  const animDays = Math.min(maxDays, s.animT * maxDays * 0.35);

  ctx.beginPath();
  let first = true;
  for (let d = 0; d <= animDays; d += 0.5) {
    const p = pByDay(pDailyVal, d);
    const x = margin.left + (d / maxDays) * cw;
    const y = margin.top + ch * (1 - p);
    if (first) { ctx.moveTo(x, y); first = false; }
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#ffd866';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Fill under curve
  if (animDays > 0) {
    const lastX = margin.left + (animDays / maxDays) * cw;
    const lastY = margin.top + ch * (1 - pByDay(pDailyVal, animDays));
    ctx.lineTo(lastX, margin.top + ch);
    ctx.lineTo(margin.left, margin.top + ch);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,216,102,0.06)';
    ctx.fill();
  }

  // ── Milestone markers ──

  const milestones = [
    { prob: 0.5, label: '50%', color: 'rgba(255,216,102,0.5)' },
    { prob: 0.9, label: '90%', color: 'rgba(255,150,50,0.5)' },
    { prob: 0.99, label: '99%', color: 'rgba(255,100,50,0.5)' },
  ];

  for (const ms of milestones) {
    const d = daysToProb(pDailyVal, ms.prob);
    if (d === Infinity || d > maxDays || d > animDays) continue;

    const x = margin.left + (d / maxDays) * cw;
    const y = margin.top + ch * (1 - ms.prob);

    // Dashed line from point to x-axis
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = ms.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, margin.top + ch);
    ctx.stroke();

    // Dashed line from point to y-axis
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(margin.left, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Point
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = ms.color;
    ctx.fill();

    // Label
    ctx.fillStyle = ms.color;
    ctx.font = 'bold 9px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(`${ms.label} @ day ${d}`, x, y - 10);
  }

  // ── Animated day indicator ──
  if (animDays >= 1 && animDays < maxDays * 0.95) {
    const curDay = Math.floor(animDays);
    const curP = pByDay(pDailyVal, curDay);
    const dotX = margin.left + (curDay / maxDays) * cw;
    const dotY = margin.top + ch * (1 - curP);

    // Glow
    ctx.beginPath();
    ctx.arc(dotX, dotY, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,216,102,0.15)';
    ctx.fill();

    // Dot
    ctx.beginPath();
    ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd866';
    ctx.fill();

    // Label
    ctx.fillStyle = 'rgba(255,216,102,0.8)';
    ctx.font = 'bold 10px system-ui';
    const label = `Day ${curDay} — ${(curP * 100).toFixed(0)}%`;
    const nearRight = dotX > margin.left + cw * 0.65;
    ctx.textAlign = nearRight ? 'right' : 'left';
    ctx.fillText(label, dotX + (nearRight ? -10 : 10), dotY - 10);
  }

  // Title
  ctx.fillStyle = 'rgba(255,215,0,0.3)';
  ctx.font = '600 10px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText('HOW QUICKLY CERTAINTY ARRIVES', margin.left, margin.top - 12);
}
