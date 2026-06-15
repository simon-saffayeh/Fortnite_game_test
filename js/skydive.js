import * as THREE from 'three';
import { paintedPBR, boxGeo } from './materials.js';
import { BattlePass } from './battlepass.js';
import { SkydiveTrail } from './skydiveTrails.js';

// ── Deploy phase: ride the battle bus, jump out, skydive, parachute, land ─────
// Fortnite-style match intro. While active, this controller fully owns the
// player's position and the camera — Game skips the normal player/camera update.

const FOOT_OFFSET = 0.43;   // matches Player

// Bus
const BUS_HEIGHT = 165;     // cruise altitude
const BUS_SPEED  = 64;      // world units / sec
const BUS_SPAN   = 360;     // half-length of the crossing line
const SEAT_DROP  = 3.6;     // player hangs this far below the bus

// Skydive (freefall) — slower fall + faster, more responsive steering
const SD_TERMINAL = 34;
const SD_ACCEL    = 60;
const SD_H_ACCEL  = 48;
const SD_H_MAX    = 50;
const SD_H_DAMP   = 2.0;

// Camera FOV per phase
const BUS_FOV      = 95;   // very wide for the orbiting establishing shot
const SD_FOV       = 86;   // wider than gameplay = sense of speed in freefall
const BASE_FOV     = 70;
const SKYDIVE_BASE_PITCH = 1.35; // belly-down dive pose (~77° head-down)
const LEAN_PITCH   = 0.25; // wishFwd modulation on top of the base dive pose
const LEAN_ROLL    = 0.40; // sideways bank when steering
const CAM_ROLL     = 0.08; // camera roll matching steering

// Scratch quaternions / axes for the body rotation (re-used each frame)
const _qPitch = new THREE.Quaternion();
const _qRoll  = new THREE.Quaternion();
const _axX    = new THREE.Vector3(1, 0, 0);
const _axZ    = new THREE.Vector3(0, 0, 1);
const _trailPos = new THREE.Vector3();   // scratch — skydive trail emit point

// Bus orbit camera
const BUS_ORBIT_DIST = 22;  // how far back the camera sits from the bus
const BUS_ORBIT_RISE = 4;   // extra height — orbit slightly above the bus

// Parachute
const PC_TERMINAL = 9;
const PC_ACCEL    = 26;
const PC_H_ACCEL  = 24;
const PC_H_MAX    = 17;
const PC_H_DAMP   = 2.6;

// Deploy heights (metres above terrain)
const AUTO_DEPLOY_H = 30;   // chute opens automatically at/below this
const MIN_DEPLOY_H  = 7;    // can't manually deploy below this

export const DEPLOY_PHASE = { BUS: 0, SKYDIVE: 1, CHUTE: 2, DONE: 3 };

// ── Wind streaks — line segments that live in the PLAYER's reference frame.
// Each streak holds an (relX, relY, relZ) offset relative to the player and
// flows upward in that frame, so when the player steers sideways the streaks
// follow along instead of getting left behind. One shared material; geometry
// is two vertices we rewrite in place each frame.
class WindStreaks {
  constructor(scene) {
    this.scene = scene;
    const POOL = 60;
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.55,
    });
    this._mat = mat;
    this._pool = [];
    for (let i = 0; i < POOL; i++) {
      const positions = new Float32Array(6);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      this._pool.push({
        line, geo, positions, alive: false,
        relX: 0, relY: 0, relZ: 0, len: 1.5,
      });
    }
    this._spawnT = 0;
  }

  // vel: player's current velocity (so flow speed scales with how fast you fall)
  update(dt, player, vel, intensity) {
    const I = Math.max(0, Math.min(1, intensity));
    const px = player.root.position.x;
    const py = player.root.position.y;
    const pz = player.root.position.z;
    const flowSpeed = Math.max(10, Math.abs(vel.y));

    // Move + cull alive streaks; rewrite their world-space line endpoints
    for (const s of this._pool) {
      if (!s.alive) continue;
      s.relY += flowSpeed * dt;
      if (s.relY > 6) {
        s.alive = false;
        s.line.visible = false;
        continue;
      }
      const x  = px + s.relX;
      const z  = pz + s.relZ;
      const y0 = py + s.relY;
      s.positions[0] = x; s.positions[1] = y0;          s.positions[2] = z;
      s.positions[3] = x; s.positions[4] = y0 + s.len;  s.positions[5] = z;
      s.geo.attributes.position.needsUpdate = true;
    }

    // Spawn new streaks below the player at random radii
    if (I > 0.05) {
      this._spawnT -= dt;
      const interval = Math.max(0.012, 0.045 - I * 0.035);
      while (this._spawnT <= 0) {
        this._spawnT += interval;
        const s = this._pool.find(p => !p.alive);
        if (!s) break;
        const ang = Math.random() * Math.PI * 2;
        const r   = 1.5 + Math.random() * 9;
        s.relX = Math.cos(ang) * r;
        s.relZ = Math.sin(ang) * r;
        s.relY = -12 - Math.random() * 22;
        s.len  = 1.8 + I * 4.2 + Math.random() * 2.0;
        s.alive = true;
        s.line.visible = true;
      }
    }

    // Overall opacity scales with intensity (smooth taper into the chute phase)
    this._mat.opacity = 0.18 + I * 0.55;
  }

  clear() {
    for (const s of this._pool) { s.alive = false; s.line.visible = false; }
  }

  remove() {
    for (const s of this._pool) {
      this.scene.remove(s.line);
      s.geo.dispose();
    }
    this._mat.dispose();
  }
}

export class DeployController {
  constructor(scene, world, player, camera, busPath = null) {
    this.scene  = scene;
    this.world  = world;
    this.player = player;
    this.camera = camera;
    this.active = true;
    this.phase  = DEPLOY_PHASE.BUS;

    // ── Bus path ──────────────────────────────────────────────────────────
    const p = busPath || {
      angle:   Math.random() * Math.PI * 2,
      offsetX: (Math.random() - 0.5) * 180,
      offsetZ: (Math.random() - 0.5) * 180,
    };
    const dir = new THREE.Vector3(Math.sin(p.angle), 0, Math.cos(p.angle));
    const mid = new THREE.Vector3(p.offsetX, BUS_HEIGHT, p.offsetZ);
    this._busStart  = mid.clone().addScaledVector(dir, -BUS_SPAN);
    this._busEnd    = mid.clone().addScaledVector(dir,  BUS_SPAN);
    this._busDir    = dir;
    this._busTotalT = (BUS_SPAN * 2) / BUS_SPEED;
    this._busT      = 0;

    this._vel = new THREE.Vector3();   // used in skydive / chute

    // ── Camera orbit ──────────────────────────────────────────────────────
    this._camYaw    = p.angle;         // start looking along travel direction
    this._camPitch  = -0.32;
    this._prevSpace = true;            // ignore a Space still held from the menu

    // ── Lean / roll smoothing (set from steering input each frame) ────────
    this._wishFwd   = 0;
    this._wishRgt   = 0;
    this._leanPitch = 0;  // body forward lean (head-down dive)
    this._leanRoll  = 0;  // body bank when steering sideways
    this._camRoll   = 0;  // matching camera roll
    this._chuteSway = 0;  // parachute sway phase
    this._chuteAmt  = 0;  // 0 = skydive limbs, 1 = chute limbs (smooth transition)

    // ── Wider FOV for the bus / skydive — restored in _finish() ──────────
    // Start at BUS_FOV; _updateFov() lerps it down once we leave the bus.
    this._savedFov = this.camera.fov;
    this.camera.fov = BUS_FOV;
    this.camera.updateProjectionMatrix();

    // ── Particles ────────────────────────────────────────────────────────
    this._particles    = null;
    this._cloudY       = 90;    // absolute world-Y of the cloud layer
    this._cloudCrossed = false;
    this._cloudFlash   = 0;

    // ── Meshes ────────────────────────────────────────────────────────────
    this._buildCloud();
    this._buildBus();
    this._buildParachute();
    this._streaks = new WindStreaks(scene);

    // ── Equipped Battle Pass skydive trail (cosmetic, local-only) ──────────
    const trailFx = BattlePass.skydiveTrailFx?.() ?? null;
    this._trail   = trailFx ? new SkydiveTrail(scene, trailFx) : null;

    // ── Player presentation ───────────────────────────────────────────────
    // Player stays invisible during the bus phase (it's a cinematic orbit of
    // the bus, not a chase cam) — revealed on _jumpOut() when they leap out.
    this.player.body.visible = false;
    this.player.gunAttachPoint.visible = false; // no gun while deploying

    this._placePlayerOnBus();

    // ── Deploy HUD banner ─────────────────────────────────────────────────
    this._banner = document.createElement('div');
    this._banner.id = 'deploy-banner';
    this._banner.style.cssText =
      'position:fixed;left:50%;bottom:120px;transform:translateX(-50%);' +
      'font:600 18px "Segoe UI",Arial;color:#fff;text-shadow:0 2px 6px #000;' +
      'background:rgba(0,0,0,0.45);padding:10px 24px;border-radius:8px;' +
      'pointer-events:none;z-index:30;letter-spacing:0.4px;white-space:nowrap;';
    document.getElementById('hud').appendChild(this._banner);
  }

  // ── Public ──────────────────────────────────────────────────────────────
  getPhaseInt() { return this.phase; }

  setParticles(ps) { this._particles = ps; }

  /**
   * Bus flight endpoints in world space, used by the map overlay to draw the
   * incoming route line. Returns null components if the controller is no
   * longer active so callers can skip rendering after landing.
   */
  getBusStart() { return this._busStart; }
  getBusEnd()   { return this._busEnd; }

  update(dt) {
    if (!this.active) return;
    this._readMouse();

    if      (this.phase === DEPLOY_PHASE.BUS)     this._updateBus(dt);
    else if (this.phase === DEPLOY_PHASE.SKYDIVE) this._updateFreefall(dt, false);
    else if (this.phase === DEPLOY_PHASE.CHUTE)   this._updateFreefall(dt, true);

    // ── Lean / roll smoothing ──────────────────────────────────────────
    // Skydive: belly-down base + steering modulation.
    // Chute / Done: smoothly rotate back to vertical and raise arms.
    const sk = this.phase === DEPLOY_PHASE.SKYDIVE;
    const cu = this.phase === DEPLOY_PHASE.CHUTE || this.phase === DEPLOY_PHASE.DONE;
    const tPitch   = sk ? (SKYDIVE_BASE_PITCH + this._wishFwd * LEAN_PITCH) : 0;
    const tBodyRol = sk ? -this._wishRgt * LEAN_ROLL : 0;
    const tCamRoll = sk ? -this._wishRgt * CAM_ROLL  : 0;
    const tChute   = cu ? 1 : 0;
    const a = 1 - Math.exp(-5 * dt);
    this._leanPitch = THREE.MathUtils.lerp(this._leanPitch, tPitch,   a);
    this._leanRoll  = THREE.MathUtils.lerp(this._leanRoll,  tBodyRol, a);
    this._camRoll   = THREE.MathUtils.lerp(this._camRoll,   tCamRoll, a);
    this._chuteAmt  = THREE.MathUtils.lerp(this._chuteAmt,  tChute,   a);
    this._chuteSway += dt * 1.6;

    this._updateCamera();
    this._updateFov(dt);
    this._updatePose();
    this._updateBanner();

    // Wind streaks — stronger at terminal velocity, gentle wisps under chute
    const intensity = this.phase === DEPLOY_PHASE.SKYDIVE
      ? Math.min(1, -this._vel.y / SD_TERMINAL)
      : (this.phase === DEPLOY_PHASE.CHUTE ? 0.18 : 0);
    this._streaks.update(dt, this.player, this._vel, intensity);

    // Speed-tinted streaks: white at slow fall, icy-blue at terminal velocity
    if (this.phase === DEPLOY_PHASE.SKYDIVE) {
      const spd = Math.min(1, -this._vel.y / SD_TERMINAL);
      this._streaks._mat.color.setRGB(
        THREE.MathUtils.lerp(1, 0.55, spd),
        THREE.MathUtils.lerp(1, 0.85, spd),
        1.0
      );
    } else {
      this._streaks._mat.color.setRGB(1, 1, 1);
    }

    // Equipped cosmetic skydive trail
    if (this._trail) {
      if (this.phase === DEPLOY_PHASE.SKYDIVE || this.phase === DEPLOY_PHASE.CHUTE) {
        const p = this.player.root.position;
        _trailPos.set(p.x, p.y + 0.6, p.z);
        this._trail.emit(dt, _trailPos);
      }
      this._trail.update(dt);
    }

    // Cloud flash — fade opacity back to resting value
    if (this._cloudFlash > 0) {
      this._cloudFlash = Math.max(0, this._cloudFlash - dt * 1.8);
      if (this._cloud) this._cloud.material.opacity = 0.22 + this._cloudFlash * 0.55;
    } else if (this._cloud) {
      this._cloud.material.opacity = 0.22;
    }

    // Keep the networked yaw meaningful for remote viewers
    this.player.yaw = this._camYaw;
    this.player.root.rotation.y = this._camYaw;
  }

  // ── Input ───────────────────────────────────────────────────────────────
  _readMouse() {
    const sens = 0.0022 * (this.player._sensMultiplier ?? 1.0);
    this._camYaw   -= this.player._mouseX * sens;
    this._camPitch -= this.player._mouseY * sens;
    this._camPitch  = Math.max(-1.2, Math.min(0.5, this._camPitch));
    this.player._mouseX = 0;
    this.player._mouseY = 0;
  }

  // ── Phase: BUS ──────────────────────────────────────────────────────────
  _placePlayerOnBus() {
    const busPos = this._busPosAt(this._busT);
    this.player.root.position.set(busPos.x, busPos.y - SEAT_DROP, busPos.z);
  }

  _busPosAt(t) {
    const f = Math.min(t, this._busTotalT) / this._busTotalT;
    return this._busStart.clone().lerp(this._busEnd, f);
  }

  _updateBus(dt) {
    this._wishFwd = 0;
    this._wishRgt = 0;
    this._busT += dt;
    const busPos = this._busPosAt(this._busT);
    this._bus.position.copy(busPos);
    this._bus.rotation.y = Math.atan2(this._busDir.x, this._busDir.z);
    this.player.root.position.set(busPos.x, busPos.y - SEAT_DROP, busPos.z);

    const space = !!this.player._keys['Space'];
    const distC = Math.hypot(busPos.x, busPos.z);
    const forced = this._busT >= this._busTotalT ||
                   (this._busT > this._busTotalT * 0.5 && distC > 270);
    if ((space && !this._prevSpace) || forced) this._jumpOut();
    this._prevSpace = space;
  }

  _jumpOut() {
    this.phase = DEPLOY_PHASE.SKYDIVE;
    this.player.body.visible = true;  // reveal the diver as they leap out
    // Snap straight into the dive pose so they don't appear upright for a beat
    this._leanPitch = SKYDIVE_BASE_PITCH;
    this._chuteAmt  = 0;
    // Inherit a little of the bus's forward momentum
    this._vel.set(this._busDir.x * BUS_SPEED * 0.28, -4,
                  this._busDir.z * BUS_SPEED * 0.28);
  }

  // ── Phase: SKYDIVE / CHUTE ──────────────────────────────────────────────
  _updateFreefall(dt, chute) {
    const term  = chute ? PC_TERMINAL : SD_TERMINAL;
    const accel = chute ? PC_ACCEL    : SD_ACCEL;
    const hAcc  = chute ? PC_H_ACCEL  : SD_H_ACCEL;
    const hMax  = chute ? PC_H_MAX    : SD_H_MAX;
    const hDamp = chute ? PC_H_DAMP   : SD_H_DAMP;

    // Vertical — ease toward terminal velocity
    if (this._vel.y > -term) this._vel.y = Math.max(-term, this._vel.y - accel * dt);
    else                     this._vel.y = Math.min(-term, this._vel.y + accel * dt);

    // Horizontal steering — camera-relative
    const k = this.player._keys;
    const fwd = new THREE.Vector3(-Math.sin(this._camYaw), 0, -Math.cos(this._camYaw));
    const rgt = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const inFwd = (k['KeyW']||k['ArrowUp']   ? 1 : 0) - (k['KeyS']||k['ArrowDown'] ? 1 : 0);
    const inRgt = (k['KeyD']||k['ArrowRight']? 1 : 0) - (k['KeyA']||k['ArrowLeft'] ? 1 : 0);
    this._wishFwd = inFwd;
    this._wishRgt = inRgt;
    const wish = new THREE.Vector3();
    if (inFwd) wish.addScaledVector(fwd, inFwd);
    if (inRgt) wish.addScaledVector(rgt, inRgt);

    if (wish.lengthSq() > 0) {
      wish.normalize();
      this._vel.x += wish.x * hAcc * dt;
      this._vel.z += wish.z * hAcc * dt;
    } else {
      const d = Math.exp(-hDamp * dt);
      this._vel.x *= d;
      this._vel.z *= d;
    }
    const hs = Math.hypot(this._vel.x, this._vel.z);
    if (hs > hMax) { this._vel.x *= hMax / hs; this._vel.z *= hMax / hs; }

    // Integrate
    const pos = this.player.root.position;
    pos.x += this._vel.x * dt;
    pos.y += this._vel.y * dt;
    pos.z += this._vel.z * dt;

    const groundY  = this.world.getTerrainHeight(pos.x, pos.z);
    const altitude = pos.y - groundY;

    // Cloud layer crossing — burst of white particles + brief white-out flash
    if (!this._cloudCrossed && pos.y < this._cloudY) {
      this._cloudCrossed = true;
      this._cloudFlash   = 0.6;
      if (this._particles) {
        const cp = pos.clone();
        cp.y = this._cloudY;
        this._particles.spawnBurst(cp, { count: 30, color: 0xddeeff, speed: 5, lifetime: 0.65, size: 0.55, gravity: 0 });
      }
    }

    // Deploy logic (skydive only)
    if (!chute) {
      const space = !!this.player._keys['Space'];
      const wantDeploy = space && !this._prevSpace;
      this._prevSpace = space;
      if ((wantDeploy && altitude > MIN_DEPLOY_H) || altitude <= AUTO_DEPLOY_H) {
        this._openChute();
      }
    }

    // Landing
    if (pos.y <= groundY + FOOT_OFFSET) {
      pos.y = groundY + FOOT_OFFSET;
      this._finish();
    }
  }

  _openChute() {
    this.phase = DEPLOY_PHASE.CHUTE;
    this._chute.visible = true;
    this._vel.y = Math.max(this._vel.y, -PC_TERMINAL);  // soften the snap

    // Chute deploy puff — white burst simulating canopy inflation
    if (this._particles) {
      const pos = this.player.root.position.clone();
      pos.y += 2.5;
      this._particles.spawnBurst(pos, { count: 20, color: 0xffffff, speed: 4.5, lifetime: 0.7, size: 0.38, gravity: 1 });
    }
  }

  // ── Hand control back to normal gameplay ────────────────────────────────
  _finish() {
    this.active = false;
    this.phase  = DEPLOY_PHASE.DONE;

    // Landing dust kick-up
    if (this._particles) {
      const pos = this.player.root.position.clone();
      this._particles.spawnBurst(pos, { count: 35, color: 0x996633, speed: 5.5, lifetime: 1.0, size: 0.28, gravity: 9 });
    }

    // Remove cloud layer
    if (this._cloud) {
      this.scene.remove(this._cloud);
      this._cloud.geometry.dispose();
      this._cloud.material.dispose();
      this._cloud = null;
    }

    this._chute.visible = false;
    if (this._chute.parent) this._chute.parent.remove(this._chute);
    this.scene.remove(this._bus);
    this._disposeGroup(this._bus);
    this._streaks.remove();
    this._trail?.remove();
    this._trail = null;
    this._banner.remove();

    // Restore camera FOV so the FPS camera doesn't pop the projection matrix
    this.camera.fov = this._savedFov ?? BASE_FOV;
    this.camera.updateProjectionMatrix();

    // Reset limb pose + body lean so _animateBody starts clean
    for (const g of [this.player.leftArmGroup, this.player.rightArmGroup,
                     this.player.leftLegGroup, this.player.rightLegGroup]) {
      g.rotation.set(0, 0, 0);
    }
    this.player.body.rotation.set(0, 0, 0);

    this.player.gunAttachPoint.visible = true;
    this.player.body.visible = false;       // back to first-person
    this.player.velocity.set(0, 0, 0);
    this.player.grounded = true;
    this.player.yaw   = this._camYaw;
    this.player.pitch = 0;
  }

  // ── Camera ──────────────────────────────────────────────────────────────
  // BUS: wide-angle orbit around the bus itself, player invisible.
  // SKYDIVE / CHUTE: chase cam locked to the player.
  _updateCamera() {
    const cp = Math.cos(this._camPitch), sp = Math.sin(this._camPitch);
    const forward = new THREE.Vector3(
      -Math.sin(this._camYaw) * cp, sp, -Math.cos(this._camYaw) * cp
    );

    if (this.phase === DEPLOY_PHASE.BUS) {
      const center = this._bus.position.clone();
      center.y += 2.0;
      const camPos = center.clone().addScaledVector(forward, -BUS_ORBIT_DIST);
      camPos.y += BUS_ORBIT_RISE;
      this.camera.position.copy(camPos);
      this.camera.lookAt(center);
      return;
    }

    // When the body tilts belly-down, its visual center extends forward from
    // the feet. Shift the camera target along the body's forward axis so the
    // diver stays in frame as they rotate between vertical and horizontal.
    const center = this.player.root.position.clone();
    const tilt   = this._leanPitch;
    const fwdAmt = 1.25 * Math.sin(tilt);
    center.x += -Math.sin(this._camYaw) * fwdAmt;
    center.y += 1.25 * Math.cos(tilt) + 0.05;
    center.z += -Math.cos(this._camYaw) * fwdAmt;

    const camPos = center.clone().addScaledVector(forward, -7.5);
    camPos.y += 1.4;
    this.camera.position.copy(camPos);
    this.camera.lookAt(center);
    if (Math.abs(this._camRoll) > 0.0005) this.camera.rotateZ(this._camRoll);
  }

  _updateFov(dt) {
    const target = this.phase === DEPLOY_PHASE.BUS ? BUS_FOV : SD_FOV;
    const a = 1 - Math.exp(-4 * dt);
    const next = THREE.MathUtils.lerp(this.camera.fov, target, a);
    if (Math.abs(next - this.camera.fov) > 0.05) {
      this.camera.fov = next;
      this.camera.updateProjectionMatrix();
    }
  }

  // ── Body pose ───────────────────────────────────────────────────────────
  // Unified pose: limbs lerp between skydive spread-eagle (_chuteAmt = 0) and
  // chute arms-up (_chuteAmt = 1). Body rotation is composed as roll-then-
  // pitch via quaternion so the bank rotates around the spine, not the yaw.
  _updatePose() {
    const la = this.player.leftArmGroup,  ra = this.player.rightArmGroup;
    const ll = this.player.leftLegGroup,  rl = this.player.rightLegGroup;
    const c  = this._chuteAmt;
    const L  = THREE.MathUtils.lerp;

    la.rotation.set(L(-0.4, -2.5, c), 0, L( 1.05,  0.35, c));
    ra.rotation.set(L(-0.4, -2.5, c), 0, L(-1.05, -0.35, c));
    ll.rotation.set(L( 0.25, 0.25, c), 0, L( 0.32,  0.05, c));
    rl.rotation.set(L( 0.25, 0.25, c), 0, L(-0.32, -0.05, c));

    // Body: pitch (belly-down) around right axis, roll around spine.
    // Quaternion order qRoll * qPitch → roll first (in local frame), then
    // pitch — so the bank actually rolls around the body's spine even when
    // the body is rotated horizontal.
    _qPitch.setFromAxisAngle(_axX, -this._leanPitch);
    _qRoll .setFromAxisAngle(_axZ,  this._leanRoll);
    this.player.body.quaternion.multiplyQuaternions(_qRoll, _qPitch);

    // Parachute sway — only animate while it's actually deployed
    if (this._chute && this._chute.visible) {
      const sway = Math.sin(this._chuteSway) * 0.07;
      const tilt = Math.cos(this._chuteSway * 1.3) * 0.05;
      const hs   = Math.hypot(this._vel.x, this._vel.z) / PC_H_MAX;
      this._chute.rotation.z = sway;
      this._chute.rotation.x = tilt - hs * 0.18;
    }
  }

  // ── HUD banner text ─────────────────────────────────────────────────────
  _updateBanner() {
    if (this.phase === DEPLOY_PHASE.BUS) {
      this._banner.style.color = '';
      this._banner.textContent = 'Press  [SPACE]  to jump';
    } else if (this.phase === DEPLOY_PHASE.SKYDIVE) {
      const pos = this.player.root.position;
      const alt = Math.max(0, Math.round(pos.y - this.world.getTerrainHeight(pos.x, pos.z)));
      // Green = safe altitude; yellow = approaching auto-deploy; red = imminent
      const col = alt <= AUTO_DEPLOY_H       ? '#ff4444'
                : alt <= AUTO_DEPLOY_H + 28  ? '#ffcc44'
                                             : '#ffffff';
      this._banner.style.color = col;
      this._banner.textContent = `Press  [SPACE]  to deploy glider  ·  Altitude ${alt}m`;
    } else {
      this._banner.style.color = '';
      this._banner.textContent = 'Steer with  [W A S D]';
    }
  }

  // ── Mesh builders ───────────────────────────────────────────────────────
  _buildCloud() {
    const geo = new THREE.CircleGeometry(220, 48);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xd4e8f5, transparent: true, opacity: 0.22,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x    = -Math.PI / 2;
    mesh.position.y    = this._cloudY;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this._cloud = mesh;
  }

  _buildBus() {
    const bus = new THREE.Group();
    const lm  = hex => paintedPBR(hex);

    // Body (long axis along Z so it aligns with travel direction)
    const body = new THREE.Mesh(boxGeo(7, 3.4, 17), lm(0x2f6fc4));
    body.position.y = 0;
    bus.add(body);
    // Roof
    const roof = new THREE.Mesh(boxGeo(7.1, 0.5, 17.1), lm(0xf2c43a));
    roof.position.y = 1.95;
    bus.add(roof);
    // Window strips
    for (const side of [-1, 1]) {
      const win = new THREE.Mesh(boxGeo(0.15, 1.1, 15.5), lm(0xaad8ff));
      win.position.set(side * 3.55, 0.6, 0);
      bus.add(win);
    }
    // Wheels (cosmetic)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.7, 12), lm(0x1a1a1a));
      w.rotation.z = Math.PI / 2;
      w.position.set(sx * 3.4, -2.0, sz * 5.4);
      bus.add(w);
    }
    // Hot-air balloon
    const balloon = new THREE.Mesh(new THREE.SphereGeometry(5.2, 18, 14), lm(0xe2473a));
    balloon.position.y = 11;
    bus.add(balloon);
    const stripe = new THREE.Mesh(new THREE.SphereGeometry(5.25, 18, 6, 0, Math.PI * 2, 1.0, 0.5), lm(0xf2f2f2));
    stripe.position.y = 11;
    bus.add(stripe);
    // Ropes from balloon to roof
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 6.5, 5), lm(0x222222));
      rope.position.set(sx * 2.4, 5.6, sz * 2.4);
      bus.add(rope);
    }

    bus.traverse(o => { if (o.isMesh) o.castShadow = false; });
    this.scene.add(bus);
    this._bus = bus;
  }

  _buildParachute() {
    const chute = new THREE.Group();
    const PANELS = 10;
    const RADIUS = 2.8;
    const Y      = 4.7;
    const colors = [0xee3a3a, 0xf5f5f5]; // alternating panels

    // Segmented canopy — each panel is a pie-slice wedge of the dome
    for (let i = 0; i < PANELS; i++) {
      const phiStart = (i / PANELS) * Math.PI * 2;
      const phiLen   = (Math.PI * 2) / PANELS;
      const geo = new THREE.SphereGeometry(
        RADIUS, 6, 10, phiStart, phiLen, 0, Math.PI * 0.5
      );
      const mat = paintedPBR(colors[i % 2], {
        side: THREE.DoubleSide, emissive: 0x080808, rough: 0.85,
      });
      const panel = new THREE.Mesh(geo, mat);
      panel.position.y = Y;
      chute.add(panel);
    }
    // Crown disc for a clean top + seam ring along the rim
    const crown = new THREE.Mesh(
      new THREE.CircleGeometry(0.35, 16),
      paintedPBR(0xdddddd, { rough: 0.7 })
    );
    crown.rotation.x = -Math.PI / 2;
    crown.position.y = Y + RADIUS - 0.02;
    chute.add(crown);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(RADIUS - 0.05, 0.04, 6, 32),
      paintedPBR(0x222222, { rough: 0.55, metal: 0.5 })
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = Y;
    chute.add(rim);

    // Risers — thin tapered lines from rim to backpack
    const lm = new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.85 });
    const RISER_COUNT = 8;
    for (let i = 0; i < RISER_COUNT; i++) {
      const a = (i / RISER_COUNT) * Math.PI * 2;
      const top = new THREE.Vector3(Math.cos(a) * (RADIUS - 0.1), Y, Math.sin(a) * (RADIUS - 0.1));
      // Risers converge to the player's shoulders (left/right of the body)
      const bot = new THREE.Vector3(
        Math.cos(a) > 0 ?  0.45 : -0.45, 2.0,
        Math.sin(a) * 0.15
      );
      const geo = new THREE.BufferGeometry().setFromPoints([top, bot]);
      chute.add(new THREE.Line(geo, lm));
    }

    chute.visible = false;
    this.player.root.add(chute);
    this._chute = chute;
  }

  _disposeGroup(group) {
    group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}
