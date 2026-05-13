import * as THREE from 'three';

// Each phase: wait N seconds still, then shrink over shrinkTime seconds to endRadius
const PHASES = [
  { endRadius: 240, waitTime: 60, shrinkTime: 35, dmgPerSec: 0.6 },
  { endRadius: 130, waitTime: 40, shrinkTime: 28, dmgPerSec: 1.2 },
  { endRadius:  60, waitTime: 28, shrinkTime: 22, dmgPerSec: 2.5 },
  { endRadius:  18, waitTime: 20, shrinkTime: 16, dmgPerSec: 5.0 },
];

const START_RADIUS = 340;
const CENTER       = new THREE.Vector3(18, 0, -12);
const WALL_HEIGHT  = 350;

export class Storm {
  constructor(scene) {
    this.scene         = scene;
    this.currentRadius = START_RADIUS;
    this.center        = CENTER.clone();
    this.phaseIndex    = 0;
    this.phaseState    = 'waiting'; // 'waiting' | 'shrinking'
    this.phaseTimer    = PHASES[0].waitTime;
    this.playerOutside = false;
    this._dmgTimer     = 0;
    this._shrinkFrom   = START_RADIUS;

    this._buildVisual();
    this._buildOverlays();
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

    // Softer outer glow ring (slightly larger)
    const glowGeo = new THREE.CylinderGeometry(1, 1, WALL_HEIGHT, 80, 1, true);
    this._glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({
      color: 0x8844ff,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    this._glow.position.copy(this.center);
    this.scene.add(this._glow);

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

  update(dt, player) {
    // ── Radius logic ──────────────────────────────────────────────────────
    this.phaseTimer -= dt;

    if (this.phaseTimer <= 0) {
      if (this.phaseState === 'waiting') {
        this.phaseState  = 'shrinking';
        this._shrinkFrom = this.currentRadius;
        this.phaseTimer  = PHASES[this.phaseIndex].shrinkTime;
      } else {
        // finished shrinking
        this.currentRadius = PHASES[this.phaseIndex].endRadius;
        this.phaseIndex++;
        if (this.phaseIndex < PHASES.length) {
          this.phaseState = 'waiting';
          this.phaseTimer = PHASES[this.phaseIndex].waitTime;
        } else {
          this.phaseState = 'done';
          this.phaseTimer = 9999;
        }
      }
    }

    if (this.phaseState === 'shrinking' && this.phaseIndex < PHASES.length) {
      const total = PHASES[this.phaseIndex].shrinkTime;
      const t = 1 - this.phaseTimer / total;
      this.currentRadius = THREE.MathUtils.lerp(
        this._shrinkFrom,
        PHASES[this.phaseIndex].endRadius,
        Math.min(1, t)
      );
    }

    // ── Scale meshes ──────────────────────────────────────────────────────
    const r = this.currentRadius;
    this._wall.scale.set(r, 1, r);
    this._glow.scale.set(r + 10, 1, r + 10);
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

    if (this.playerOutside) {
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
