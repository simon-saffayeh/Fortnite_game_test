import * as THREE from 'three';
import { paintedPBR } from './materials.js';

// ── Spawn points for up to 20 players — POI regions + mid-map + edges ──
// Each point is on flat reachable terrain, spaced to avoid spawn-clusters.
export const MP_SPAWNS = [
  // POI-adjacent (original 6)
  [  80,   15 ],  // Cedar Creek side
  [ -108,   35 ],  // Frank's Jail side
  [  55, -140 ],  // Ancient Temple side
  [ -70,   95 ],  // Military Compound side
  [ 140,  -90 ],  // Olsen's Farm side
  [ -105, -105 ],  // Whalen's Town side
  // Mid-map cardinal extras (original 4)
  [   0,  120 ],
  [   0, -120 ],
  [ 120,   60 ],
  [ -120,  -40 ],
  // Outer ring (added for 11–20)
  [  170,    0 ],  // east coast
  [ -170,   80 ],  // far west
  [   80,  170 ],  // far north-east
  [  -40, -180 ],  // far south
  [  200,  170 ],  // NE corner
  [ -190, -160 ],  // SW corner
  [   40,   60 ],  // central north
  [  -45,  -40 ],  // central south
  [  165, -150 ],  // SE corner
  [  -60,  150 ],  // mid-north
];

// ── Remote Player (3D character + name tag, driven by network) ────────────────
export class RemotePlayer {
  constructor(scene, id, name) {
    this.id     = id;
    this.name   = name;
    this.scene  = scene;
    this.dead   = false;
    this.health = 100;
    this.phase  = 3;   // 0 bus · 1 skydive · 2 chute · 3 playing

    this._targetPos = new THREE.Vector3();
    this._targetYaw = 0;

    // Animation state — driven by frame-to-frame position deltas
    this._prevPos    = new THREE.Vector3();
    this._animPhase  = 0;   // sine-wave phase for leg/arm swing
    this._animSpeed  = 0;   // smoothed horizontal speed estimate
    this._bobY       = 0;   // smoothed torso bob
    this._crouchBlend = 0;  // 0 = standing, 1 = fully crouched
    this.crouching   = false;

    this._buildModel();
    this._buildParachute();
    this._buildNameTag();
  }

  _buildModel() {
    this.root = new THREE.Group();
    this.scene.add(this.root);

    // Per-instance material cache — share materials across same-color parts so
    // a 25-mesh character has ~6 materials instead of 25. Materials, not meshes,
    // dominate draw-call cost in three.js. paintedPBR() also caches globally,
    // so a remote player and the local player reuse the same hex-keyed PBR.
    const matFor = hex => paintedPBR(hex);
    const box = (w, h, d, hex, px, py, pz) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matFor(hex));
      m.position.set(px, py, pz);
      m.castShadow = true;
      return m;
    };

    // ── Torso (bobs vertically, leans on sprint) ────────────────────────
    this._torso = new THREE.Group();
    this.root.add(this._torso);
    this._torso.add(box(0.70, 0.90, 0.45, 0x8b0000, 0, 1.35, 0));   // torso
    this._torso.add(box(0.50, 0.55, 0.04, 0x5a1a00, 0, 1.42, 0.225)); // chest plate
    this._torso.add(box(0.72, 0.15, 0.47, 0x5a1a00, 0, 0.97, 0));   // belt
    this._torso.add(box(0.65, 0.25, 0.42, 0x37474f, 0, 0.87, 0));   // hips

    // ── Head (child of torso so it inherits lean) ────────────────────────
    // Chibi proportions — head ~30% bigger than realistic so the silhouette
    // reads cartoony at a distance (Fortnite/Funko-style).
    this._head = new THREE.Group();
    this._head.position.set(0, 2.00, 0);
    this._torso.add(this._head);
    this._head.add(box(0.78, 0.72, 0.72, 0xffcba4, 0, 0, 0));
    const helm = new THREE.Mesh(
      new THREE.SphereGeometry(0.46, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.6),
      matFor(0x6a0000),
    );
    helm.position.set(0, 0.08, 0);
    helm.castShadow = true;
    this._head.add(helm);
    // Visor — bright unshaded strip, no shadow casting (cheap, no lighting cost)
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.10, 0.04),
      new THREE.MeshBasicMaterial({ color: 0xff5533 }),
    );
    visor.position.set(0, -0.04, 0.36);
    this._head.add(visor);
    this._visor = visor;  // recolored by setTeammate

    // ── Articulated arms ────────────────────────────────────────────────
    // shoulder pivot ▶ upper arm + pauldron
    //   └─ elbow pivot ▶ forearm + glove
    const buildArm = (sx) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(sx, 1.65, 0);
      shoulder.add(box(0.30, 0.14, 0.28, 0x5a1a00, 0, 0.00, 0));    // pauldron
      shoulder.add(box(0.22, 0.50, 0.22, 0x7a0000, 0, -0.28, 0));   // upper arm
      const elbow = new THREE.Group();
      elbow.position.set(0, -0.55, 0);
      elbow.add(box(0.20, 0.45, 0.20, 0xffcba4, 0, -0.22, 0));      // forearm (skin)
      elbow.add(box(0.30, 0.25, 0.30, 0x1a237e, 0, -0.57, 0.02));   // chunky glove (chibi)
      shoulder.add(elbow);
      return { shoulder, elbow };
    };
    const la = buildArm(-0.48);
    const ra = buildArm( 0.48);
    this._leftArm    = la.shoulder;
    this._leftElbow  = la.elbow;
    this._rightArm   = ra.shoulder;
    this._rightElbow = ra.elbow;
    this._torso.add(this._leftArm);
    this._torso.add(this._rightArm);

    // ── Articulated legs ────────────────────────────────────────────────
    // hip pivot ▶ thigh + kneepad (fixed at joint)
    //   └─ knee pivot ▶ shin + boot
    const buildLeg = (sx) => {
      const hip = new THREE.Group();
      hip.position.set(sx, 1.00, 0);
      hip.add(box(0.26, 0.55, 0.26, 0x37474f, 0, -0.275, 0));       // thigh
      hip.add(box(0.28, 0.10, 0.08, 0x1a1a22, 0, -0.55, 0.10));     // kneepad
      const knee = new THREE.Group();
      knee.position.set(0, -0.55, 0);
      knee.add(box(0.23, 0.42, 0.23, 0x37474f, 0, -0.21, 0));       // shin
      knee.add(box(0.34, 0.22, 0.42, 0x212121, 0, -0.53, 0.06));    // chunky boot (chibi)
      hip.add(knee);
      return { hip, knee };
    };
    const ll = buildLeg(-0.20);
    const rl = buildLeg( 0.20);
    this._leftLeg   = ll.hip;
    this._leftKnee  = ll.knee;
    this._rightLeg  = rl.hip;
    this._rightKnee = rl.knee;
    this.root.add(this._leftLeg);
    this.root.add(this._rightLeg);

    // ── Health bar ──────────────────────────────────────────────────────
    const hpBg = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 0.16),
      new THREE.MeshBasicMaterial({ color: 0x220000, depthTest: false, side: THREE.DoubleSide })
    );
    hpBg.position.y = 2.9;
    this.root.add(hpBg);

    this._hpFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 0.16),
      new THREE.MeshBasicMaterial({ color: 0xee2222, depthTest: false, side: THREE.DoubleSide })
    );
    this._hpFill.position.set(0, 2.9, 0.005);
    this.root.add(this._hpFill);
    this._hpBg = hpBg;
  }

  _buildParachute() {
    const chute = new THREE.Group();
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(2.6, 16, 9, 0, Math.PI * 2, 0, Math.PI * 0.5),
      paintedPBR(0xcc4433, { side: THREE.DoubleSide, rough: 0.9 })
    );
    canopy.position.y = 4.4;
    chute.add(canopy);
    const lm = new THREE.LineBasicMaterial({ color: 0x222222 });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(Math.cos(a) * 2.3, 4.3, Math.sin(a) * 2.3),
        new THREE.Vector3(0, 1.9, 0),
      ]);
      chute.add(new THREE.Line(geo, lm));
    }
    chute.visible = false;
    this.root.add(chute);
    this._chute = chute;
  }

  _buildNameTag() {
    this._tag = document.createElement('div');
    this._tag.className = 'remote-player-tag';
    this._tag.textContent = this.name;
    const hud = document.getElementById('hud');
    if (hud) hud.appendChild(this._tag);
  }

  setTargetState(pos, yaw, phase, weapon, ammo, reserve, health, crouching) {
    this._targetPos.set(pos[0], pos[1], pos[2]);
    this._targetYaw = yaw;
    if (phase !== undefined) this.phase = phase;
    // Held-weapon snapshot for spectator HUD. Null when the remote is on
    // a consumable slot or hasn't transmitted yet.
    this.weaponId = weapon ?? null;
    this.ammo     = ammo    ?? null;
    this.reserve  = reserve ?? null;
    // Authoritative health from victim — overrides local prediction
    if (health !== undefined && !this.dead) this.health = health;
    // Crouch state — animation pose + lowered silhouette
    this.crouching = !!crouching;
  }

  /**
   * Apply teammate visuals: HP bar turns green, nametag gets a CSS class
   * the stylesheet can theme. Called from NetworkManager.spawnRemotePlayers
   * once team membership is known. Idempotent — safe to call again.
   */
  setTeammate(isTeammate) {
    this.isTeammate = !!isTeammate;
    if (this._hpFill) this._hpFill.material.color.setHex(isTeammate ? 0x22dd66 : 0xee2222);
    if (this._visor)  this._visor.material.color.setHex(isTeammate ? 0x33ff88 : 0xff5533);
    if (this._tag) this._tag.classList.toggle('teammate', !!isTeammate);
  }

  takeDamage(amount) {
    if (this.dead) return;
    this.health = Math.max(0, this.health - amount);
    // Don't trigger death from local prediction — the victim has shield we
    // can't see, so our health calc can be wrong. Death arrives authoritatively
    // via the server's `death` message; killing locally would freeze the body
    // and make bullets phase through a still-alive enemy (projectile.js skips
    // rp.dead targets), creating an unkillable ghost.
  }

  die() {
    this.dead = true;
    this.root.rotation.z = Math.PI / 2;
    if (this._tag) this._tag.style.display = 'none';
  }

  getCenter() {
    const p = this.root.position;
    return new THREE.Vector3(p.x, p.y + 1.2, p.z);
  }

  // ── Limb animation — driven by horizontal speed estimated from the
  // delta between the previous and current root positions. Walking and
  // sprinting drive a sine-based swing; idle eases everything back to
  // neutral. Mid-air (skydive/chute) and dead get pose overrides.
  _animate(dt) {
    if (!this._leftLeg) return;

    if (this.dead) {
      // Limbs go limp — soft easing back to neutral while the body topples.
      const ease = 1 - Math.exp(-6 * dt);
      this._leftLeg.rotation.x   *= 1 - ease;
      this._rightLeg.rotation.x  *= 1 - ease;
      this._leftKnee.rotation.x  *= 1 - ease;
      this._rightKnee.rotation.x *= 1 - ease;
      this._leftArm.rotation.x   *= 1 - ease;
      this._rightArm.rotation.x  *= 1 - ease;
      this._leftElbow.rotation.x *= 1 - ease;
      this._rightElbow.rotation.x*= 1 - ease;
      this._torso.position.y     *= 1 - ease;
      this._torso.rotation.x     *= 1 - ease;
      return;
    }

    // Horizontal speed from frame-to-frame position delta (m/s).
    const dx = this.root.position.x - this._prevPos.x;
    const dz = this.root.position.z - this._prevPos.z;
    const instSpeed = Math.sqrt(dx*dx + dz*dz) / Math.max(dt, 0.001);
    this._prevPos.copy(this.root.position);

    // Smooth so a single laggy frame doesn't spike the animation.
    this._animSpeed = THREE.MathUtils.lerp(this._animSpeed, instSpeed, 1 - Math.exp(-10 * dt));

    const airborne = this.phase === 1 || this.phase === 2;
    if (airborne) {
      // Skydive / parachute pose — arms out, legs tucked, knees bent.
      const target = this.phase === 1 ? 1.55 : 0.7;
      const k = 0.18;
      this._leftArm.rotation.x   = THREE.MathUtils.lerp(this._leftArm.rotation.x,   -target, k);
      this._rightArm.rotation.x  = THREE.MathUtils.lerp(this._rightArm.rotation.x,  -target, k);
      this._leftElbow.rotation.x = THREE.MathUtils.lerp(this._leftElbow.rotation.x, 0.55,    k);
      this._rightElbow.rotation.x= THREE.MathUtils.lerp(this._rightElbow.rotation.x,0.55,    k);
      this._leftLeg.rotation.x   = THREE.MathUtils.lerp(this._leftLeg.rotation.x,  -0.25,   k);
      this._rightLeg.rotation.x  = THREE.MathUtils.lerp(this._rightLeg.rotation.x, -0.25,   k);
      this._leftKnee.rotation.x  = THREE.MathUtils.lerp(this._leftKnee.rotation.x,  0.70,   k);
      this._rightKnee.rotation.x = THREE.MathUtils.lerp(this._rightKnee.rotation.x, 0.70,   k);
      this._torso.position.y     = THREE.MathUtils.lerp(this._torso.position.y, 0, 0.2);
      this._torso.rotation.x     = THREE.MathUtils.lerp(this._torso.rotation.x, 0, 0.2);
      return;
    }

    // Walking / running. Map speed → stride frequency + swing amplitude.
    // Running threshold is roughly the local player's sprint speed.
    const speed   = Math.min(this._animSpeed, 18);
    const running = speed > 10;
    const moving  = speed > 0.8;

    if (moving) {
      const freq    = running ? 9.0 : 6.0;
      const ampLeg  = THREE.MathUtils.clamp(speed / (running ? 14 : 8), 0.2, 1.0) * (running ? 0.55 : 0.40);
      const ampArm  = ampLeg * 0.85;
      const ampKnee = ampLeg * 1.6;             // knee bends harder than hip swings
      const baseElbow = running ? 0.55 : 0.35;  // arms held bent during locomotion
      this._animPhase += dt * freq;

      const sw  = Math.sin(this._animPhase);
      const pSw = Math.max(0,  sw);   // positive half — left leg forward
      const nSw = Math.max(0, -sw);   // negative half — right leg forward

      // Hip swing (forward/back). Opposite phase per leg.
      this._leftLeg.rotation.x  =  sw * ampLeg;
      this._rightLeg.rotation.x = -sw * ampLeg;
      // Knee bend — only when the leg swings forward, so the foot clears the ground
      this._leftKnee.rotation.x  = pSw * ampKnee;
      this._rightKnee.rotation.x = nSw * ampKnee;
      // Arms counter-swing the legs (left arm goes back when left leg goes forward)
      this._leftArm.rotation.x  = -sw * ampArm;
      this._rightArm.rotation.x =  sw * ampArm;
      // Elbows: constant relaxed bend + small bump when the arm swings forward
      this._leftElbow.rotation.x  = baseElbow + nSw * 0.18;
      this._rightElbow.rotation.x = baseElbow + pSw * 0.18;

      // Vertical torso bob — abs(sin) so it dips on each foot-plant.
      const bobAmt = (running ? 0.08 : 0.04) * Math.min(speed / 10, 1);
      this._bobY = THREE.MathUtils.lerp(this._bobY,
        Math.abs(Math.sin(this._animPhase)) * bobAmt - bobAmt * 0.5,
        1 - Math.exp(-14 * dt));
      this._torso.position.y = this._bobY;
      // Forward lean — bigger when sprinting, subtle when walking.
      const leanTarget = running ? 0.22 : 0.05;
      this._torso.rotation.x = THREE.MathUtils.lerp(this._torso.rotation.x, leanTarget, 1 - Math.exp(-8 * dt));
    } else {
      // Idle — ease limbs to relaxed pose with a faint breathing rise/fall.
      const ease = 1 - Math.exp(-7 * dt);
      this._leftLeg.rotation.x   *= 1 - ease;
      this._rightLeg.rotation.x  *= 1 - ease;
      this._leftKnee.rotation.x  *= 1 - ease;
      this._rightKnee.rotation.x *= 1 - ease;
      this._leftArm.rotation.x   *= 1 - ease;
      this._rightArm.rotation.x  *= 1 - ease;
      // Elbows hold a constant slight bend so arms don't dangle dead-straight.
      this._leftElbow.rotation.x  = THREE.MathUtils.lerp(this._leftElbow.rotation.x,  0.30, ease);
      this._rightElbow.rotation.x = THREE.MathUtils.lerp(this._rightElbow.rotation.x, 0.30, ease);
      this._animPhase += dt * 1.4;
      this._torso.position.y = Math.sin(this._animPhase) * 0.012;
      this._torso.rotation.x = THREE.MathUtils.lerp(this._torso.rotation.x, 0, ease);
    }

    // Crouch overlay — uses real knee bend now, so the pose reads clearly as
    // crouched rather than just "shrunk".
    this._crouchBlend = THREE.MathUtils.lerp(
      this._crouchBlend, this.crouching ? 1 : 0, 1 - Math.exp(-12 * dt),
    );
    const cb = this._crouchBlend;
    if (cb > 0.005) {
      this._torso.position.y     -= cb * 0.45;
      this._torso.rotation.x     += cb * 0.10;   // slight forward stoop
      this._leftLeg.rotation.x   += cb * 0.35;   // hips rotate forward
      this._rightLeg.rotation.x  += cb * 0.35;
      this._leftKnee.rotation.x  += cb * 1.00;   // knees fold hard
      this._rightKnee.rotation.x += cb * 1.00;
      this._leftArm.rotation.x   += cb * 0.20;
      this._rightArm.rotation.x  += cb * 0.20;
      this._leftElbow.rotation.x += cb * 0.25;
      this._rightElbow.rotation.x+= cb * 0.25;
    }
  }

  update(dt, camera, canvas) {
    // Framerate-independent smoothing toward the latest server state.
    // 1 - exp(-k*dt) eases identically regardless of frame rate, so remote
    // players don't snap on fast frames or crawl/rubber-band on slow ones.
    // Mid-air phases move fast — snap harder so skydivers don't rubber-band.
    const airborne = this.phase === 1 || this.phase === 2;
    const posA = 1 - Math.exp((airborne ? -26 : -16) * dt);
    const yawA = 1 - Math.exp(-14 * dt);
    this.root.position.lerp(this._targetPos, posA);
    this.root.rotation.y = THREE.MathUtils.lerp(
      this.root.rotation.y, this._targetYaw, yawA
    );

    this._animate(dt);

    // Parachute is visible only during the chute phase
    if (this._chute) this._chute.visible = this.phase === 2 && !this.dead;

    // Health bar facing camera
    if (camera) {
      const pct = this.health / 100;
      this._hpFill.scale.x = Math.max(0, pct);
      this._hpFill.position.x = -(1 - pct) * 0.7;
      this._hpBg.lookAt(camera.position);
      this._hpFill.lookAt(camera.position);
    }

    // Name tag projected to screen
    if (canvas && camera && !this.dead) {
      const wp = this.root.position.clone();
      wp.y += 3.2;
      const proj = wp.project(camera);
      if (proj.z > 1) {
        this._tag.style.display = 'none';
      } else {
        this._tag.style.display = 'block';
        this._tag.style.left = ((proj.x * 0.5 + 0.5) * canvas.clientWidth)  + 'px';
        this._tag.style.top  = ((proj.y * -0.5 + 0.5) * canvas.clientHeight) + 'px';
      }
    }
  }

  remove() {
    this.scene.remove(this.root);
    if (this._tag) this._tag.remove();
  }
}

// ── Network Manager ───────────────────────────────────────────────────────────
export class NetworkManager {
  constructor() {
    this.ws             = null;
    this.myId           = null;
    this.myName         = 'Player';
    this.isHost         = false;
    this.players        = new Map(); // id → { id, name, ready }
    this.remotePlayers  = new Map(); // id → RemotePlayer
    this._scene         = null;
    this._killCounts    = new Map(); // id → kills
    this.gameStartTime  = null;      // performance.now() when gameStart arrived
    this.gameActive     = false;     // server-reported: is a match running right now?
    this.matchMode      = 'solo';    // 'solo' (FFA) or 'duo' (teams of 2)
    this.teams          = {};        // { playerId: teamId } — populated in duo mode
    this.myTeamId       = null;      // convenience: this.teams[this.myId]
    this.inGameIds      = new Set(); // ids currently in the running match
    this.worldSeed      = null;      // 32-bit seed shared by all clients for
                                     // deterministic world-loot placement

    // Callbacks wired by Menu / Game
    this.onWelcome      = null;
    this.onPlayerJoined = null;
    this.onPlayerLeft   = null;
    this.onPlayerReady  = null;
    this.onHostTransfer = null;
    this.onGameStart    = null;
    this.onRemoteState  = null;
    this.onRemoteShoot  = null;
    this.onRemoteHit    = null;
    this.onRemoteDeath  = null;
    this.onLocalHit     = null; // (damage, fromId) → void
    this.onRemoteBuild  = null; // (msg) => void

    // Supply-drop sync callbacks (set by SupplyDropManager).
    // `supplyDropSpawn` is host-authored — non-hosts ignore the spawn timer
    // and only render drops the host announces. `supplyDropOpen` is any-client
    // → server → all-clients so opens propagate everywhere.
    this.onSupplyDropSpawn = null; // (msg) => void
    this.onSupplyDropOpen  = null; // (msg) => void

    // Fires when the server reports the running match has ended (winner
    // declared, last player disconnected, explicit matchEnd). Late joiners
    // refresh their lobby; spectator sessions reload to clean up.
    this.onMatchEnded = null; // () => void

    // A remote player threw a weapon on the ground — host spawns a world
    // pickup with the broadcast ammo state so spectators + other players
    // can see and re-collect it.
    this.onWeaponDropped = null; // (msg) => void

    // Boss (Ms. Franks) sync. Host-authoritative: host broadcasts state
    // and shots, non-hosts send hits, host broadcasts death. All callbacks
    // are wired by MsFranksManager.
    this.onBossState = null; // (msg) => void   host → all
    this.onBossShoot = null; // (msg) => void   host → all
    this.onBossHit   = null; // (msg) => void   any → host
    this.onBossDied  = null; // (msg) => void   host → all
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen    = () => resolve();
      this.ws.onerror   = () => reject(new Error('WebSocket error'));
      this.ws.onclose   = () => console.log('[net] disconnected');
      this.ws.onmessage = e => {
        try { this._handle(JSON.parse(e.data)); } catch {}
      };
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(obj));
  }

  setName(name)          { this.myName = name; this.send({ type: 'setName', name }); }
  setReady(ready)        { this.send({ type: 'ready', value: ready }); }
  /**
   * Host only. `matchMode` is 'solo' or 'duo'. `teams` is a {playerId: teamId}
   * map (only meaningful for duo). The server forwards both verbatim in the
   * gameStart broadcast so every client agrees on team membership.
   */
  startGame(matchMode = 'solo', teams = {}) {
    this.send({ type: 'startGame', matchMode, teams });
  }
  /** Any in-game client may declare match end (victory / spectator-end). */
  sendMatchEnd() { this.send({ type: 'matchEnd' }); }
  /**
   * Broadcast our state. `weapon` (def id), `ammo` (loaded mag),
   * `reserve` (shared-pool reserve for the held weapon's ammoType) and
   * `health` (authoritative HP so remotes show accurate bars). All optional.
   */
  sendState(pos, yaw, phase = 3, weapon = null, ammo = null, reserve = null, health = 100, crouching = false) {
    this.send({
      type: 'state',
      pos: [pos.x, pos.y, pos.z], yaw, phase,
      weapon, ammo, reserve, health, crouching,
    });
  }
  sendShoot(orig, dir, weapon) { this.send({ type: 'shoot', orig: [orig.x, orig.y, orig.z], dir: [dir.x, dir.y, dir.z], weapon }); }
  sendHit(targetId, dmg) { this.send({ type: 'hit', targetId, damage: dmg }); }
  /**
   * Notify others we died. Optional `drops` array carries everything in our
   * inventory (weapons + consumables) so other clients can spawn matching
   * world pickups at the body. Each entry:
   *   { kind: 'weapon',     id, ammo, reserve }
   *   { kind: 'consumable', id, count }
   */
  sendDeath(drops = null) { this.send({ type: 'death', drops }); }
  sendBuild(pieceType, x, y, z, rotY) { this.send({ type: 'build', pieceType, x, y, z, rotY }); }

  /**
   * Notify others that we just dropped a weapon at `pos` with the given
   * loaded mag + reserve. Other clients spawn a matching WeaponPickup so
   * the dropped gun is visible (and re-collectable) for everyone.
   */
  sendWeaponDropped(weaponId, pos, ammo, reserve) {
    this.send({
      type: 'weaponDropped',
      weaponId,
      pos: [pos.x, pos.y, pos.z],
      ammo, reserve,
    });
  }

  // Supply-drop sync.
  sendSupplyDropSpawn(data) { this.send({ type: 'supplyDropSpawn', ...data }); }
  sendSupplyDropOpen(id)    { this.send({ type: 'supplyDropOpen', dropId: id }); }

  // ── Boss sync ─────────────────────────────────────────────────────────
  // Host-only: periodic state + per-shot broadcasts.
  sendBossState(data) { this.send({ type: 'bossState', ...data }); }
  sendBossShoot(origin, dir) {
    this.send({
      type: 'bossShoot',
      origin: [origin.x, origin.y, origin.z],
      dir:    [dir.x,    dir.y,    dir.z],
    });
  }
  /** Any client → host. Server only forwards to host. */
  sendBossHit(damage) { this.send({ type: 'bossHit', damage }); }
  /** Host only: declare boss death + drop location. */
  sendBossDied(x, y, z, ammo, reserve) {
    this.send({ type: 'bossDied', x, y, z, ammo, reserve });
  }

  _handle(msg) {
    switch (msg.type) {
      case 'welcome':
        this.myId   = msg.id;
        this.isHost = msg.isHost;
        this.gameActive = !!msg.gameActive;
        this.inGameIds = new Set(msg.inGameIds ?? []);
        for (const p of msg.players) this.players.set(p.id, { ...p, inGame: !!p.inGame });
        // Late-spectator storm sync: server reports how long the match has
        // been running, and we plant gameStartTime that many ms in the past
        // so storm.setClockStart() (called later in Game._loadWorld) lands
        // on the correct phase/radius.
        if (this.gameActive && typeof msg.matchElapsedMs === 'number') {
          this.gameStartTime = performance.now() - msg.matchElapsedMs;
        }
        if (typeof msg.worldSeed === 'number') this.worldSeed = msg.worldSeed;
        if (this.onWelcome) this.onWelcome(msg);
        break;

      case 'playerJoined':
        this.players.set(msg.id, {
          id: msg.id, name: msg.name, ready: false, inGame: !!msg.inGame,
        });
        if (this.onPlayerJoined) this.onPlayerJoined(msg);
        break;

      case 'playerLeft':
        this.players.delete(msg.id);
        if (this.remotePlayers.has(msg.id)) {
          this.remotePlayers.get(msg.id).remove();
          this.remotePlayers.delete(msg.id);
        }
        if (this.onPlayerLeft) this.onPlayerLeft(msg);
        break;

      case 'playerName':
        if (this.players.has(msg.id)) this.players.get(msg.id).name = msg.name;
        // Update 3D name tag if already spawned
        if (this.remotePlayers.has(msg.id)) {
          const rp = this.remotePlayers.get(msg.id);
          rp.name = msg.name;
          rp._tag.textContent = msg.name;
        }
        break;

      case 'playerReady':
        if (this.players.has(msg.id)) this.players.get(msg.id).ready = msg.ready;
        if (this.onPlayerReady) this.onPlayerReady(msg);
        break;

      case 'hostTransfer':
        this.isHost = true;
        if (this.onHostTransfer) this.onHostTransfer();
        break;

      case 'gameStart':
        // Anchor the shared storm clock — gameStart is broadcast to every
        // client at once, so this moment is the same for everyone (±latency).
        this.gameStartTime = performance.now();
        this.gameActive    = true;
        this.matchMode     = msg.matchMode ?? 'solo';
        this.teams         = msg.teams     ?? {};
        this.myTeamId      = this.teams[this.myId] ?? null;
        this.inGameIds     = new Set(msg.inGameIds ?? []);
        if (typeof msg.worldSeed === 'number') this.worldSeed = msg.worldSeed;
        // Mark each player as in-game / lobby so the lobby UI can recolor.
        for (const p of this.players.values()) p.inGame = this.inGameIds.has(p.id);
        if (this.onGameStart) this.onGameStart(msg);
        break;

      case 'matchEnded':
        // Server says the running match is over (winner / all-disconnected /
        // explicit end). Reset team state so the next match starts clean.
        this.gameActive = false;
        this.matchMode  = 'solo';
        this.teams      = {};
        this.myTeamId   = null;
        this.inGameIds  = new Set();
        for (const p of this.players.values()) p.inGame = false;
        if (this.onMatchEnded) this.onMatchEnded();
        break;

      case 'state':
        if (this.remotePlayers.has(msg.id)) {
          this.remotePlayers.get(msg.id).setTargetState(
            msg.pos, msg.yaw, msg.phase, msg.weapon, msg.ammo, msg.reserve, msg.health, msg.crouching,
          );
        }
        if (this.onRemoteState) this.onRemoteState(msg);
        break;

      case 'shoot':
        if (this.onRemoteShoot) this.onRemoteShoot(msg);
        break;

      case 'hit':
        // Damage arrives: are we the target?
        if (msg.targetId === this.myId) {
          if (this.onLocalHit) this.onLocalHit(msg.damage, msg.id);
        }
        // Also damage the remote player's rendered HP bar
        if (this.remotePlayers.has(msg.targetId)) {
          this.remotePlayers.get(msg.targetId).takeDamage(msg.damage);
        }
        if (this.onRemoteHit) this.onRemoteHit(msg);
        break;

      case 'death':
        if (this.remotePlayers.has(msg.id)) {
          this.remotePlayers.get(msg.id).die();
        }
        if (this.onRemoteDeath) this.onRemoteDeath(msg);
        break;

      case 'build':
        if (this.onRemoteBuild) this.onRemoteBuild(msg);
        break;

      case 'supplyDropSpawn':
        if (this.onSupplyDropSpawn) this.onSupplyDropSpawn(msg);
        break;

      case 'supplyDropOpen':
        if (this.onSupplyDropOpen) this.onSupplyDropOpen(msg);
        break;

      case 'weaponDropped':
        if (this.onWeaponDropped) this.onWeaponDropped(msg);
        break;

      case 'bossState':
        if (this.onBossState) this.onBossState(msg);
        break;

      case 'bossShoot':
        if (this.onBossShoot) this.onBossShoot(msg);
        break;

      case 'bossHit':
        // Server only forwards bossHit to the host; receiving it means
        // we are the host and a non-host scored damage.
        if (this.onBossHit) this.onBossHit(msg);
        break;

      case 'bossDied':
        if (this.onBossDied) this.onBossDied(msg);
        break;
    }
  }

  // Call this after the game world is ready
  spawnRemotePlayers(scene, spawnPoints) {
    this._scene = scene;
    for (const [id, info] of this.players) {
      if (id === this.myId) continue;
      const idx = (parseInt(id) - 1) % spawnPoints.length;
      const rp  = new RemotePlayer(scene, id, info.name);
      rp.root.position.copy(spawnPoints[idx]);
      rp._targetPos.copy(spawnPoints[idx]);
      // Mark teammates so projectiles + damage filtering can skip them.
      // In solo (FFA) this is always false; in duo it's true when the
      // remote player shares this client's team id. Applying via setter
      // also recolors the HP bar and tags the nametag for CSS theming.
      rp.setTeammate(this.matchMode === 'duo'
        && this.myTeamId != null
        && this.teams[id] === this.myTeamId);
      this.remotePlayers.set(id, rp);
    }
  }

  /** Returns true if the given player id is on the local player's team. */
  isTeammate(id) {
    if (this.matchMode !== 'duo' || this.myTeamId == null) return false;
    return this.teams[id] === this.myTeamId;
  }

  getRemotePlayers() { return this.remotePlayers; }

  aliveRemoteCount() {
    return [...this.remotePlayers.values()].filter(r => !r.dead).length;
  }

  /**
   * Number of remote players who are alive AND not on the local player's
   * team. In Solo (FFA) this equals aliveRemoteCount(). In Duo, teammates
   * are excluded so "victory" fires when the opposing teams are wiped out.
   */
  aliveOpponentCount() {
    let n = 0;
    for (const rp of this.remotePlayers.values()) {
      if (rp.dead) continue;
      if (this.matchMode === 'duo' && rp.isTeammate) continue;
      n++;
    }
    return n;
  }

  /**
   * Initial opponent total — used as the HUD "enemies remaining" denominator.
   * Computed from the lobby roster at match-start time (callers should latch
   * this once when the match begins).
   */
  totalOpponentCount() {
    if (this.matchMode !== 'duo') return Math.max(0, this.players.size - 1);
    let n = 0;
    for (const id of this.players.keys()) {
      if (id === this.myId) continue;
      if (this.teams[id] === this.myTeamId) continue;
      n++;
    }
    return n;
  }

  update(dt, camera, canvas) {
    for (const rp of this.remotePlayers.values()) {
      rp.update(dt, camera, canvas);
    }
  }
}
