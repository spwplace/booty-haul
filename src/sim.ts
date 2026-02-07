// ── Types ──────────────────────────────────────────────

export interface Vec2 { x: number; y: number }

export interface Port { name: string; pos: Vec2 }

export interface Route {
  from: number;
  to: number;
  cp: Vec2;
  traffic: number; // spawns per second
}

export interface Merchant {
  id: number;
  route: number;
  t: number; // 0→1 along bezier
  speed: number;
}

export interface PirateState {
  pos: Vec2;
  target: Vec2;
  captures: number;
  trail: Vec2[];
  trailTimer: number;
  patrolRoute: number;
  patrolDir: 1 | -1;
  patrolT: number;
  watchPort: number;
  portTimer: number;
  intelTarget: number | null;
  // chokepoint patrol state
  chokeLeg: 0 | 1;
}

export interface CaptureEffect { pos: Vec2; age: number }

export type Strategy = 'random' | 'chokepoint' | 'patrol' | 'port-lurk' | 'intel';

export const ALL_STRATEGIES: Strategy[] = [
  'random', 'chokepoint', 'patrol', 'port-lurk', 'intel',
];

export interface StrategyInfo { name: string; desc: string; color: string }

export const STRATEGY_INFO: Record<Strategy, StrategyInfo> = {
  random: {
    name: 'Random Wandering',
    desc: 'Sail aimlessly across the open ocean hoping to stumble upon a merchant vessel. This is what "the ocean is so huge" assumes — and exactly why the question seems paradoxical.',
    color: '#888888',
  },
  chokepoint: {
    name: 'Chokepoint Ambush',
    desc: 'Patrol the Windward Passage — the 43-nautical-mile gap between Cuba and Hispaniola where Atlantic trade routes compress into a single funnel. This was the dominant real-world pirate strategy.',
    color: '#e74c3c',
  },
  patrol: {
    name: 'Trade Route Patrol',
    desc: "Cruise along known shipping lanes, favoring high-traffic routes. Pirates knew the routes merchants followed — they didn't search the whole Caribbean, just the ribbons of sea that carried commerce.",
    color: '#3498db',
  },
  'port-lurk': {
    name: 'Port Lurking',
    desc: 'Loiter near the busiest ports — Havana, Cartagena, Port Royal — where ships depart and arrive. Vessels are most predictable at the start and end of their voyages.',
    color: '#2ecc71',
  },
  intel: {
    name: 'Intelligence Network',
    desc: "Use informants in taverns and harbours to learn when valuable ships depart, then intercept them en route. Real pirates bribed harbour officials and gathered gossip across the Caribbean.",
    color: '#9b59b6',
  },
};

// ── World — Caribbean basin ────────────────────────────
//
// Geographic projection: 90°W–58°W × 27°N–8°N
//   x = (90 - lon) / 32
//   y = (27 - lat) / 19
//
// All positions computed from real lat/lon coordinates.

// Helper used at design time:  geo(lon, lat) → {x, y}
// (lon in degrees West, lat in degrees North)
function geo(lonW: number, latN: number): Vec2 {
  return { x: (90 - lonW) / 32, y: (27 - latN) / 19 };
}

export const PORTS: Port[] = [
  { name: 'Havana',        pos: geo(82.35, 23.14) },  // 0
  { name: 'Port Royal',    pos: geo(76.84, 17.94) },  // 1
  { name: 'Nassau',        pos: geo(77.34, 25.06) },  // 2
  { name: 'Porto Bello',   pos: geo(79.66,  9.55) },  // 3
  { name: 'Cartagena',     pos: geo(75.51, 10.39) },  // 4
  { name: 'Santo Domingo', pos: geo(69.90, 18.47) },  // 5
  { name: 'San Juan',      pos: geo(66.07, 18.47) },  // 6
  { name: 'Barbados',      pos: geo(59.62, 13.19) },  // 7
];

// ── Routes ─────────────────────────────────────────────
//
// Control points are computed so that routes funneling through the
// Windward Passage have their t≈0.5 midpoint at the passage center.
//
// For a quadratic bezier from A through cp to B:
//   mid = 0.25·A + 0.5·cp + 0.25·B
// Solving for cp:
//   cp = 2·mid - 0.5·A - 0.5·B

const PASSAGE_CENTER: Vec2 = { x: 0.508, y: 0.367 };

function cpThroughPassage(from: Vec2, to: Vec2): Vec2 {
  return {
    x: 2 * PASSAGE_CENTER.x - 0.5 * from.x - 0.5 * to.x,
    y: 2 * PASSAGE_CENTER.y - 0.5 * from.y - 0.5 * to.y,
  };
}

const _ports = PORTS.map(p => p.pos);

export const ROUTES: Route[] = [
  // ★ Through Windward Passage (midpoint at passage center)
  { from: 7, to: 1, cp: cpThroughPassage(_ports[7], _ports[1]), traffic: 0.30 }, // 0: Barbados→Port Royal via passage
  { from: 5, to: 1, cp: cpThroughPassage(_ports[5], _ports[1]), traffic: 0.25 }, // 1: Santo Domingo→Port Royal via passage
  { from: 6, to: 1, cp: cpThroughPassage(_ports[6], _ports[1]), traffic: 0.22 }, // 2: San Juan→Port Royal via passage

  // Atlantic entry (east → Caribbean)
  { from: 7, to: 5, cp: geo(67.0, 15.5),  traffic: 0.22 },  // 3: Barbados→Santo Domingo
  { from: 7, to: 6, cp: geo(62.0, 16.5),  traffic: 0.20 },  // 4: Barbados→San Juan
  { from: 7, to: 1, cp: geo(68.0, 14.5),  traffic: 0.18 },  // 5: Barbados→Port Royal (south route)

  // Western Caribbean
  { from: 1, to: 0, cp: geo(85.0, 21.0),  traffic: 0.22 },  // 6: Port Royal→Havana (around W Cuba)
  { from: 3, to: 0, cp: geo(85.0, 15.0),  traffic: 0.20 },  // 7: Porto Bello→Havana (Yucatan Ch.)

  // Intra-Caribbean
  { from: 4, to: 1, cp: geo(77.5, 14.0),  traffic: 0.18 },  // 8: Cartagena→Port Royal
  { from: 3, to: 4, cp: geo(78.0,  9.8),  traffic: 0.15 },  // 9: Porto Bello→Cartagena
  { from: 4, to: 5, cp: geo(72.0, 14.0),  traffic: 0.15 },  // 10: Cartagena→Santo Domingo
  { from: 0, to: 2, cp: geo(80.0, 25.0),  traffic: 0.25 },  // 11: Havana→Nassau (Florida Straits)
];

// Windward Passage — between Cuba's east tip and Haiti's NW coast
// Cuba Maisí: geo(74.13, 20.22) = (0.496, 0.357)
// Haiti Môle: geo(73.38, 19.83) = (0.519, 0.377)
export const STRAIT = { x: 0.508, y: 0.367, r: 0.05 };

// Two endpoints of the passage gap (for chokepoint patrol)
const PASSAGE_N = geo(74.13, 20.22);  // Cuba east tip
const PASSAGE_S = geo(73.38, 19.83);  // Haiti NW tip

// ── Coastlines ─────────────────────────────────────────
// Each landmass is an array of {x,y} vertices forming a closed polygon.
// Coordinates from real geography via geo(lon, lat).

export const LANDMASSES: Vec2[][] = [
  // Florida (peninsula tip + Keys, enters from top edge)
  [
    geo(80.0, 27),     // NE coast at top edge
    geo(80.1, 25.8),   // Fort Lauderdale
    geo(80.2, 25.1),   // Miami
    geo(80.4, 24.9),   // Key Largo
    geo(81.8, 24.6),   // Key West
    geo(83.0, 24.7),   // Dry Tortugas
    geo(81.5, 25.1),   // Cape Sable
    geo(81.8, 26.1),   // Naples
    geo(82.0, 27),     // NW coast at top edge
  ],

  // Cuba
  [
    // North coast (W → E)
    geo(85.0, 21.85),  // Cape San Antonio
    geo(83.7, 22.45),  // Pinar del Río
    geo(82.4, 23.10),  // Havana
    geo(81.2, 23.18),  // Varadero
    geo(79.5, 22.55),  // Villa Clara
    geo(78.4, 22.50),  // Camagüey
    geo(77.0, 21.55),  // Nuevitas
    geo(76.1, 21.10),  // Holguín
    geo(74.5, 20.35),  // Baracoa
    geo(74.1, 20.22),  // Punta de Maisí (E tip)
    // South coast (E → W)
    geo(74.2, 20.05),  // SE coast
    geo(75.8, 19.98),  // Santiago de Cuba
    geo(77.7, 19.83),  // Cabo Cruz (S-most point)
    geo(77.5, 20.40),  // Manzanillo
    geo(80.0, 21.80),  // Trinidad coast
    geo(80.5, 22.10),  // Cienfuegos
    geo(82.3, 22.70),  // Batabanó
    geo(84.5, 21.76),  // SW coast
  ],

  // Hispaniola (with Gulf of Gonâve indent)
  [
    // Start NW, go clockwise
    geo(73.4, 19.83),  // Môle-Saint-Nicolas (NW)
    geo(72.2, 19.76),  // Cap-Haïtien
    geo(71.6, 19.85),  // Monte Cristi
    geo(70.7, 19.79),  // Puerto Plata
    geo(69.3, 19.21),  // Samaná
    geo(68.3, 18.50),  // Punta Cana (E tip)
    geo(69.0, 18.42),  // La Romana
    geo(70.0, 18.43),  // Santo Domingo
    geo(71.1, 18.21),  // Barahona
    geo(72.5, 18.23),  // Jacmel (S coast Haiti)
    geo(74.5, 18.19),  // Tiburon (SW tip)
    // Gulf of Gonâve (indent northward)
    geo(73.5, 18.50),  // S entrance of gulf
    geo(72.8, 18.90),  // Gulf interior
    geo(73.1, 19.30),  // N entrance of gulf
    geo(73.3, 19.55),  // W coast going back to NW
  ],

  // Yucatan peninsula (juts from left edge)
  [
    geo(90.0, 22.5),   // NW at left edge
    geo(88.5, 21.5),   // N coast
    geo(87.1, 21.5),   // Cabo Catoche (NE tip)
    geo(86.8, 21.2),   // Cancún
    geo(87.4, 19.5),   // E coast (Cozumel area)
    geo(88.2, 18.5),   // Belize border area
    geo(90.0, 18.0),   // SW at left edge
  ],

  // Central America coast (left edge → Panama)
  [
    geo(90.0, 17.0),   // Belize at left edge
    geo(88.2, 16.0),   // Honduras coast
    geo(86.0, 15.9),   // Trujillo
    geo(84.0, 12.0),   // Nicaragua
    geo(83.0, 10.0),   // Costa Rica
    geo(80.0,  9.4),   // Panama
    geo(79.5,  9.0),   // Isthmus
    geo(79.0,  8.0),   // off bottom
    geo(90.0,  8.0),   // bottom-left corner
  ],

  // South America north coast
  [
    geo(77.0,  8.0),   // Gulf of Urabá (bottom edge)
    geo(76.5,  9.0),   // NW Colombia
    geo(75.5, 10.4),   // Cartagena
    geo(74.2, 11.2),   // Santa Marta
    geo(72.0, 12.0),   // Guajira Peninsula
    geo(71.6, 10.6),   // Maracaibo
    geo(70.0, 11.8),   // Coro
    geo(67.0, 10.6),   // Central Venezuela
    geo(64.7, 10.1),   // Eastern Venezuela
    geo(62.0, 10.7),   // Orinoco
    geo(60.0,  9.5),   // Trinidad area
    geo(58.0,  8.0),   // off bottom-right
    geo(77.0,  8.0),   // close along bottom
  ],
];

// Small islands (ellipses)
export const ISLANDS: { pos: Vec2; rx: number; ry: number; name?: string }[] = [
  // Jamaica (W tip 78.4W→E tip 76.2W, ~18.1N)
  { pos: geo(77.3, 18.1), rx: 0.034, ry: 0.010, name: 'Jamaica' },
  // Puerto Rico (67.2W→65.6W, ~18.3N)
  { pos: geo(66.4, 18.3), rx: 0.025, ry: 0.009, name: 'Puerto Rico' },
  // Bahamas: New Providence (Nassau)
  { pos: geo(77.3, 25.0), rx: 0.008, ry: 0.004 },
  // Andros
  { pos: geo(78.0, 24.5), rx: 0.012, ry: 0.018 },
  // Eleuthera
  { pos: geo(76.3, 25.0), rx: 0.004, ry: 0.012 },
  // Grand Bahama
  { pos: geo(78.7, 26.6), rx: 0.012, ry: 0.004 },
  // Long Island / Exumas
  { pos: geo(75.5, 23.5), rx: 0.005, ry: 0.016 },
  // Lesser Antilles chain (N→S)
  { pos: geo(64.8, 18.3), rx: 0.005, ry: 0.004 }, // Virgin Is.
  { pos: geo(62.7, 17.3), rx: 0.004, ry: 0.003 }, // St. Kitts
  { pos: geo(61.8, 17.1), rx: 0.005, ry: 0.004 }, // Antigua
  { pos: geo(61.5, 16.2), rx: 0.006, ry: 0.005 }, // Guadeloupe
  { pos: geo(61.4, 15.4), rx: 0.004, ry: 0.003 }, // Dominica
  { pos: geo(61.0, 14.6), rx: 0.005, ry: 0.004 }, // Martinique
  { pos: geo(61.0, 13.9), rx: 0.004, ry: 0.003 }, // St. Lucia
  { pos: geo(61.2, 13.3), rx: 0.004, ry: 0.003 }, // St. Vincent
  { pos: geo(61.7, 12.1), rx: 0.005, ry: 0.004 }, // Grenada
  // Trinidad & Tobago
  { pos: geo(61.3, 10.4), rx: 0.012, ry: 0.008, name: 'Trinidad' },
  { pos: geo(60.7, 11.2), rx: 0.008, ry: 0.004 },
];

// ── Math helpers ───────────────────────────────────────

export function bezier(p0: Vec2, cp: Vec2, p1: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * cp.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * cp.y + t * t * p1.y,
  };
}

export function routePos(r: Route, t: number): Vec2 {
  return bezier(PORTS[r.from].pos, r.cp, PORTS[r.to].pos, t);
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Land collision ─────────────────────────────────────

function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > p.y) !== (yj > p.y) &&
        p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function isOnLand(p: Vec2): boolean {
  for (const lm of LANDMASSES) {
    if (pointInPolygon(p, lm)) return true;
  }
  for (const isle of ISLANDS) {
    const dx = (p.x - isle.pos.x) / isle.rx;
    const dy = (p.y - isle.pos.y) / isle.ry;
    if (dx * dx + dy * dy < 1) return true;
  }
  return false;
}

// ── Constants ──────────────────────────────────────────

const MERCHANT_SPEED = 0.028;
const PIRATE_SPEED   = 0.04;

// Detection radius: 23nm real ≈ 43km.
// Map spans ~3200km. Accurate: 43/3200 = 0.0134.
// We use 0.018 (slightly exaggerated for visibility).
const BASE_DETECT_R  = 0.018;
const TRAIL_INTERVAL  = 0.08;
const TRAIL_MAX       = 180;

// ── Port traffic weights (for port-lurk strategy) ──────

const PORT_WEIGHTS: number[] = PORTS.map((_, i) => {
  let w = 0;
  for (const r of ROUTES) {
    if (r.from === i || r.to === i) w += r.traffic;
  }
  return w;
});

function weightedRandomPort(): number {
  const total = PORT_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < PORT_WEIGHTS.length; i++) {
    r -= PORT_WEIGHTS[i];
    if (r <= 0) return i;
  }
  return 0;
}

// Route traffic weights (for patrol strategy)
function weightedRandomRoute(): number {
  const total = ROUTES.reduce((a, r) => a + r.traffic, 0);
  let r = Math.random() * total;
  for (let i = 0; i < ROUTES.length; i++) {
    r -= ROUTES[i].traffic;
    if (r <= 0) return i;
  }
  return 0;
}

// ── Simulation instance ────────────────────────────────

export interface SimInstance {
  merchants: Merchant[];
  pirate: PirateState;
  captures: number;
  time: number;
  spawnAcc: number[];
  effects: CaptureEffect[];
  nextId: number;
  weatherMul: number;
}

function randomWaterPos(): Vec2 {
  for (let i = 0; i < 50; i++) {
    const p = { x: 0.05 + Math.random() * 0.90, y: 0.05 + Math.random() * 0.85 };
    if (!isOnLand(p)) return p;
  }
  return { x: 0.5, y: 0.5 }; // fallback
}

function makePirate(): PirateState {
  const pos = randomWaterPos();
  return {
    pos,
    target: pos,
    captures: 0,
    trail: [],
    trailTimer: 0,
    patrolRoute: weightedRandomRoute(),
    patrolDir: 1,
    patrolT: Math.random(),
    watchPort: weightedRandomPort(),
    portTimer: 0,
    intelTarget: null,
    chokeLeg: 0,
  };
}

export function createInstance(weatherMul = 1.0): SimInstance {
  return {
    merchants: [],
    pirate: makePirate(),
    captures: 0,
    time: 0,
    spawnAcc: ROUTES.map(() => Math.random() * 0.5),
    effects: [],
    nextId: 0,
    weatherMul,
  };
}

export function effectiveDetectR(inst: SimInstance): number {
  return BASE_DETECT_R * inst.weatherMul;
}

// ── Strategy behaviours ────────────────────────────────

function steer(pirate: PirateState, strategy: Strategy, inst: SimInstance, dt: number) {
  switch (strategy) {

    case 'random': {
      if (dist(pirate.pos, pirate.target) < 0.03 || isOnLand(pirate.target)) {
        pirate.target = randomWaterPos();
      }
      break;
    }

    case 'chokepoint': {
      // Patrol back and forth across the Windward Passage gap
      const targets = [PASSAGE_N, PASSAGE_S];
      const current = targets[pirate.chokeLeg];

      if (dist(pirate.pos, { x: STRAIT.x, y: STRAIT.y }) > STRAIT.r * 2) {
        // Not at passage yet — sail there
        pirate.target = { x: STRAIT.x, y: STRAIT.y };
      } else if (dist(pirate.pos, current) < 0.02) {
        // Reached one end — patrol to the other
        pirate.chokeLeg = pirate.chokeLeg === 0 ? 1 : 0;
        pirate.target = targets[pirate.chokeLeg];
      } else {
        pirate.target = current;
      }
      break;
    }

    case 'patrol': {
      pirate.patrolT += pirate.patrolDir * 0.7 * dt;
      if (pirate.patrolT > 1 || pirate.patrolT < 0) {
        pirate.patrolRoute = weightedRandomRoute();
        pirate.patrolT = Math.random() > 0.5 ? 0 : 1;
        pirate.patrolDir = pirate.patrolT < 0.5 ? 1 : -1;
      }
      pirate.target = routePos(ROUTES[pirate.patrolRoute], clamp(pirate.patrolT, 0, 1));
      break;
    }

    case 'port-lurk': {
      pirate.portTimer += dt;
      if (pirate.portTimer > 20) {
        pirate.portTimer = 0;
        pirate.watchPort = weightedRandomPort();
      }
      const port = PORTS[pirate.watchPort];
      const a = inst.time * 0.4 + pirate.watchPort * 1.5;
      const r = 0.04;
      pirate.target = {
        x: port.pos.x + Math.cos(a) * r,
        y: port.pos.y + Math.sin(a) * r,
      };
      break;
    }

    case 'intel': {
      if (pirate.intelTarget !== null) {
        const m = inst.merchants.find(v => v.id === pirate.intelTarget);
        if (m) {
          const predictT = clamp(m.t + m.speed * 4, 0, 1);
          pirate.target = routePos(ROUTES[m.route], predictT);
        } else {
          pirate.intelTarget = null;
        }
      }
      if (pirate.intelTarget === null && inst.merchants.length > 0) {
        let bestD = Infinity;
        let bestId: number | null = null;
        for (const m of inst.merchants) {
          const mp = routePos(ROUTES[m.route], m.t);
          const d = dist(pirate.pos, mp);
          if (d < bestD) { bestD = d; bestId = m.id; }
        }
        pirate.intelTarget = bestId;
      }
      if (pirate.intelTarget === null) {
        // Patrol near passage when no merchants
        pirate.target = { x: STRAIT.x, y: STRAIT.y };
      }
      break;
    }
  }

  // Move toward target (with land avoidance)
  const dx = pirate.target.x - pirate.pos.x;
  const dy = pirate.target.y - pirate.pos.y;
  const d = Math.hypot(dx, dy);
  if (d > 0.003) {
    const step = Math.min(PIRATE_SPEED * dt, d);
    const nx = pirate.pos.x + (dx / d) * step;
    const ny = pirate.pos.y + (dy / d) * step;
    if (!isOnLand({ x: nx, y: ny })) {
      pirate.pos.x = nx;
      pirate.pos.y = ny;
    } else {
      // Deflect: try perpendicular directions
      const perp1 = { x: pirate.pos.x + (-dy / d) * step, y: pirate.pos.y + (dx / d) * step };
      const perp2 = { x: pirate.pos.x + (dy / d) * step, y: pirate.pos.y + (-dx / d) * step };
      if (!isOnLand(perp1)) {
        pirate.pos.x = perp1.x;
        pirate.pos.y = perp1.y;
      } else if (!isOnLand(perp2)) {
        pirate.pos.x = perp2.x;
        pirate.pos.y = perp2.y;
      }
      // else: stuck, skip this frame
    }
  }
  pirate.pos.x = clamp(pirate.pos.x, 0.01, 0.99);
  pirate.pos.y = clamp(pirate.pos.y, 0.01, 0.99);

  // Trail
  pirate.trailTimer += dt;
  if (pirate.trailTimer >= TRAIL_INTERVAL) {
    pirate.trailTimer = 0;
    pirate.trail.push({ x: pirate.pos.x, y: pirate.pos.y });
    if (pirate.trail.length > TRAIL_MAX) pirate.trail.shift();
  }
}

// ── Tick ───────────────────────────────────────────────

export function tick(inst: SimInstance, strategy: Strategy, dt: number) {
  inst.time += dt;

  for (let i = 0; i < ROUTES.length; i++) {
    inst.spawnAcc[i] += ROUTES[i].traffic * dt;
    while (inst.spawnAcc[i] >= 1) {
      inst.spawnAcc[i] -= 1;
      inst.merchants.push({
        id: inst.nextId++,
        route: i,
        t: 0,
        speed: MERCHANT_SPEED * (0.8 + Math.random() * 0.4),
      });
    }
  }

  for (const m of inst.merchants) m.t += m.speed * dt;
  inst.merchants = inst.merchants.filter(m => m.t < 1);

  steer(inst.pirate, strategy, inst, dt);

  const detectR = effectiveDetectR(inst);
  for (let i = inst.merchants.length - 1; i >= 0; i--) {
    const m = inst.merchants[i];
    const mp = routePos(ROUTES[m.route], m.t);
    if (isOnLand(mp)) continue;
    if (dist(inst.pirate.pos, mp) < detectR) {
      inst.effects.push({ pos: { x: mp.x, y: mp.y }, age: 0 });
      inst.merchants.splice(i, 1);
      inst.captures++;
      inst.pirate.captures++;
      if (strategy === 'intel') inst.pirate.intelTarget = null;
    }
  }

  for (const e of inst.effects) e.age += dt;
  inst.effects = inst.effects.filter(e => e.age < 0.8);
}

export function captureRate(inst: SimInstance): number {
  return inst.time > 2 ? (inst.captures / inst.time) * 60 : 0;
}
