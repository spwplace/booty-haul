// ── Arms Race — Section 5 ──────────────────────────────────
//
// Self-contained module: simulation engine, map renderer,
// cost-curve chart, population-dynamics chart.

import {
  Vec2, PORTS, ROUTES, STRAIT, LANDMASSES, ISLANDS,
  bezier, routePos, isOnLand,
} from './sim';

// ── Types ──────────────────────────────────────────────────

type MerchantDefense = 'convoy' | 'armed' | 'scatter' | 'avoidance' | 'naval' | 'storm';

interface ARMerchant {
  id: number;
  route: number;
  t: number;
  speed: number;
  isConvoy: boolean;
  convoySize: number;
  escortStrength: number;
  armament: number;
  routeOffset: Vec2;
  isEvasive: boolean;
  evasiveRoute: number;
  isStormTimer: boolean;
}

interface ARPirate {
  pos: Vec2;
  target: Vec2;
  trail: Vec2[];
  trailTimer: number;
  adaptedStrategy: string;
  fleeTimer: number;
  avoidsConvoys: boolean;
}

interface NavyShip {
  pos: Vec2;
  patrolCenter: Vec2;
  patrolRadius: number;
  angle: number;
}

interface RunningStats {
  captures: number;
  attempts: number;
  repelled: number;
  totalMerchants: number;
}

interface DefenseConfig {
  active: Set<MerchantDefense>;
  convoySize: number;
  armament: number;
  scatterRadius: number;
  avoidFraction: number;
  patrolShips: number;
}

interface GlobalConfig {
  shipsPerDay: number;
  cargoValue: number;
  pirateStrength: number;
}

interface ARSimState {
  merchants: ARMerchant[];
  pirate: ARPirate;
  navyShips: NavyShip[];
  time: number;
  weatherCycle: number;
  stormActive: boolean;
  stats: RunningStats;
  nextId: number;
  spawnAcc: number;
  convoyQueue: Map<number, ARMerchant[]>;
}

// ── Evasive routes (bypass Windward Passage) ─────────────

interface EvasiveRoute {
  from: Vec2;
  cp: Vec2;
  to: Vec2;
}

// South of Jamaica, north via Bahamas, wide Caribbean
const EVASIVE_ROUTES: EvasiveRoute[] = [
  { from: PORTS[7].pos, cp: { x: 0.45, y: 0.62 }, to: PORTS[1].pos },  // south of Jamaica
  { from: PORTS[7].pos, cp: { x: 0.35, y: 0.15 }, to: PORTS[1].pos },  // north via Bahamas
  { from: PORTS[5].pos, cp: { x: 0.45, y: 0.65 }, to: PORTS[1].pos },  // wide Caribbean
];

// ── Constants ────────────────────────────────────────────

const AR_MERCHANT_SPEED = 0.025;
const AR_PIRATE_SPEED = 0.035;
const AR_DETECT_R = 0.018;
const TRAIL_INTERVAL = 0.08;
const TRAIL_MAX = 120;
const STORM_CYCLE = 30;   // seconds per full weather cycle
const STORM_DURATION = 8; // seconds of storm
const ADAPT_INTERVAL = 5; // seconds between pirate adaptation checks

// ── Math helpers ─────────────────────────────────────────

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function randomWater(): Vec2 {
  for (let i = 0; i < 50; i++) {
    const p = { x: 0.05 + Math.random() * 0.90, y: 0.05 + Math.random() * 0.85 };
    if (!isOnLand(p)) return p;
  }
  return { x: 0.5, y: 0.5 };
}

function hex2(a: number): string {
  return Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0');
}

// ── Physical Model ───────────────────────────────────────
// Every number traces back to Section 4's encounter chain:
//   pSingle = min(1, detectWidth / laneWidth)

interface PhysicalParams {
  detectWidth: number;      // nm — base 40, storm → ×0.08
  laneWidth: number;        // nm — base 43, scatter widens it
  targetsPerDay: number;    // base = shipsPerDay, convoy/avoidance reduce it
  pCapture: number;         // 1.0 base, armed/convoy escort reduce it
  operationalFrac: number;  // 1.0 base, naval patrols reduce it
}

function computePhysicalParams(
  cfg: DefenseConfig,
  g: GlobalConfig,
): PhysicalParams {
  // Detection width = 2 × range; d = 1.17 × (√h_obs + √h_tgt) at h=100ft, h_tgt=80ft
  let detectWidth = 2 * 1.17 * (Math.sqrt(100) + Math.sqrt(80));
  let laneWidth = 43;
  let targetsPerDay = g.shipsPerDay;
  let pCapture = 1.0;
  let operationalFrac = 1.0;

  if (cfg.active.has('storm')) {
    // Storm timing: merchants sail during storms (~27% of weather cycle).
    // Weighted detection: 27% at storm visibility + 73% clear (for those who leak through)
    const stormFrac = STORM_DURATION / STORM_CYCLE; // ~0.27
    const leakFrac = 0.15; // ~15% of merchants sail in clear weather anyway (sim behavior)
    detectWidth *= stormFrac * 0.08 + (1 - stormFrac) * leakFrac;
  }

  if (cfg.active.has('scatter'))
    laneWidth += 2 * cfg.scatterRadius;

  if (cfg.active.has('convoy'))  {
    targetsPerDay /= cfg.convoySize;
    pCapture *= g.pirateStrength / (g.pirateStrength + 1 + cfg.convoySize * 0.5);
  }

  if (cfg.active.has('armed'))
    pCapture *= g.pirateStrength / (g.pirateStrength + cfg.armament);

  if (cfg.active.has('avoidance'))
    targetsPerDay *= (1 - cfg.avoidFraction / 100);

  if (cfg.active.has('naval'))
    operationalFrac = Math.max(0.05, 1 - cfg.patrolShips * 0.15);

  return { detectWidth, laneWidth, targetsPerDay, pCapture, operationalFrac };
}

/** Expected piracy loss in k doubloons/day — E[captures] × cargoValue */
function expectedDailyPiracyLoss(p: PhysicalParams, cargoValue: number): number {
  const pSingle = Math.min(1, p.detectWidth / p.laneWidth);
  const expectedCaptures = p.targetsPerDay * pSingle * p.pCapture * p.operationalFrac;
  return expectedCaptures * cargoValue;
}

/** Defense cost in k doubloons/day — concrete economic penalties */
function dailyDefenseCost(cfg: DefenseConfig, g: GlobalConfig): number {
  let cost = 0;

  if (cfg.active.has('convoy')) {
    const avgWaitDays = (cfg.convoySize - 1) / (2 * g.shipsPerDay);
    cost += avgWaitDays * g.cargoValue * 0.02 * g.shipsPerDay;
    // Escort cost: per convoy formed per day, not per ship
    cost += (g.shipsPerDay / cfg.convoySize) * 3;
  }

  if (cfg.active.has('armed'))
    cost += cfg.armament * 0.03 * g.cargoValue * g.shipsPerDay;

  if (cfg.active.has('scatter'))
    // Extra transit time: scatterRadius nm at 120nm/day speed, 2% daily holding cost
    cost += (cfg.scatterRadius / 120) * 0.02 * g.cargoValue * g.shipsPerDay;

  if (cfg.active.has('avoidance'))
    cost += (cfg.avoidFraction / 100) * 1.5 * g.cargoValue * 0.02 * g.shipsPerDay;

  if (cfg.active.has('naval'))
    cost += cfg.patrolShips * 5;

  if (cfg.active.has('storm')) {
    // Ship losses to weather + waiting cost for storm windows
    const stormFrac = STORM_DURATION / STORM_CYCLE;
    const waitDays = (1 - stormFrac) / stormFrac * 0.5; // avg wait for next storm window
    cost += 0.05 * g.cargoValue * g.shipsPerDay; // 5% ship loss to weather
    cost += waitDays * 0.02 * g.cargoValue * g.shipsPerDay; // waiting cost
  }

  return cost;
}

/** Lerp all active defense params from min→max at proportion α */
function scaledDefenseConfig(cfg: DefenseConfig, alpha: number): DefenseConfig {
  return {
    active: cfg.active,
    convoySize:     cfg.active.has('convoy')    ? lerp(2, 6, alpha) : cfg.convoySize,
    armament:       cfg.active.has('armed')     ? lerp(1, 5, alpha) : cfg.armament,
    scatterRadius:  cfg.active.has('scatter')   ? lerp(0, 50, alpha) : cfg.scatterRadius,
    avoidFraction:  cfg.active.has('avoidance') ? lerp(0, 100, alpha) : cfg.avoidFraction,
    patrolShips:    cfg.active.has('naval')     ? lerp(0, 5, alpha) : cfg.patrolShips,
  };
}

interface Equilibrium {
  optAlpha: number;
  minCost: number;
  piracyAtOpt: number;
  defCostAtOpt: number;
  currentAlpha: number; // where user's sliders fall on the 0–1 curve
}

function computeEquilibrium(cfg: DefenseConfig, g: GlobalConfig): Equilibrium {
  const nSteps = 200;
  let minCost = Infinity;
  let optAlpha = 0;
  let piracyAtOpt = 0;
  let defCostAtOpt = 0;

  for (let i = 0; i <= nSteps; i++) {
    const alpha = i / nSteps;
    const scaled = scaledDefenseConfig(cfg, alpha);
    const pp = computePhysicalParams(scaled, g);
    const piracyLoss = expectedDailyPiracyLoss(pp, g.cargoValue);
    const defCost = dailyDefenseCost(scaled, g);
    const total = piracyLoss + defCost;
    if (total < minCost) {
      minCost = total;
      optAlpha = alpha;
      piracyAtOpt = piracyLoss;
      defCostAtOpt = defCost;
    }
  }

  // Compute where the user's actual slider values fall on the 0–1 curve
  const currentAlpha = computeCurrentAlpha(cfg);

  return { optAlpha, minCost, piracyAtOpt, defCostAtOpt, currentAlpha };
}

/** Map user's current slider values to their approximate α position */
function computeCurrentAlpha(cfg: DefenseConfig): number {
  const alphas: number[] = [];
  if (cfg.active.has('convoy'))    alphas.push((cfg.convoySize - 2) / 4);
  if (cfg.active.has('armed'))     alphas.push((cfg.armament - 1) / 4);
  if (cfg.active.has('scatter'))   alphas.push(cfg.scatterRadius / 50);
  if (cfg.active.has('avoidance')) alphas.push(cfg.avoidFraction / 100);
  if (cfg.active.has('naval'))     alphas.push(cfg.patrolShips / 5);
  if (alphas.length === 0) return 0;
  return alphas.reduce((a, b) => a + b, 0) / alphas.length;
}

// ── Population Dynamics (replicator) ─────────────────────

interface PopDynamicsState {
  f: number;       // fraction of merchants defending
  history: number[];
  time: number;
}

function initPopDynamics(): PopDynamicsState {
  return { f: 0.1, history: [0.1], time: 0 };
}

function tickPopDynamics(
  pop: PopDynamicsState,
  dt: number,
  cfg: DefenseConfig,
  g: GlobalConfig,
): void {
  // pop.f = fraction of merchants who adopt defense
  // When no defenses are active, nothing to adopt — hold steady
  if (cfg.active.size === 0) {
    pop.time += dt;
    if (pop.history.length < 240 && pop.time > pop.history.length * 0.5)
      pop.history.push(pop.f);
    return;
  }

  const ppDefended = computePhysicalParams(cfg, g);
  const piracyLossDefended = expectedDailyPiracyLoss(ppDefended, g.cargoValue) / g.shipsPerDay;
  const defCostPerShip = dailyDefenseCost(cfg, g) / g.shipsPerDay;

  // Undefended: no defense, but pirate concentrates on the (1-f) undefended fraction
  const noDefCfg: DefenseConfig = { active: new Set(), convoySize: 2, armament: 0, scatterRadius: 0, avoidFraction: 0, patrolShips: 0 };
  const ppUndefended = computePhysicalParams(noDefCfg, g);
  const piracyLossUndefended = expectedDailyPiracyLoss(ppUndefended, g.cargoValue) / g.shipsPerDay;

  // Concentration effect: pirates target undefended ships disproportionately
  const eps = 0.01;
  const concentrationFactor = 1 / (1 - pop.f + eps);

  // Normalize payoffs to [0,1] range to keep replicator dynamics stable
  const normFactor = g.cargoValue || 1;
  const payoffDefended = -(piracyLossDefended + defCostPerShip) / normFactor;
  const payoffUndefended = -(piracyLossUndefended * concentrationFactor) / normFactor;

  const speed = 2.0;
  const df = pop.f * (1 - pop.f) * (payoffDefended - payoffUndefended) * speed * dt;
  pop.f = clamp(pop.f + df, 0.01, 0.99);
  pop.time += dt;

  // Record at ~0.5s intervals
  if (pop.history.length < 240 && pop.time > pop.history.length * 0.5) {
    pop.history.push(pop.f);
  }
}

/** Compute the stable interior equilibrium f* where payoffDefended = payoffUndefended */
function computePopEquilibrium(cfg: DefenseConfig, g: GlobalConfig): number {
  if (cfg.active.size === 0) return 0;

  const ppDefended = computePhysicalParams(cfg, g);
  const piracyLossDefended = expectedDailyPiracyLoss(ppDefended, g.cargoValue) / g.shipsPerDay;
  const defCostPerShip = dailyDefenseCost(cfg, g) / g.shipsPerDay;

  const noDefCfg: DefenseConfig = { active: new Set(), convoySize: 2, armament: 0, scatterRadius: 0, avoidFraction: 0, patrolShips: 0 };
  const ppUndefended = computePhysicalParams(noDefCfg, g);
  const piracyLossUndefended = expectedDailyPiracyLoss(ppUndefended, g.cargoValue) / g.shipsPerDay;

  // At equilibrium: piracyLossDefended + defCostPerShip = piracyLossUndefended * concentrationFactor
  // concentrationFactor = 1 / (1 - f* + eps)
  // Solve for f*: 1 - f* + eps = piracyLossUndefended / (piracyLossDefended + defCostPerShip)
  const defendedTotal = piracyLossDefended + defCostPerShip;
  if (defendedTotal <= 0) return 0.99;
  const ratio = piracyLossUndefended / defendedTotal;
  const eps = 0.01;
  const fStar = 1 + eps - ratio;
  return clamp(fStar, 0, 1);
}

// ── Simulation Engine ────────────────────────────────────

function createARSim(): ARSimState {
  const pos = randomWater();
  return {
    merchants: [],
    pirate: {
      pos, target: pos,
      trail: [], trailTimer: 0,
      adaptedStrategy: 'Random hunting',
      fleeTimer: 0, avoidsConvoys: false,
    },
    navyShips: [],
    time: 0,
    weatherCycle: 0,
    stormActive: false,
    stats: {
      captures: 0, attempts: 0, repelled: 0,
      totalMerchants: 0,
    },
    nextId: 0,
    spawnAcc: 0,
    convoyQueue: new Map(),
  };
}

function ensureNavyShips(sim: ARSimState, count: number): void {
  while (sim.navyShips.length < count) {
    const angle = Math.random() * Math.PI * 2;
    sim.navyShips.push({
      pos: { x: STRAIT.x + Math.cos(angle) * 0.04, y: STRAIT.y + Math.sin(angle) * 0.04 },
      patrolCenter: { x: STRAIT.x, y: STRAIT.y },
      patrolRadius: 0.06,
      angle,
    });
  }
  while (sim.navyShips.length > count) sim.navyShips.pop();
}

function spawnMerchant(
  sim: ARSimState,
  cfg: DefenseConfig,
): ARMerchant {
  const routeIdx = Math.floor(Math.random() * ROUTES.length);
  const isEvasive = cfg.active.has('avoidance') && Math.random() * 100 < cfg.avoidFraction;
  const scatterR = cfg.active.has('scatter') ? (cfg.scatterRadius / 50) * 0.04 : 0;
  const offsetAngle = Math.random() * Math.PI * 2;

  const m: ARMerchant = {
    id: sim.nextId++,
    route: routeIdx,
    t: 0,
    speed: AR_MERCHANT_SPEED * (0.8 + Math.random() * 0.4),
    isConvoy: false,
    convoySize: 1,
    escortStrength: 0,
    armament: cfg.active.has('armed') ? cfg.armament : 0,
    routeOffset: { x: Math.cos(offsetAngle) * scatterR, y: Math.sin(offsetAngle) * scatterR },
    isEvasive,
    evasiveRoute: isEvasive ? Math.floor(Math.random() * EVASIVE_ROUTES.length) : -1,
    isStormTimer: cfg.active.has('storm'),
  };

  return m;
}

function merchantPos(m: ARMerchant): Vec2 {
  if (m.isEvasive && m.evasiveRoute >= 0) {
    const er = EVASIVE_ROUTES[m.evasiveRoute];
    const pos = bezier(er.from, er.cp, er.to, m.t);
    return { x: pos.x + m.routeOffset.x, y: pos.y + m.routeOffset.y };
  }
  const r = ROUTES[m.route];
  if (!r) return { x: 0.5, y: 0.5 };
  const pos = routePos(r, m.t);
  return { x: pos.x + m.routeOffset.x, y: pos.y + m.routeOffset.y };
}

function adaptPirate(sim: ARSimState, cfg: DefenseConfig): void {
  const strats: string[] = [];

  if (cfg.active.has('convoy')) strats.push('Targeting stragglers');
  if (cfg.active.has('armed')) strats.push('Avoiding armed ships');
  if (cfg.active.has('avoidance')) strats.push('Relocated to open ocean');
  if (cfg.active.has('naval')) strats.push('Timing patrol gaps');
  if (cfg.active.has('storm')) strats.push('Attacking in clear weather');
  if (cfg.active.has('scatter')) strats.push('Widening patrol area');

  if (strats.length === 0) {
    sim.pirate.adaptedStrategy = 'Random hunting';
  } else {
    sim.pirate.adaptedStrategy = strats[Math.floor(Math.random() * strats.length)];
  }

  // Decide convoy avoidance once per adaptation cycle (not per frame)
  sim.pirate.avoidsConvoys = cfg.active.has('convoy') && Math.random() < 0.7;

  // Behavioral adaptation: if passage is being avoided, relocate pirate
  if (cfg.active.has('avoidance') && cfg.avoidFraction > 60) {
    if (dist(sim.pirate.pos, { x: STRAIT.x, y: STRAIT.y }) < 0.1) {
      sim.pirate.target = randomWater();
    }
  }
}

function tickARSim(
  sim: ARSimState,
  cfg: DefenseConfig,
  global: GlobalConfig,
  dt: number,
): void {
  sim.time += dt;

  // Weather cycle
  sim.weatherCycle = (sim.time % STORM_CYCLE) / STORM_CYCLE;
  sim.stormActive = sim.weatherCycle > (1 - STORM_DURATION / STORM_CYCLE);

  // Spawn merchants
  const spawnRate = global.shipsPerDay / 60; // ships per sim-second (1 day = 60s)
  sim.spawnAcc += spawnRate * dt;
  while (sim.spawnAcc >= 1) {
    sim.spawnAcc -= 1;
    const m = spawnMerchant(sim, cfg);

    if (cfg.active.has('convoy')) {
      // Queue for convoy
      const q = sim.convoyQueue.get(m.route) || [];
      q.push(m);
      sim.convoyQueue.set(m.route, q);
      if (q.length >= cfg.convoySize) {
        // Release convoy
        for (const cm of q) {
          cm.isConvoy = true;
          cm.convoySize = q.length;
          cm.escortStrength = 2 + cfg.convoySize * 0.5;
          sim.merchants.push(cm);
        }
        sim.convoyQueue.set(m.route, []);
      }
    } else {
      // Storm timing: wait for storm
      if (m.isStormTimer && !sim.stormActive) {
        // Skip spawn — merchants wait for storms
        // Add with small probability anyway to avoid total stoppage
        if (Math.random() < 0.15) sim.merchants.push(m);
      } else {
        sim.merchants.push(m);
      }
    }
    sim.stats.totalMerchants++;
  }

  // Move merchants
  for (const m of sim.merchants) {
    // Storm timers move slower when no storm (they're cautious)
    const speedMul = (m.isStormTimer && !sim.stormActive) ? 0.5 : 1.0;
    // Evasive routes are longer
    const evasiveMul = m.isEvasive ? 0.6 : 1.0;
    m.t += m.speed * speedMul * evasiveMul * dt;
  }
  sim.merchants = sim.merchants.filter(m => m.t < 1);

  // Move navy ships
  if (cfg.active.has('naval')) {
    ensureNavyShips(sim, cfg.patrolShips);
    for (const n of sim.navyShips) {
      n.angle += 0.3 * dt;
      const tx = n.patrolCenter.x + Math.cos(n.angle) * n.patrolRadius;
      const ty = n.patrolCenter.y + Math.sin(n.angle) * n.patrolRadius;
      if (!isOnLand({ x: tx, y: ty })) {
        n.pos.x = tx;
        n.pos.y = ty;
      }
    }
  } else {
    sim.navyShips = [];
  }

  // Navy flee check
  if (sim.pirate.fleeTimer > 0) {
    sim.pirate.fleeTimer -= dt;
  }
  for (const n of sim.navyShips) {
    if (dist(sim.pirate.pos, n.pos) < 0.05) {
      sim.pirate.fleeTimer = 3;
      sim.pirate.target = randomWater();
      break;
    }
  }

  // Pirate adaptation
  if (Math.floor(sim.time) % ADAPT_INTERVAL === 0 &&
      Math.floor(sim.time) !== Math.floor(sim.time - dt)) {
    adaptPirate(sim, cfg);
  }

  // Pirate movement
  if (sim.pirate.fleeTimer <= 0) {
    // Find closest merchant to hunt
    let closest: ARMerchant | null = null;
    let closestD = Infinity;
    for (const m of sim.merchants) {
      const mp = merchantPos(m);
      if (isOnLand(mp)) continue;
      // Armed avoidance
      if (cfg.active.has('armed') && m.armament > 0 && m.armament >= global.pirateStrength) continue;
      // Convoy avoidance (decided per adaptation cycle, not per frame)
      if (sim.pirate.avoidsConvoys && m.isConvoy && m.convoySize >= 4) continue;
      const d = dist(sim.pirate.pos, mp);
      if (d < closestD) { closestD = d; closest = m; }
    }
    if (closest) {
      const mp = merchantPos(closest);
      sim.pirate.target = mp;
    } else if (dist(sim.pirate.pos, sim.pirate.target) < 0.03) {
      sim.pirate.target = randomWater();
    }
  }

  // Move pirate
  const dx = sim.pirate.target.x - sim.pirate.pos.x;
  const dy = sim.pirate.target.y - sim.pirate.pos.y;
  const d = Math.hypot(dx, dy);
  if (d > 0.003) {
    const step = Math.min(AR_PIRATE_SPEED * dt, d);
    const nx = sim.pirate.pos.x + (dx / d) * step;
    const ny = sim.pirate.pos.y + (dy / d) * step;
    if (!isOnLand({ x: nx, y: ny })) {
      sim.pirate.pos.x = nx;
      sim.pirate.pos.y = ny;
    } else {
      const perp1 = { x: sim.pirate.pos.x + (-dy / d) * step, y: sim.pirate.pos.y + (dx / d) * step };
      if (!isOnLand(perp1)) { sim.pirate.pos.x = perp1.x; sim.pirate.pos.y = perp1.y; }
    }
  }
  sim.pirate.pos.x = clamp(sim.pirate.pos.x, 0.01, 0.99);
  sim.pirate.pos.y = clamp(sim.pirate.pos.y, 0.01, 0.99);

  // Trail
  sim.pirate.trailTimer += dt;
  if (sim.pirate.trailTimer >= TRAIL_INTERVAL) {
    sim.pirate.trailTimer = 0;
    sim.pirate.trail.push({ ...sim.pirate.pos });
    if (sim.pirate.trail.length > TRAIL_MAX) sim.pirate.trail.shift();
  }

  // Detection + capture
  const detectR = sim.stormActive ? AR_DETECT_R * 0.08 : AR_DETECT_R;
  for (let i = sim.merchants.length - 1; i >= 0; i--) {
    const m = sim.merchants[i];
    const mp = merchantPos(m);
    if (isOnLand(mp)) continue;
    if (dist(sim.pirate.pos, mp) < detectR) {
      sim.stats.attempts++;

      // Convoy escort defense
      if (m.isConvoy && m.escortStrength > 0) {
        const captureProb = global.pirateStrength / (global.pirateStrength + m.escortStrength);
        if (Math.random() > captureProb) {
          sim.stats.repelled++;
          continue;
        }
      }

      // Armed defense
      if (m.armament > 0) {
        const repelProb = m.armament / (m.armament + global.pirateStrength);
        if (Math.random() < repelProb) {
          sim.stats.repelled++;
          continue;
        }
      }

      sim.merchants.splice(i, 1);
      sim.stats.captures++;
    }
  }
}

// ── Preset Configurations ────────────────────────────────

interface Preset {
  name: string;
  defenses: MerchantDefense[];
  convoySize: number;
  armament: number;
  scatterRadius: number;
  avoidFraction: number;
  patrolShips: number;
  pirateStrength: number;
  shipsPerDay: number;
  cargoValue: number;
  blurb: string;
}

const PRESETS: Record<string, Preset> = {
  anarchy: {
    name: 'Golden Age Anarchy',
    defenses: [],
    convoySize: 3, armament: 2, scatterRadius: 20, avoidFraction: 50, patrolShips: 2,
    pirateStrength: 4, shipsPerDay: 5, cargoValue: 80,
    blurb: 'The Golden Age (1680–1720): no organized defense, maximum piracy. Hundreds of pirates prowled the Caribbean unchecked. This is the baseline — what happens when trade is completely unprotected.',
  },
  treasure: {
    name: 'Spanish Treasure Fleet',
    defenses: ['convoy', 'naval', 'armed'],
    convoySize: 6, armament: 3, scatterRadius: 20, avoidFraction: 50, patrolShips: 3,
    pirateStrength: 3, shipsPerDay: 3, cargoValue: 150,
    blurb: 'The Spanish Treasure Fleet system (1564–1790): massive convoys with armed escorts. Only 3 convoys were ever captured in over 200 years — but the system was enormously expensive. Ships waited months for convoy formation.',
  },
  privateer: {
    name: 'English Privateer Era',
    defenses: ['armed', 'scatter'],
    convoySize: 3, armament: 4, scatterRadius: 30, avoidFraction: 50, patrolShips: 2,
    pirateStrength: 3, shipsPerDay: 4, cargoValue: 60,
    blurb: 'The English approach (1700–1730): arm the merchants themselves. Letter-of-marque ships carried enough guns to fight back. Combined with unpredictable routing, this made piracy risky but not impossible.',
  },
  crackdown: {
    name: 'Royal Navy Crackdown',
    defenses: ['naval', 'storm'],
    convoySize: 3, armament: 2, scatterRadius: 20, avoidFraction: 50, patrolShips: 5,
    pirateStrength: 2, shipsPerDay: 4, cargoValue: 80,
    blurb: 'The Royal Navy crackdown (1720–1730): state power ended the Golden Age. Five warships patrolling the passage, combined with storm-timed transits, reduced piracy to near zero — but at enormous public expense.',
  },
};

// ── Callout text generation ──────────────────────────────

function generateCallout(cfg: DefenseConfig, g: GlobalConfig, eq: Equilibrium): string {
  // No-defense baseline for comparison
  const noDefCfg: DefenseConfig = { active: new Set(), convoySize: 2, armament: 0, scatterRadius: 0, avoidFraction: 0, patrolShips: 0 };
  const ppNoDef = computePhysicalParams(noDefCfg, g);
  const noDefLoss = expectedDailyPiracyLoss(ppNoDef, g.cargoValue);
  const pSingleNoDef = Math.min(1, ppNoDef.detectWidth / ppNoDef.laneWidth);

  if (cfg.active.size === 0) {
    return `Without defense: ${(pSingleNoDef * 100).toFixed(0)}% detection per ship, ${noDefLoss.toFixed(1)}k doubloons lost per day. This is the baseline \u2014 the price of unprotected trade.`;
  }

  if (cfg.active.has('convoy') && cfg.active.size === 1) {
    return `The convoy system reduces targets from ${g.shipsPerDay}/day to ${(g.shipsPerDay / cfg.convoySize).toFixed(1)}/day, but waiting costs ${eq.defCostAtOpt.toFixed(1)}k/day. Spain\u2019s answer: 200 years of treasure fleets with only 3 ever captured.`;
  }

  const alphaPct = Math.round(eq.optAlpha * 100);
  const savings = noDefLoss - eq.minCost;

  if (savings <= 0) {
    return `Current defenses cost more than they save. The piracy loss of ${eq.piracyAtOpt.toFixed(1)}k/day plus defense cost of ${eq.defCostAtOpt.toFixed(1)}k/day exceeds the ${noDefLoss.toFixed(1)}k/day undefended loss.`;
  }

  return `Nash equilibrium at \u03b1 = ${alphaPct}%: defense costs ${eq.defCostAtOpt.toFixed(1)}k/day to save ${savings.toFixed(1)}k/day in piracy losses. Neither merchants nor pirates can improve unilaterally.`;
}

// ── Public State & API ───────────────────────────────────

export interface ArmsRaceState {
  sim: ARSimState;
  defense: DefenseConfig;
  global: GlobalConfig;
  pop: PopDynamicsState;
  // Canvas contexts
  mapCtx: CanvasRenderingContext2D;
  costCtx: CanvasRenderingContext2D;
  popCtx: CanvasRenderingContext2D;
  mapCanvas: HTMLCanvasElement;
  costCanvas: HTMLCanvasElement;
  popCanvas: HTMLCanvasElement;
  // Dimensions
  mapW: number; mapH: number;
  costW: number; costH: number;
  popW: number; popH: number;
  // Cached equilibrium
  equilibrium: Equilibrium;
}

export function initArmsRace(): ArmsRaceState {
  const mapCanvas = document.getElementById('ar-map') as HTMLCanvasElement;
  const costCanvas = document.getElementById('ar-cost-chart') as HTMLCanvasElement;
  const popCanvas = document.getElementById('ar-pop-chart') as HTMLCanvasElement;

  const defense: DefenseConfig = {
    active: new Set(),
    convoySize: 3,
    armament: 2,
    scatterRadius: 20,
    avoidFraction: 50,
    patrolShips: 2,
  };

  const global: GlobalConfig = {
    shipsPerDay: 3,
    cargoValue: 80,
    pirateStrength: 2,
  };

  const state: ArmsRaceState = {
    sim: createARSim(),
    defense,
    global,
    pop: initPopDynamics(),
    mapCtx: mapCanvas.getContext('2d')!,
    costCtx: costCanvas.getContext('2d')!,
    popCtx: popCanvas.getContext('2d')!,
    mapCanvas,
    costCanvas,
    popCanvas,
    mapW: 0, mapH: 0,
    costW: 0, costH: 0,
    popW: 0, popH: 0,
    equilibrium: computeEquilibrium(defense, global),
  };

  resizeCanvases(state);
  window.addEventListener('resize', () => resizeCanvases(state));

  wireControls(state);

  // Default to Treasure Fleet preset so readers see active defenses on arrival
  const defaultPresetBtn = document.querySelector<HTMLButtonElement>('.ar-preset-btn[data-preset="treasure"]');
  if (defaultPresetBtn) defaultPresetBtn.click();

  return state;
}

function resizeCanvases(s: ArmsRaceState): void {
  const dpr = window.devicePixelRatio || 1;

  function setup(canvas: HTMLCanvasElement, aspect: number) {
    const parent = canvas.parentElement!;
    const w = parent.clientWidth;
    const h = Math.round(w * aspect);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  const map = setup(s.mapCanvas, 0.55);
  s.mapW = map.w; s.mapH = map.h;

  const cost = setup(s.costCanvas, 0.35);
  s.costW = cost.w; s.costH = cost.h;

  const pop = setup(s.popCanvas, 0.25);
  s.popW = pop.w; s.popH = pop.h;
}

// ── Controls Wiring ──────────────────────────────────────

function wireControls(state: ArmsRaceState): void {
  const { defense, global: g } = state;

  // Strategy toggle buttons
  const stratBtns = document.querySelectorAll<HTMLButtonElement>('.ar-strat-btn');
  stratBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const strat = btn.dataset.arStrat as MerchantDefense;
      if (defense.active.has(strat)) {
        defense.active.delete(strat);
        btn.classList.remove('active');
      } else {
        defense.active.add(strat);
        btn.classList.add('active');
      }
      updateSliderVisibility(defense);
      recalcEquilibrium(state);
    });
  });

  // Per-strategy sliders
  bindSlider('ar-convoy-size', v => { defense.convoySize = v; }, v => String(v));
  bindSlider('ar-armed-level', v => { defense.armament = v; }, v => String(v));
  bindSlider('ar-scatter-radius', v => { defense.scatterRadius = v; }, v => v + ' nm');
  bindSlider('ar-avoid-frac', v => { defense.avoidFraction = v; }, v => v + '%');
  bindSlider('ar-patrol-ships', v => { defense.patrolShips = v; }, v => String(v));

  // Global controls
  bindSlider('ar-ships-day', v => { g.shipsPerDay = v; }, v => String(v));
  bindSlider('ar-cargo', v => { g.cargoValue = v; }, v => v + 'k');
  bindSlider('ar-pirate-str', v => { g.pirateStrength = v; recalcEquilibrium(state); }, v => String(v));

  // Preset buttons
  const presetBtns = document.querySelectorAll<HTMLButtonElement>('.ar-preset-btn');
  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const presetId = btn.dataset.preset!;
      const preset = PRESETS[presetId];
      if (!preset) return;

      // Clear active presets
      presetBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Apply preset
      defense.active.clear();
      stratBtns.forEach(b => b.classList.remove('active'));
      for (const d of preset.defenses) {
        defense.active.add(d);
        const matchBtn = document.querySelector<HTMLButtonElement>(`.ar-strat-btn[data-ar-strat="${d}"]`);
        if (matchBtn) matchBtn.classList.add('active');
      }

      defense.convoySize = preset.convoySize;
      defense.armament = preset.armament;
      defense.scatterRadius = preset.scatterRadius;
      defense.avoidFraction = preset.avoidFraction;
      defense.patrolShips = preset.patrolShips;
      g.pirateStrength = preset.pirateStrength;
      g.shipsPerDay = preset.shipsPerDay;
      g.cargoValue = preset.cargoValue;

      // Update slider values in DOM
      setSlider('ar-convoy-size', preset.convoySize, String(preset.convoySize));
      setSlider('ar-armed-level', preset.armament, String(preset.armament));
      setSlider('ar-scatter-radius', preset.scatterRadius, preset.scatterRadius + ' nm');
      setSlider('ar-avoid-frac', preset.avoidFraction, preset.avoidFraction + '%');
      setSlider('ar-patrol-ships', preset.patrolShips, String(preset.patrolShips));
      setSlider('ar-ships-day', preset.shipsPerDay, String(preset.shipsPerDay));
      setSlider('ar-cargo', preset.cargoValue, preset.cargoValue + 'k');
      setSlider('ar-pirate-str', preset.pirateStrength, String(preset.pirateStrength));

      updateSliderVisibility(defense);
      recalcEquilibrium(state);

      // Show preset blurb
      const calloutEl = document.getElementById('ar-callout');
      if (calloutEl) calloutEl.textContent = preset.blurb;

      // Reset sim
      state.sim = createARSim();
      state.pop = initPopDynamics();
    });
  });

  function bindSlider(id: string, onChange: (v: number) => void, format: (v: number) => string): void {
    const input = document.getElementById(id) as HTMLInputElement | null;
    const valEl = document.getElementById(id + '-val') as HTMLElement | null;
    if (!input) return;
    input.addEventListener('input', () => {
      const v = +input.value;
      onChange(v);
      if (valEl) valEl.textContent = format(v);
      recalcEquilibrium(state);
    });
  }

  function setSlider(id: string, value: number, display: string): void {
    const input = document.getElementById(id) as HTMLInputElement | null;
    const valEl = document.getElementById(id + '-val') as HTMLElement | null;
    if (input) input.value = String(value);
    if (valEl) valEl.textContent = display;
  }
}

function updateSliderVisibility(cfg: DefenseConfig): void {
  const groups = document.querySelectorAll<HTMLElement>('.ar-slider-group');
  groups.forEach(g => {
    const strat = g.dataset.for as MerchantDefense;
    g.classList.toggle('visible', cfg.active.has(strat));
  });
}

function recalcEquilibrium(state: ArmsRaceState): void {
  state.equilibrium = computeEquilibrium(state.defense, state.global);
  // Reset pop dynamics on config change
  state.pop = initPopDynamics();
}

// ── Drawing ──────────────────────────────────────────────

export function drawArmsRace(state: ArmsRaceState, dt: number): void {
  // Tick simulation
  tickARSim(state.sim, state.defense, state.global, dt);

  // Tick population dynamics
  tickPopDynamics(state.pop, dt, state.defense, state.global);

  // Draw all three panels
  drawMap(state);
  drawCostChart(state);
  drawPopChart(state);
  // Throttle DOM updates (stats every ~1s, callout every ~2s)
  if (++statsTimer % 60 === 0) updateStats(state);
  updateCallout(state);
}

// ── Map Renderer ─────────────────────────────────────────

function drawMap(state: ArmsRaceState): void {
  const { mapCtx: ctx, mapW: w, mapH: h, sim, defense } = state;
  const tx = (x: number) => x * w;
  const ty = (y: number) => y * h;

  // Ocean
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#080e1e');
  g.addColorStop(0.5, '#0b1630');
  g.addColorStop(1, '#070c1a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.02)';
  ctx.lineWidth = 0.5;
  for (let y = 0.1; y < 1; y += 0.1) {
    ctx.beginPath(); ctx.moveTo(0, ty(y)); ctx.lineTo(w, ty(y)); ctx.stroke();
  }
  for (let x = 0.1; x < 1; x += 0.1) {
    ctx.beginPath(); ctx.moveTo(tx(x), 0); ctx.lineTo(tx(x), h); ctx.stroke();
  }

  // Landmasses
  for (const lm of LANDMASSES) drawLandmass(ctx, lm, tx, ty);
  for (const isle of ISLANDS) drawIsland(ctx, isle, tx, ty);

  // Passage zone
  ctx.beginPath();
  ctx.ellipse(tx(STRAIT.x), ty(STRAIT.y), tx(STRAIT.r), ty(STRAIT.r), 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,200,50,0.03)';
  ctx.fill();
  ctx.setLineDash([3, 5]);
  ctx.strokeStyle = 'rgba(255,200,50,0.10)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(255,200,50,0.22)';
  ctx.font = '600 9px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('WINDWARD PASSAGE', tx(STRAIT.x), ty(STRAIT.y - STRAIT.r - 0.015));

  // Trade routes
  for (const r of ROUTES) {
    const from = PORTS[r.from].pos;
    const to = PORTS[r.to].pos;
    ctx.beginPath();
    ctx.moveTo(tx(from.x), ty(from.y));
    ctx.quadraticCurveTo(tx(r.cp.x), ty(r.cp.y), tx(to.x), ty(to.y));
    ctx.setLineDash([4, 8]);
    ctx.strokeStyle = 'rgba(255,215,0,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Evasive routes (if avoidance active)
  if (defense.active.has('avoidance')) {
    for (const er of EVASIVE_ROUTES) {
      ctx.beginPath();
      ctx.moveTo(tx(er.from.x), ty(er.from.y));
      ctx.quadraticCurveTo(tx(er.cp.x), ty(er.cp.y), tx(er.to.x), ty(er.to.y));
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = 'rgba(26,188,156,0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Naval defense zones
  if (defense.active.has('naval')) {
    ctx.beginPath();
    ctx.ellipse(tx(STRAIT.x), ty(STRAIT.y), tx(0.08), ty(0.08), 0, 0, Math.PI * 2);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(52,152,219,0.15)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Ports
  for (const p of PORTS) {
    const x = tx(p.pos.x);
    const y = ty(p.pos.y);
    const pg = ctx.createRadialGradient(x, y, 0, x, y, 10);
    pg.addColorStop(0, 'rgba(255,215,0,0.25)');
    pg.addColorStop(1, 'rgba(255,215,0,0)');
    ctx.fillStyle = pg;
    ctx.fillRect(x - 10, y - 10, 20, 20);
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd700';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,215,0,0.55)';
    ctx.font = '9px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, x, y - 8);
  }

  // Merchants
  for (const m of sim.merchants) {
    const pos = merchantPos(m);
    if (isOnLand(pos)) continue;
    const mx = tx(pos.x);
    const my = ty(pos.y);

    if (m.isConvoy) {
      // Convoy: cluster of diamonds + escort
      for (let k = 0; k < Math.min(m.convoySize, 4); k++) {
        const ox = (k - 1.5) * 4;
        const oy = (k % 2) * 3 - 1.5;
        ctx.save();
        ctx.translate(mx + ox, my + oy);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = 'rgba(230,230,255,0.55)';
        ctx.fillRect(-1.5, -1.5, 3, 3);
        ctx.restore();
      }
      // Escort triangle
      ctx.beginPath();
      ctx.moveTo(mx - 8, my - 4);
      ctx.lineTo(mx - 12, my + 2);
      ctx.lineTo(mx - 4, my + 2);
      ctx.closePath();
      ctx.fillStyle = '#3498db';
      ctx.fill();
    } else if (m.armament > 0) {
      // Armed merchant: diamond with orange border
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = 'rgba(230,230,255,0.65)';
      ctx.fillRect(-2, -2, 4, 4);
      ctx.strokeStyle = 'rgba(255,180,80,0.8)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-2, -2, 4, 4);
      ctx.restore();
    } else if (m.isEvasive) {
      // Evasive: cyan tint
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = 'rgba(100,220,220,0.65)';
      ctx.fillRect(-2, -2, 4, 4);
      ctx.restore();
    } else {
      // Standard
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = 'rgba(230,230,255,0.65)';
      ctx.fillRect(-2, -2, 4, 4);
      ctx.restore();
    }
  }

  // Navy ships
  for (const n of sim.navyShips) {
    const nx = tx(n.pos.x);
    const ny = ty(n.pos.y);
    // Detection circle
    ctx.beginPath();
    ctx.ellipse(nx, ny, tx(0.03), ty(0.03), 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(52,152,219,0.06)';
    ctx.fill();
    // Triangle
    ctx.beginPath();
    ctx.moveTo(nx, ny - 6);
    ctx.lineTo(nx - 5, ny + 3);
    ctx.lineTo(nx + 5, ny + 3);
    ctx.closePath();
    ctx.fillStyle = '#3498db';
    ctx.fill();
    ctx.strokeStyle = '#ffffff44';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  // Pirate trail
  const trail = sim.pirate.trail;
  const n = trail.length;
  for (let i = 1; i < n; i++) {
    const alpha = (i / n) * 0.3;
    ctx.beginPath();
    ctx.moveTo(tx(trail[i - 1].x), ty(trail[i - 1].y));
    ctx.lineTo(tx(trail[i].x), ty(trail[i].y));
    ctx.strokeStyle = '#e74c3c' + hex2(alpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Pirate detection radius
  const detectR = sim.stormActive ? AR_DETECT_R * 0.08 : AR_DETECT_R;
  ctx.beginPath();
  ctx.ellipse(tx(sim.pirate.pos.x), ty(sim.pirate.pos.y), tx(detectR), ty(detectR), 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(231,76,60,0.10)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(231,76,60,0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Pirate
  const px = tx(sim.pirate.pos.x);
  const py = ty(sim.pirate.pos.y);
  const s = 7;
  const grd = ctx.createRadialGradient(px, py, 0, px, py, 18);
  grd.addColorStop(0, 'rgba(231,76,60,0.25)');
  grd.addColorStop(1, 'rgba(231,76,60,0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(px, py, 18, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(px, py - s);
  ctx.lineTo(px - s * 0.7, py + s * 0.5);
  ctx.lineTo(px + s * 0.7, py + s * 0.5);
  ctx.closePath();
  ctx.fillStyle = '#e74c3c';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#e74c3c';
  ctx.font = 'bold 8px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('PIRATE', px, py + s + 11);

  // Strategy status box
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  const stratText = 'PIRATE: ' + sim.pirate.adaptedStrategy;
  ctx.font = '10px system-ui';
  const tm = ctx.measureText(stratText);
  const bx = w - tm.width - 20;
  const by = 12;
  ctx.fillRect(bx - 6, by - 2, tm.width + 12, 18);
  ctx.fillStyle = '#e74c3c';
  ctx.textAlign = 'left';
  ctx.fillText(stratText, bx, by + 11);

  // Storm overlay
  if (sim.stormActive) {
    ctx.fillStyle = 'rgba(60,70,90,0.2)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(200,200,220,0.15)';
    ctx.font = 'bold 11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('STORM', tx(STRAIT.x), ty(STRAIT.y + STRAIT.r + 0.04));
  }
}

function drawLandmass(ctx: CanvasRenderingContext2D, points: Vec2[], tx: (x: number) => number, ty: (y: number) => number): void {
  if (points.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(tx(points[0].x), ty(points[0].y));
  for (let i = 0; i < points.length; i++) {
    const curr = points[i];
    const next = points[(i + 1) % points.length];
    const midX = (tx(curr.x) + tx(next.x)) / 2;
    const midY = (ty(curr.y) + ty(next.y)) / 2;
    ctx.quadraticCurveTo(tx(curr.x), ty(curr.y), midX, midY);
  }
  ctx.closePath();

  let minY = 1, maxY = 0, sumX = 0;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    sumX += p.x;
  }
  const cx = sumX / points.length;

  const lg = ctx.createLinearGradient(tx(cx), ty(minY), tx(cx), ty(maxY));
  lg.addColorStop(0, '#111a0c');
  lg.addColorStop(0.5, '#1a2610');
  lg.addColorStop(1, '#0f1508');
  ctx.fillStyle = lg;
  ctx.fill();
  ctx.strokeStyle = '#2e3a1c';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(80,100,50,0.08)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawIsland(ctx: CanvasRenderingContext2D, isle: { pos: Vec2; rx: number; ry: number }, tx: (x: number) => number, ty: (y: number) => number): void {
  ctx.beginPath();
  ctx.ellipse(tx(isle.pos.x), ty(isle.pos.y), tx(isle.rx), ty(isle.ry), 0, 0, Math.PI * 2);
  ctx.fillStyle = '#172010';
  ctx.fill();
  ctx.strokeStyle = '#2e3a1c';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ── Cost Curve Chart ─────────────────────────────────────

function drawCostChart(state: ArmsRaceState): void {
  const { costCtx: ctx, costW: w, costH: h, defense, global: g, equilibrium: eq } = state;

  ctx.fillStyle = '#080e1e';
  ctx.fillRect(0, 0, w, h);

  const pad = { top: 30, right: 20, bottom: 30, left: 55 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  // Title
  ctx.fillStyle = 'rgba(255,215,0,0.55)';
  ctx.font = '600 10px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('TOTAL COST vs DEFENSE INTENSITY (\u03b1)', w / 2, 16);

  // Axes
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + chartH);
  ctx.lineTo(pad.left + chartW, pad.top + chartH);
  ctx.stroke();

  // Axis labels
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = '9px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('Defense Intensity \u03b1 (%)', pad.left + chartW / 2, h - 6);
  ctx.save();
  ctx.translate(12, pad.top + chartH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Cost (k doubloons/day)', 0, 0);
  ctx.restore();

  // X-axis ticks
  for (let i = 0; i <= 10; i++) {
    const x = pad.left + (i / 10) * chartW;
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '8px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText((i * 10) + '', x, pad.top + chartH + 14);
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + chartH);
    ctx.stroke();
  }

  // Compute curves using PhysicalParams model
  const nPoints = 200;
  let maxCost = 1;

  const piracyCurve: number[] = [];
  const defCostCurve: number[] = [];
  const totalCurve: number[] = [];

  for (let i = 0; i <= nPoints; i++) {
    const alpha = i / nPoints;
    const scaled = scaledDefenseConfig(defense, alpha);
    const pp = computePhysicalParams(scaled, g);
    const piracyLoss = expectedDailyPiracyLoss(pp, g.cargoValue);
    const defCost = dailyDefenseCost(scaled, g);
    const total = piracyLoss + defCost;

    piracyCurve.push(piracyLoss);
    defCostCurve.push(defCost);
    totalCurve.push(total);
    if (total > maxCost) maxCost = total;
    if (piracyLoss > maxCost) maxCost = piracyLoss;
    if (defCost > maxCost) maxCost = defCost;
  }

  maxCost = Math.ceil(maxCost / 10) * 10; // Round up to nearest 10k
  if (maxCost < 10) maxCost = 10;

  // Y-axis ticks
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = (i / yTicks) * maxCost;
    const y = pad.top + chartH - (i / yTicks) * chartH;
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '8px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(0) + 'k', pad.left - 6, y + 3);
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + chartW, y);
    ctx.stroke();
  }

  function plotCurve(data: number[], color: string, dashed: boolean, lineW: number): void {
    ctx.beginPath();
    if (dashed) ctx.setLineDash([5, 4]);
    for (let i = 0; i <= nPoints; i++) {
      const x = pad.left + (i / nPoints) * chartW;
      const y = pad.top + chartH - (data[i] / maxCost) * chartH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Defense cost curve (orange dashed)
  plotCurve(defCostCurve, '#e67e22', true, 1.5);

  // Piracy loss curve (red dashed)
  plotCurve(piracyCurve, '#e74c3c', true, 1.5);

  // Total cost curve (gold solid)
  plotCurve(totalCurve, '#ffd700', false, 2);

  // Equilibrium line
  const eqX = pad.left + eq.optAlpha * chartW;
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = 'rgba(255,215,0,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(eqX, pad.top);
  ctx.lineTo(eqX, pad.top + chartH);
  ctx.stroke();
  ctx.setLineDash([]);

  // Equilibrium label
  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 9px system-ui';
  const labelText = `EQUILIBRIUM: \u03b1 = ${Math.round(eq.optAlpha * 100)}%`;
  const labelW = ctx.measureText(labelText).width;
  const labelX = clamp(eqX, pad.left + labelW / 2, pad.left + chartW - labelW / 2);
  ctx.textAlign = 'center';
  ctx.fillText(labelText, labelX, pad.top - 6);

  // Current position marker (where user's sliders fall on the α curve)
  const curAlpha = eq.currentAlpha;
  const curIdx = Math.round(clamp(curAlpha, 0, 1) * nPoints);
  const curTotal = totalCurve[clamp(curIdx, 0, nPoints)];
  const markerX = pad.left + curAlpha * chartW;
  const markerY = pad.top + chartH - (curTotal / maxCost) * chartH;

  ctx.beginPath();
  ctx.arc(markerX, markerY, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd700';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Legend
  const legX = pad.left + chartW - 120;
  const legY = pad.top + 10;
  ctx.font = '9px system-ui';
  ctx.textAlign = 'left';

  ctx.fillStyle = '#e74c3c';
  ctx.fillRect(legX, legY, 12, 2);
  ctx.fillText('Piracy loss', legX + 16, legY + 4);

  ctx.fillStyle = '#e67e22';
  ctx.fillRect(legX, legY + 14, 12, 2);
  ctx.fillText('Defense cost', legX + 16, legY + 18);

  ctx.fillStyle = '#ffd700';
  ctx.fillRect(legX, legY + 28, 12, 2);
  ctx.fillText('Total cost', legX + 16, legY + 32);
}

// ── Population Dynamics Chart ────────────────────────────

function drawPopChart(state: ArmsRaceState): void {
  const { popCtx: ctx, popW: w, popH: h, pop, defense, global: g } = state;

  ctx.fillStyle = '#080e1e';
  ctx.fillRect(0, 0, w, h);

  const pad = { top: 28, right: 20, bottom: 26, left: 50 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  // Title
  ctx.fillStyle = 'rgba(255,215,0,0.55)';
  ctx.font = '600 10px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('MERCHANT DEFENSE ADOPTION OVER TIME', w / 2, 14);

  // Axes
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + chartH);
  ctx.lineTo(pad.left + chartW, pad.top + chartH);
  ctx.stroke();

  // Y-axis
  for (let i = 0; i <= 4; i++) {
    const v = i * 25;
    const y = pad.top + chartH - (v / 100) * chartH;
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '8px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(v + '%', pad.left - 6, y + 3);
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + chartW, y);
    ctx.stroke();
  }

  // X-axis label
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = '9px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('Time (simulation steps)', pad.left + chartW / 2, h - 4);

  // Equilibrium line — actual replicator fixed point f*
  const fStar = computePopEquilibrium(defense, g);
  const eqY = pad.top + chartH - fStar * chartH;
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = 'rgba(231,76,60,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, eqY);
  ctx.lineTo(pad.left + chartW, eqY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(231,76,60,0.5)';
  ctx.font = '8px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText('equilibrium', pad.left + chartW + 2, eqY + 3);

  // Population history
  const hist = pop.history;
  if (hist.length > 1) {
    const maxIdx = Math.min(hist.length, 240);
    ctx.beginPath();
    for (let i = 0; i < maxIdx; i++) {
      const x = pad.left + (i / 240) * chartW;
      const y = pad.top + chartH - hist[i] * chartH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// ── Stats Row ────────────────────────────────────────────

function updateStats(state: ArmsRaceState): void {
  const el = document.getElementById('ar-stats');
  if (!el) return;

  const { defense, global: g, equilibrium: eq } = state;

  // Current params (user's actual slider values)
  const pp = computePhysicalParams(defense, g);
  const pSingle = Math.min(1, pp.detectWidth / pp.laneWidth);
  const captureRate = pp.pCapture * pp.operationalFrac;
  const expectedCap = pp.targetsPerDay * pSingle * captureRate;
  const piracyLoss = expectedDailyPiracyLoss(pp, g.cargoValue);
  const defCost = dailyDefenseCost(defense, g);
  const totalCost = piracyLoss + defCost;

  // No-defense baseline
  const noDefCfg: DefenseConfig = { active: new Set(), convoySize: 2, armament: 0, scatterRadius: 0, avoidFraction: 0, patrolShips: 0 };
  const ppNoDef = computePhysicalParams(noDefCfg, g);
  const noDefLoss = expectedDailyPiracyLoss(ppNoDef, g.cargoValue);
  const savings = noDefLoss - totalCost;

  // Simulated capture rate: captures per sim-day (60 sim-seconds = 1 day)
  const simDays = state.sim.time / 60;
  const simCapPerDay = simDays > 0.5 ? state.sim.stats.captures / simDays : 0;

  el.innerHTML = `
    <div class="stat"><span class="stat-label">Encounter rate:</span> <span class="stat-value">${(pSingle * 100).toFixed(0)}%/ship</span></div>
    <div class="stat"><span class="stat-label">Capture rate:</span> <span class="stat-value">${(captureRate * 100).toFixed(0)}%/enc</span></div>
    <div class="stat"><span class="stat-label">Piracy loss:</span> <span class="stat-value">${piracyLoss.toFixed(1)}k/day</span></div>
    <div class="stat"><span class="stat-label">Defense cost:</span> <span class="stat-value">${defCost.toFixed(1)}k/day</span></div>
    <div class="stat"><span class="stat-label">Total cost:</span> <span class="stat-value">${totalCost.toFixed(1)}k/day</span></div>
    <div class="stat"><span class="stat-label">Savings:</span> <span class="stat-value">${savings.toFixed(1)}k/day vs none</span></div>
    <div class="stat"><span class="stat-label">Analytical:</span> <span class="stat-value">${expectedCap.toFixed(2)} cap/day</span></div>
    <div class="stat"><span class="stat-label">Simulated:</span> <span class="stat-value">${simCapPerDay.toFixed(2)} cap/day</span></div>
  `;
}

// ── Callout Update ───────────────────────────────────────

let statsTimer = 0;
let calloutTimer = 0;

function updateCallout(state: ArmsRaceState): void {
  calloutTimer++;
  if (calloutTimer % 120 !== 0) return; // Update every ~2s

  // Don't override preset blurbs immediately
  const presetActive = document.querySelector('.ar-preset-btn.active');
  if (presetActive) return;

  const el = document.getElementById('ar-callout');
  if (!el) return;
  el.textContent = generateCallout(state.defense, state.global, state.equilibrium);
}
