import * as THREE from 'three';

// ── Spawn points for up to 10 players (in world XZ coords) ───────────────────
export const MP_SPAWNS = [
  [  20,   5 ], [ -20,   5 ],
  [   5,  20 ], [   5, -20 ],
  [  14,  14 ], [ -14,  14 ],
  [  14, -14 ], [ -14, -14 ],
  [  28,   0 ], [ -28,   0 ],
];

// ── Remote Player (3D character + name tag, driven by network) ────────────────
export class RemotePlayer {
  constructor(scene, id, name) {
    this.id     = id;
    this.name   = name;
    this.scene  = scene;
    this.dead   = false;
    this.health = 100;

    this._targetPos = new THREE.Vector3();
    this._targetYaw = 0;

    this._buildModel();
    this._buildNameTag();
  }

  _buildModel() {
    this.root = new THREE.Group();
    this.scene.add(this.root);

    const lm  = hex => new THREE.MeshLambertMaterial({ color: hex });
    const box = (w, h, d, hex, px, py, pz) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lm(hex));
      m.position.set(px, py, pz);
      m.castShadow = true;
      return m;
    };

    // Body — red scheme to distinguish from the blue local player
    this.root.add(box(0.70, 0.90, 0.45, 0x8b0000, 0, 1.35, 0));  // torso
    this.root.add(box(0.72, 0.15, 0.47, 0x5a1a00, 0, 0.97, 0));  // belt
    this.root.add(box(0.65, 0.25, 0.42, 0x37474f, 0, 0.87, 0));  // hips

    // Head
    this.root.add(box(0.60, 0.58, 0.56, 0xffcba4, 0, 1.90, 0));
    const helmGeo = new THREE.SphereGeometry(0.36, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.6);
    const helm    = new THREE.Mesh(helmGeo, lm(0x6a0000));
    helm.position.set(0, 1.95, 0);
    this.root.add(helm);

    // Arms
    this.root.add(box(0.22, 0.90, 0.22, 0x7a0000, -0.48, 1.20, 0));
    this.root.add(box(0.22, 0.90, 0.22, 0x7a0000,  0.48, 1.20, 0));
    // Gloves
    this.root.add(box(0.22, 0.20, 0.22, 0x1a237e, -0.48, 0.72, 0));
    this.root.add(box(0.22, 0.20, 0.22, 0x1a237e,  0.48, 0.72, 0));

    // Legs
    this.root.add(box(0.26, 1.0, 0.26, 0x37474f, -0.20, 0.50, 0));
    this.root.add(box(0.26, 1.0, 0.26, 0x37474f,  0.20, 0.50, 0));
    // Boots
    this.root.add(box(0.26, 0.22, 0.34, 0x212121, -0.20, -0.01, 0.04));
    this.root.add(box(0.26, 0.22, 0.34, 0x212121,  0.20, -0.01, 0.04));

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

  _buildNameTag() {
    this._tag = document.createElement('div');
    this._tag.className = 'remote-player-tag';
    this._tag.textContent = this.name;
    const hud = document.getElementById('hud');
    if (hud) hud.appendChild(this._tag);
  }

  setTargetState(pos, yaw) {
    this._targetPos.set(pos[0], pos[1], pos[2]);
    this._targetYaw = yaw;
  }

  takeDamage(amount) {
    if (this.dead) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) this.die();
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

  update(dt, camera, canvas) {
    // Interpolate to server position
    this.root.position.lerp(this._targetPos, Math.min(1, dt * 22));
    this.root.rotation.y = THREE.MathUtils.lerp(
      this.root.rotation.y, this._targetYaw, Math.min(1, dt * 18)
    );

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
  startGame()            { this.send({ type: 'startGame' }); }
  sendState(pos, yaw)    { this.send({ type: 'state', pos: [pos.x, pos.y, pos.z], yaw }); }
  sendShoot(orig, dir)   { this.send({ type: 'shoot', orig: [orig.x, orig.y, orig.z], dir: [dir.x, dir.y, dir.z] }); }
  sendHit(targetId, dmg) { this.send({ type: 'hit', targetId, damage: dmg }); }
  sendDeath()            { this.send({ type: 'death' }); }

  _handle(msg) {
    switch (msg.type) {
      case 'welcome':
        this.myId   = msg.id;
        this.isHost = msg.isHost;
        for (const p of msg.players) this.players.set(p.id, p);
        if (this.onWelcome) this.onWelcome(msg);
        break;

      case 'playerJoined':
        this.players.set(msg.id, { id: msg.id, name: msg.name, ready: false });
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
        if (this.onGameStart) this.onGameStart();
        break;

      case 'state':
        if (this.remotePlayers.has(msg.id)) {
          this.remotePlayers.get(msg.id).setTargetState(msg.pos, msg.yaw);
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
      this.remotePlayers.set(id, rp);
    }
  }

  getRemotePlayers() { return this.remotePlayers; }

  aliveRemoteCount() {
    return [...this.remotePlayers.values()].filter(r => !r.dead).length;
  }

  update(dt, camera, canvas) {
    for (const rp of this.remotePlayers.values()) {
      rp.update(dt, camera, canvas);
    }
  }
}
