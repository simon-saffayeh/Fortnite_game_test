import * as THREE from 'three';

const TOTAL_WAVES      = 10;
const INTERMISSION_SEC = 15;

function waveCount(w)  { return 3 + (w - 1) * 2; }         // 3,5,7…21
function waveHP(w)     { return Math.round(80 * (1 + (w - 1) * 0.32)); }
function waveDmgMult(w){ return 1 + (w - 1) * 0.22; }
function waveSpeed(w)  { return 1 + (w - 1) * 0.07; }      // subtle speed increase

// ── Zombie (melee undead) ────────────────────────────────────────────────────
const FOOT_OFFSET     = 0.42;
const DETECT_RANGE    = 130;   // zombies are relentless — they always find you
const SHAMBLE_SPEED   = 2.3;   // base chase speed, scaled by _spdMult
const LUNGE_SPEED     = 8.0;   // burst speed during a lunge
const LUNGE_RANGE     = 8.5;   // distance at which a lunge can trigger
const ATTACK_RANGE    = 2.0;   // melee reach
const ATTACK_COOLDOWN = 1.05;  // seconds between claw swings
const CLAW_DAMAGE     = 11;    // base, scaled by _dmgMult

// Group behaviour tunables
const ALERT_RADIUS    = 35;    // world units — a hit/spot spreads aggro this far
const SEP_RADIUS      = 1.8;   // minimum gap between two chasing zombies
const SEP_FORCE       = 4.0;   // lateral push strength for separation
const ALERT_FLASH_DUR = 0.40;  // seconds of orange flash on remote-alert

const Z_STATE = { WANDER: 0, CHASE: 1, ATTACK: 2, DEAD: 3 };

// Skin / clothing palettes per variant
const PAL = {
  normal: { SKIN: 0x6f7d59, SKIN_D: 0x55613f, SHIRT: 0x39362c, PANTS: 0x2a2620, BONE: 0xd9d2bd, BLOOD: 0x5a1212 },
  rager:  { SKIN: 0x8a2020, SKIN_D: 0x6a0808, SHIRT: 0x5a0000, PANTS: 0x2a0808, BONE: 0xd9d2bd, BLOOD: 0xcc2222 },
  bloater:{ SKIN: 0x4a7a2a, SKIN_D: 0x2a5010, SHIRT: 0x1a3a10, PANTS: 0x122208, BONE: 0xc8d2a0, BLOOD: 0x2a6a18 },
};
// HP bar colour gradient [high, mid, low] per variant
const HP_COLS = {
  normal: [0x7ac11f, 0xc9a01a, 0xb02020],
  rager:  [0xff3322, 0xcc1100, 0x660000],
  bloater:[0x55ee22, 0x88cc00, 0x224400],
};

export class Zombie {
  // variant: null / 'rager' / 'bloater'
  constructor(scene, world, position, variant = null) {
    this.scene     = scene;
    this.world     = world;
    this.health    = 80;
    this.maxHealth = 80;
    this.dead      = false;
    this.state     = Z_STATE.WANDER;
    this._variant  = variant;
    this.bloaterAoE = false; // set true in _die(); read by ZombieWaveManager.onKill

    this._dmgMult   = 1;
    this._spdMult   = 1;
    this._t         = Math.random() * 10;
    this._wanderT   = 0;
    this._wanderDir = Math.random() * Math.PI * 2;
    this._hitFlash  = 0;
    this._deathT    = 0;
    this._attackT      = 0;         // cooldown timer
    this._swing        = 0;         // claw-swing animation progress (0 idle)
    this._lungeT       = 0;         // remaining lunge-burst time
    // Ragers lunge twice as often
    this._lungeCD      = variant === 'rager'
      ? 0.8  + Math.random() * 1.2
      : 1.5  + Math.random() * 2.0;
    this._justAggroed  = false;     // set this frame when transitioning WANDER→CHASE
    this._alertFlash   = 0;         // orange flash timer for remote-aggro alert
    // Silhouette variation — bloaters are wide, ragers are lean
    this._scale = variant === 'bloater' ? 1.00 + Math.random() * 0.22
                : variant === 'rager'   ? 0.80 + Math.random() * 0.14
                :                         0.90 + Math.random() * 0.28;
    this._lean  = variant === 'rager'   ? 0.28 + Math.random() * 0.12
                :                         0.18 + Math.random() * 0.16;

    this._buildModel(position);
    this._buildHealthBar();
  }

  // ── Model ────────────────────────────────────────────────────────────────
  _buildModel(pos) {
    this.root = new THREE.Group();
    this.root.position.copy(pos);
    // Bloaters are wider in XZ but same height; ragers/normals uniform scale
    if (this._variant === 'bloater') {
      this.root.scale.set(this._scale * 1.38, this._scale, this._scale * 1.38);
    } else {
      this.root.scale.setScalar(this._scale);
    }
    this.scene.add(this.root);

    const lm = hex => new THREE.MeshLambertMaterial({ color: hex });
    const box = (w, h, d, hex, px, py, pz, parent) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lm(hex));
      mesh.position.set(px, py, pz);
      mesh.castShadow = true;
      (parent || this.root).add(mesh);
      return mesh;
    };

    const { SKIN, SKIN_D, SHIRT, PANTS, BONE, BLOOD } = PAL[this._variant ?? 'normal'];

    // ── Upper body leans forward (hunched) — wrap torso+head+arms in a lean group
    this._upper = new THREE.Group();
    this._upper.position.set(0, 0.92, 0);
    this._upper.rotation.x = this._lean;
    this.root.add(this._upper);

    // Torso — gaunt, ribs showing on one side
    box(0.58, 0.78, 0.36, SHIRT, 0, 0.30, 0, this._upper);
    box(0.30, 0.30, 0.30, SKIN_D, 0.16, 0.42, 0.16, this._upper);   // torn shoulder gap
    box(0.05, 0.40, 0.22, BONE, -0.20, 0.28, 0.16, this._upper);    // exposed ribs
    box(0.18, 0.16, 0.12, BLOOD, 0.05, 0.18, 0.19, this._upper);    // chest wound

    // Hips
    box(0.50, 0.22, 0.32, PANTS, 0, -0.08, 0);

    // Head — tilted, jaw hanging
    this._head = new THREE.Group();
    this._head.position.set(0.06, 0.78, 0.04);
    this._head.rotation.z = -0.28;
    this._upper.add(this._head);
    box(0.46, 0.46, 0.44, SKIN, 0, 0, 0, this._head);              // skull
    box(0.30, 0.12, 0.18, SKIN_D, 0, -0.26, 0.14, this._head);     // hanging jaw
    box(0.10, 0.10, 0.06, 0x111111, -0.10, 0.06, 0.22, this._head); // sunken eye
    box(0.10, 0.10, 0.06, 0xb02020,  0.11, 0.05, 0.22, this._head); // glowing eye
    box(0.18, 0.10, 0.10, BONE, 0, 0.24, -0.04, this._head);       // exposed scalp/bone

    // Arms — reaching forward, asymmetric lengths
    this._leftArm  = new THREE.Group();
    this._rightArm = new THREE.Group();
    this._leftArm.position.set(-0.36, 0.54, 0);
    this._rightArm.position.set( 0.36, 0.54, 0);
    // Both arms hang/reach forward
    this._leftArm.rotation.x  = -1.15;
    this._rightArm.rotation.x = -1.35;   // right reaches further
    this._upper.add(this._leftArm);
    this._upper.add(this._rightArm);
    // upper arm + forearm + claw hand
    box(0.17, 0.46, 0.17, SKIN,   0, -0.23, 0, this._leftArm);
    box(0.15, 0.40, 0.15, SKIN_D, 0, -0.62, 0, this._leftArm);
    box(0.18, 0.14, 0.20, SKIN,   0, -0.88, 0.02, this._leftArm);   // clawed hand
    box(0.17, 0.50, 0.17, SKIN,   0, -0.25, 0, this._rightArm);
    box(0.04, 0.30, 0.04, BONE,   0, -0.66, 0, this._rightArm);     // exposed forearm bone
    box(0.20, 0.14, 0.22, SKIN_D, 0, -0.94, 0.02, this._rightArm);  // clawed hand

    // Legs — one drags
    this._leftLeg  = new THREE.Group();
    this._rightLeg = new THREE.Group();
    this._leftLeg.position.set(-0.16, 0.72, 0);
    this._rightLeg.position.set( 0.16, 0.72, 0);
    this.root.add(this._leftLeg);
    this.root.add(this._rightLeg);
    box(0.22, 0.46, 0.22, PANTS, 0, -0.23, 0, this._leftLeg);
    box(0.20, 0.42, 0.20, SKIN,  0, -0.60, 0, this._leftLeg);
    box(0.24, 0.18, 0.32, 0x14130f, 0, -0.84, 0.04, this._leftLeg); // foot
    box(0.22, 0.46, 0.22, PANTS, 0, -0.23, 0, this._rightLeg);
    box(0.20, 0.42, 0.20, SKIN_D, 0, -0.60, 0, this._rightLeg);
    box(0.05, 0.20, 0.05, BONE,  0, -0.74, 0, this._rightLeg);      // shin bone poking out
    box(0.24, 0.18, 0.32, 0x14130f, 0, -0.84, 0.04, this._rightLeg);

    // Store meshes for hit-flash
    this._meshes = [];
    this.root.traverse(o => { if (o.isMesh) this._meshes.push(o); });
    this._origColors = this._meshes.map(m => m.material.color.getHex());
  }

  // ── Health bar ───────────────────────────────────────────────────────────
  _buildHealthBar() {
    this._hpGroup = new THREE.Group();
    this._hpGroup.position.y = 2.35;

    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.18),
      new THREE.MeshBasicMaterial({ color: 0x101805, side: THREE.DoubleSide, depthTest: false })
    );
    this._hpGroup.add(bg);

    const hpInitColor = HP_COLS[this._variant ?? 'normal'][0];
    this._hpFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.18),
      new THREE.MeshBasicMaterial({ color: hpInitColor, side: THREE.DoubleSide, depthTest: false })
    );
    this._hpFill.position.z = 0.005;
    this._hpGroup.add(this._hpFill);

    const outline = new THREE.Mesh(
      new THREE.PlaneGeometry(1.56, 0.24),
      new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.4 })
    );
    outline.position.z = -0.005;
    this._hpGroup.add(outline);

    this.root.add(this._hpGroup);
  }

  _updateHealthBar(camera) {
    const pct = Math.max(0, this.health / this.maxHealth);
    this._hpFill.scale.x = pct;
    this._hpFill.position.x = -(1 - pct) * 0.75;
    const [hi, mid, lo] = HP_COLS[this._variant ?? 'normal'];
    let c;
    if (pct > 0.5) c = new THREE.Color(hi).lerp(new THREE.Color(mid), (1 - pct) * 2);
    else           c = new THREE.Color(mid).lerp(new THREE.Color(lo), (0.5 - pct) * 2);
    this._hpFill.material.color.copy(c);
    if (camera) this._hpGroup.lookAt(camera.position);
  }

  // ── AI Update ────────────────────────────────────────────────────────────
  update(dt, player, projectileSystem, camera, allZombies = null) {
    if (this.dead) {
      this._deathT += dt;
      if (this._deathT < 0.5) {
        this.root.rotation.z = Math.min(Math.PI / 2, this._deathT / 0.5 * Math.PI / 2);
        this._upper.position.y = Math.max(0.2, 0.92 - this._deathT * 1.2);
      }
      if (this._deathT > 4) this.scene.remove(this.root);
      return;
    }

    this._t += dt;

    // Damage flash (white) takes priority over alert flash (orange)
    if (this._hitFlash > 0) {
      this._hitFlash -= dt;
      this._meshes.forEach((m, i) => m.material.color.setHex(this._hitFlash > 0 ? 0xffffff : this._origColors[i]));
    } else if (this._alertFlash > 0) {
      this._alertFlash -= dt;
      this._meshes.forEach((m, i) => m.material.color.setHex(this._alertFlash > 0 ? 0xff4400 : this._origColors[i]));
    }

    const pp = player.getPosition();
    const dx = pp.x - this.root.position.x;
    const dz = pp.z - this.root.position.z;
    const dist2D = Math.sqrt(dx * dx + dz * dz) || 0.0001;

    // State transitions — zombies lock on and never let go
    if (this.state === Z_STATE.WANDER && dist2D < DETECT_RANGE) {
      this.state = Z_STATE.CHASE;
      this._justAggroed = true;    // will spread to nearby wanderers
    }
    if (this.state === Z_STATE.CHASE  && dist2D < ATTACK_RANGE) this.state = Z_STATE.ATTACK;
    if (this.state === Z_STATE.ATTACK && dist2D > ATTACK_RANGE * 1.4) this.state = Z_STATE.CHASE;

    this._attackT = Math.max(0, this._attackT - dt);
    this._lungeT  = Math.max(0, this._lungeT - dt);
    this._lungeCD = Math.max(0, this._lungeCD - dt);

    let walking = false;
    switch (this.state) {
      case Z_STATE.WANDER: walking = this._doWander(dt);                          break;
      case Z_STATE.CHASE:  walking = this._doChase(dt, dx, dz, dist2D, allZombies); break;
      case Z_STATE.ATTACK: this._doAttack(dt, dx, dz, dist2D, player);             break;
    }

    this._animate(dt, walking);

    // Terrain snap
    const h = this.world.getTerrainHeight(this.root.position.x, this.root.position.z);
    this.root.position.y = h + FOOT_OFFSET;

    this._updateHealthBar(camera);
  }

  _doWander(dt) {
    this._wanderT -= dt;
    if (this._wanderT <= 0) {
      this._wanderDir += (Math.random() - 0.5) * 2.2;
      this._wanderT = 1.5 + Math.random() * 3;
    }
    const sp = SHAMBLE_SPEED * 0.3;
    const nx = Math.sin(this._wanderDir);
    const nz = Math.cos(this._wanderDir);
    const nextX = this.root.position.x + nx * sp * dt;
    const nextZ = this.root.position.z + nz * sp * dt;
    // Turn away when wander path leads into a building
    if (this._inBuilding(nextX, nextZ)) {
      this._wanderDir += Math.PI * 0.5 + (Math.random() - 0.5) * 1.2;
      this._wanderT = 1.0 + Math.random() * 1.5;
    } else {
      this.root.position.x = nextX;
      this.root.position.z = nextZ;
    }
    this.root.rotation.y = this._wanderDir;
    return true;
  }

  _doChase(dt, dx, dz, dist, allZombies = null) {
    let nx = dx / dist, nz = dz / dist;

    // Steer around building walls before committing to direction
    const steered = this._steerAroundWalls(nx, nz);
    nx = steered.x; nz = steered.z;
    this.root.rotation.y = Math.atan2(nx, nz);

    // Occasionally lunge — a sudden burst of speed that closes distance fast
    if (this._lungeT <= 0 && this._lungeCD <= 0 && dist < LUNGE_RANGE && dist > ATTACK_RANGE) {
      this._lungeT  = 0.55;
      this._lungeCD = 2.5 + Math.random() * 2.5;
    }
    const lunging = this._lungeT > 0;
    const speed = (lunging ? LUNGE_SPEED : SHAMBLE_SPEED) * this._spdMult;

    this.root.position.x += nx * speed * dt;
    this.root.position.z += nz * speed * dt;

    // Separation: push apart from nearby chasing zombies so they fan out
    if (allZombies) {
      for (const other of allZombies) {
        if (other === this || other.dead) continue;
        const odx = this.root.position.x - other.root.position.x;
        const odz = this.root.position.z - other.root.position.z;
        const odist = Math.sqrt(odx * odx + odz * odz);
        if (odist > 0 && odist < SEP_RADIUS) {
          const push = ((SEP_RADIUS - odist) / SEP_RADIUS) * SEP_FORCE;
          this.root.position.x += (odx / odist) * push * dt;
          this.root.position.z += (odz / odist) * push * dt;
        }
      }
    }

    return true;
  }

  // Returns true if world position (x, z) overlaps any static building box.
  // Margin 0.5 keeps zombies from hugging walls too tightly.
  _inBuilding(x, z) {
    for (const b of this.world.staticCollider._boxes) {
      if (Math.abs(x - b.cx) <= b.hw + 0.5 && Math.abs(z - b.cz) <= b.hd + 0.5) return true;
    }
    return false;
  }

  // Given desired direction (nx, nz), return a steered direction that avoids
  // the nearest building wall. Checks a look-ahead feeler; if blocked, tries
  // rotating in increasing steps until a clear heading is found.
  _steerAroundWalls(nx, nz) {
    const FEELER = 3.2;
    const px = this.root.position.x;
    const pz = this.root.position.z;

    if (!this._inBuilding(px + nx * FEELER, pz + nz * FEELER)) {
      return { x: nx, z: nz }; // direct path is clear
    }

    // Try rotating ±30°, ±60°, ±90°, ±120° until a clear heading is found
    const steps = [Math.PI/6, -Math.PI/6, Math.PI/3, -Math.PI/3,
                   Math.PI/2, -Math.PI/2, Math.PI*2/3, -Math.PI*2/3];
    for (const a of steps) {
      const cos = Math.cos(a), sin = Math.sin(a);
      const sx = nx * cos - nz * sin;
      const sz = nx * sin + nz * cos;
      if (!this._inBuilding(px + sx * FEELER, pz + sz * FEELER)) {
        return { x: sx, z: sz };
      }
    }
    return { x: -nx, z: -nz }; // fully blocked — back off
  }

  _doAttack(dt, dx, dz, dist, player) {
    this.root.rotation.y = Math.atan2(dx, dz);
    this._lungeT = 0;

    // Shuffle the final inches to stay in reach
    if (dist > ATTACK_RANGE * 0.7) {
      const nx = dx / dist, nz = dz / dist;
      const sp = SHAMBLE_SPEED * 0.6 * this._spdMult;
      this.root.position.x += nx * sp * dt;
      this.root.position.z += nz * sp * dt;
    }

    // Claw swing on cooldown — damage lands at the mid-point of the swing
    if (this._attackT <= 0) {
      this._attackT = ATTACK_COOLDOWN;
      this._swing   = 1;
      if (dist < ATTACK_RANGE * 1.2) {
        const dmg = CLAW_DAMAGE * this._dmgMult;
        const src = this.root.position.clone();
        player.takeDamage(dmg, false, src, 'a zombie');
      }
    }
  }

  _animate(dt, walking) {
    // Claw swing animation — decays back to reach pose
    if (this._swing > 0) {
      this._swing = Math.max(0, this._swing - dt * 3.5);
      const s = Math.sin((1 - this._swing) * Math.PI); // 0→1→0
      this._rightArm.rotation.x = -1.35 - s * 1.1;
      this._leftArm.rotation.x  = -1.15 - s * 0.5;
      this._rightArm.rotation.z =  s * 0.5;
    } else if (this.state === Z_STATE.CHASE || this.state === Z_STATE.ATTACK) {
      // Reaching-forward arm sway
      const sway = Math.sin(this._t * 4) * 0.18;
      this._leftArm.rotation.x  = THREE.MathUtils.lerp(this._leftArm.rotation.x,  -1.15 + sway, dt * 8);
      this._rightArm.rotation.x = THREE.MathUtils.lerp(this._rightArm.rotation.x, -1.35 - sway, dt * 8);
      this._rightArm.rotation.z = THREE.MathUtils.lerp(this._rightArm.rotation.z, 0, dt * 8);
    }

    // Shambling gait — asymmetric, one leg drags
    if (walking) {
      const pace = this.state === Z_STATE.WANDER ? 3.2 : 5.0;
      const swing = Math.sin(this._t * pace);
      this._leftLeg.rotation.x  =  swing * 0.5;
      this._rightLeg.rotation.x = -Math.max(-0.15, swing) * 0.32;  // right leg drags
      this._upper.position.y = 0.92 + Math.abs(swing) * 0.05;       // limping bob
      this._head.rotation.x  = Math.sin(this._t * pace * 0.5) * 0.08;
    } else {
      this._leftLeg.rotation.x  *= 0.9;
      this._rightLeg.rotation.x *= 0.9;
    }
  }

  takeDamage(amount) {
    if (this.dead) return;
    this.health -= amount;
    this._hitFlash = 0.1;
    // Being hit aggressively overrides any passive wandering
    if (this.state === Z_STATE.WANDER) {
      this.state = Z_STATE.CHASE;
      this._justAggroed = true;
    }
    if (this.health <= 0) { this.health = 0; this._die(); }
  }

  _die() {
    this.dead = true;
    this._hpGroup.visible = false;
    if (this._variant === 'bloater') this.bloaterAoE = true;
    if (this.onDeath) this.onDeath(this);
  }
}

// ── ZombieWaveManager ────────────────────────────────────────────────────────
export class ZombieWaveManager {
  constructor(scene, world, projectiles) {
    this.scene       = scene;
    this.world       = world;
    this.projectiles = projectiles;
    this.enemies     = [];
    this._particles  = null; // set via setParticles() by Game

    this.wave        = 0;
    this.state       = 'intermission'; // 'fighting' | 'intermission' | 'complete'
    this._timer      = 5;              // 5-second countdown before wave 1

    // Callbacks wired by Game
    this.onKill               = null; // (enemy) => void
    this.onWaveStart          = null; // (waveNum) => void
    this.onWaveEnd            = null; // (waveNum) => void
    this.onAllWavesComplete   = null; // () => void
    this.onIntermissionTick   = null; // (secsLeft, waveNum) => void
  }

  setParticles(ps) { this._particles = ps; }

  get aliveCount() { return this.enemies.filter(e => !e.dead).length; }

  _spawnWave(w) {
    const count    = waveCount(w);
    const hp       = waveHP(w);
    const dmgMult  = waveDmgMult(w);
    const spdMult  = waveSpeed(w);
    const S        = this.world.size * 0.38;
    const baseR    = 55 + w * 4;

    // Variant probability ramps up with wave number.
    // Ragers appear from wave 4; bloaters from wave 6.
    const ragerChance   = Math.min(0.40, Math.max(0, (w - 3) * 0.09));
    const bloaterChance = Math.min(0.28, Math.max(0, (w - 5) * 0.07));

    let spawned = 0, attempts = 0;
    while (spawned < count && attempts < count * 8) {
      attempts++;
      const angle = Math.random() * Math.PI * 2;
      const dist  = baseR + (Math.random() - 0.5) * 20;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      if (Math.abs(x) > S || Math.abs(z) > S) continue;
      const h = this.world.getTerrainHeight(x, z);
      if (h < 0.8) continue;

      // Roll variant
      const roll = Math.random();
      const variant = roll < bloaterChance        ? 'bloater'
                    : roll < bloaterChance + ragerChance ? 'rager'
                    : null;

      const e = new Zombie(this.scene, this.world, new THREE.Vector3(x, h + FOOT_OFFSET, z), variant);
      // Stats scaled by variant: rager = fast/fragile; bloater = slow/tanky
      e.health    = variant === 'rager'   ? Math.round(hp * 0.55)
                  : variant === 'bloater' ? Math.round(hp * 2.20)
                  : hp;
      e.maxHealth = e.health;
      e._dmgMult  = variant === 'rager'   ? dmgMult * 0.80
                  : variant === 'bloater' ? dmgMult * 1.40
                  : dmgMult;
      e._spdMult  = variant === 'rager'   ? spdMult * 1.70
                  : variant === 'bloater' ? spdMult * 0.55
                  : spdMult;
      e.onDeath   = (enemy) => { if (this.onKill) this.onKill(enemy); };
      this.enemies.push(e);
      spawned++;
    }
  }

  _startNextWave() {
    this.wave++;
    this._spawnWave(this.wave);
    this.state = 'fighting';
    if (this.onWaveStart) this.onWaveStart(this.wave);
  }

  update(dt, player, camera) {
    for (const e of this.enemies) {
      e.update(dt, player, this.projectiles, camera, this.enemies);
    }

    // ── Group aggro spread ────────────────────────────────────────────────
    // Any zombie that just transitioned WANDER→CHASE (spotted player or was
    // shot) broadcasts its position: wandering zombies within ALERT_RADIUS
    // immediately join the chase with an orange alert flash.
    for (const e of this.enemies) {
      if (!e._justAggroed) continue;
      e._justAggroed = false;
      const ex = e.root.position.x, ez = e.root.position.z;
      const rSq = ALERT_RADIUS * ALERT_RADIUS;
      for (const other of this.enemies) {
        if (other === e || other.dead || other.state !== Z_STATE.WANDER) continue;
        const dx = other.root.position.x - ex;
        const dz = other.root.position.z - ez;
        if (dx * dx + dz * dz < rSq) {
          other.state = Z_STATE.CHASE;
          other._alertFlash = ALERT_FLASH_DUR;
        }
      }
    }

    if (this.state === 'fighting') {
      if (this.enemies.length > 0 && this.aliveCount === 0) {
        if (this.wave >= TOTAL_WAVES) {
          this.state = 'complete';
          if (this.onAllWavesComplete) this.onAllWavesComplete();
        } else {
          this.state  = 'intermission';
          this._timer = INTERMISSION_SEC;
          if (this.onWaveEnd) this.onWaveEnd(this.wave);
        }
      }
    } else if (this.state === 'intermission') {
      this._timer -= dt;
      if (this.onIntermissionTick) {
        this.onIntermissionTick(Math.max(0, Math.ceil(this._timer)), this.wave + 1);
      }
      if (this._timer <= 0) this._startNextWave();
    }
  }

  get totalWaves() { return TOTAL_WAVES; }
}
