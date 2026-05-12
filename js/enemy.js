import * as THREE from 'three';

const FOOT_OFFSET    = 0.42;
const DETECT_RANGE   = 65;
const ATTACK_RANGE   = 40;
const LOSE_RANGE     = DETECT_RANGE * 1.4;
const MOVE_SPEED     = 4.8;
const SHOOT_INTERVAL = 2.0;
const PATROL_SPEED   = MOVE_SPEED * 0.38;

const STATE = { PATROL: 0, CHASE: 1, ATTACK: 2, DEAD: 3 };

// ── Enemy ────────────────────────────────────────────────────────────────────
class Enemy {
  constructor(scene, world, position) {
    this.scene     = scene;
    this.world     = world;
    this.health    = 100;
    this.maxHealth = 100;
    this.dead      = false;
    this.state     = STATE.PATROL;
    this._t        = Math.random() * 10;
    this._shootT   = Math.random() * SHOOT_INTERVAL;
    this._patrolT  = 0;
    this._spawnPos = position.clone();
    this._patrolDest = position.clone();
    this._hitFlash  = 0;
    this._deathT    = 0;
    this._strafeT   = Math.random() * 1.5;
    this._strafeDir = Math.random() > 0.5 ? 1 : -1;
    this._strafeVel = 0;

    this._buildModel(position);
    this._buildHealthBar();
  }

  // ── Model ────────────────────────────────────────────────────────────────
  _buildModel(pos) {
    this.root = new THREE.Group();
    this.root.position.copy(pos);
    this.scene.add(this.root);

    const lm = hex => new THREE.MeshLambertMaterial({ color: hex });
    const box = (w, h, d, hex, px, py, pz) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lm(hex));
      mesh.position.set(px, py, pz);
      mesh.castShadow = true;
      return mesh;
    };

    // Head
    this.root.add(box(0.54, 0.54, 0.50, 0xc8906a, 0, 1.90, 0));
    // Helmet
    const helm = new THREE.Mesh(
      new THREE.SphereGeometry(0.33, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.58),
      lm(0x8b0000)
    );
    helm.position.set(0, 1.96, 0);
    this.root.add(helm);
    // Visor strip
    this.root.add(box(0.50, 0.10, 0.06, 0x222244, 0, 1.82, 0.27));

    // Torso
    this.root.add(box(0.64, 0.84, 0.42, 0x7a0000, 0, 1.28, 0));
    this.root.add(box(0.66, 0.12, 0.44, 0x282828, 0, 0.88, 0)); // belt

    // Shoulder plates
    this.root.add(box(0.22, 0.16, 0.26, 0x660000, -0.48, 1.64, 0));
    this.root.add(box(0.22, 0.16, 0.26, 0x660000,  0.48, 1.64, 0));

    // Arms
    this._leftArm  = new THREE.Group(); this._leftArm.position.set(-0.46, 1.28, 0);
    this._rightArm = new THREE.Group(); this._rightArm.position.set( 0.46, 1.28, 0);
    this._leftArm.add(box(0.20, 0.78, 0.20, 0x6a0000, 0, -0.39, 0));
    this._rightArm.add(box(0.20, 0.78, 0.20, 0x6a0000, 0, -0.39, 0));
    this.root.add(this._leftArm);
    this.root.add(this._rightArm);

    // Legs
    this._leftLeg  = new THREE.Group(); this._leftLeg.position.set(-0.19, 0.74, 0);
    this._rightLeg = new THREE.Group(); this._rightLeg.position.set( 0.19, 0.74, 0);
    const legShin = () => {
      const sg = new THREE.Group(); sg.position.set(0, -0.48, 0);
      sg.add(box(0.22, 0.44, 0.22, 0x2a2a36, 0, -0.22, 0));  // shin
      sg.add(box(0.24, 0.21, 0.32, 0x0a0a0a, 0, -0.54, 0.04)); // boot
      return sg;
    };
    this._leftLeg.add(box(0.24, 0.48, 0.24, 0x303044, 0, -0.24, 0));
    this._rightLeg.add(box(0.24, 0.48, 0.24, 0x303044, 0, -0.24, 0));
    this._lShin = legShin(); this._leftLeg.add(this._lShin);
    this._rShin = legShin(); this._rightLeg.add(this._rShin);
    this.root.add(this._leftLeg);
    this.root.add(this._rightLeg);

    // Rifle (simple box, held in right hand)
    const rifleG = new THREE.Group();
    rifleG.position.set(0.46, 1.25, -0.32);
    rifleG.add(box(0.07, 0.07, 0.72, 0x1a1a1a, 0, 0, 0));   // body
    rifleG.add(box(0.04, 0.04, 0.32, 0x111111, 0, 0.04, -0.50)); // barrel
    rifleG.add(box(0.06, 0.20, 0.10, 0x2a2a2a, 0, -0.10, 0.20)); // grip
    this.root.add(rifleG);

    // Store meshes for hit-flash
    this._meshes = [];
    this.root.traverse(o => { if (o.isMesh) this._meshes.push(o); });
    this._origColors = this._meshes.map(m => m.material.color.getHex());
  }

  // ── Health bar ───────────────────────────────────────────────────────────
  _buildHealthBar() {
    this._hpGroup = new THREE.Group();
    this._hpGroup.position.y = 3.0;

    // Dark background
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.20),
      new THREE.MeshBasicMaterial({ color: 0x220000, side: THREE.DoubleSide, depthTest: false })
    );
    this._hpGroup.add(bg);

    // Red fill (anchored left via offset)
    this._hpFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.20),
      new THREE.MeshBasicMaterial({ color: 0xee2222, side: THREE.DoubleSide, depthTest: false })
    );
    this._hpFill.position.z = 0.005;
    this._hpGroup.add(this._hpFill);

    // White outline
    const outline = new THREE.Mesh(
      new THREE.PlaneGeometry(1.76, 0.26),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.35 })
    );
    outline.position.z = -0.005;
    this._hpGroup.add(outline);

    // Name strip (rarity-colored, above bar)
    const nameStrip = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.16),
      new THREE.MeshBasicMaterial({ color: 0xaa0000, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.7 })
    );
    nameStrip.position.set(0, 0.19, 0.003);
    this._hpGroup.add(nameStrip);

    this.root.add(this._hpGroup);
  }

  _updateHealthBar(camera) {
    const pct = Math.max(0, this.health / this.maxHealth);
    this._hpFill.scale.x = pct;
    this._hpFill.position.x = -(1 - pct) * 0.85;

    // color transition: green → yellow → red
    let c;
    if (pct > 0.5) c = new THREE.Color(0xee2222).lerp(new THREE.Color(0xee8822), (1 - pct) * 2);
    else           c = new THREE.Color(0xee8822).lerp(new THREE.Color(0x22ee22), (pct) * 2);
    this._hpFill.material.color.copy(c);

    if (camera) this._hpGroup.lookAt(camera.position);
  }

  // ── AI Update ────────────────────────────────────────────────────────────
  update(dt, player, projectileSystem, camera) {
    if (this.dead) {
      this._deathT += dt;
      // Topple
      if (this._deathT < 0.4) {
        this.root.rotation.z = Math.min(Math.PI / 2, this._deathT / 0.4 * Math.PI / 2);
      }
      if (this._deathT > 3.5) this.scene.remove(this.root);
      return;
    }

    this._t += dt;

    // Hit flash
    if (this._hitFlash > 0) {
      this._hitFlash -= dt;
      const white = this._hitFlash > 0;
      this._meshes.forEach((m, i) => m.material.color.setHex(white ? 0xffffff : this._origColors[i]));
    }

    const pp = player.getPosition();
    const dx = pp.x - this.root.position.x;
    const dz = pp.z - this.root.position.z;
    const dist2D = Math.sqrt(dx * dx + dz * dz);

    // State transitions
    if (this.state !== STATE.DEAD) {
      if (this.state === STATE.PATROL && dist2D < DETECT_RANGE) this.state = STATE.CHASE;
      if (this.state === STATE.CHASE  && dist2D < ATTACK_RANGE)  this.state = STATE.ATTACK;
      if (this.state === STATE.ATTACK && dist2D > ATTACK_RANGE * 1.15) this.state = STATE.CHASE;
      if (this.state === STATE.CHASE  && dist2D > LOSE_RANGE)    this.state = STATE.PATROL;
    }

    // Execute state
    const moving = this.state === STATE.PATROL || this.state === STATE.CHASE;
    switch (this.state) {
      case STATE.PATROL: this._doPatrol(dt); break;
      case STATE.CHASE:  this._doMove(dt, pp, MOVE_SPEED, 1.5); break;
      case STATE.ATTACK: this._doAttack(dt, pp, dist2D, projectileSystem); break;
    }

    // Walk animation (also plays when strafing)
    const isAnimating = moving || this._strafeVel > 0.4;
    if (isAnimating) {
      const legSwing = Math.sin(this._t * 6.5) * 0.52;
      this._leftLeg.rotation.x  =  legSwing;
      this._rightLeg.rotation.x = -legSwing;
      if (this.state !== STATE.ATTACK) {
        this._leftArm.rotation.x  = -legSwing * 0.5;
        this._rightArm.rotation.x =  legSwing * 0.5;
      }
    } else {
      this._leftLeg.rotation.x  *= 0.88;
      this._rightLeg.rotation.x *= 0.88;
    }

    // Terrain snap
    const h = this.world.getTerrainHeight(this.root.position.x, this.root.position.z);
    this.root.position.y = h + FOOT_OFFSET;

    this._updateHealthBar(camera);
  }

  _doPatrol(dt) {
    this._patrolT -= dt;
    if (this._patrolT <= 0) {
      const a = Math.random() * Math.PI * 2;
      const r = 12 + Math.random() * 22;
      this._patrolDest.set(
        this._spawnPos.x + Math.cos(a) * r,
        0,
        this._spawnPos.z + Math.sin(a) * r
      );
      this._patrolT = 3.5 + Math.random() * 4;
    }
    this._doMove(dt, this._patrolDest, PATROL_SPEED, 2.0);
  }

  _doMove(dt, target, speed, stopDist) {
    const dx = target.x - this.root.position.x;
    const dz = target.z - this.root.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < stopDist) return;
    const nx = dx / dist, nz = dz / dist;
    this.root.position.x += nx * speed * dt;
    this.root.position.z += nz * speed * dt;
    this.root.rotation.y = Math.atan2(nx, nz);
  }

  _doAttack(dt, playerPos, dist, proj) {
    const dx  = playerPos.x - this.root.position.x;
    const dz  = playerPos.z - this.root.position.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    this.root.rotation.y = Math.atan2(dx, dz);

    // Strafe perpendicular to the player vector
    this._strafeT -= dt;
    if (this._strafeT <= 0) {
      this._strafeT   = 0.7 + Math.random() * 1.5;
      this._strafeDir = Math.random() > 0.5 ? 1 : -1;
    }
    if (dist > 7 && len > 0.01) {
      const px = -dz / len, pz = dx / len; // perpendicular unit vector
      const sSpeed = MOVE_SPEED * 0.5;
      this.root.position.x += px * this._strafeDir * sSpeed * dt;
      this.root.position.z += pz * this._strafeDir * sSpeed * dt;
      this._strafeVel = sSpeed;
    } else {
      this._strafeVel *= 0.85;
    }

    // Raise arms for aiming pose
    this._rightArm.rotation.x = THREE.MathUtils.lerp(this._rightArm.rotation.x, -0.52 + Math.sin(this._t * 2) * 0.025, dt * 8);
    this._leftArm.rotation.x  = THREE.MathUtils.lerp(this._leftArm.rotation.x,  -0.30, dt * 6);

    this._shootT -= dt;
    if (this._shootT <= 0 && proj) {
      this._shootT = SHOOT_INTERVAL + (Math.random() - 0.5) * 0.6;
      this._shoot(playerPos, proj);
    }
  }

  _shoot(targetPos, proj) {
    const origin = this.root.position.clone().add(new THREE.Vector3(0, 1.55, 0));
    // Aim with slight inaccuracy
    const spread = 1.8;
    const aim = new THREE.Vector3(
      targetPos.x + (Math.random() - 0.5) * spread,
      targetPos.y + 1.1 + (Math.random() - 0.5) * spread * 0.5,
      targetPos.z + (Math.random() - 0.5) * spread
    );
    const dir = aim.clone().sub(origin).normalize();
    proj.spawn(origin, dir, { speed: 55, damage: 14, faction: 'enemy', range: 120 });
  }

  takeDamage(amount) {
    if (this.dead) return;
    this.health -= amount;
    this._hitFlash = 0.1;
    if (this.health <= 0) { this.health = 0; this._die(); }
  }

  _die() {
    this.dead = true;
    this._hpGroup.visible = false;
    if (this.onDeath) this.onDeath(this);
  }
}

// ── EnemyManager ─────────────────────────────────────────────────────────────
const SPAWN_POINTS = [
  { x:  60, z:  -3 }, { x:  54, z:   7 },  // cabin
  { x: -80, z:  31 }, { x: -88, z:  22 },  // tower
  { x:  16, z:-102 }, { x:  28, z: -94 },  // ruins
  { x: -30, z:  55 }, { x: -22, z:  44 },  // bunker
];

export class EnemyManager {
  constructor(scene, world, projectileSystem) {
    this.scene       = scene;
    this.world       = world;
    this.projectiles = projectileSystem;
    this.enemies     = [];
    this.onKill      = null; // (enemy) => void — wired by main.js
    this._spawn();
  }

  _spawn() {
    for (const sp of SPAWN_POINTS) {
      const h = this.world.getTerrainHeight(sp.x, sp.z);
      if (h < 0.5) continue;
      const e = new Enemy(
        this.scene, this.world,
        new THREE.Vector3(sp.x, h + FOOT_OFFSET, sp.z)
      );
      e.onDeath = (enemy) => { if (this.onKill) this.onKill(enemy); };
      this.enemies.push(e);
    }
  }

  update(dt, player, camera) {
    for (const e of this.enemies) {
      e.update(dt, player, this.projectiles, camera);
    }
  }

  get aliveCount() { return this.enemies.filter(e => !e.dead).length; }
}
