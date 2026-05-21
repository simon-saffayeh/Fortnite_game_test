import * as THREE from 'three';

/**
 * ParticleSystem — lightweight GPU-friendly particle effects.
 * Uses BufferGeometry + Points for performance.
 * Supports: dust, explosion, sparkle, footstep — extensible.
 */
export class ParticleSystem {
  constructor(scene) {
    this.scene  = scene;
    this.emitters = [];
    this._time = 0;

    // Ambient floating dust particles across the island
    this._buildAmbientDust();
  }

  _buildAmbientDust() {
    const count = 350;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors    = new Float32Array(count * 3);
    const scales    = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 300;
      positions[i * 3 + 1] = Math.random() * 30 + 2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 300;

      // Soft golden dust colour
      colors[i * 3]     = 0.9 + Math.random() * 0.1;
      colors[i * 3 + 1] = 0.85 + Math.random() * 0.1;
      colors[i * 3 + 2] = 0.6 + Math.random() * 0.2;

      scales[i] = Math.random();
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
    this._dustPositions = positions;
    this._dustVelocities = new Float32Array(count * 3);

    // Random drift velocities
    for (let i = 0; i < count; i++) {
      this._dustVelocities[i * 3]     = (Math.random() - 0.5) * 0.4;
      this._dustVelocities[i * 3 + 1] = Math.random() * 0.15 + 0.05;
      this._dustVelocities[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
    }

    this.scene.add(this._dust);
  }

  /**
   * Spawn a burst emitter (explosion, impact, etc.)
   * @param {THREE.Vector3} pos
   * @param {object} opts - { count, color, speed, lifetime, size }
   */
  _getBurstMaterial(color, size) {
    if (!this._burstMatCache) this._burstMatCache = new Map();
    const key = `${color}_${size}`;
    let mat = this._burstMatCache.get(key);
    if (!mat) {
      mat = new THREE.PointsMaterial({
        size, color, transparent: true, opacity: 1, depthWrite: false,
      });
      this._burstMatCache.set(key, mat);
    }
    return mat;
  }

  spawnBurst(pos, opts = {}) {
    const count    = opts.count    || 24;
    const color    = opts.color    || 0xffaa33;
    const speed    = opts.speed    || 5;
    const lifetime = opts.lifetime || 0.8;
    const size     = opts.size     || 0.4;
    const gravity  = opts.gravity  ?? 9;

    const geo = new THREE.BufferGeometry();
    const positions  = new Float32Array(count * 3);
    const velocities = [];

    for (let i = 0; i < count; i++) {
      positions[i * 3]     = pos.x;
      positions[i * 3 + 1] = pos.y;
      positions[i * 3 + 2] = pos.z;
      velocities.push(
        (Math.random() - 0.5) * speed * 2,
        Math.random() * speed,
        (Math.random() - 0.5) * speed * 2
      );
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = this._getBurstMaterial(color, size).clone();
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);

    this.emitters.push({ points, positions, velocities, lifetime, age: 0, gravity });
  }

  /**
   * Directional spark spray — particles arc in a cone around `dir` and fall
   * under gravity. Used for muzzle sparks, bullet ricochets, impact chips.
   * @param {THREE.Vector3} pos   world origin
   * @param {THREE.Vector3} dir   normalised spray direction
   * @param {object}        opts  count, color, speed, lifetime, size, spread (0‒1)
   */
  spawnSparks(pos, dir, opts = {}) {
    const count    = opts.count    || 12;
    const color    = opts.color    || 0xffcc55;
    const speed    = opts.speed    || 9;
    const lifetime = opts.lifetime || 0.38;
    const size     = opts.size     || 0.07;
    const spread   = opts.spread   ?? 0.7; // lateral cone fraction (0=laser, 1=sphere)

    const d  = dir.clone().normalize();
    const up = Math.abs(d.y) < 0.9
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(d, up).normalize();
    const upDir = new THREE.Vector3().crossVectors(right, d).normalize();

    const geo = new THREE.BufferGeometry();
    const positions  = new Float32Array(count * 3);
    const velocities = [];

    for (let i = 0; i < count; i++) {
      positions[i * 3]     = pos.x;
      positions[i * 3 + 1] = pos.y;
      positions[i * 3 + 2] = pos.z;

      const fwd  = 1 - spread * Math.random();       // forward weight
      const ang  = Math.random() * Math.PI * 2;
      const side = spread * Math.random();
      const spd  = speed * (0.4 + Math.random() * 0.8);

      velocities.push(
        (d.x * fwd + right.x * Math.cos(ang) * side + upDir.x * Math.sin(ang) * side) * spd,
        (d.y * fwd + right.y * Math.cos(ang) * side + upDir.y * Math.sin(ang) * side) * spd + 1.5,
        (d.z * fwd + right.z * Math.cos(ang) * side + upDir.z * Math.sin(ang) * side) * spd,
      );
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({ size, color, transparent: true, opacity: 1, depthWrite: false });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.emitters.push({ points, positions, velocities, lifetime, age: 0, gravity: 14 });
  }

  /**
   * Slowly rising smoke puff — low gravity, large soft particles that fade out.
   * Used after explosions and building hits to leave a lingering plume.
   */
  spawnSmoke(pos, opts = {}) {
    const count    = opts.count    || 7;
    const color    = opts.color    || 0x777777;
    const speed    = opts.speed    || 1.8;
    const lifetime = opts.lifetime || 2.2;
    const size     = opts.size     || 0.75;

    const geo = new THREE.BufferGeometry();
    const positions  = new Float32Array(count * 3);
    const velocities = [];

    for (let i = 0; i < count; i++) {
      positions[i * 3]     = pos.x + (Math.random() - 0.5) * 0.4;
      positions[i * 3 + 1] = pos.y + Math.random() * 0.3;
      positions[i * 3 + 2] = pos.z + (Math.random() - 0.5) * 0.4;
      velocities.push(
        (Math.random() - 0.5) * speed * 0.5,
        speed * (0.5 + Math.random() * 0.6),
        (Math.random() - 0.5) * speed * 0.5,
      );
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      size, color, transparent: true, opacity: 0.55, depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    // gravity: -1 = slight upward acceleration (smoke rises faster over time)
    this.emitters.push({ points, positions, velocities, lifetime, age: 0, gravity: -1, startOpacity: 0.55 });
  }

  update(dt) {
    this._time += dt;

    // Animate ambient dust
    const dp = this._dustPositions;
    const dv = this._dustVelocities;
    const count = dp.length / 3;
    for (let i = 0; i < count; i++) {
      dp[i * 3]     += dv[i * 3]     * dt;
      dp[i * 3 + 1] += dv[i * 3 + 1] * dt;
      dp[i * 3 + 2] += dv[i * 3 + 2] * dt;

      // Wrap around
      if (dp[i * 3 + 1] > 35) {
        dp[i * 3]     = (Math.random() - 0.5) * 300;
        dp[i * 3 + 1] = 2;
        dp[i * 3 + 2] = (Math.random() - 0.5) * 300;
      }
    }
    this._dust.geometry.attributes.position.needsUpdate = true;

    // Update burst emitters
    for (const em of this.emitters) {
      em.age += dt;
      const t   = em.age / em.lifetime;
      const g   = em.gravity ?? 9;
      const opk = em.startOpacity ?? 1;
      em.points.material.opacity = opk * (1 - t);

      const p = em.positions;
      for (let i = 0; i < p.length / 3; i++) {
        p[i * 3]     += em.velocities[i * 3]     * dt;
        p[i * 3 + 1] += (em.velocities[i * 3 + 1] - g * em.age) * dt;
        p[i * 3 + 2] += em.velocities[i * 3 + 2] * dt;
      }
      em.points.geometry.attributes.position.needsUpdate = true;
    }

    // Remove expired emitters
    const dead = this.emitters.filter(e => e.age >= e.lifetime);
    dead.forEach(e => {
      this.scene.remove(e.points);
      e.points.geometry.dispose();
      e.points.material.dispose();
    });
    this.emitters = this.emitters.filter(e => e.age < e.lifetime);
  }
}
