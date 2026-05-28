import * as THREE from 'three';
import { buildGunModel } from './weapons.js';
import { paintedPBR, boxGeo, fabricPBR, skinPBR, metalPBR } from './materials.js';

const MOVE_SPEED   = 8;
const SPRINT_SPEED = 16;
const JUMP_FORCE   = 9;
const GRAVITY      = -22;
const MAX_HEALTH   = 100;
const MAX_SHIELD   = 100;
const FOOT_OFFSET  = 0.43;

export class Player {
  constructor(scene, spawnPos, world) {
    this.scene  = scene;
    this.world  = world;
    this.health = MAX_HEALTH;
    this.shield = 0;
    this.armour = 0;
    this.maxHealth = MAX_HEALTH;
    this.maxShield = MAX_SHIELD;
    this.maxArmour = 100;
    this.dead   = false;

    this.velocity = new THREE.Vector3();
    this.grounded = false;
    this.airTime  = 0;

    this.yaw   = 0;
    this.pitch = 0;

    this._keys      = {};
    this._mouseX    = 0;
    this._mouseY    = 0;
    this._sprinting = false;
    this.crouching  = false;   // read by camera + main; broadcast to remotes
    this.mouseDown  = false;   // read by main.js for shooting

    this._bobTime  = 0;
    this._squashScale  = new THREE.Vector3(1, 1, 1);
    this._squashTarget = new THREE.Vector3(1, 1, 1);

    this.heldWeapon = null;    // weapon def (not instance)
    this.adsActive  = false;   // right-mouse held

    // Set by main.js to BuildingSystem for structural collision
    this.collisionProvider = null;

    // Callbacks wired by main.js
    this.onDamage = null;
    this.onDeath  = null;

    this._buildCharacter();
    this.root.position.copy(spawnPos);
    this._bindInput();
  }

  // ── Character Model ──────────────────────────────────────────────────────
  _buildCharacter() {
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.body = new THREE.Group();
    this.root.add(this.body);

    // Heuristic: skin-tone hexes get the pore detail map, gold-ish hexes get
    // a touch of metalness, everything else reads as cloth via the fabric
    // weave normal map. Single chokepoint so every box() call self-routes.
    const lm  = hex => {
      if (hex === 0xffcba4 || hex === 0xc8906a) return skinPBR(hex);
      const r = (hex >> 16) & 0xff, g = (hex >> 8) & 0xff, b = hex & 0xff;
      if (r > 180 && g > 130 && b < 80) {
        return paintedPBR(hex, { metal: 0.7, rough: 0.35, detail: 'metal', normalScale: 0.35 });
      }
      return fabricPBR(hex);
    };
    const box = (w, h, d, hex, px, py, pz) => {
      const m = new THREE.Mesh(boxGeo(w, h, d), lm(hex));
      m.position.set(px, py, pz);
      m.castShadow = true;
      return m;
    };

    // Torso, belt, buckle, hips
    this.body.add(box(0.70, 0.90, 0.45, 0x1565c0, 0, 1.35, 0));
    this.body.add(box(0.72, 0.15, 0.47, 0x4a3728, 0, 0.97, 0));
    this.body.add(box(0.18, 0.12, 0.05, 0xd4a017, 0, 0.97, 0.24));
    this.body.add(box(0.65, 0.25, 0.42, 0x37474f, 0, 0.87, 0));

    // Head — skin block, ridged helmet shell, emissive visor band w/ catchlights.
    this.headGroup = new THREE.Group();
    this.headGroup.position.set(0, 1.9, 0);
    this.body.add(this.headGroup);
    this.headGroup.add(new THREE.Mesh(boxGeo(0.60, 0.58, 0.56), skinPBR(0xffcba4)));
    const helm = new THREE.Mesh(
      new THREE.SphereGeometry(0.36, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.6),
      paintedPBR(0x8d6e63, { rough: 0.55, metal: 0.25 }),
    );
    helm.position.set(0, 0.05, 0); helm.castShadow = true;
    this.headGroup.add(helm);
    // Visor: PBR emissive cyan so bloom picks it up + reads as "tactical lens".
    const visor = new THREE.Mesh(
      boxGeo(0.52, 0.20, 0.08),
      paintedPBR(0x0c2030, {
        rough: 0.15, metal: 0.5, emissive: 0x66ccff, emissiveIntensity: 0.45,
      }),
    );
    visor.position.set(0, -0.04, 0.30);
    this.headGroup.add(visor);
    // Two tiny brighter catchlights on the visor — sells "eye contact" at distance.
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xeaffff });
    for (const sx of [-0.13, 0.13]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 5), eyeMat);
      eye.position.set(sx, -0.04, 0.35);
      this.headGroup.add(eye);
    }
    // Ears (skin) stay as boxGeo.
    for (const sx of [-0.34, 0.34]) {
      const ear = new THREE.Mesh(boxGeo(0.08, 0.20, 0.18), skinPBR(0xffcba4));
      ear.position.set(sx, 0, 0);
      this.headGroup.add(ear);
    }

    // Arms
    this.leftArmGroup  = new THREE.Group();
    this.rightArmGroup = new THREE.Group();
    this.leftArmGroup.position.set(-0.48, 1.3, 0);
    this.rightArmGroup.position.set( 0.48, 1.3, 0);
    this.body.add(this.leftArmGroup);
    this.body.add(this.rightArmGroup);

    const buildArm = (g) => {
      g.add(box(0.22, 0.50, 0.22, 0x1565c0, 0, -0.25, 0));  // upper
      const fg = new THREE.Group(); fg.position.set(0, -0.5, 0);
      fg.add(box(0.19, 0.44, 0.19, 0xffcba4, 0, -0.22, 0));  // forearm
      fg.add(box(0.22, 0.20, 0.22, 0x1a237e, 0, -0.50, 0));  // glove
      g.add(fg);
      return fg;
    };
    this.leftForearm  = buildArm(this.leftArmGroup);
    this.rightForearm = buildArm(this.rightArmGroup);

    // Shoulder pads
    this.body.add(box(0.30, 0.15, 0.30, 0x8d6e63, -0.52, 1.62, 0));
    this.body.add(box(0.30, 0.15, 0.30, 0x8d6e63,  0.52, 1.62, 0));

    // Legs
    this.leftLegGroup  = new THREE.Group();
    this.rightLegGroup = new THREE.Group();
    this.leftLegGroup.position.set(-0.20, 0.75, 0);
    this.rightLegGroup.position.set( 0.20, 0.75, 0);
    this.body.add(this.leftLegGroup);
    this.body.add(this.rightLegGroup);

    const buildLeg = (g) => {
      g.add(box(0.26, 0.50, 0.26, 0x37474f, 0, -0.25, 0));
      const sg = new THREE.Group(); sg.position.set(0, -0.5, 0);
      sg.add(box(0.23, 0.46, 0.23, 0x37474f, 0, -0.23, 0));
      sg.add(box(0.26, 0.22, 0.34, 0x212121, 0, -0.57, 0.04));
      g.add(sg);
      return sg;
    };
    this.leftShin  = buildLeg(this.leftLegGroup);
    this.rightShin = buildLeg(this.rightLegGroup);

    // Backpack
    this.body.add(box(0.50, 0.60, 0.28, 0x4a4a4a, 0, 1.35, -0.36));
    this.body.add(box(0.08, 0.55, 0.08, 0x333333, -0.22, 1.35, -0.22));
    this.body.add(box(0.08, 0.55, 0.08, 0x333333,  0.22, 1.35, -0.22));

    // Gun attachment point — child of rightForearm at hand level
    this.gunAttachPoint = new THREE.Group();
    this.gunAttachPoint.position.set(0, -0.58, 0.06);
    this.rightForearm.add(this.gunAttachPoint);

    this.root.traverse(o => { if (o.isMesh) o.receiveShadow = true; });

    this._animParts = {
      leftArm:  this.leftArmGroup,
      rightArm: this.rightArmGroup,
      leftLeg:  this.leftLegGroup,
      rightLeg: this.rightLegGroup,
      head:     this.headGroup,
    };
  }

  // ── Gun in hand ──────────────────────────────────────────────────────────
  setHeldWeapon(def) {
    this.heldWeapon = def;
    // Clear existing model
    while (this.gunAttachPoint.children.length) {
      this.gunAttachPoint.remove(this.gunAttachPoint.children[0]);
    }
    if (!def) return;
    const model = buildGunModel(def, 0.58);
    this.gunAttachPoint.add(model);
  }

  // ── Damage / Health ──────────────────────────────────────────────────────
  takeDamage(amount, stormDamage = false, sourcePos = null, killerLabel = null) {
    if (this.dead) return;
    let remaining = amount;
    if (!stormDamage && this.armour > 0) {
      const absorbed = Math.min(this.armour, remaining);
      this.armour  -= absorbed;
      remaining    -= absorbed;
    }
    if (!stormDamage && this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield   -= absorbed;
      remaining     -= absorbed;
    }
    this.health = Math.max(0, this.health - remaining);
    if (killerLabel) this._lastKillerLabel = killerLabel;
    if (this.onDamage) this.onDamage(amount, sourcePos);
    if (this.health <= 0 && !this.dead) this._die();
  }

  healShield(amount) {
    this.shield = Math.min(this.maxShield, this.shield + amount);
  }

  healArmour(amount) {
    this.armour = Math.min(this.maxArmour, this.armour + amount);
  }

  _die() {
    this.dead = true;
    if (this.onDeath) this.onDeath(this._lastKillerLabel ?? null);
  }

  // ── Input ────────────────────────────────────────────────────────────────
  _bindInput() {
    window.addEventListener('keydown', e => {
      this._keys[e.code] = true;
      if (e.code === 'Space' && this.grounded && !this.dead) this._jump();
    });
    window.addEventListener('keyup', e => { this._keys[e.code] = false; });
    document.addEventListener('mousemove', e => {
      if (document.pointerLockElement) {
        this._mouseX += e.movementX;
        this._mouseY += e.movementY;
      }
    });
    document.addEventListener('mousedown', e => {
      if (e.button === 0) this.mouseDown = true;
      if (e.button === 2) this.adsActive  = true;
    });
    document.addEventListener('mouseup', e => {
      if (e.button === 0) this.mouseDown  = false;
      if (e.button === 2) this.adsActive  = false;
    });
    // Prevent right-click context menu
    document.addEventListener('contextmenu', e => e.preventDefault());
  }

  _jump() {
    this.velocity.y = JUMP_FORCE;
    this.grounded   = false;
    this._squashTarget.set(0.82, 1.28, 0.82);
  }

  // ── Update ───────────────────────────────────────────────────────────────
  update(dt) {
    if (this.dead) return;
    this._handleMouse();
    this._handleMovement(dt);
    this._collideWithBuildings();
    this._applyGravity(dt);
    this._collideWithTerrain();
    this._animateBody(dt);
    this._squash(dt);
    this.world.updateClouds(dt);
  }

  _handleMouse() {
    const base  = 0.0018 * (this._sensMultiplier ?? 1.0);
    const scope = this._scopeMultiplier ?? 1.0;
    const sens  = base * scope;
    this.yaw   -= this._mouseX * sens;
    this.pitch -= this._mouseY * sens;
    this.pitch  = Math.max(-Math.PI / 2.6, Math.min(Math.PI / 4, this.pitch));
    this._mouseX = 0;
    this._mouseY = 0;
    this.root.rotation.y = this.yaw;
  }

  _handleMovement(dt) {
    const k      = this._keys;
    // Crouch is held (Ctrl). Crouch + sprint is mutually exclusive — crouch wins.
    this.crouching = !!(k['ControlLeft'] || k['ControlRight']) && this.grounded;
    const testingMode = (this._sprintMultiplier ?? 1.0) > 1.0;
    const sprint = testingMode && (k['ShiftLeft'] || k['ShiftRight']) && !this.adsActive && !this.crouching;
    const adsSlow = this.adsActive ? 0.55 : 1.0;
    const sprintMult = sprint ? this._sprintMultiplier : 1.0;
    const crouchMult = this.crouching ? 0.5 : 1.0;
    const speed  = (sprint ? SPRINT_SPEED : MOVE_SPEED) * adsSlow * sprintMult * crouchMult;
    const dir    = new THREE.Vector3();
    if (k['KeyW'] || k['ArrowUp'])    dir.z -= 1;
    if (k['KeyS'] || k['ArrowDown'])  dir.z += 1;
    if (k['KeyA'] || k['ArrowLeft'])  dir.x -= 1;
    if (k['KeyD'] || k['ArrowRight']) dir.x += 1;

    if (dir.length() > 0) {
      dir.normalize().applyEuler(new THREE.Euler(0, this.yaw, 0));
      this.velocity.x = dir.x * speed;
      this.velocity.z = dir.z * speed;
    } else {
      this.velocity.x *= 0.82;
      this.velocity.z *= 0.82;
    }
    this.root.position.x += this.velocity.x * dt;
    this.root.position.z += this.velocity.z * dt;
    this._sprinting = sprint && dir.length() > 0;
    this._isSprinting = this._sprinting; // expose for camera
  }

  _applyGravity(dt) {
    if (!this.grounded) this.velocity.y += GRAVITY * dt;
    this.root.position.y += this.velocity.y * dt;
  }

  _collideWithBuildings() {
    if (!this.collisionProvider) return;
    const push = this.collisionProvider.getWallPush(
      this.root.position.x, this.root.position.y, this.root.position.z, 0.42
    );
    if (!push) return;
    this.root.position.x += push.x;
    this.root.position.z += push.z;
    if (Math.abs(push.x) > 0.001) this.velocity.x = 0;
    if (Math.abs(push.z) > 0.001) this.velocity.z = 0;
  }

  _collideWithTerrain() {
    let groundY = this.world.getTerrainHeight(this.root.position.x, this.root.position.z);

    // Check build pieces for additional standing surfaces (floors and ramps)
    if (this.collisionProvider) {
      const buildY = this.collisionProvider.getHeightAt(
        this.root.position.x, this.root.position.z, this.root.position.y
      );
      if (buildY !== null) groundY = Math.max(groundY, buildY);
    }

    const standY  = groundY + FOOT_OFFSET;
    const was     = this.grounded;
    if (this.root.position.y <= standY) {
      this.root.position.y = standY;
      if (!was && this.velocity.y < -4) {
        const impact = Math.min(Math.abs(this.velocity.y) / 15, 0.5);
        this._squashTarget.set(1 + impact, 1 - impact * 0.8, 1 + impact);
      }
      this.velocity.y = 0;
      this.grounded   = true;
      this.airTime    = 0;
    } else {
      this.grounded = false;
      this.airTime += 0.016;
    }
  }

  _squash(dt) {
    this._squashScale.lerp(this._squashTarget, dt * 14);
    this._squashTarget.lerp(new THREE.Vector3(1, 1, 1), dt * 8);
    this.body.scale.copy(this._squashScale);
  }

  _animateBody(dt) {
    const p = this._animParts;
    const moving = Math.abs(this.velocity.x) > 0.5 || Math.abs(this.velocity.z) > 0.5;
    const spd    = this._sprinting ? 1.7 : 1.0;
    const armed  = !!this.heldWeapon;

    if (moving && this.grounded) {
      this._bobTime += dt * spd * 6;
      const leg = Math.sin(this._bobTime) * 0.55;
      p.leftLeg.rotation.x  =  leg;
      p.rightLeg.rotation.x = -leg;
      const arm = Math.sin(this._bobTime) * 0.38;
      p.leftArm.rotation.x  = armed ? 0.12 : -arm;
      if (!armed) p.rightArm.rotation.x = arm;
      this.body.position.y = Math.abs(Math.sin(this._bobTime)) * 0.05 - 0.02;
      p.head.position.y    = 1.9 + Math.sin(this._bobTime * 2) * 0.015;
    } else {
      this._bobTime += dt * 1.2;
      p.leftLeg.rotation.x  = 0;
      p.rightLeg.rotation.x = 0;
      if (!armed) {
        p.leftArm.rotation.x  *= 0.88;
        p.rightArm.rotation.x *= 0.88;
      }
      this.body.position.y = Math.sin(this._bobTime) * 0.012;
      p.head.position.y    = 1.9 + Math.sin(this._bobTime * 0.8) * 0.008;
    }

    // Weapon aiming pose for right arm
    if (armed) {
      const targetRX = -0.55 + this.pitch * 0.35;
      p.rightArm.rotation.x = THREE.MathUtils.lerp(p.rightArm.rotation.x, targetRX, 0.18);
      p.rightArm.rotation.z = THREE.MathUtils.lerp(p.rightArm.rotation.z, -0.12, 0.15);
    } else {
      p.rightArm.rotation.z = THREE.MathUtils.lerp(p.rightArm.rotation.z, 0, 0.15);
    }

    // Air pose
    if (!this.grounded) {
      p.leftLeg.rotation.x  = -0.5;
      p.rightLeg.rotation.x = -0.5;
      if (!armed) {
        p.leftArm.rotation.x  = 0.6;
        p.rightArm.rotation.x = 0.6;
      }
    }

    p.head.rotation.x = this.pitch * 0.6;
  }

  get isMovingInput() {
    const k = this._keys;
    return !!(k['KeyW'] || k['KeyS'] || k['KeyA'] || k['KeyD'] ||
              k['ArrowUp'] || k['ArrowDown'] || k['ArrowLeft'] || k['ArrowRight']);
  }

  getPosition() { return this.root.position; }
  getYaw()      { return this.yaw; }
  getPitch()    { return this.pitch; }
  isGrounded()  { return this.grounded; }
}
