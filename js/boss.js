import * as THREE from 'three';
import { WEAPON_DEFS, WeaponPickup } from './weapons.js';

// ── Ms. Franks (Frank's Jail boss) ───────────────────────────────────────
//
// Math-teacher mini-boss. Patrols the jail cellblock + exercise yard,
// chases the nearest player on detection, fires the Protractor Beam at
// close-to-medium range. On death she drops the Protractor Beam with its
// remaining ammo state preserved.
//
// Multiplayer model: host-authoritative. The host instantiates a full
// `MsFranksBoss` (with AI) and broadcasts pos/yaw/hp/state at 8 Hz.
// Non-hosts construct a passive shell (`MsFranksBoss` with `isRemote=true`)
// that only interpolates incoming state and renders shoots/hits.

// Patrol bounds — rectangle that just contains the cellblock + exercise yard.
// Anchor (-128, 50) is the cellblock center.
const PATROL_MIN_X = -137;
const PATROL_MAX_X =  -99;
const PATROL_MIN_Z =   38;
const PATROL_MAX_Z =   62;
const SPAWN_X      = -128;
const SPAWN_Z      =   50;

const MAX_HEALTH    = 450;
const DETECT_RANGE  = 50;
const ATTACK_RANGE  = 32;
const LOSE_RANGE    = DETECT_RANGE * 1.5;
const MOVE_SPEED    = 3.8;
const PATROL_SPEED  = MOVE_SPEED * 0.45;
const SHOOT_PERIOD  = 1.8;
const FOOT_OFFSET   = 0.42;

// Combat range band — back off below PREF_MIN, close the gap above PREF_MAX,
// strafe in-between. Tight numbers because the protractor cone is short range.
const PREF_MIN      = 12;
const PREF_MAX      = 22;
// Per-pellet laser visual length — short enough to feel like a "flash",
// long enough to read as a beam at typical engagement range.
const LASER_LEN     = 28;
const LASER_LIFE    = 0.18;

// Per-pellet hues sweep across the fan so the spread reads like a math
// protractor measuring angles instead of a uniform shotgun blast.
const LASER_PALETTE = [0xff2266, 0xff3344, 0xff5522, 0xffaa22, 0xff5522, 0xff3344, 0xff2266];

// Protractor cone projectile params — read directly from the weapon def at
// fire time so balance tweaks in weapons.js apply to the boss too.

const STATE = { PATROL: 0, CHASE: 1, ATTACK: 2, DEAD: 3 };

// ── Shared protractor visual effect ──────────────────────────────────────
// Lasers are stored module-level so both the boss and the player can spawn
// them through the same pipeline. main.js calls tickProtractorLasers(dt)
// each frame to fade/dispose.
const _activeLasers = [];

/**
 * Spawn the full protractor visual blast at `origin` aimed along `baseDir`:
 * a 7-laser fan + muzzle particle burst. Used by Ms. Franks AND by the
 * player when firing the Protractor Beam they picked up from her.
 *
 * Laser cylinders are truncated to the nearest wall hit (and clipped against
 * terrain) so beams don't pierce solid geometry.
 */
export function spawnProtractorBlast(scene, world, particles, origin, baseDir) {
  const def     = WEAPON_DEFS.protractorBeam;
  const ndir    = baseDir.clone().normalize();
  const pellets = def.pellets;
  const spread  = def.spread;
  for (let i = 0; i < pellets; i++) {
    const t   = pellets === 1 ? 0 : (i / (pellets - 1)) * 2 - 1;
    const yaw = t * spread * 8;
    const dir = ndir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    _spawnLaser(scene, world, origin, dir, LASER_PALETTE[i % LASER_PALETTE.length]);
  }
  if (particles) {
    particles.spawnBurst(origin.clone(), {
      count: 24, color: 0xff5522, speed: 11, lifetime: 0.28, size: 0.18,
    });
    particles.spawnBurst(origin.clone(), {
      count: 14, color: 0xffdd44, speed: 6,  lifetime: 0.22, size: 0.14,
    });
  }
}

/** Per-frame fade + cleanup. main.js calls this for the global laser pool. */
export function tickProtractorLasers(dt) {
  if (_activeLasers.length === 0) return;
  for (let i = _activeLasers.length - 1; i >= 0; i--) {
    const l = _activeLasers[i];
    l.life -= dt;
    if (l.life <= 0) {
      l.scene.remove(l.mesh);
      l.mesh.geometry.dispose();
      l.mesh.material.dispose();
      _activeLasers.splice(i, 1);
    } else {
      l.mesh.material.opacity = (l.life / l.maxLife) * 0.95;
    }
  }
}

function _spawnLaser(scene, world, origin, dir, colorHex) {
  const ndir = dir.clone().normalize();
  // Truncate at first wall hit so the beam doesn't visually pierce solids.
  const endPoint = origin.clone().addScaledVector(ndir, LASER_LEN);
  let length = LASER_LEN;
  if (world?.staticCollider?.raycastDistance) {
    const t = world.staticCollider.raycastDistance(origin, endPoint);
    if (t < 1) length = Math.max(0.1, t * LASER_LEN);
  }
  // Also clip against terrain — 8 samples is enough for a 28m beam.
  if (world?.getTerrainHeight) {
    const STEPS = 8;
    for (let s = 1; s <= STEPS; s++) {
      const tt = (s / STEPS) * length;
      const px = origin.x + ndir.x * tt;
      const py = origin.y + ndir.y * tt;
      const pz = origin.z + ndir.z * tt;
      if (py < world.getTerrainHeight(px, pz)) { length = tt; break; }
    }
  }
  const geo = new THREE.CylinderGeometry(0.05, 0.05, length, 6, 1, true);
  geo.translate(0, length / 2, 0);
  const mat = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(origin);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), ndir,
  );
  mesh.quaternion.copy(q);
  scene.add(mesh);
  _activeLasers.push({ scene, mesh, life: LASER_LIFE, maxLife: LASER_LIFE });
}

export class MsFranksBoss {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./world.js').World} world
   * @param {Object} [opts]
   * @param {boolean} [opts.isRemote] non-host shell that only interpolates
   *                                   broadcast state (no AI, no autonomous fire)
   */
  constructor(scene, world, opts = {}) {
    this.scene  = scene;
    this.world  = world;
    this.isRemote = !!opts.isRemote;
    // Optional particle system — when present, fire-time muzzle bursts spawn.
    // Manager wires this; it's optional so a fresh boss can be built without one.
    this._particles = opts.particles ?? null;

    this.health     = MAX_HEALTH;
    this.maxHealth  = MAX_HEALTH;
    this.dead       = false;
    this.state      = STATE.PATROL;

    this._t          = 0;
    this._shootT     = SHOOT_PERIOD;
    this._patrolT    = 0;
    this._patrolDest = new THREE.Vector3(SPAWN_X, 0, SPAWN_Z);
    this._hitFlash   = 0;
    this._deathT     = 0;
    // Combat movement state. Local-space velocity (X = strafe relative to
    // player, Z = radial toward/away from player) is re-rolled every
    // _moveT seconds with a randomised direction and speed multiplier so
    // she doesn't oscillate side-to-side predictably.
    this._moveT          = 0;
    this._moveDirX       = 0;
    this._moveDirZ       = 0;
    this._moveSpeedMult  = 1;
    this.weaponAmmo    = WEAPON_DEFS.protractorBeam.magSize;
    this.weaponReserve = WEAPON_DEFS.protractorBeam.magSize * 4;

    // Remote interpolation targets (used only when isRemote=true).
    this._targetPos = new THREE.Vector3();
    this._targetYaw = 0;

    this._buildModel();
    this._buildHealthBar();

    // Initial position — terrain-snapped.
    const sy = this.world.getTerrainHeight(SPAWN_X, SPAWN_Z) + FOOT_OFFSET;
    this.root.position.set(SPAWN_X, sy, SPAWN_Z);
    this._targetPos.copy(this.root.position);

    // Wired by manager — fires on local death only (host or solo).
    this.onDeath = null;
    // Wired by manager — fires on each local shot (host or solo). Args:
    // (origin: Vector3, dir: Vector3). Used by the host to broadcast.
    this.onShoot = null;
  }

  // ── Visuals ────────────────────────────────────────────────────────────
  _buildModel() {
    this.root = new THREE.Group();
    this.scene.add(this.root);

    const matCache = new Map();
    const lm = hex => {
      let m = matCache.get(hex);
      if (!m) { m = new THREE.MeshLambertMaterial({ color: hex }); matCache.set(hex, m); }
      return m;
    };
    const box = (w, h, d, hex, px, py, pz) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lm(hex));
      mesh.position.set(px, py, pz);
      mesh.castShadow = true;
      return mesh;
    };

    // Skirt (pleated, A-line). Wider at bottom than top.
    this.root.add(box(0.78, 0.48, 0.50, 0x2a2a48, 0, 0.92, 0));      // skirt
    this.root.add(box(0.86, 0.06, 0.56, 0x1a1a30, 0, 1.18, 0));      // skirt waistband
    this.root.add(box(0.66, 0.04, 0.48, 0x2a2a48, 0, 0.66, 0));      // skirt hem

    // Torso — burgundy cardigan over a cream blouse.
    this._torso = new THREE.Group();
    this.root.add(this._torso);
    this._torso.add(box(0.66, 0.74, 0.40, 0x7d2a3a, 0, 1.62, 0));    // cardigan body
    this._torso.add(box(0.42, 0.66, 0.42, 0xf5e6cf, 0, 1.62, 0.01)); // blouse panel (visible at collar)
    this._torso.add(box(0.10, 0.12, 0.10, 0xffd700, 0.18, 1.82, 0.18)); // brooch / pin

    // Head + face details.
    this._head = new THREE.Group();
    this._head.position.set(0, 2.10, 0);
    this._torso.add(this._head);
    this._head.add(box(0.56, 0.62, 0.56, 0xfbd7b0, 0, 0, 0));        // face
    // Hair — bun on top + sides framing the face.
    this._head.add(box(0.62, 0.32, 0.62, 0x3a2418, 0, 0.30, 0));     // hair cap
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), lm(0x3a2418));
    bun.position.set(0, 0.50, -0.10);
    bun.castShadow = true;
    this._head.add(bun);
    // Side hair strips
    this._head.add(box(0.06, 0.40, 0.40, 0x3a2418, -0.31, 0.04, 0));
    this._head.add(box(0.06, 0.40, 0.40, 0x3a2418,  0.31, 0.04, 0));
    // Glasses — two dark frames + a connecting bridge.
    const glassMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
    const lensGeo  = new THREE.RingGeometry(0.07, 0.10, 12);
    const lensL = new THREE.Mesh(lensGeo, glassMat); lensL.position.set(-0.13, 0.04, 0.29);
    const lensR = new THREE.Mesh(lensGeo, glassMat); lensR.position.set( 0.13, 0.04, 0.29);
    this._head.add(lensL); this._head.add(lensR);
    this._head.add(box(0.10, 0.02, 0.02, 0x111111, 0, 0.04, 0.29));  // bridge
    // Eyes inside the lenses
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const eyeL = new THREE.Mesh(new THREE.CircleGeometry(0.045, 10), eyeMat);
    const eyeR = new THREE.Mesh(new THREE.CircleGeometry(0.045, 10), eyeMat);
    eyeL.position.set(-0.13, 0.04, 0.292);
    eyeR.position.set( 0.13, 0.04, 0.292);
    this._head.add(eyeL); this._head.add(eyeR);

    // Arms — cardigan sleeves with skin forearms.
    const buildArm = (sx) => {
      const g = new THREE.Group();
      g.position.set(sx, 1.85, 0);
      g.add(box(0.20, 0.42, 0.20, 0x7d2a3a, 0, -0.22, 0));     // upper sleeve
      g.add(box(0.18, 0.36, 0.18, 0xfbd7b0, 0, -0.62, 0));     // forearm skin
      g.add(box(0.16, 0.14, 0.16, 0xfbd7b0, 0, -0.84, 0));     // hand
      return g;
    };
    this._leftArm  = buildArm(-0.42);
    this._rightArm = buildArm( 0.42);
    this._torso.add(this._leftArm);
    this._torso.add(this._rightArm);

    // Legs — dark stockings under the skirt, low heels.
    const buildLeg = (sx) => {
      const g = new THREE.Group();
      g.position.set(sx, 0.70, 0);
      g.add(box(0.18, 0.62, 0.18, 0x141420, 0, -0.31, 0));     // stocking
      g.add(box(0.22, 0.10, 0.30, 0x1a0a0a, 0, -0.66, 0.04));  // heel
      return g;
    };
    this._leftLeg  = buildLeg(-0.16);
    this._rightLeg = buildLeg( 0.16);
    this.root.add(this._leftLeg);
    this.root.add(this._rightLeg);

    // Held protractor beam — a glowing semicircle in the right hand.
    const weapon = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(0.18, 0.22, 16, 1, 0, Math.PI);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff3344, side: THREE.DoubleSide, transparent: true, opacity: 0.95,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.rotation.z = Math.PI;
    weapon.add(ring);
    const fillGeo = new THREE.CircleGeometry(0.18, 16, 0, Math.PI);
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0xff5566, side: THREE.DoubleSide, transparent: true, opacity: 0.30,
    });
    const fill = new THREE.Mesh(fillGeo, fillMat);
    fill.rotation.x = Math.PI / 2;
    fill.rotation.z = Math.PI;
    weapon.add(fill);
    weapon.position.set(0.42, 1.10, -0.20);
    this._weapon = weapon;
    this.root.add(weapon);

    // Hit-flash tracking — every Lambert mesh, so the whole boss flashes white.
    this._meshes = [];
    this.root.traverse(o => {
      if (o.isMesh && o.material.isMeshLambertMaterial) this._meshes.push(o);
    });
    this._origColors = this._meshes.map(m => m.material.color.getHex());
  }

  // ── Boss-tier health bar (wider, with name strip) ───────────────────────
  _buildHealthBar() {
    this._hpGroup = new THREE.Group();
    this._hpGroup.position.y = 3.30;

    const outline = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 0.34),
      new THREE.MeshBasicMaterial({
        color: 0xffe080, side: THREE.DoubleSide, depthTest: false,
        transparent: true, opacity: 0.7,
      }),
    );
    outline.position.z = -0.005;
    this._hpGroup.add(outline);

    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 0.28),
      new THREE.MeshBasicMaterial({ color: 0x220000, side: THREE.DoubleSide, depthTest: false }),
    );
    this._hpGroup.add(bg);

    this._hpFill = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 0.28),
      new THREE.MeshBasicMaterial({ color: 0xff3344, side: THREE.DoubleSide, depthTest: false }),
    );
    this._hpFill.position.z = 0.005;
    this._hpGroup.add(this._hpFill);

    // Name strip above the bar.
    const nameStrip = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 0.30),
      new THREE.MeshBasicMaterial({
        color: 0x000000, side: THREE.DoubleSide, depthTest: false,
        transparent: true, opacity: 0.7,
      }),
    );
    nameStrip.position.set(0, 0.34, 0.003);
    this._hpGroup.add(nameStrip);

    // Name text via canvas texture — keeps it fast (no font asset).
    const cnv = document.createElement('canvas');
    cnv.width = 256; cnv.height = 64;
    const ctx = cnv.getContext('2d');
    ctx.fillStyle = '#ffe080';
    ctx.font = 'bold 30px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('MS. FRANKS', cnv.width / 2, cnv.height / 2);
    const tex = new THREE.CanvasTexture(cnv);
    tex.minFilter = THREE.LinearFilter;
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 0.28),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }),
    );
    label.position.set(0, 0.34, 0.006);
    this._hpGroup.add(label);

    this.root.add(this._hpGroup);
  }

  _updateHealthBar(camera) {
    const pct = Math.max(0, this.health / this.maxHealth);
    this._hpFill.scale.x = pct;
    this._hpFill.position.x = -(1 - pct) * 1.15;
    if (camera) this._hpGroup.lookAt(camera.position);
  }

  // ── Public API ─────────────────────────────────────────────────────────
  getPosition() { return this.root.position; }

  /** Apply damage (local — host or solo). Returns true if this hit killed her. */
  takeDamage(amount) {
    if (this.dead) return false;
    this.health -= amount;
    this._hitFlash = 0.12;
    if (this.health <= 0) {
      this.health = 0;
      this._die();
      return true;
    }
    return false;
  }

  /**
   * Remote-only: apply broadcast state. The host computed it, we just
   * interpolate toward it. Yaw is set immediately because remote shells
   * don't run their own facing logic.
   */
  applyRemoteState(msg) {
    if (!this.isRemote) return;
    this._targetPos.set(msg.x, msg.y, msg.z);
    this._targetYaw = msg.yaw;
    this.state = msg.state ?? this.state;
    if (msg.hp !== undefined) this.health = msg.hp;
  }

  // ── Update ─────────────────────────────────────────────────────────────
  update(dt, player, projectileSystem, camera) {
    if (this.dead) {
      this._deathT += dt;
      if (this._deathT < 0.5) {
        this.root.rotation.z = Math.min(Math.PI / 2, this._deathT / 0.5 * Math.PI / 2);
      }
      if (this._deathT > 4.5 && this.root.parent) this.scene.remove(this.root);
      return;
    }

    this._t += dt;

    // Hit flash — flip every Lambert mesh's color for a few frames.
    if (this._hitFlash > 0) {
      this._hitFlash -= dt;
      const white = this._hitFlash > 0;
      this._meshes.forEach((m, i) =>
        m.material.color.setHex(white ? 0xffffff : this._origColors[i]),
      );
    }

    if (this.isRemote) {
      // Smooth toward broadcast state.
      const a = 1 - Math.exp(-12 * dt);
      this.root.position.lerp(this._targetPos, a);
      this.root.rotation.y = THREE.MathUtils.lerp(
        this.root.rotation.y, this._targetYaw, a,
      );
      const h = this.world.getTerrainHeight(this.root.position.x, this.root.position.z);
      this.root.position.y = h + FOOT_OFFSET;
      this._animateLegs(dt, /*moving=*/true);
      this._updateHealthBar(camera);
      return;
    }

    // Local AI (host or solo).
    const pp = player.getPosition();
    const dx = pp.x - this.root.position.x;
    const dz = pp.z - this.root.position.z;
    const dist2D = Math.sqrt(dx * dx + dz * dz);

    if (this.state === STATE.PATROL && dist2D < DETECT_RANGE) this.state = STATE.CHASE;
    if (this.state === STATE.CHASE  && dist2D < ATTACK_RANGE) this.state = STATE.ATTACK;
    if (this.state === STATE.ATTACK && dist2D > ATTACK_RANGE * 1.15) this.state = STATE.CHASE;
    if (this.state === STATE.CHASE  && dist2D > LOSE_RANGE)   this.state = STATE.PATROL;

    // Legs animate whenever she's moving — patrolling, chasing, or strafing
    // during attack. STATE.ATTACK strafes constantly, so it always animates.
    const moving = this.state !== STATE.DEAD;
    switch (this.state) {
      case STATE.PATROL: this._doPatrol(dt); break;
      case STATE.CHASE:  this._doMove(dt, pp, MOVE_SPEED); break;
      case STATE.ATTACK: this._doAttack(dt, pp, projectileSystem); break;
    }

    this._animateLegs(dt, moving);

    // Wall collision — push her out of any static wall she just clipped into.
    // Two passes so a corner doesn't trap her in the wedge between two boxes.
    const sc = this.world?.staticCollider;
    if (sc?.getWallPush) {
      for (let pass = 0; pass < 2; pass++) {
        const wp = sc.getWallPush(
          this.root.position.x, this.root.position.y, this.root.position.z, 0.55,
        );
        if (!wp) break;
        this.root.position.x += wp.x;
        this.root.position.z += wp.z;
      }
    }

    const h = this.world.getTerrainHeight(this.root.position.x, this.root.position.z);
    this.root.position.y = h + FOOT_OFFSET;

    this._updateHealthBar(camera);
  }

  _animateLegs(dt, moving) {
    if (moving) {
      const swing = Math.sin(this._t * 5.5) * 0.40;
      this._leftLeg.rotation.x  =  swing;
      this._rightLeg.rotation.x = -swing;
    } else {
      this._leftLeg.rotation.x  *= 0.88;
      this._rightLeg.rotation.x *= 0.88;
    }
  }

  _doPatrol(dt) {
    this._patrolT -= dt;
    if (this._patrolT <= 0) {
      // Pick a random point inside the bounded jail rectangle.
      this._patrolDest.set(
        PATROL_MIN_X + Math.random() * (PATROL_MAX_X - PATROL_MIN_X),
        0,
        PATROL_MIN_Z + Math.random() * (PATROL_MAX_Z - PATROL_MIN_Z),
      );
      this._patrolT = 4 + Math.random() * 3;
    }
    this._doMove(dt, this._patrolDest, PATROL_SPEED);
  }

  _doMove(dt, target, speed) {
    const dx = target.x - this.root.position.x;
    const dz = target.z - this.root.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 1.0) return;
    const nx = dx / dist, nz = dz / dist;
    let nextX = this.root.position.x + nx * speed * dt;
    let nextZ = this.root.position.z + nz * speed * dt;
    // Keep her bounded inside the patrol rectangle so she never wanders out
    // of the jail compound. The walls block her too, but this is cheaper.
    nextX = THREE.MathUtils.clamp(nextX, PATROL_MIN_X, PATROL_MAX_X);
    nextZ = THREE.MathUtils.clamp(nextZ, PATROL_MIN_Z, PATROL_MAX_Z);
    this.root.position.x = nextX;
    this.root.position.z = nextZ;
    this.root.rotation.y = Math.atan2(nx, nz);
  }

  _doAttack(dt, playerPos, proj) {
    const dx = playerPos.x - this.root.position.x;
    const dz = playerPos.z - this.root.position.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 0.0001;
    const nx = dx / len, nz = dz / len;
    const px = -nz, pz = nx;            // perpendicular (strafe) unit vector
    this.root.rotation.y = Math.atan2(nx, nz);
    // Raise the right arm to aim.
    this._rightArm.rotation.x = THREE.MathUtils.lerp(
      this._rightArm.rotation.x, -1.05, dt * 8,
    );

    // Re-roll a 2D local-space velocity periodically. Local Z = radial
    // (toward player when >0, away when <0); local X = strafe. Range
    // pressure biases the radial component so she keeps the protractor's
    // short cone in striking distance.
    this._moveT -= dt;
    if (this._moveT <= 0) {
      this._moveT = 0.35 + Math.random() * 1.05;
      let radial;
      if      (len < PREF_MIN) radial = -(0.5 + Math.random() * 0.5);  // back off
      else if (len > PREF_MAX) radial =  (0.5 + Math.random() * 0.5);  // close in
      else                     radial =  (Math.random() - 0.5) * 1.4;  // free
      const strafe = (Math.random() * 2 - 1);
      // Normalise so direction is on the unit circle — magnitude lives on
      // _moveSpeedMult, which we vary independently.
      const mag = Math.sqrt(radial * radial + strafe * strafe) || 1;
      this._moveDirZ = radial / mag;
      this._moveDirX = strafe / mag;
      this._moveSpeedMult = 0.55 + Math.random() * 0.75;
    }

    const speed = MOVE_SPEED * this._moveSpeedMult;
    let mx = nx * this._moveDirZ * speed + px * this._moveDirX * speed;
    let mz = nz * this._moveDirZ * speed + pz * this._moveDirX * speed;

    // Clamp to the jail rectangle. If we'd leave the box, flip the offending
    // axis of our movement vector so she bounces back inside.
    const wantX = this.root.position.x + mx * dt;
    const wantZ = this.root.position.z + mz * dt;
    const nextX = THREE.MathUtils.clamp(wantX, PATROL_MIN_X, PATROL_MAX_X);
    const nextZ = THREE.MathUtils.clamp(wantZ, PATROL_MIN_Z, PATROL_MAX_Z);
    if (nextX !== wantX) this._moveDirX *= -1;
    if (nextZ !== wantZ) this._moveDirZ *= -1;
    this.root.position.x = nextX;
    this.root.position.z = nextZ;

    this._shootT -= dt;
    if (this._shootT <= 0 && proj) {
      this._fireProtractor(playerPos, proj);
      this._shootT = SHOOT_PERIOD;
    }
  }

  /**
   * Fire one Protractor Beam shot: a fan of `pellets` projectiles spread
   * across the def's spread cone. Called locally on the host/solo; remotes
   * receive the same effect via `bossShoot` broadcast.
   */
  _fireProtractor(targetPos, proj) {
    const def = WEAPON_DEFS.protractorBeam;
    const origin = this.root.position.clone().add(new THREE.Vector3(0, 1.55, 0));
    const aim    = targetPos.clone().add(new THREE.Vector3(0, 1.1, 0));
    const baseDir = aim.sub(origin).normalize();
    this._spawnConeFromBaseDir(origin, baseDir, def, proj);
    if (this.onShoot) this.onShoot(origin, baseDir);
  }

  /**
   * Shared cone-fire helper. Also used by remote shells when they receive
   * a `bossShoot` broadcast so every client sees identical pellet spread.
   * Spawns damage projectiles + the protractor visual blast (lasers + muzzle).
   */
  _spawnConeFromBaseDir(origin, baseDir, def, proj) {
    const pellets = def.pellets;
    const spread  = def.spread;
    // Even fan: pellets distributed across [-spread, +spread] in yaw only,
    // so the cone reads as a horizontal sweep rather than a sphere blast.
    for (let i = 0; i < pellets; i++) {
      const t   = pellets === 1 ? 0 : (i / (pellets - 1)) * 2 - 1;
      const yaw = t * spread * 8;       // multiplier widens the fan visually
      const dir = baseDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      proj.spawn(origin, dir, {
        speed: def.bulletSpeed,
        damage: def.damage,
        range: def.range,
        faction: 'enemy',
        attacker: 'Ms. Franks',
      });
    }
    // Lasers + muzzle from the shared module-level helper. The player's
    // protractor fires go through the same function so the effect is
    // identical regardless of who pulled the trigger.
    spawnProtractorBlast(this.scene, this.world, this._particles, origin, baseDir);
  }

  /** Public entry for non-host clients to play back a broadcast shot. */
  playShoot(origin, dir, projectileSystem) {
    if (!projectileSystem) return;
    const def = WEAPON_DEFS.protractorBeam;
    this._spawnConeFromBaseDir(origin, dir, def, projectileSystem);
  }

  _die() {
    this.dead = true;
    this.state = STATE.DEAD;
    this._hpGroup.visible = false;
    if (this.onDeath) this.onDeath(this);
  }

  /**
   * Drop the protractor beam as a pickup at the boss's feet. Caller owns
   * the WeaponSystem so it can register the pickup. Returns the pickup
   * (caller pushes it into weapons.pickups so it can be collected).
   */
  dropWeapon() {
    const pos = this.root.position.clone();
    pos.y = this.world.getTerrainHeight(pos.x, pos.z) + 0.4;
    const ammoState = { ammo: this.weaponAmmo, reserve: this.weaponReserve };
    return new WeaponPickup(this.scene, WEAPON_DEFS.protractorBeam, pos, ammoState);
  }
}

// ── Single-instance manager ──────────────────────────────────────────────
// Thin wrapper that owns the boss + multiplayer wiring. Solo: just construct
// with no net. Multiplayer: pass `net` so it knows whether it's authoritative
// and how to send/receive broadcasts.

const BROADCAST_HZ = 8;

export class MsFranksManager {
  /**
   * @param {Object} cfg
   * @param {THREE.Scene} cfg.scene
   * @param {import('./world.js').World} cfg.world
   * @param {import('./projectile.js').ProjectileSystem} cfg.projectileSystem
   * @param {import('./weapons.js').WeaponSystem} cfg.weapons   for dropping the protractor on death
   * @param {import('./multiplayer.js').NetworkManager} [cfg.net]
   */
  constructor(cfg) {
    this.scene       = cfg.scene;
    this.world       = cfg.world;
    this.projectiles = cfg.projectileSystem;
    this.weapons     = cfg.weapons;
    this.particles   = cfg.particles ?? null;
    this.net         = cfg.net ?? null;

    this._broadcastT = 0;
    this.boss        = null;

    // Wire net callbacks first so a host that beats us to bossSpawn doesn't
    // get dropped on the floor.
    if (this.net) this._wireNet();
    this._spawn();
  }

  _isAuthority() { return !this.net || this.net.isHost; }

  _spawn() {
    const isRemote = !this._isAuthority();
    this.boss = new MsFranksBoss(this.scene, this.world, {
      isRemote,
      particles: this.particles,
    });
    this.boss.onDeath = () => this._onLocalDeath();
    this.boss.onShoot = (origin, dir) => {
      if (this.net && this._isAuthority()) {
        this.net.sendBossShoot(origin, dir);
      }
    };
  }

  _wireNet() {
    // Hosts authoritatively spawn the boss; non-hosts receive `bossSpawn`
    // as a sanity ping (we already spawned a remote shell). State updates
    // are the primary sync path.
    this.net.onBossState = (msg) => {
      if (!this.boss || !this.boss.isRemote) return;
      this.boss.applyRemoteState(msg);
    };
    this.net.onBossShoot = (msg) => {
      if (!this.boss || this.boss.dead) return;
      const origin = new THREE.Vector3(msg.origin[0], msg.origin[1], msg.origin[2]);
      const dir    = new THREE.Vector3(msg.dir[0],    msg.dir[1],    msg.dir[2]);
      this.boss.playShoot(origin, dir, this.projectiles);
    };
    this.net.onBossHit = (msg) => {
      // Only the host applies hits. Other receivers ignore (their boss is
      // a remote shell and will catch up via the next bossState broadcast).
      if (!this._isAuthority() || !this.boss || this.boss.dead) return;
      this.boss.takeDamage(msg.damage);
    };
    this.net.onBossDied = (msg) => {
      if (!this.boss || this.boss.dead) return;
      // Force death state + spawn the pickup at the broadcast location so
      // every client sees the protractor at the same spot.
      this.boss.health = 0;
      this.boss._die();
      this._spawnDropAt(msg.x, msg.y, msg.z, msg.ammo, msg.reserve);
    };
  }

  /**
   * Apply a hit. Called by the local player's projectile when it strikes
   * the boss. On the authority (solo/host) we apply directly; non-host
   * clients send a `bossHit` so the host can authoritatively apply it.
   */
  applyHit(damage) {
    if (!this.boss || this.boss.dead) return;
    if (this._isAuthority()) {
      this.boss.takeDamage(damage);
    } else if (this.net) {
      // Non-host: ship damage to host for authoritative application. Trigger
      // local hit-flash so the shooter still gets visual feedback this frame;
      // the next bossState broadcast will sync our local HP to the host's.
      this.boss._hitFlash = 0.12;
      this.net.sendBossHit(damage);
    }
  }

  _onLocalDeath() {
    if (!this.boss) return;
    const pos = this.boss.getPosition().clone();
    pos.y = this.world.getTerrainHeight(pos.x, pos.z) + 0.4;
    // Local pickup spawn for solo or host.
    const pickup = this.boss.dropWeapon();
    this.weapons.pickups.push(pickup);
    if (this.net && this._isAuthority()) {
      this.net.sendBossDied(pos.x, pos.y, pos.z,
                            this.boss.weaponAmmo, this.boss.weaponReserve);
    }
  }

  _spawnDropAt(x, y, z, ammo, reserve) {
    if (!this.weapons) return;
    const ammoState = { ammo, reserve };
    const pos = new THREE.Vector3(x, y, z);
    const pickup = new WeaponPickup(this.scene, WEAPON_DEFS.protractorBeam, pos, ammoState);
    this.weapons.pickups.push(pickup);
  }

  update(dt, player, camera) {
    if (!this.boss) return;
    this.boss.update(dt, player, this.projectiles, camera);

    // Authority broadcasts boss state at fixed rate so non-hosts stay synced.
    if (this.net && this._isAuthority() && !this.boss.dead) {
      this._broadcastT -= dt;
      if (this._broadcastT <= 0) {
        this._broadcastT = 1 / BROADCAST_HZ;
        const p = this.boss.root.position;
        this.net.sendBossState({
          x: p.x, y: p.y, z: p.z,
          yaw: this.boss.root.rotation.y,
          hp: this.boss.health,
          state: this.boss.state,
        });
      }
    }
  }

  /** Used by projectile collision — return the boss if she's alive. */
  getAliveBoss() {
    if (this.boss && !this.boss.dead) return this.boss;
    return null;
  }
}
