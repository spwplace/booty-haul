import {
  Vec2, SimInstance, Strategy,
  PORTS, ROUTES, STRAIT, LANDMASSES, ISLANDS, STRATEGY_INFO,
  routePos, effectiveDetectR, isOnLand,
} from './sim';

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const parent = this.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    this.w = parent.clientWidth;
    this.h = Math.round(this.w * 0.55);
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private tx(x: number) { return x * this.w; }
  private ty(y: number) { return y * this.h; }

  // ── Drawing ────────────────────────────────────────

  draw(inst: SimInstance, strategy: Strategy) {
    const { ctx, w, h } = this;
    const detectR = effectiveDetectR(inst);

    // Ocean gradient
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#080e1e');
    g.addColorStop(0.5, '#0b1630');
    g.addColorStop(1, '#070c1a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Subtle grid
    ctx.strokeStyle = 'rgba(255,255,255,0.02)';
    ctx.lineWidth = 0.5;
    for (let y = 0.1; y < 1; y += 0.1) {
      ctx.beginPath();
      ctx.moveTo(0, this.ty(y));
      ctx.lineTo(w, this.ty(y));
      ctx.stroke();
    }
    for (let x = 0.1; x < 1; x += 0.1) {
      ctx.beginPath();
      ctx.moveTo(this.tx(x), 0);
      ctx.lineTo(this.tx(x), h);
      ctx.stroke();
    }

    // Land masses (coastline polygons)
    for (const lm of LANDMASSES) this.drawLandmass(lm);

    // Small islands
    for (const isle of ISLANDS) this.drawIsland(isle);

    // Windward Passage zone
    ctx.beginPath();
    ctx.ellipse(
      this.tx(STRAIT.x), this.ty(STRAIT.y),
      this.tx(STRAIT.r), this.ty(STRAIT.r),
      0, 0, Math.PI * 2
    );
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
    ctx.fillText('WINDWARD PASSAGE', this.tx(STRAIT.x), this.ty(STRAIT.y - STRAIT.r - 0.015));

    // Trade routes
    for (const r of ROUTES) this.drawRoute(r);

    // Ports
    for (const p of PORTS) this.drawPort(p);

    // Merchants (skip those on land)
    for (const m of inst.merchants) {
      const pos = routePos(ROUTES[m.route], m.t);
      if (!isOnLand(pos)) this.drawMerchant(pos);
    }

    const color = STRATEGY_INFO[strategy].color;

    // Pirate trail
    this.drawTrail(inst.pirate.trail, color);

    // Detection radius
    ctx.beginPath();
    ctx.ellipse(
      this.tx(inst.pirate.pos.x), this.ty(inst.pirate.pos.y),
      this.tx(detectR), this.ty(detectR),
      0, 0, Math.PI * 2
    );
    ctx.fillStyle = color + '12';
    ctx.fill();
    ctx.strokeStyle = color + '30';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Pirate
    this.drawPirate(inst.pirate.pos, color);

    // Capture effects
    for (const e of inst.effects) this.drawBurst(e, color);

    // Weather overlay
    if (inst.weatherMul < 0.7) {
      const fogAlpha = (1 - inst.weatherMul) * 0.2;
      ctx.fillStyle = `rgba(80,90,110,${fogAlpha})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  // ── Land drawing ──────────────────────────────────

  private drawLandmass(points: Vec2[]) {
    if (points.length < 3) return;
    const ctx = this.ctx;

    ctx.beginPath();
    ctx.moveTo(this.tx(points[0].x), this.ty(points[0].y));

    // Smooth path with quadratic curves between midpoints
    for (let i = 0; i < points.length; i++) {
      const curr = points[i];
      const next = points[(i + 1) % points.length];
      const midX = (this.tx(curr.x) + this.tx(next.x)) / 2;
      const midY = (this.ty(curr.y) + this.ty(next.y)) / 2;
      ctx.quadraticCurveTo(this.tx(curr.x), this.ty(curr.y), midX, midY);
    }
    ctx.closePath();

    // Fill gradient (dark land)
    const bounds = this.getLandBounds(points);
    const lg = ctx.createLinearGradient(
      this.tx(bounds.cx), this.ty(bounds.minY),
      this.tx(bounds.cx), this.ty(bounds.maxY),
    );
    lg.addColorStop(0, '#111a0c');
    lg.addColorStop(0.5, '#1a2610');
    lg.addColorStop(1, '#0f1508');
    ctx.fillStyle = lg;
    ctx.fill();

    // Coastline
    ctx.strokeStyle = '#2e3a1c';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Subtle inner highlight
    ctx.strokeStyle = 'rgba(80,100,50,0.08)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  private drawIsland(isle: { pos: Vec2; rx: number; ry: number }) {
    const ctx = this.ctx;
    const x = this.tx(isle.pos.x);
    const y = this.ty(isle.pos.y);
    const rx = this.tx(isle.rx);
    const ry = this.ty(isle.ry);

    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#172010';
    ctx.fill();
    ctx.strokeStyle = '#2e3a1c';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private getLandBounds(points: Vec2[]) {
    let minY = 1, maxY = 0, sumX = 0;
    for (const p of points) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      sumX += p.x;
    }
    return { minY, maxY, cx: sumX / points.length };
  }

  // ── Routes, ports, ships ──────────────────────────

  private drawRoute(r: typeof ROUTES[0]) {
    const ctx = this.ctx;
    const from = PORTS[r.from].pos;
    const to = PORTS[r.to].pos;

    ctx.beginPath();
    ctx.moveTo(this.tx(from.x), this.ty(from.y));
    ctx.quadraticCurveTo(
      this.tx(r.cp.x), this.ty(r.cp.y),
      this.tx(to.x), this.ty(to.y),
    );
    ctx.setLineDash([4, 8]);
    ctx.strokeStyle = 'rgba(255,215,0,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawPort(port: typeof PORTS[0]) {
    const ctx = this.ctx;
    const x = this.tx(port.pos.x);
    const y = this.ty(port.pos.y);

    // Glow
    const g = ctx.createRadialGradient(x, y, 0, x, y, 10);
    g.addColorStop(0, 'rgba(255,215,0,0.25)');
    g.addColorStop(1, 'rgba(255,215,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 10, y - 10, 20, 20);

    // Dot
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd700';
    ctx.fill();

    // Label
    ctx.fillStyle = 'rgba(255,215,0,0.55)';
    ctx.font = '9px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(port.name, x, y - 8);
  }

  private drawMerchant(pos: Vec2) {
    const ctx = this.ctx;
    const x = this.tx(pos.x);
    const y = this.ty(pos.y);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = 'rgba(230,230,255,0.65)';
    ctx.fillRect(-2, -2, 4, 4);
    ctx.restore();
  }

  private drawPirate(pos: Vec2, color: string) {
    const ctx = this.ctx;
    const x = this.tx(pos.x);
    const y = this.ty(pos.y);
    const s = 7;

    // Glow
    const grd = ctx.createRadialGradient(x, y, 0, x, y, 18);
    grd.addColorStop(0, color + '40');
    grd.addColorStop(1, color + '00');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fill();

    // Triangle
    ctx.beginPath();
    ctx.moveTo(x, y - s);
    ctx.lineTo(x - s * 0.7, y + s * 0.5);
    ctx.lineTo(x + s * 0.7, y + s * 0.5);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Label
    ctx.fillStyle = color;
    ctx.font = 'bold 8px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('PIRATE', x, y + s + 11);
  }

  private drawTrail(trail: Vec2[], color: string) {
    const ctx = this.ctx;
    const n = trail.length;
    if (n < 2) return;

    for (let i = 1; i < n; i++) {
      const alpha = (i / n) * 0.35;
      ctx.beginPath();
      ctx.moveTo(this.tx(trail[i - 1].x), this.ty(trail[i - 1].y));
      ctx.lineTo(this.tx(trail[i].x), this.ty(trail[i].y));
      ctx.strokeStyle = color + hex2(alpha);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private drawBurst(e: { pos: Vec2; age: number }, color: string) {
    const ctx = this.ctx;
    const x = this.tx(e.pos.x);
    const y = this.ty(e.pos.y);
    const alpha = 1 - e.age / 0.8;
    const r = 4 + e.age * 25;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color + hex2(alpha * 0.7);
    ctx.lineWidth = 2;
    ctx.stroke();

    if (e.age < 0.35) {
      ctx.fillStyle = 'rgba(255,200,60,' + (alpha * 0.9).toFixed(2) + ')';
      ctx.font = 'bold 10px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('x', x, y - r - 3);
    }
  }
}

function hex2(a: number): string {
  return Math.round(clamp01(a) * 255).toString(16).padStart(2, '0');
}

function clamp01(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v; }
