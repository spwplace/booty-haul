// Section 2: "The Ribbon" — Area coverage animation
// Top-down view of a shipping lane with detection circle sweep

export interface SweepState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  shipSpeed: number;      // knots
  laneWidth: number;      // nm
  weatherMul: number;
  // Animation state
  shipX: number;          // 0–1 fraction across lane
  sweptTrail: number[];   // x positions of trail samples
  merchants: SweepMerchant[];
  detected: number;
  total: number;
  time: number;
  nextSpawn: number;
}

interface SweepMerchant {
  x: number;  // 0–1 horizontal
  y: number;  // 0–1 vertical within lane
  detected: boolean;
  flashAge: number;
}

const BASE_DETECT_WIDTH_NM = 40; // ~20nm each side from crow's nest (clear weather)

function effectiveDetectWidth(weatherMul: number): number {
  return BASE_DETECT_WIDTH_NM * weatherMul;
}

export function initSweep(): SweepState {
  const canvas = document.getElementById('sweep-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;

  const state: SweepState = {
    canvas, ctx,
    shipSpeed: 5,
    laneWidth: 43,
    weatherMul: 1.0,
    shipX: 0,
    sweptTrail: [],
    merchants: [],
    detected: 0,
    total: 0,
    time: 0,
    nextSpawn: 0.5,
  };

  // Controls
  const speedSlider = document.getElementById('ship-speed') as HTMLInputElement;
  const laneSel = document.getElementById('lane-width') as HTMLSelectElement;
  const weatherSel = document.getElementById('weather-sweep') as HTMLSelectElement;
  const speedVal = document.getElementById('ship-speed-val')!;

  speedSlider.addEventListener('input', () => {
    state.shipSpeed = +speedSlider.value;
    speedVal.textContent = speedSlider.value + ' kn';
    updateSweepStats(state);
  });
  laneSel.addEventListener('change', () => {
    state.laneWidth = +laneSel.value;
    resetSweep(state);
    updateSweepStats(state);
  });
  weatherSel.addEventListener('change', () => {
    state.weatherMul = +weatherSel.value;
    updateSweepStats(state);
  });

  resize(state);
  window.addEventListener('resize', () => resize(state));
  updateSweepStats(state);

  return state;
}

function resize(s: SweepState) {
  const parent = s.canvas.parentElement!;
  const dpr = window.devicePixelRatio || 1;
  const w = parent.clientWidth;
  const h = Math.round(w * 0.35);
  s.canvas.width = w * dpr;
  s.canvas.height = h * dpr;
  s.canvas.style.width = w + 'px';
  s.canvas.style.height = h + 'px';
  s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function resetSweep(s: SweepState) {
  s.shipX = 0;
  s.sweptTrail = [];
  s.merchants = [];
  s.detected = 0;
  s.total = 0;
  s.time = 0;
}

function updateSweepStats(s: SweepState) {
  const detectW = effectiveDetectWidth(s.weatherMul);
  const dailyDistance = s.shipSpeed * 24; // nm/day
  const dailyArea = dailyDistance * detectW;
  const coverage = Math.min(100, (detectW / s.laneWidth) * 100);

  const statsEl = document.getElementById('sweep-stats')!;
  statsEl.innerHTML =
    stat('Detection width', detectW.toFixed(0) + ' nm') +
    stat('Daily distance', dailyDistance.toFixed(0) + ' nm') +
    stat('Daily sweep', dailyArea.toLocaleString() + ' sq nm') +
    stat('Lane coverage', coverage.toFixed(0) + '%');

  // Update callout
  const callout = document.getElementById('sweep-callout')!;
  if (s.laneWidth <= 43 && s.weatherMul >= 0.7) {
    callout.textContent = `The ${getLaneName(s.laneWidth)} is ${s.laneWidth} nautical miles wide. A pirate's lookout can see ${detectW.toFixed(0)} miles across. ${coverage >= 90 ? 'One ship nearly covers the entire strait.' : `That's ${coverage.toFixed(0)}% coverage from a single vessel.`}`;
  } else if (s.laneWidth >= 200) {
    callout.textContent = `In open ocean (${s.laneWidth} nm wide), detection width covers only ${coverage.toFixed(1)}% of the lane. This is why pirates didn't search open water — they lurked in narrow passages.`;
  } else {
    callout.textContent = `${detectW.toFixed(0)} nm detection across a ${s.laneWidth} nm lane = ${coverage.toFixed(0)}% coverage. ${coverage >= 70 ? 'Excellent odds.' : coverage >= 40 ? 'Decent odds with patience.' : 'The wider the lane, the harder the hunt.'}`;
  }
}

function getLaneName(width: number): string {
  if (width <= 30) return 'Strait of Malacca';
  if (width <= 43) return 'Windward Passage';
  return 'lane';
}

function stat(label: string, value: string): string {
  return `<span class="stat"><span class="stat-label">${label}:</span> <span class="stat-value">${value}</span></span>`;
}

export function drawSweep(s: SweepState, dt: number) {
  s.time += dt;
  const { ctx, canvas } = s;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  const detectW = effectiveDetectWidth(s.weatherMul);
  const detectFrac = Math.min(1, detectW / s.laneWidth); // fraction of lane width covered

  // Ship moves across the lane
  // Map: full width of canvas = some journey time
  // Speed: fraction per second (complete traversal in ~10s at 5 knots)
  const speedFrac = (s.shipSpeed / 5) * 0.08;
  s.shipX += speedFrac * dt;

  // Reset when ship crosses
  if (s.shipX > 1.15) {
    s.shipX = -0.05;
    s.sweptTrail = [];
    s.merchants = [];
    s.detected = 0;
    s.total = 0;
  }

  // Trail
  if (s.sweptTrail.length === 0 || s.shipX - s.sweptTrail[s.sweptTrail.length - 1] > 0.005) {
    s.sweptTrail.push(s.shipX);
  }

  // Spawn merchants
  s.nextSpawn -= dt;
  if (s.nextSpawn <= 0 && s.shipX < 1.0) {
    s.nextSpawn = 1.0 + Math.random() * 2.0;
    const mx = Math.random();
    const my = Math.random();
    s.merchants.push({ x: mx, y: my, detected: false, flashAge: 0 });
    s.total++;
  }

  // Detect merchants
  const shipY = 0.5; // ship travels through middle of lane
  for (const m of s.merchants) {
    if (!m.detected) {
      const dx = m.x - s.shipX;
      const dy = (m.y - shipY) * (s.laneWidth / detectW); // scale y by lane/detect ratio
      if (Math.hypot(dx * (s.laneWidth / detectW), dy) < 0.5) {
        m.detected = true;
        m.flashAge = 0;
        s.detected++;
      }
    }
    if (m.detected) m.flashAge += dt;
  }

  // ── Draw ──

  // Background
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#070c1a');
  bg.addColorStop(0.5, '#0b1630');
  bg.addColorStop(1, '#070c1a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Lane boundaries
  const laneTop = h * 0.08;
  const laneBot = h * 0.92;
  const laneH = laneBot - laneTop;

  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = 'rgba(255,215,0,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, laneTop);
  ctx.lineTo(w, laneTop);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, laneBot);
  ctx.lineTo(w, laneBot);
  ctx.stroke();
  ctx.setLineDash([]);

  // Lane width label (right side)
  ctx.fillStyle = 'rgba(255,215,0,0.25)';
  ctx.font = '9px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText(`${s.laneWidth} nm`, w - 8, laneTop - 4);

  // Width bracket on right
  ctx.beginPath();
  ctx.moveTo(w - 4, laneTop + 2);
  ctx.lineTo(w - 4, laneBot - 2);
  ctx.strokeStyle = 'rgba(255,215,0,0.15)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Swept ribbon (translucent fill behind ship)
  if (s.sweptTrail.length > 1) {
    const ribbonHalfH = (detectFrac * laneH) / 2;
    const centerY = laneTop + laneH / 2;

    ctx.fillStyle = 'rgba(255,216,102,0.06)';
    ctx.beginPath();
    const startX = Math.max(0, s.sweptTrail[0] * w);
    const endX = Math.min(w, s.shipX * w);
    ctx.rect(startX, centerY - ribbonHalfH, endX - startX, ribbonHalfH * 2);
    ctx.fill();

    // Ribbon border
    ctx.strokeStyle = 'rgba(255,216,102,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(startX, centerY - ribbonHalfH);
    ctx.lineTo(endX, centerY - ribbonHalfH);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(startX, centerY + ribbonHalfH);
    ctx.lineTo(endX, centerY + ribbonHalfH);
    ctx.stroke();

    // Detection width bracket (left side, if visible)
    if (s.shipX > 0.05) {
      const bracketX = 12;
      ctx.beginPath();
      ctx.moveTo(bracketX, centerY - ribbonHalfH);
      ctx.lineTo(bracketX, centerY + ribbonHalfH);
      ctx.strokeStyle = 'rgba(255,216,102,0.3)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Ticks
      ctx.beginPath();
      ctx.moveTo(bracketX - 3, centerY - ribbonHalfH);
      ctx.lineTo(bracketX + 3, centerY - ribbonHalfH);
      ctx.moveTo(bracketX - 3, centerY + ribbonHalfH);
      ctx.lineTo(bracketX + 3, centerY + ribbonHalfH);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,216,102,0.45)';
      ctx.font = '8px system-ui';
      ctx.textAlign = 'center';
      ctx.save();
      ctx.translate(bracketX - 8, centerY);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`${detectW.toFixed(0)} nm detect`, 0, 0);
      ctx.restore();
    }
  }

  // Merchants
  for (const m of s.merchants) {
    const mx = m.x * w;
    const my = laneTop + m.y * laneH;

    if (m.detected) {
      // Flash effect
      const flash = Math.max(0, 1 - m.flashAge * 2);
      if (flash > 0) {
        ctx.beginPath();
        ctx.arc(mx, my, 8 + flash * 12, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,216,102,${flash * 0.3})`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(mx, my, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd866';
      ctx.fill();
    } else {
      // Undetected merchant
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = 'rgba(230,230,255,0.5)';
      ctx.fillRect(-2.5, -2.5, 5, 5);
      ctx.restore();
    }
  }

  // Pirate ship
  const shipPx = s.shipX * w;
  const shipPy = laneTop + laneH / 2;

  // Detection circle around ship
  const detectRadiusPx = (detectFrac * laneH) / 2;
  ctx.beginPath();
  ctx.arc(shipPx, shipPy, detectRadiusPx, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,216,102,0.05)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,216,102,0.2)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Ship icon
  ctx.beginPath();
  const ss = 6;
  ctx.moveTo(shipPx + ss, shipPy);
  ctx.lineTo(shipPx - ss * 0.5, shipPy - ss * 0.7);
  ctx.lineTo(shipPx - ss * 0.5, shipPy + ss * 0.7);
  ctx.closePath();
  ctx.fillStyle = '#ffd866';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Ship label
  ctx.fillStyle = '#ffd866';
  ctx.font = 'bold 8px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('PIRATE', shipPx, shipPy - detectRadiusPx - 6);

  // Detection counter
  if (s.total > 0) {
    ctx.fillStyle = 'rgba(255,216,102,0.6)';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(`Detected: ${s.detected}/${s.total}`, 10, h - 8);
  }

  // Weather overlay
  if (s.weatherMul < 0.7) {
    const fogAlpha = (1 - s.weatherMul) * 0.25;
    ctx.fillStyle = `rgba(80,90,110,${fogAlpha})`;
    ctx.fillRect(0, 0, w, h);
  }
}
