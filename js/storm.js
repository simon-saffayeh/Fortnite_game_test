import * as THREE from 'three';

// Each phase: wait N seconds still, then shrink over shrinkTime seconds to endRadius
const PHASES = [
  { endRadius: 240, waitTime: 30, shrinkTime: 20, dmgPerSec: 0.6 },
  { endRadius: 130, waitTime: 20, shrinkTime: 15, dmgPerSec: 1.2 },
  { endRadius:  60, waitTime: 14, shrinkTime: 12, dmgPerSec: 2.5 },
  { endRadius:  18, waitTime: 10, shrinkTime:  8, dmgPerSec: 5.0 },
];

const START_RADIUS = 340;
const CENTER       = new THREE.Vector3(18, 0, -12);
const WALL_HEIGHT  = 350;
// Delay before the storm visually appears or deals damage — covers the
// battle bus's flight across the map so it doesn't pass through the wall.
const STORM_DELAY  = 12;

export class Storm {
  constructor(scene) {
    this.scene         = scene;
    this.currentRadius = START_RADIUS;
    this.center        = CENTER.clone();
    this.phaseIndex    = 0;
    this.phaseState    = 'waiting'; // 'waiting' | 'shrinking' | 'done'
    this.phaseTimer    = PHASES[0].waitTime;
    this.playerOutside = false;
    this._dmgTimer     = 0;
    this._elapsed      = 0;         // seconds since the storm clock started
    this._clockStart   = null;      // performance.now() anchor (multiplayer)

    this._buildVisual();
    this._buildRain();
    this._buildOverlays();
  }

  // Anchor the storm clock to a shared performance.now() timestamp. In
  // multiplayer every client passes the same game-start moment, so _elapsed is
  // recomputed from it each frame — no accumulation drift, no dependence on
  // per-machine load time. Solo leaves this null and just accumulates dt.
  setClockStart(perfTimestamp) {
    this._clockStart = perfTimestamp;
    this._elapsed = Math.max(0, (performance.now() - perfTimestamp) / 1000);
    this._recompute();
  }

  // Derive phase / radius / countdown purely from _elapsed — makes the storm
  // state a pure function of time, so it's identical wherever the clock matches.
  _recompute() {
    // Initial grace period: storm is invisible and inert while the bus
    // crosses the map. Reports as 'pending' so HUD/map can hide it.
    if (this._elapsed < STORM_DELAY) {
      this.phaseIndex    = 0;
      this.phaseState    = 'pending';
      this.currentRadius = START_RADIUS;
      this.phaseTimer    = STORM_DELAY - this._elapsed;
      return;
    }

    let t = this._elapsed - STORM_DELAY;
    let radiusFrom = START_RADIUS;
    for (let i = 0; i < PHASES.length; i++) {
      const ph = PHASES[i];
      if (t < ph.waitTime) {
        this.phaseIndex = i;
        this.phaseState = 'waiting';
        this.currentRadius = radiusFrom;
        this.phaseTimer = ph.waitTime - t;
        return;
      }
      t -= ph.waitTime;
      if (t < ph.shrinkTime) {
        this.phaseIndex = i;
        this.phaseState = 'shrinking';
        this.currentRadius = THREE.MathUtils.lerp(radiusFrom, ph.endRadius, t / ph.shrinkTime);
        this.phaseTimer = ph.shrinkTime - t;
        return;
      }
      t -= ph.shrinkTime;
      radiusFrom = ph.endRadius;
    }
    this.phaseIndex    = PHASES.length - 1;
    this.phaseState    = 'done';
    this.currentRadius = PHASES[PHASES.length - 1].endRadius;
    this.phaseTimer    = 9999;
  }

  _buildVisual() {
    // Normalized radius=1 cylinder, scaled each frame
    const wallGeo = new THREE.CylinderGeometry(1, 1, WALL_HEIGHT, 80, 1, true);
    this._wall = new THREE.Mesh(wallGeo, new THREE.MeshBasicMaterial({
      color: 0x3355ff,
      transparent: true,
      opacity: 0.38,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    this._wall.position.copy(this.center);
    this.scene.add(this._wall);

    // Storm ceiling disc (dark cloud cap)
    const capGeo = new THREE.CircleGeometry(1, 80);
    this._cap = new THREE.Mesh(capGeo, new THREE.MeshBasicMaterial({
      color: 0x1122aa,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    this._cap.rotation.x = -Math.PI / 2;
    this._cap.position.set(this.center.x, WALL_HEIGHT / 2 - 1, this.center.z);
    this.scene.add(this._cap);

    // Storm lightning flashes — random bright lines on the wall
    this._flashes = [];
    for (let i = 0; i < 8; i++) {
      const pts = [new THREE.Vector3(0, -20, 0), new THREE.Vector3(2, -60, 1)];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const flash = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0xaaccff, transparent: true, opacity: 0, linewidth: 2,
      }));
      this.scene.add(flash);
      this._flashes.push({ mesh: flash, timer: 0, interval: 1.5 + Math.random() * 3 });
    }
  }

  /**
   * Build a Points-based rain field that follows the camera. Particles live
   * in a 60×40×60 box around the camera (slanted by the wind), recycled when
   * they fall below ground. Cheap — single draw call, 250 vertices.
   * Visible only outside the storm circle (where the weather is "bad").
   */
  _buildRain() {
    const N = 250;
    const positions = new Float32Array(N * 3);
    const velocities = new Float32Array(N);   // per-particle Y speed
    for (let i = 0; i < N; i++) {
      positions[i*3 + 0] = (Math.random() - 0.5) * 60;
      positions[i*3 + 1] =  Math.random() * 40;
      positions[i*3 + 2] = (Math.random() - 0.5) * 60;
      velocities[i] = 35 + Math.random() * 15;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xaabbcc, size: 0.16,
      transparent: true, opacity: 0.55,
      depthWrite: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;        // box is camera-relative; never cull
    pts.visible = false;
    this.scene.add(pts);
    this._rain = { mesh: pts, geo, positions, velocities, count: N };
  }

  _buildOverlays() {
    // Purple vignette when outside storm
    this._outsideOverlay = document.createElement('div');
    this._outsideOverlay.style.cssText = `
      position:fixed;inset:0;pointer-events:none;z-index:5;opacity:0;
      background:radial-gradient(ellipse at center, transparent 28%, rgba(40,0,110,0.72) 100%);
      transition:opacity 0.4s;
    `;
    document.body.appendChild(this._outsideOverlay);

    // Pulsing damage flash
    this._dmgFlash = document.createElement('div');
    this._dmgFlash.style.cssText = `
      position:fixed;inset:0;pointer-events:none;z-index:6;opacity:0;
      background:radial-gradient(ellipse at center, transparent 18%, rgba(90,0,200,0.75) 100%);
    `;
    document.body.appendChild(this._dmgFlash);
  }

  // applyDamage is false during the deploy phase — the storm clock keeps
  // advancing (so it stays synced) but airborne players take no damage.
  update(dt, player, applyDamage = true) {
    if (this._clockStart != null) {
      this._elapsed = Math.max(0, (performance.now() - this._clockStart) / 1000);
    } else {
      this._elapsed += dt;
    }
    this._recompute();

    // ── Visibility: hidden during the pre-storm grace period ──────────────
    const pending = this.phaseState === 'pending';
    const showWall = !pending;
    this._wall.visible = showWall;
    this._cap.visible  = showWall;
    for (const f of this._flashes) f.mesh.visible = showWall;

    if (pending) {
      this._outsideOverlay.style.opacity = '0';
      this._dmgFlash.style.opacity = '0';
      this._dmgTimer = 0;
      this.playerOutside = false;
      return;
    }

    // ── Scale meshes ──────────────────────────────────────────────────────
    const r = this.currentRadius;
    this._wall.scale.set(r, 1, r);
    this._cap.scale.set(r, r, r);

    // Animate wall pulsing
    const pulse = 0.30 + Math.sin(Date.now() * 0.0022) * 0.10;
    this._wall.material.opacity = pulse;

    // Lightning flashes
    this._animateFlashes(dt, r);

    // ── Player damage ─────────────────────────────────────────────────────
    const pp = player.getPosition();

    const dx = pp.x - this.center.x;
    const dz = pp.z - this.center.z;
    this.playerOutside = Math.sqrt(dx * dx + dz * dz) > this.currentRadius;

    // Rain field — only when the local player is actually in the damage zone
    // AND damage is being applied (suppresses rain during bus/skydive even
    // though the storm clock keeps running). Box recentered each frame.
    this._animateRain(dt, pp, this.playerOutside && applyDamage);

    if (this.playerOutside && applyDamage) {
      this._outsideOverlay.style.opacity = '1';
      this._dmgTimer += dt;
      const pulseAmt = 0.3 + Math.sin(Date.now() * 0.005) * 0.25;
      this._dmgFlash.style.opacity = pulseAmt.toFixed(3);

      // Tick damage every 0.5 s
      while (this._dmgTimer >= 0.5) {
        this._dmgTimer -= 0.5;
        const dmg = this._currentDmg() * 0.5;
        player.takeDamage(dmg, true, null, 'the storm');
      }
    } else {
      this._outsideOverlay.style.opacity = '0';
      this._dmgFlash.style.opacity = '0';
      this._dmgTimer = 0;
    }
  }

  /**
   * Update the rain Points. Box is camera-relative so we never need to
   * frustum-cull or maintain global rain over the whole 800m map.
   * Visibility tracks whether the player is outside the safe circle.
   */
  _animateRain(dt, playerPos, shouldShow) {
    if (!this._rain) return;
    this._rain.mesh.visible = !!shouldShow;
    if (!shouldShow) return;
    const pos = this._rain.positions;
    const vel = this._rain.velocities;
    const n   = this._rain.count;
    // Slight horizontal wind for visual interest.
    const windX = 4 * dt;
    for (let i = 0; i < n; i++) {
      const ix = i * 3;
      pos[ix + 0] += windX;
      pos[ix + 1] -= vel[i] * dt;
      // Recycle when below ground or out of box bounds.
      if (pos[ix + 1] < -1) {
        pos[ix + 0] = (Math.random() - 0.5) * 60;
        pos[ix + 1] =  20 + Math.random() * 20;
        pos[ix + 2] = (Math.random() - 0.5) * 60;
      } else if (pos[ix + 0] > 30) {
        pos[ix + 0] = -30;
      }
    }
    this._rain.geo.attributes.position.needsUpdate = true;
    // Keep the rain box recentered on the player so particles always feel
    // local. Y stays at player height for natural alignment.
    this._rain.mesh.position.set(playerPos.x, playerPos.y, playerPos.z);
  }

  _animateFlashes(dt, radius) {
    for (const f of this._flashes) {
      f.timer -= dt;
      if (f.timer <= 0) {
        f.interval = 1.2 + Math.random() * 3.5;
        f.timer    = f.interval;
        // Reposition on wall surface
        const angle = Math.random() * Math.PI * 2;
        const x = this.center.x + Math.cos(angle) * radius;
        const z = this.center.z + Math.sin(angle) * radius;
        const yTop = 20 + Math.random() * 60;
        const yBot = yTop - 30 - Math.random() * 40;
        const pts = [
          new THREE.Vector3(x, yTop, z),
          new THREE.Vector3(x + (Math.random() - 0.5) * 4, (yTop + yBot) / 2, z + (Math.random() - 0.5) * 4),
          new THREE.Vector3(x, yBot, z),
        ];
        f.mesh.geometry.setFromPoints(pts);
        f.mesh.material.opacity = 0.9;
      }
      // Fade flash
      f.mesh.material.opacity = Math.max(0, f.mesh.material.opacity - dt * 4);
    }
  }

  _currentDmg() {
    const idx = Math.min(this.phaseIndex, PHASES.length - 1);
    return PHASES[idx].dmgPerSec;
  }

  getInfo() {
    const phase = Math.min(this.phaseIndex + 1, PHASES.length);
    return {
      radius: this.currentRadius,
      center: this.center,
      phase,
      state: this.phaseState,
      timeLeft: Math.ceil(Math.max(0, this.phaseTimer)),
      playerOutside: this.playerOutside,
      dmgPerSec: this._currentDmg(),
    };
  }
}
