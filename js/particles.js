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
    const gravity  = opts.gravity  ?? 9;  // positive = down, negative = up (fire/smoke)

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

    // Clone shared material so per-emitter opacity fade doesn't affect others
    const mat = this._getBurstMaterial(color, size).clone();
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);

    this.emitters.push({
      points,
      positions,
      velocities,
      lifetime,
      age: 0,
      gravity,
    });
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
      const t = em.age / em.lifetime;
      em.points.material.opacity = 1 - t;

      const p = em.positions;
      for (let i = 0; i < p.length / 3; i++) {
        p[i * 3]     += em.velocities[i * 3]     * dt;
        p[i * 3 + 1] += (em.velocities[i * 3 + 1] - (em.gravity ?? 9) * em.age) * dt;
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
