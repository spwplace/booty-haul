import './style.css';
import { initHorizon, drawHorizon, HorizonState } from './horizon';
import { initSweep, drawSweep, SweepState } from './sweep';
import {
  Strategy, ALL_STRATEGIES, STRATEGY_INFO,
  SimInstance, createInstance, tick, captureRate,
} from './sim';
import { Renderer } from './render';
import { initProbability, drawProbability, ProbState } from './probability';
import { initArmsRace, drawArmsRace, ArmsRaceState } from './arms-race';

// ── Scroll progress bar ───────────────────────────────

const progressBar = document.getElementById('scroll-progress');
const scrollHint = document.querySelector('.scroll-hint');
window.addEventListener('scroll', () => {
  const top = document.documentElement.scrollTop;
  const height = document.documentElement.scrollHeight - window.innerHeight;
  if (progressBar && height > 0) {
    progressBar.style.width = ((top / height) * 100).toFixed(1) + '%';
  }
  if (scrollHint && top > 60) scrollHint.classList.add('hidden');
}, { passive: true });

// ── Section visibility & scroll reveal ────────────────

document.getElementById('app')!.classList.add('will-animate');

const visible = new Map<string, boolean>();

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      visible.set(e.target.id, e.isIntersecting);
      if (e.isIntersecting) e.target.classList.add('revealed');
    }
  },
  { threshold: 0.05 }
);

for (const id of ['horizon', 'sweep', 'sim', 'probability', 'arms-race']) {
  const el = document.getElementById(id);
  if (el) {
    observer.observe(el);
    visible.set(id, false);
  }
}

// ── Section 1: Horizon ─────────────────────────────────

const horizonState = initHorizon();

// ── Section 2: Sweep ───────────────────────────────────

const sweepState = initSweep();

// ── Section 3: Simulation ──────────────────────────────

const instances = new Map<Strategy, SimInstance>();
for (const s of ALL_STRATEGIES) instances.set(s, createInstance());

let active: Strategy = 'random';
let speed = 3;
let simWeather = 1.0;

const canvas   = document.getElementById('sea') as HTMLCanvasElement;
const stratBox = document.getElementById('strategies')!;
const descEl   = document.getElementById('desc')!;
const barsEl   = document.getElementById('bars')!;
const clockEl  = document.getElementById('clock')!;
const speedIn  = document.getElementById('speed') as HTMLInputElement;
const resetBtn = document.getElementById('reset')!;
const weatherSimSel = document.getElementById('weather-sim') as HTMLSelectElement;
const encountersEl = document.getElementById('sim-encounters')!;

const renderer = new Renderer(canvas);

// Strategy buttons
for (const s of ALL_STRATEGIES) {
  const info = STRATEGY_INFO[s];
  const btn = document.createElement('button');
  btn.className = 'strat-btn' + (s === active ? ' active' : '');
  btn.dataset.strat = s;
  btn.innerHTML = `<span class="strat-dot" style="background:${info.color}"></span>${info.name}`;
  btn.onclick = () => {
    active = s;
    stratBox.querySelectorAll('.strat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    showDesc();
  };
  stratBox.appendChild(btn);
}

function showDesc() {
  descEl.textContent = STRATEGY_INFO[active].desc;
}
showDesc();

// Sim controls
speedIn.addEventListener('input', () => { speed = +speedIn.value; });

resetBtn.addEventListener('click', () => {
  for (const s of ALL_STRATEGIES) instances.set(s, createInstance(simWeather));
});

weatherSimSel.addEventListener('change', () => {
  simWeather = +weatherSimSel.value;
  for (const [, inst] of instances) inst.weatherMul = simWeather;
});

// Comparison bars
let barFrame = 0;

function updateBars() {
  let maxRate = 0.1;
  for (const s of ALL_STRATEGIES) {
    const r = captureRate(instances.get(s)!);
    if (r > maxRate) maxRate = r;
  }

  let html = '';
  for (const s of ALL_STRATEGIES) {
    const info = STRATEGY_INFO[s];
    const inst = instances.get(s)!;
    const rate = captureRate(inst);
    const pct = (rate / maxRate) * 100;

    html += `<div class="bar-row${s === active ? ' active' : ''}">
      <div class="bar-label">${info.name}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${info.color}"></div></div>
      <div class="bar-value">${rate.toFixed(1)}/m</div>
      <div class="bar-total">${inst.captures}</div>
    </div>`;
  }
  barsEl.innerHTML = html;

  // Update encounters counter
  const activeInst = instances.get(active)!;
  encountersEl.textContent = `Encounters: ${activeInst.captures}`;
}

// ── Section 4: Probability ─────────────────────────────

const probState = initProbability();

// ── Section 5: Arms Race ──────────────────────────────

const arState = initArmsRace();

// ── Main loop ──────────────────────────────────────────

let prev = 0;

function loop(now: number) {
  const rawDt = prev ? (now - prev) / 1000 : 0;
  prev = now;
  const dt = Math.min(rawDt, 0.1);

  // Section 1: Horizon
  if (visible.get('horizon')) {
    drawHorizon(horizonState, dt);
  }

  // Section 2: Sweep
  if (visible.get('sweep')) {
    drawSweep(sweepState, dt);
  }

  // Section 3: Simulation
  if (visible.get('sim')) {
    const simDt = dt * speed;
    for (const s of ALL_STRATEGIES) tick(instances.get(s)!, s, simDt);
    renderer.draw(instances.get(active)!, active);

    if (++barFrame % 6 === 0) {
      updateBars();
      const t = instances.get(active)!.time;
      const m = Math.floor(t / 60);
      const sec = Math.floor(t % 60);
      clockEl.textContent = m + ':' + String(sec).padStart(2, '0');
    }
  }

  // Section 4: Probability
  if (visible.get('probability')) {
    drawProbability(probState, dt);
  }

  // Section 5: Arms Race
  if (visible.get('arms-race')) {
    drawArmsRace(arState, dt);
  }

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
