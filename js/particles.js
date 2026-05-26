import * as THREE from 'three';

// Pre-allocated pool of burst emitters — no per-burst geometry/material creation.
// Each slot stays in the scene permanently (visible=false when idle).
const POOL_SIZE    = 64;  // max simultaneous bursts before silently dropping
const MAX_PER_EMIT = 64;  // max particles per burst; excess is clamped

export class ParticleSystem {
  constructor(scene) {
    this.scene = scene;
    this._time = 0;
    this._buildAmbientDust();
    this._buildPool();
  }

  _buildAmbientDust() {
    const count = 350;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors    = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 300;
      positions[i * 3 + 1] = Math.random() * 30 + 2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 300;

      colors[i * 3]     = 0.9 + Math.random() * 0.1;
      colors[i * 3 + 1] = 0.85 + Math.random() * 0.1;
      colors[i * 3 + 2] = 0.6 + Math.random() * 0.2;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size: 0.25,
      vertexColors: true,
      transparent: true,
      opacity: 0.35,
      sizeAttenuation: true,
      depthWrite: false,
    });

    this._dust = new THREE.Points(geo, mat);
    this._dustPositions  = positions;
    this._dustVelocities = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      this._dustVelocities[i * 3]     = (Math.random() - 0.5) * 0.4;
      this._dustVelocities[i * 3 + 1] = Math.random() * 0.15 + 0.05;
      this._dustVelocities[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
    }

    this.scene.add(this._dust);
  }

  _buildPool() {
    this._pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const positions  = new Float32Array(MAX_PER_EMIT * 3);
      const velocities = new Float32Array(MAX_PER_EMIT * 3);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setDrawRange(0, 0);

      const mat = new THREE.PointsMaterial({
        size: 0.4, color: 0xffaa33,
        transparent: true, opacity: 0,
        depthWrite: false,
      });

      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      points.visible = false;
      this.scene.add(points);

      this._pool.push({
        points, positions, velocities,
        active: false,
        age: 0, lifetime: 0, count: 0, gravity: 9,
      });
    }
  }

  /**
   * Spawn a burst from the pool.
   * @param {THREE.Vector3} pos
   * @param {object} opts - { count, color, speed, lifetime, size, gravity }
   *   gravity: acceleration pulling particles down (default 9, negative = push up)
   */
  spawnBurst(pos, opts = {}) {
    const count    = Math.min(opts.count    ?? 24, MAX_PER_EMIT);
    const color    = opts.color    ?? 0xffaa33;
    const speed    = opts.speed    ?? 5;
    const lifetime = opts.lifetime ?? 0.8;
    const size     = opts.size     ?? 0.4;
    const gravity  = opts.gravity  ?? 9;

    // Find a free pool slot — skip if pool is exhausted
    let slot = null;
    for (const s of this._pool) {
      if (!s.active) { slot = s; break; }
    }
    if (!slot) return;

    slot.active   = true;
    slot.age      = 0;
    slot.lifetime = lifetime;
    slot.count    = count;
    slot.gravity  = gravity;

    const mat = slot.points.material;
    mat.color.setHex(color);
    mat.size    = size;
    mat.opacity = 1;
    slot.points.visible = true;
    slot.points.geometry.setDrawRange(0, count);

    const p = slot.positions;
    const v = slot.velocities;
    for (let i = 0; i < count; i++) {
      p[i*3+0] = pos.x;
      p[i*3+1] = pos.y;
      p[i*3+2] = pos.z;
      v[i*3+0] = (Math.random() - 0.5) * speed * 2;
      v[i*3+1] = Math.random() * speed;
      v[i*3+2] = (Math.random() - 0.5) * speed * 2;
    }
    slot.points.geometry.attributes.position.needsUpdate = true;
  }

  /**
   * Directional spark spray — particles biased along `dir`. Delegates to the
   * pooled spawnBurst with a directional velocity override so we don't have
   * to allocate a second pool just for sparks.
   */
  spawnSparks(pos, dir, opts = {}) {
    // Bake the direction into the burst speed/spread by offsetting the spawn
    // slightly forward and using a higher upward bias.
    const count    = Math.min(opts.count    ?? 12, MAX_PER_EMIT);
    const color    = opts.color    ?? 0xffcc55;
    const speed    = opts.speed    ?? 9;
    const lifetime = opts.lifetime ?? 0.38;
    const size     = opts.size     ?? 0.07;

    let slot = null;
    for (const s of this._pool) {
      if (!s.active) { slot = s; break; }
    }
    if (!slot) return;

    slot.active   = true;
    slot.age      = 0;
    slot.lifetime = lifetime;
    slot.count    = count;
    slot.gravity  = 14;

    const mat = slot.points.material;
    mat.color.setHex(color);
    mat.size    = size;
    mat.opacity = 1;
    slot.points.visible = true;
    slot.points.geometry.setDrawRange(0, count);

    const d = dir.clone().normalize();
    const p = slot.positions;
    const v = slot.velocities;
    for (let i = 0; i < count; i++) {
      p[i*3+0] = pos.x;
      p[i*3+1] = pos.y;
      p[i*3+2] = pos.z;
      // Forward-biased velocity with lateral jitter
      const spd = speed * (0.4 + Math.random() * 0.8);
      v[i*3+0] = d.x * spd + (Math.random() - 0.5) * speed * 0.5;
      v[i*3+1] = d.y * spd + Math.random() * speed * 0.3 + 1.5;
      v[i*3+2] = d.z * spd + (Math.random() - 0.5) * speed * 0.5;
    }
    slot.points.geometry.attributes.position.needsUpdate = true;
  }

  /**
   * Slow-rising smoke puff. Delegates to spawnBurst with low speed +
   * negative gravity so the cloud drifts upward instead of falling.
   */
  spawnSmoke(pos, opts = {}) {
    this.spawnBurst(pos, {
      count:    opts.count    ?? 7,
      color:    opts.color    ?? 0x777777,
      speed:    opts.speed    ?? 1.5,
      lifetime: opts.lifetime ?? 2.0,
      size:     opts.size     ?? 0.6,
      gravity:  -1,
    });
  }

  update(dt) {
    this._time += dt;

    // Animate ambient dust
    const dp = this._dustPositions;
    const dv = this._dustVelocities;
    const dc = dp.length / 3;
    for (let i = 0; i < dc; i++) {
      dp[i*3]   += dv[i*3]   * dt;
      dp[i*3+1] += dv[i*3+1] * dt;
      dp[i*3+2] += dv[i*3+2] * dt;
      if (dp[i*3+1] > 35) {
        dp[i*3]   = (Math.random() - 0.5) * 300;
        dp[i*3+1] = 2;
        dp[i*3+2] = (Math.random() - 0.5) * 300;
      }
    }
    this._dust.geometry.attributes.position.needsUpdate = true;

    // Update pooled burst emitters
    for (const slot of this._pool) {
      if (!slot.active) continue;
      slot.age += dt;

      slot.points.material.opacity = 1 - slot.age / slot.lifetime;

      const p = slot.positions;
      const v = slot.velocities;
      const c = slot.count;
      const g = slot.gravity;
      for (let i = 0; i < c; i++) {
        p[i*3+0] += v[i*3+0] * dt;
        p[i*3+1] += (v[i*3+1] - g * slot.age) * dt;
        p[i*3+2] += v[i*3+2] * dt;
      }
      slot.points.geometry.attributes.position.needsUpdate = true;

      if (slot.age >= slot.lifetime) {
        slot.active = false;
        slot.points.visible = false;
      }
    }
  }
}
