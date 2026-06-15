import * as THREE from 'three';
// Fat-line primitives — THREE.LineBasicMaterial.linewidth is ignored by most
// WebGL drivers (everything renders 1px), so the aurora ribbon and voltage
// bolts use Line2, whose LineMaterial honours a real world-space width.
import { Line2 }        from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

// ── Skydive trail effects ────────────────────────────────────────────────────
// Each equipped Battle Pass trail is a genuinely different *kind* of effect, not
// just a recoloured particle burst. Three render primitives are used:
//   • Points  → smoke puffs / sparkles / flames (differ by motion, density,
//               blending and per-particle colour)
//   • Line    → aurora ribbon (a flowing, colour-cycling streak) and voltage
//               (jagged lightning bolts)
//   • Mesh    → confetti (spinning rectangular quads that tumble)
// Owned by DeployController, which calls emit() during freefall + update() each
// frame, then remove() on landing. Self-contained pools — no allocations in the
// per-frame hot path, and it never touches the shared gameplay particle pool.

const CONFETTI_COLORS = [0xff4a5e, 0xffce4a, 0x46e07a, 0x4aa8ff, 0xb96bff];

// ── Points: smoke / sparkle / flame ──────────────────────────────────────────
// All additive so a particle "fades" simply by driving its vertex colour to 0
// (additive black contributes nothing → reads as transparent on any backdrop).
const POINT_STYLES = {
  // pale, big, slow-rising vapour
  puff:  { size: 0.55, life: 1.10, rise: 1.0, spread: 0.9, perEmit: 2, interval: 0.05,  twinkle: false, warm: false },
  // tiny, dense, twinkling stars
  spark: { size: 0.14, life: 0.85, rise: 0.5, spread: 1.1, perEmit: 4, interval: 0.03,  twinkle: true,  warm: false },
  // warm, fast-rising, flickering fire
  flame: { size: 0.34, life: 0.60, rise: 3.0, spread: 0.5, perEmit: 4, interval: 0.025, twinkle: false, warm: true  },
};

class PointTrail {
  constructor(scene, style, baseColor) {
    this.scene = scene;
    this.cfg   = POINT_STYLES[style];
    this.base  = new THREE.Color(baseColor);
    this.N     = 170;
    this._pos  = new Float32Array(this.N * 3);
    this._col  = new Float32Array(this.N * 3);
    this._p    = [];
    for (let i = 0; i < this.N; i++) {
      this._p.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, r: 1, g: 1, b: 1, tw: Math.random() * 6.283 });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(this._col, 3));
    geo.setDrawRange(0, this.N);
    this._mat = new THREE.PointsMaterial({
      size: this.cfg.size, vertexColors: true, transparent: true, opacity: 1,
      depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this._mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this._t = 0;
  }

  emit(dt, pos) {
    this._t -= dt;
    while (this._t <= 0) {
      this._t += this.cfg.interval;
      for (let n = 0; n < this.cfg.perEmit; n++) {
        const p = this._p.find(q => !q.alive);
        if (!p) break;
        p.alive = true; p.age = 0; p.life = this.cfg.life * (0.7 + Math.random() * 0.6);
        p.x = pos.x + (Math.random() - 0.5) * this.cfg.spread;
        p.y = pos.y + (Math.random() - 0.5) * 0.3;
        p.z = pos.z + (Math.random() - 0.5) * this.cfg.spread;
        p.vx = (Math.random() - 0.5) * 0.8;
        p.vy = this.cfg.rise * (0.5 + Math.random());
        p.vz = (Math.random() - 0.5) * 0.8;
        if (this.cfg.warm) {            // yellow core → orange → red
          const t = Math.random();
          p.r = 1.0; p.g = 0.85 - t * 0.55; p.b = 0.08 * (1 - t);
        } else {
          p.r = this.base.r; p.g = this.base.g; p.b = this.base.b;
        }
        p.tw = Math.random() * 6.283;
      }
    }
  }

  update(dt) {
    const P = this._p, pos = this._pos, col = this._col;
    for (let i = 0; i < this.N; i++) {
      const p = P[i];
      if (!p.alive) { col[i*3] = col[i*3+1] = col[i*3+2] = 0; continue; }
      p.age += dt;
      if (p.age >= p.life) { p.alive = false; col[i*3] = col[i*3+1] = col[i*3+2] = 0; continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      let f = 1 - p.age / p.life;
      if (this.cfg.twinkle) f *= 0.35 + 0.65 * Math.abs(Math.sin(p.tw + p.age * 20));
      pos[i*3] = p.x; pos[i*3+1] = p.y; pos[i*3+2] = p.z;
      col[i*3] = p.r * f; col[i*3+1] = p.g * f; col[i*3+2] = p.b * f;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  remove() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this._mat.dispose();
  }
}

// ── Line: aurora ribbon ───────────────────────────────────────────────────────
// A flowing streak that follows the diver's recent path, shimmering sideways
// and cycling through the spectrum head-to-tail. Reads as a continuous ribbon
// rather than discrete particles.
class RibbonTrail {
  constructor(scene) {
    this.scene  = scene;
    this.N      = 190;                       // long history → a streak that trails far behind
    this._trail = [];                       // recent world positions, newest first
    this._geo   = new LineGeometry();
    this._geo.setPositions([0, 0, 0, 0, 0, 0]);   // placeholder until we have points
    this._geo.setColors([0, 0, 0, 0, 0, 0]);
    this._mat = new LineMaterial({
      linewidth: 0.18, worldUnits: true,    // slim ~0.18m ribbon (was too fat)
      vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._mat.resolution.set(window.innerWidth, window.innerHeight);
    this.line = new Line2(this._geo, this._mat);
    this.line.frustumCulled = false;
    this.line.visible = false;
    scene.add(this.line);
    this._hue = 0;
    this._t   = 0;
  }

  emit(dt, pos) {
    this._t -= dt;
    if (this._t <= 0) {
      this._t = 0.02;
      this._trail.unshift({ x: pos.x, y: pos.y, z: pos.z });
      if (this._trail.length > this.N) this._trail.pop();
    }
  }

  update(dt) {
    this._hue = (this._hue + dt * 0.4) % 1;
    const n = this._trail.length;
    if (n < 2) { this.line.visible = false; return; }
    const pos = new Array(n * 3);
    const col = new Array(n * 3);
    const c = new THREE.Color();
    const now = performance.now() * 0.005;
    for (let i = 0; i < n; i++) {
      const tp  = this._trail[i];
      const wob = Math.sin(i * 0.6 + now) * 0.25 * (i / n);   // lateral shimmer, grows toward tail
      pos[i*3]   = tp.x + wob;
      pos[i*3+1] = tp.y;
      pos[i*3+2] = tp.z + Math.cos(i * 0.6 + now) * 0.15 * (i / n);
      c.setHSL((this._hue + i / n) % 1, 1, 0.6);
      const f = 1 - i / n;                                    // fade toward the tail
      col[i*3] = c.r * f; col[i*3+1] = c.g * f; col[i*3+2] = c.b * f;
    }
    this._geo.setPositions(pos);
    this._geo.setColors(col);
    this._mat.resolution.set(window.innerWidth, window.innerHeight);
    this.line.visible = true;
  }

  remove() { this.scene.remove(this.line); this._geo.dispose(); this._mat.dispose(); }
}

// ── Line: voltage bolts ───────────────────────────────────────────────────────
// Short jagged lightning arcs that flash above the diver and fade fast, leaving
// a stuttering electric trail as they fall away.
class BoltTrail {
  constructor(scene, color) {
    this.scene = scene;
    this.SEG   = 7;
    this._bolts = [];
    for (let i = 0; i < 10; i++) {
      const geo = new LineGeometry();
      geo.setPositions(new Array(this.SEG * 3).fill(0));
      const mat = new LineMaterial({
        color, linewidth: 0.17, worldUnits: true,   // thick, pronounced bolts
        transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      mat.resolution.set(window.innerWidth, window.innerHeight);
      const line = new Line2(geo, mat);
      line.frustumCulled = false; line.visible = false;
      scene.add(line);
      this._bolts.push({ line, geo, mat, alive: false, age: 0, life: 0.2 });
    }
    this._t = 0;
  }

  emit(dt, pos) {
    this._t -= dt;
    while (this._t <= 0) {
      this._t += 0.06;                                 // slightly denser → more pronounced
      const b = this._bolts.find(x => !x.alive);
      if (!b) break;
      b.alive = true; b.age = 0; b.life = 0.18 + Math.random() * 0.1;
      const x0 = pos.x + (Math.random() - 0.5) * 1.2;
      const z0 = pos.z + (Math.random() - 0.5) * 1.2;
      const arr = new Array(this.SEG * 3);
      for (let s = 0; s < this.SEG; s++) {
        const f = s / (this.SEG - 1);
        arr[s*3]   = x0 + (Math.random() - 0.5) * 0.7;
        arr[s*3+1] = pos.y + 1.4 - f * 3.4;
        arr[s*3+2] = z0 + (Math.random() - 0.5) * 0.7;
      }
      b.geo.setPositions(arr);
      b.mat.resolution.set(window.innerWidth, window.innerHeight);
      b.mat.opacity = 1;
      b.line.visible = true;
    }
  }

  update(dt) {
    for (const b of this._bolts) {
      if (!b.alive) continue;
      b.age += dt;
      if (b.age >= b.life) { b.alive = false; b.line.visible = false; continue; }
      b.mat.opacity = 1 - b.age / b.life;
    }
  }

  remove() { for (const b of this._bolts) { this.scene.remove(b.line); b.geo.dispose(); b.mat.dispose(); } }
}

// ── Mesh: confetti ────────────────────────────────────────────────────────────
// Little rectangular quads in five colours that tumble and spin as they fall
// away — a clearly different silhouette from any point/line trail.
class ConfettiTrail {
  constructor(scene) {
    this.scene = scene;
    this._geo  = new THREE.PlaneGeometry(0.18, 0.12);
    this._q    = [];
    for (let i = 0; i < 44; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false,
      });
      const m = new THREE.Mesh(this._geo, mat);
      m.frustumCulled = false; m.visible = false;
      scene.add(m);
      this._q.push({ m, mat, alive: false, age: 0, life: 1, vx: 0, vy: 0, vz: 0, rvx: 0, rvy: 0, rvz: 0 });
    }
    this._t = 0;
  }

  emit(dt, pos) {
    this._t -= dt;
    while (this._t <= 0) {
      this._t += 0.04;
      for (let k = 0; k < 3; k++) {
        const q = this._q.find(x => !x.alive);
        if (!q) break;
        q.alive = true; q.age = 0; q.life = 1.0 + Math.random() * 0.6;
        q.m.position.set(
          pos.x + (Math.random() - 0.5) * 0.8,
          pos.y + (Math.random() - 0.5) * 0.4,
          pos.z + (Math.random() - 0.5) * 0.8,
        );
        q.m.rotation.set(Math.random() * 6.283, Math.random() * 6.283, Math.random() * 6.283);
        q.vx = (Math.random() - 0.5) * 1.5; q.vy = 0.5 + Math.random(); q.vz = (Math.random() - 0.5) * 1.5;
        q.rvx = (Math.random() - 0.5) * 10; q.rvy = (Math.random() - 0.5) * 10; q.rvz = (Math.random() - 0.5) * 10;
        q.mat.color.setHex(CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0]);
        q.mat.opacity = 1; q.m.visible = true;
      }
    }
  }

  update(dt) {
    for (const q of this._q) {
      if (!q.alive) continue;
      q.age += dt;
      if (q.age >= q.life) { q.alive = false; q.m.visible = false; continue; }
      q.vy -= 1.5 * dt;       // gentle settle (slower than the diver → trails upward)
      q.m.position.x += q.vx * dt; q.m.position.y += q.vy * dt; q.m.position.z += q.vz * dt;
      q.m.rotation.x += q.rvx * dt; q.m.rotation.y += q.rvy * dt; q.m.rotation.z += q.rvz * dt;
      q.mat.opacity = Math.min(1, (1 - q.age / q.life) * 1.5);
    }
  }

  remove() { for (const q of this._q) { this.scene.remove(q.m); q.mat.dispose(); } this._geo.dispose(); }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
// Picks the right effect implementation from the equipped cosmetic's fx.mode.
export class SkydiveTrail {
  constructor(scene, fx) {
    const mode  = fx?.mode ?? null;
    const color = (typeof fx?.color === 'number') ? fx.color : 0xffffff;
    if (mode === 'puff' || mode === 'sparkle' || mode === 'flame') {
      const style = mode === 'puff' ? 'puff' : mode === 'sparkle' ? 'spark' : 'flame';
      this._impl = new PointTrail(scene, style, color);
    } else if (mode === 'rainbow') {
      this._impl = new RibbonTrail(scene);
    } else if (mode === 'volt') {
      this._impl = new BoltTrail(scene, color);
    } else if (mode === 'confetti') {
      this._impl = new ConfettiTrail(scene);
    } else {
      this._impl = null;
    }
  }

  emit(dt, pos) { this._impl?.emit(dt, pos); }
  update(dt)    { this._impl?.update(dt); }
  remove()      { this._impl?.remove(); this._impl = null; }
}
