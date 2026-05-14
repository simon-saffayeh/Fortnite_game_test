import * as THREE from 'three';
import { World }             from './world.js';
import { Player }            from './player.js';
import { ThirdPersonCamera } from './camera.js';
import { HUD }               from './ui.js';
import { ParticleSystem }    from './particles.js';
import { WeaponSystem, WeaponInstance, WEAPON_DEFS, buildGunModel } from './weapons.js';
import { Inventory }         from './inventory.js';
import { ProjectileSystem }  from './projectile.js';
import { EnemyManager }      from './enemy.js';
import { Storm }             from './storm.js';
import { PickupManager }     from './pickups.js';
import { ScreenShake, MuzzleFlash, DamageNumbers, DirectionalDamage, HitMarker } from './effects.js';
import { NetworkManager, MP_SPAWNS } from './multiplayer.js';
import { BuildingSystem } from './building.js';
import { ZombieWaveManager } from './zombie.js';
import { AudioManager } from './audio.js';

const waveCount_hud = (w) => 3 + (w - 1) * 2; // mirrors zombie.js formula

// ── Menu / Lobby controller ───────────────────────────────────────────────────
class Menu {
  constructor() {
    this._net    = null;
    this._ready  = false;
    this._myName = localStorage.getItem('bi_name') || `Player${Math.floor(Math.random() * 90) + 10}`;

    document.getElementById('btn-solo').addEventListener('click', () => this._startSolo());
    document.getElementById('btn-zombie').addEventListener('click', () => this._startZombie());
    document.getElementById('btn-multiplayer').addEventListener('click', () => this._openLobby());
    document.getElementById('btn-ready').addEventListener('click', () => this._toggleReady());
    document.getElementById('btn-start-game').addEventListener('click', () => this._requestStart());
    document.getElementById('btn-lobby-back').addEventListener('click', () => location.reload());

    // Sensitivity slider
    const sensSlider = document.getElementById('sens-slider');
    const sensValue  = document.getElementById('sens-value');
    const saved = JSON.parse(localStorage.getItem('bi_settings') || '{}');
    if (saved.sensitivity) sensSlider.value = saved.sensitivity;
    sensValue.textContent = parseFloat(sensSlider.value).toFixed(1);
    sensSlider.addEventListener('input', () => {
      sensValue.textContent = parseFloat(sensSlider.value).toFixed(1);
      localStorage.setItem('bi_settings', JSON.stringify({ sensitivity: parseFloat(sensSlider.value) }));
    });

    const nameInput = document.getElementById('player-name');
    nameInput.value = this._myName;
    nameInput.addEventListener('input', () => {
      this._myName = nameInput.value.trim() || 'Player';
      localStorage.setItem('bi_name', this._myName);
      if (this._net) this._net.setName(this._myName);
      // Update own entry in local players map
      if (this._net?.myId && this._net.players.has(this._net.myId)) {
        this._net.players.get(this._net.myId).name = this._myName;
        this._refreshList();
      }
    });
  }

  _buildEnabled()   { return document.getElementById('build-toggle')?.checked   ?? false; }
  _testingEnabled() { return document.getElementById('testing-toggle')?.checked ?? false; }

  _startSolo() {
    const hs = document.getElementById('home-screen');
    const buildEnabled   = this._buildEnabled();
    const testingEnabled = this._testingEnabled();
    hs.classList.add('fade-out');
    setTimeout(() => {
      hs.style.display = 'none';
      document.getElementById('loading-screen').classList.remove('hidden');
    }, 380);
    setTimeout(() => new Game('solo', null, buildEnabled, testingEnabled), 420);
  }

  _startZombie() {
    const hs = document.getElementById('home-screen');
    const buildEnabled   = this._buildEnabled();
    const testingEnabled = this._testingEnabled();
    hs.classList.add('fade-out');
    setTimeout(() => {
      hs.style.display = 'none';
      document.getElementById('loading-screen').classList.remove('hidden');
    }, 380);
    setTimeout(() => new Game('zombie', null, buildEnabled, testingEnabled), 420);
  }

  async _openLobby() {
    const hs = document.getElementById('home-screen');
    hs.classList.add('fade-out');
    setTimeout(() => hs.style.display = 'none', 380);

    this._net = new NetworkManager();
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${window.location.host}/ws`;

    try {
      await this._net.connect(wsUrl);
    } catch {
      alert('Could not reach the game server.\nMake sure server.js is running.');
      hs.style.display = '';
      hs.classList.remove('fade-out');
      this._net = null;
      return;
    }

    // Show share URL
    document.getElementById('lobby-share-url').textContent = window.location.href;

    // Wire lobby callbacks
    this._net.onWelcome = msg => {
      this._net.players.set(msg.id, { id: msg.id, name: this._myName, ready: false });
      this._net.setName(this._myName);
      if (msg.isHost) {
        document.getElementById('btn-start-game').classList.remove('hidden');
        this._setStatus('You are the host — wait for friends, then Start Game.');
      } else {
        this._setStatus('Waiting for host to start…');
      }
      this._refreshList();
    };

    this._net.onPlayerJoined = () => this._refreshList();
    this._net.onPlayerLeft   = () => this._refreshList();
    this._net.onPlayerReady  = () => this._refreshList();

    this._net.onHostTransfer = () => {
      document.getElementById('btn-start-game').classList.remove('hidden');
      this._setStatus('You are now the host!');
    };

    this._net.onGameStart = () => {
      const buildEnabled   = this._buildEnabled();
      const testingEnabled = this._testingEnabled();
      document.getElementById('lobby-screen').classList.add('hidden');
      document.getElementById('loading-screen').classList.remove('hidden');
      setTimeout(() => new Game('multi', this._net, buildEnabled, testingEnabled), 120);
    };

    document.getElementById('lobby-screen').classList.remove('hidden');
  }

  _refreshList() {
    const ul = document.getElementById('lobby-players');
    ul.innerHTML = '';
    for (const [id, p] of this._net.players) {
      const isMe = id === this._net.myId;
      const li   = document.createElement('div');
      li.className = 'lobby-player' + (isMe ? ' me' : '');
      li.innerHTML = `
        <span class="lp-name">${isMe ? this._myName : p.name}${isMe ? ' (you)' : ''}</span>
        <span class="lp-ready ${p.ready ? 'yes' : ''}">${p.ready ? '✓ READY' : '○ WAITING'}</span>
      `;
      ul.appendChild(li);
    }
    const total = this._net.players.size;
    const rdy   = [...this._net.players.values()].filter(p => p.ready).length;
    this._setStatus(`${total} / 10 players — ${rdy} ready`);
  }

  _toggleReady() {
    this._ready = !this._ready;
    this._net.setReady(this._ready);
    const btn = document.getElementById('btn-ready');
    btn.textContent = this._ready ? 'NOT READY' : 'READY UP';
    btn.classList.toggle('active', this._ready);
    if (this._net.players.has(this._net.myId)) {
      this._net.players.get(this._net.myId).ready = this._ready;
      this._refreshList();
    }
  }

  _requestStart() {
    if ((this._net?.players.size ?? 0) < 2) {
      this._setStatus('Need at least 2 players to start!');
      return;
    }
    this._net.startGame();
  }

  _setStatus(txt) {
    const el = document.getElementById('lobby-status');
    if (el) el.textContent = txt;
  }
}

// ── Game ──────────────────────────────────────────────────────────────────────
class Game {
  constructor(mode = 'solo', net = null, buildEnabled = false, testingEnabled = false) {
    this.mode           = mode;
    this.net            = net;
    this.buildEnabled   = buildEnabled;
    this.testingEnabled = testingEnabled;
    this.canvas = document.getElementById('game-canvas');
    this.clock  = new THREE.Clock();
    this.running = false;
    this._prevMouseDown = false;
    this._killCount    = 0;
    this._totalEnemies = 0;
    this._victoryShown = false;
    this._netTimer      = 0;
    this._playerKills   = 0;
    this._lastHitTarget = null;
    this._init();
  }

  async _init() {
    try {
      this._setupRenderer();
      this._setupScene();
      await this._loadWorld();
      this._setupEvents();
      this._startLoop();
    } catch (err) {
      console.error('Game init failed:', err);
      const txt = document.getElementById('loading-text');
      if (txt) txt.textContent = 'Error: ' + err.message;
    }
  }

  _setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled   = true;
    this.renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping         = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure  = 1.1;
    this.renderer.outputColorSpace    = THREE.SRGBColorSpace;
  }

  _setupScene() {
    this.scene  = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x9ec8e8, 0.0038);
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
  }

  async _loadWorld() {
    const steps = [
      'Generating terrain…', 'Planting trees…', 'Building structures…',
      'Spawning weapons…', 'Placing med kits…',
      this.mode === 'solo' ? 'Deploying enemies…' : 'Connecting players…',
      'Charging storm…', 'Ready!',
    ];
    const bar = document.getElementById('loading-bar');
    const txt = document.getElementById('loading-text');
    for (let i = 0; i < steps.length; i++) {
      txt.textContent = steps[i];
      bar.style.width = `${((i + 1) / steps.length) * 100}%`;
      await sleep(240 + Math.random() * 140);
    }

    // ── Core world ───────────────────────────────────────────────────────
    this.world  = new World(this.scene);
    this.world.generate();
    await this.world.loadFurniture();
    await this.world.loadNature();

    // ── Spawn position ───────────────────────────────────────────────────
    let spawnPos;
    if (this.mode === 'solo' || this.mode === 'zombie') {
      spawnPos = this.world.getSpawnPosition();
    } else {
      const idx = (parseInt(this.net.myId) - 1) % MP_SPAWNS.length;
      const [sx, sz] = MP_SPAWNS[idx];
      const sh = this.world.getTerrainHeight(sx, sz);
      spawnPos = new THREE.Vector3(sx, sh + 1.5, sz);
    }

    this.player    = new Player(this.scene, spawnPos, this.world);
    const biSettings = JSON.parse(localStorage.getItem('bi_settings') || '{}');
    if (biSettings.sensitivity) this.player._sensMultiplier = biSettings.sensitivity;
    this.camera3P  = new ThirdPersonCamera(this.camera, this.player);
    this.particles = new ParticleSystem(this.scene);

    // ── Combat systems ────────────────────────────────────────────────
    this.projectiles = new ProjectileSystem(this.scene, this.world);

    if (this.mode === 'solo') {
      this.enemies    = new EnemyManager(this.scene, this.world, this.projectiles);
      this.zombieWaves = null;
    } else if (this.mode === 'zombie') {
      this.enemies    = null;
      this.zombieWaves = new ZombieWaveManager(this.scene, this.world, this.projectiles);
    } else {
      this.enemies    = null;
      this.zombieWaves = null;
      const mpSpawnVecs = MP_SPAWNS.map(([x, z]) => {
        const h = this.world.getTerrainHeight(x, z);
        return new THREE.Vector3(x, h + 1.5, z);
      });
      this.net.spawnRemotePlayers(this.scene, mpSpawnVecs);
    }

    this.weapons   = new WeaponSystem(this.scene, this.world);
    this.inventory = new Inventory(this.player);
    this.pickups   = new PickupManager(this.scene, this.world);
    this.storm     = this.mode === 'zombie' ? null : new Storm(this.scene);

    // ── Effects ───────────────────────────────────────────────────────
    this.shake   = new ScreenShake();
    this.muzzle  = new MuzzleFlash(this.scene);
    this.dmgNums = new DamageNumbers();
    this.dirDmg  = new DirectionalDamage();
    this.hitMark = new HitMarker();

    // ── Audio ─────────────────────────────────────────────────────────
    this.audio = new AudioManager();
    await this.audio.init();

    // ── Building ──────────────────────────────────────────────────────
    if (this.buildEnabled) {
      this.building = new BuildingSystem(this.scene, this.world);
      if (this.net) {
        this.building.onPlace = (type, x, y, z, rotY) => this.net.sendBuild(type, x, y, z, rotY);
        this.net.onRemoteBuild = msg => this.building.placeRemote(msg.pieceType, msg.x, msg.y, msg.z, msg.rotY);
      }
    } else {
      this.building = null;
    }
    this.projectiles.buildingSystem = this.building;

    // ── Composite collision provider (build pieces + static world) ────
    const building = this.building;
    const staticC  = this.world.staticCollider;
    this.player.collisionProvider = {
      getWallPush(wx, wy, wz, r) {
        const p1 = building?.getWallPush(wx, wy, wz, r);
        const p2 = staticC.getWallPush(wx, wy, wz, r);
        if (!p1 && !p2) return null;
        return { x: (p1?.x ?? 0) + (p2?.x ?? 0), z: (p1?.z ?? 0) + (p2?.z ?? 0) };
      },
      getHeightAt(wx, wz, py) {
        const h1 = building?.getHeightAt(wx, wz, py) ?? null;
        const h2 = staticC.getHeightAt(wx, wz, py);
        if (h1 === null && h2 === null) return null;
        if (h1 === null) return h2;
        if (h2 === null) return h1;
        return Math.max(h1, h2);
      },
    };

    // ── Map ───────────────────────────────────────────────────────────
    this._mapOverlay  = document.getElementById('map-overlay');
    this._mapTerrain  = this.world.renderMapCanvas();
    this._mapOpen     = false;

    // ── HUD ───────────────────────────────────────────────────────────
    this.hud = new HUD(this.player, this.world, this.enemies, this.inventory, this.storm);
    this.hud.setWeaponSystem(this.weapons);
    this.hud.setPickupManager(this.pickups);

    // ── Heal channel progress ─────────────────────────────────────────
    this.inventory.onHealProgress = (progress, label) => this.hud.setHealProgress(progress, label);

    // ── Starting weapon ───────────────────────────────────────────────
    if (this.testingEnabled) {
      for (const id of ['phaseRifle', 'sniper', 'rocketLauncher', 'minigun', 'bombLauncher']) {
        this.inventory.addWeapon(new WeaponInstance(WEAPON_DEFS[id]));
      }
      this.player._sprintMultiplier = 2.0;
    } else {
      this.inventory.addWeapon(new WeaponInstance(WEAPON_DEFS.pistol));
    }

    // ── Prewarm gun model cache + explosion particle materials + shaders ──
    // Building each gun model once at startup populates the cache so future
    // pickups clone instead of re-allocating geometry/materials. The held-scale
    // clones must also be present in the scene when renderer.compile() runs so
    // their shader programs compile during boot instead of stuttering the first
    // time the player picks up that weapon type.
    const _prewarmGroup = new THREE.Group();
    _prewarmGroup.visible = false;
    for (const id of Object.keys(WEAPON_DEFS)) {
      _prewarmGroup.add(buildGunModel(WEAPON_DEFS[id], 0.58));
      buildGunModel(WEAPON_DEFS[id], 1.15);
    }
    this.scene.add(_prewarmGroup);
    // Prewarm common burst-particle materials (nuke, normal explosion, hit fx)
    const _warmColors = [
      [0xffffff, 0.9], [0xff7700, 0.65], [0xff3300, 0.55], [0xffdd00, 0.45],
      [0xff2200, 0.22], [0x333333, 0.75], [0x222222, 1.0], [0xff5500, 0.55],
      [0x884422, 0.55], [0x553322, 0.8], [0x222211, 0.6],
      [0xff6600, 0.35], [0xffdd00, 0.2], [0x888888, 0.15],
      [0xffee00, 0.25], [0xaaddff, 0.15], [0xffffff, 0.1], [0xffee00, 0.15],
      [0xff1111, 0.2],
    ];
    for (const [c, s] of _warmColors) this.particles._getBurstMaterial(c, s);

    // Stage explosion mesh-FX into the scene so their MeshBasicMaterial shaders
    // (incl. DoubleSide and transparent variants) compile during boot.
    const _fxMat = (side = THREE.FrontSide) => new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1, depthWrite: false, side,
    });
    const _fxGeos = [
      new THREE.SphereGeometry(1, 14, 10),
      new THREE.TorusGeometry(1, 0.55, 6, 48),
      new THREE.TorusGeometry(1, 0.7, 8, 32),
      new THREE.CylinderGeometry(1, 1, 1, 12),
    ];
    const _fxMeshes = [];
    for (const geo of _fxGeos) {
      const mFront = new THREE.Mesh(geo, _fxMat(THREE.FrontSide));
      const mDouble = new THREE.Mesh(geo, _fxMat(THREE.DoubleSide));
      mFront.position.set(0, -9999, 0);
      mDouble.position.set(0, -9999, 0);
      this.scene.add(mFront); this.scene.add(mDouble);
      _fxMeshes.push(mFront, mDouble);
    }

    // Compile twice: once with the current N-light state (matches normal play),
    // then again with an extra PointLight present so lit materials also have a
    // compiled program for the N+1-light state a nuclear explosion produces.
    // Otherwise the first explosion stalls every lit material's shader compile.
    this.renderer.compile(this.scene, this.camera);
    const _prewarmLight = new THREE.PointLight(0xff8822, 0.0001, 1);
    _prewarmLight.position.set(0, -9999, 0);
    this.scene.add(_prewarmLight);
    this.renderer.compile(this.scene, this.camera);
    this.scene.remove(_prewarmLight);

    this.scene.remove(_prewarmGroup);
    for (const m of _fxMeshes) {
      this.scene.remove(m);
      m.material.dispose();
    }
    for (const g of _fxGeos) g.dispose();

    // ── Wire callbacks ────────────────────────────────────────────────
    this._totalEnemies = this.enemies?.enemies.length ?? 0;

    this.player.onDamage = (_amt, sourcePos) => {
      this.hud.flashDamage();
      this.shake.shake(0.22);
      if (sourcePos) this.dirDmg.show(this.player.getPosition(), this.player.getYaw(), sourcePos);
    };
    this.player.onDeath = (killerLabel) => {
      if (this.net) this.net.sendDeath();
      this._showDeathScreen(killerLabel);
    };

    if (this.mode === 'solo') {
      this._totalEnemies = this.enemies.enemies.length;
      this.hud.setEnemiesRemaining(this._totalEnemies, this._totalEnemies);

      this.enemies.onKill = (killedEnemy) => {
        this._killCount++;
        this.hud.addKill('Enemy Soldier');
        this.hud.setEnemiesRemaining(this._totalEnemies - this._killCount, this._totalEnemies);
        if (Math.random() < 0.65) this.pickups.spawnLoot(killedEnemy.root.position);
        if (this._killCount >= this._totalEnemies && !this._victoryShown) {
          this._victoryShown = true;
          setTimeout(() => this._showVictory(), 1200);
        }
      };
    } else if (this.mode === 'zombie') {
      this._buildZombieHUD();
      this.hud.setEnemiesRemaining(0, 0);
      document.querySelector('.er-label').textContent = 'ZOMBIES';

      this.zombieWaves.onKill = (e) => {
        this._killCount++;
        this.hud.addKill('Zombie');
        if (Math.random() < 0.5) this.pickups.spawnLoot(e.root.position);
        const alive = this.zombieWaves.aliveCount;
        this.hud.setEnemiesRemaining(alive, waveCount_hud(this.zombieWaves.wave));
      };
      this.zombieWaves.onWaveStart = (w) => {
        this._showWaveBanner(`WAVE ${w} / ${this.zombieWaves.totalWaves}`, '#ef4444');
        const total = waveCount_hud(w);
        this.hud.setEnemiesRemaining(total, total);
      };
      this.zombieWaves.onWaveEnd = (_w) => {
        this._showWaveBanner('WAVE CLEAR!', '#22c55e');
      };
      this.zombieWaves.onAllWavesComplete = () => {
        this._victoryShown = true;
        setTimeout(() => this._showVictory(), 1200);
      };
      this.zombieWaves.onIntermissionTick = (secs, next) => {
        this._updateZombieHUD(secs, next);
      };
    } else {
      // Multiplayer enemy-remaining → players remaining
      const totalPlayers = this.net.players.size;
      this.hud.setEnemiesRemaining(totalPlayers - 1, totalPlayers - 1);
      document.querySelector('.er-label').textContent = 'PLAYERS';

      // Incoming damage from other players
      this.net.onLocalHit = (damage, fromId) => {
        const srcPos = this.net.remotePlayers.get(fromId)?.root.position ?? null;
        const killerName = this.net.players.get(fromId)?.name ?? 'a player';
        this.player.takeDamage(damage, false, srcPos, killerName);
      };

      // Remote player died
      this.net.onRemoteDeath = (msg) => {
        // Only credit a kill if we were the last to hit this player
        if (this._lastHitTarget === msg.id) {
          this._playerKills++;
          this.hud.addKill(this.net.players.get(msg.id)?.name ?? 'Player');
          this.hitMark.hit(true);
          this._lastHitTarget = null;
        }
        const alive = this.net.aliveRemoteCount();
        this.hud.setEnemiesRemaining(alive, totalPlayers - 1);
        if (!this.player.dead && alive === 0 && !this._victoryShown) {
          this._victoryShown = true;
          setTimeout(() => this._showVictory(), 1200);
        }
      };

      // Visual shoot from remote player
      this.net.onRemoteShoot = (msg) => {
        const orig = new THREE.Vector3(...msg.orig);
        const dir  = new THREE.Vector3(...msg.dir);
        this.projectiles.spawn(orig, dir, { speed: 180, damage: 0, faction: 'remote', range: 300 });
        if (this.audio && msg.weapon) {
          const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
          this.audio.playAt(msg.weapon, orig, this.player.getPosition(), right);
        }
      };

      // When we hit a remote player — track who we last hit for kill credit
      this.projectiles.onRemotePlayerHit = (targetId, damage) => {
        this.net.sendHit(targetId, damage);
        this.hitMark.hit(false);
        this._lastHitTarget = targetId;

        // Server won't echo the hit back to us, so update locally
        const rp = this.net.remotePlayers.get(targetId);
        if (rp) {
          rp.takeDamage(damage);
          const numPos = rp.getCenter().clone().add(new THREE.Vector3(0, 0.5, 0));
          this.dmgNums.show(numPos, damage, this.camera, this.canvas, damage >= 80);
        }
      };
    }

    this.projectiles.onExplosion = (pos, soundId) => {
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      this.audio?.playAt(soundId, pos, this.player.getPosition(), right);
    };

    this.projectiles.onEnemyHit = (pos, damage, _enemy, justKilled, headshot) => {
      const numPos = pos.clone().add(new THREE.Vector3(0, 0.8, 0));
      this.dmgNums.show(numPos, damage, this.camera, this.canvas, headshot);
      if (justKilled) this.dmgNums.showKill(numPos, this.camera, this.canvas);
      this.hitMark.hit(justKilled);
    };

    // ── Fade out loading screen ───────────────────────────────────────
    const loading = document.getElementById('loading-screen');
    loading.classList.add('fade-out');
    setTimeout(() => loading.style.display = 'none', 800);
    document.getElementById('hud').classList.remove('hidden');
    this.running = true;
  }

  _setupEvents() {
    this.canvas.addEventListener('click', () => {
      this.audio?.resume();
      if (!document.pointerLockElement) this.canvas.requestPointerLock();
    });

    window.addEventListener('keydown', e => {
      if (!this.running) return;

      // Inventory panel
      if (e.code === 'Tab') { e.preventDefault(); this._toggleInvPanel(); return; }
      if (e.code === 'Escape' && this._invPanelOpen) { this._closeInvPanel(); return; }

      // Map
      if (e.code === 'KeyM') { this._toggleMap(); return; }

      // Build mode toggle
      if (this.building && e.code === 'KeyB') { this.building.toggle(); this._updateBuildHUD(); return; }

      // Build mode controls
      if (this.building?.active) {
        if (e.code === 'KeyZ') { this.building.setType('wall');  this._updateBuildHUD(); return; }
        if (e.code === 'KeyX') { this.building.setType('floor'); this._updateBuildHUD(); return; }
        if (e.code === 'KeyC') { this.building.setType('ramp');  this._updateBuildHUD(); return; }
        if (e.code === 'KeyR') { this.building.rotate(); return; }
        if (e.code === 'Escape') { this.building.toggle(); this._updateBuildHUD(); return; }
      }

      if (e.code === 'KeyE') {
        const wp = this.weapons.getNearbyPickup();
        if (wp) {
          this.inventory.addWeapon(new WeaponInstance(wp.def));
          wp.collect();
          return;
        }
        const def = this.pickups.tryCollect();
        if (def) {
          this.inventory.addConsumable(def);
          this.hud.showPickupMessage(def.label, def.healHp > 0 ? 0x00ee66 : 0x44aaff);
        }
      }

    });

    if (this.building) this._buildBuildHUD();
    this._buildInvPanel();

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // ── Shooting ──────────────────────────────────────────────────────────────
  _tryShoot() {
    if (!document.pointerLockElement) {
      this._prevMouseDown = this.player.mouseDown;
      return;
    }

    // In build mode: left-click places, no shooting
    if (this.building?.active) {
      const now  = this.player.mouseDown;
      const prev = this._prevMouseDown;
      if (now && !prev) this.building.tryPlace(this.camera);
      this._prevMouseDown = now;
      return;
    }
    const weapon = this.inventory?.getActive();
    const now    = this.player.mouseDown;
    const prev   = this._prevMouseDown;
    this._prevMouseDown = now;

    // Left-click on consumable slot → start / cancel heal channel
    if (!weapon || weapon.isConsumable) {
      if (now && !prev) this.inventory.useActive(this.player);
      return;
    }

    const shoot = weapon.def.auto ? now : (now && !prev);
    if (!shoot || !weapon.fire()) return;

    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const origin = this.player.getPosition().clone().add(new THREE.Vector3(0, 1.55, 0));
    const adsMultiplier = this.player.adsActive ? 0.4 : 1.0;
    const moveMult = !this.player.adsActive
      ? (this.player.airTime > 0.15 ? 2.8 : this.player._isSprinting ? 2.2 : this.player.isMovingInput ? 1.6 : 1.0)
      : 1.0;
    const spread = weapon.def.spread * adsMultiplier * moveMult;

    for (let p = 0; p < weapon.def.pellets; p++) {
      const dir = camDir.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * spread * 2,
        (Math.random() - 0.5) * spread * 2,
        (Math.random() - 0.5) * spread * 2,
      )).normalize();
      this.projectiles.spawn(origin.clone(), dir, {
        speed: weapon.def.bulletSpeed, damage: weapon.def.damage,
        faction: 'player', range: weapon.def.range, def: weapon.def,
      });
    }

    // Local gunshot audio — one shot per bullet (semi- and full-auto alike)
    this.audio?.playLocal(weapon.def.id);

    // Broadcast shot to other players
    if (this.net) this.net.sendShoot(origin, camDir, weapon.def.id);

    const muzzlePos = origin.clone().addScaledVector(camDir, 1.2);
    this.muzzle.flash(muzzlePos, 3.5);
    this.particles.spawnBurst(muzzlePos, { count: 4, color: 0xffcc44, speed: 2.5, lifetime: 0.08, size: 0.1 });

    const shakeAmt  = weapon.def.id === 'sniper' ? 0.18 : weapon.def.id === 'shotgun' ? 0.14 : 0.06;
    const recoilAmt = weapon.def.id === 'sniper' ? 0.045 : weapon.def.id === 'shotgun' ? 0.030
                    : weapon.def.id === 'ar'     ? 0.010 : 0.018;
    this.shake.shake(shakeAmt);
    this.camera3P.addRecoil(recoilAmt);
  }

  // ── ADS ───────────────────────────────────────────────────────────────────
  _updateADS() {
    const ads    = this.player.adsActive && !!this.inventory.getActive();
    const sniper = ads && this.inventory.getActive()?.def.id === 'sniper';
    this.camera3P.setADS(ads, sniper);
    this.camera3P.setSprint(this.player._isSprinting && !ads);
    this.hud.setADS(ads, sniper);
    this.player._scopeMultiplier = sniper ? 0.25 : ads ? 0.50 : 1.0;
  }

  // ── End screens ───────────────────────────────────────────────────────────
  _showDeathScreen(killerLabel) {
    const statsLabel = this.mode === 'multi' ? `Kills: ${this._playerKills}` : `Enemies remaining: ${this._totalEnemies - this._killCount}`;
    const killedByLine = killerLabel ? `<p class="killed-by">Eliminated by <strong>${killerLabel}</strong></p>` : '';
    const el = document.createElement('div');
    el.id = 'death-screen';
    el.innerHTML = `<div class="end-content">
      <div class="end-icon">✕</div>
      <h1>ELIMINATED</h1>
      ${killedByLine}
      <p>${statsLabel}</p>
      <button onclick="location.reload()">Play Again</button>
    </div>`;
    document.body.appendChild(el);
  }

  _showVictory() {
    const label = this.mode === 'multi' ? `Kills: ${this._playerKills}` : 'All enemies eliminated!';
    const el = document.createElement('div');
    el.id = 'victory-screen';
    el.innerHTML = `<div class="end-content">
      <div class="end-icon victory-icon">★</div>
      <h1>VICTORY ROYALE</h1>
      <p>${label}</p>
      <button onclick="location.reload()">Play Again</button>
    </div>`;
    document.body.appendChild(el);
  }

  // ── Zombie HUD ────────────────────────────────────────────────────────────
  _buildZombieHUD() {
    this._zombieEl = document.createElement('div');
    this._zombieEl.id = 'zombie-hud';
    this._zombieEl.innerHTML = `<span id="z-label">NEXT WAVE IN</span> <span id="z-timer">5</span>s`;
    document.getElementById('hud').appendChild(this._zombieEl);
  }

  _updateZombieHUD(secs, nextWave) {
    if (!this._zombieEl) return;
    const label = document.getElementById('z-label');
    const timer = document.getElementById('z-timer');
    if (label) label.textContent = `WAVE ${nextWave} IN`;
    if (timer) timer.textContent = secs;
  }

  _showWaveBanner(text, color = '#fff') {
    let el = document.getElementById('wave-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wave-banner';
      document.getElementById('hud').appendChild(el);
    }
    el.textContent = text;
    el.style.color = color;
    el.style.opacity = '1';
    clearTimeout(this._waveBannerTimer);
    this._waveBannerTimer = setTimeout(() => { el.style.opacity = '0'; }, 2800);
  }

  // ── Map ───────────────────────────────────────────────────────────────────
  _toggleMap() {
    this._mapOpen = !this._mapOpen;
    this._mapOverlay.classList.toggle('hidden', !this._mapOpen);
    if (this._mapOpen) {
      document.exitPointerLock();
      this._drawMap();
    } else {
      this.canvas.requestPointerLock();
    }
  }

  _drawMap() {
    const canvas = document.getElementById('map-canvas');
    const ctx    = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const S = this.world.size;

    // Terrain base image
    ctx.drawImage(this._mapTerrain, 0, 0, W, H);

    // World-space → canvas pixel
    const toCanvas = (wx, wz) => ({
      x: (wx / S + 0.5) * W,
      y: (wz / S + 0.5) * H,
    });

    // POI labels
    ctx.font = 'bold 11px "Segoe UI", Arial';
    ctx.textAlign = 'center';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    for (const poi of this.world.pois) {
      const { x, y } = toCanvas(poi.x, poi.z);
      ctx.strokeText(poi.name, x, y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(poi.name, x, y);
    }

    // Player marker
    const pp = this.player.getPosition();
    const { x: px, y: py } = toCanvas(pp.x, pp.z);
    const yaw = this.player.getYaw();

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-yaw);
    ctx.fillStyle = '#00ff88';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // ── Inventory Panel (Tab) ────────────────────────────────────────────────
  _buildInvPanel() {
    this._invPanelOpen     = false;
    this._invSelectedSlot  = -1;

    const el = document.createElement('div');
    el.id = 'inv-panel';
    el.classList.add('hidden');
    el.innerHTML = `
      <div id="inv-panel-inner">
        <div id="inv-panel-title">INVENTORY</div>
        <div id="inv-panel-slots"></div>
        <div id="inv-panel-hint">Click a slot to select · click another to swap · Tab / Esc to close</div>
      </div>`;
    document.body.appendChild(el);
    this._invPanelEl = el;
  }

  _toggleInvPanel() {
    if (this._invPanelOpen) this._closeInvPanel();
    else                    this._openInvPanel();
  }

  _openInvPanel() {
    this._invPanelOpen    = true;
    this._invSelectedSlot = -1;
    this._invPanelEl.classList.remove('hidden');
    document.exitPointerLock();
    this._renderInvPanel();
  }

  _closeInvPanel() {
    this._invPanelOpen    = false;
    this._invSelectedSlot = -1;
    this._invPanelEl.classList.add('hidden');
    this.canvas.requestPointerLock();
  }

  _renderInvPanel() {
    const container = document.getElementById('inv-panel-slots');
    container.innerHTML = '';
    const slots = this.inventory.slots;

    slots.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'inv-panel-row' +
        (i === this._invSelectedSlot ? ' selected' : '') +
        (!item ? ' empty' : '');

      let colorHex = 'rgba(255,255,255,0.12)';
      let name     = 'Empty';
      let detail   = '';

      if (item) {
        if (item.isConsumable) {
          colorHex = '#' + item.def.color.toString(16).padStart(6, '0');
          name     = item.def.label;
          detail   = `x${item.count}`;
        } else {
          colorHex = '#' + item.def.rarityColor.toString(16).padStart(6, '0');
          name     = item.def.name;
          detail   = item.reloading ? 'Reloading…' : `${item.ammo} / ${item.reserve}`;
        }
      }

      row.innerHTML = `
        <div class="ip-num">${i + 1}</div>
        <div class="ip-color" style="background:${colorHex}"></div>
        <div class="ip-info">
          <div class="ip-name">${name}</div>
          <div class="ip-detail">${detail}</div>
        </div>
        ${item ? `<button class="ip-drop" data-slot="${i}">Drop</button>` : '<div class="ip-drop-spacer"></div>'}
      `;

      row.addEventListener('click', e => {
        if (e.target.classList.contains('ip-drop')) return;
        if (!item) { this._invSelectedSlot = -1; this._renderInvPanel(); return; }
        if (this._invSelectedSlot === -1) {
          this._invSelectedSlot = i;
        } else if (this._invSelectedSlot === i) {
          this._invSelectedSlot = -1;
        } else {
          // Swap
          const tmp = this.inventory.slots[this._invSelectedSlot];
          this.inventory.slots[this._invSelectedSlot] = this.inventory.slots[i];
          this.inventory.slots[i] = tmp;
          this.inventory.selectSlot(this.inventory.activeSlot);
          this._invSelectedSlot = -1;
        }
        this._renderInvPanel();
      });

      const dropBtn = row.querySelector('.ip-drop');
      if (dropBtn) {
        dropBtn.addEventListener('click', e => {
          e.stopPropagation();
          const si = parseInt(e.target.dataset.slot);
          this.inventory.slots[si] = null;
          if (si === this.inventory.activeSlot) this.player.setHeldWeapon(null);
          if (this._invSelectedSlot === si) this._invSelectedSlot = -1;
          this._renderInvPanel();
        });
      }

      container.appendChild(row);
    });
  }

  // ── Build HUD ─────────────────────────────────────────────────────────────
  _buildBuildHUD() {
    this._buildHudEl = document.createElement('div');
    this._buildHudEl.id = 'build-hud';
    this._buildHudEl.innerHTML = `
      <span class="bh-mode">BUILD</span>
      <span class="bh-sep">·</span>
      <span class="bh-cur" id="bh-cur-type">Wall</span>
      <span class="bh-sep">·</span>
      <span class="bh-keys">Z/X/C · R rotate · B exit</span>
    `;
    this._buildHudEl.style.display = 'none';
    document.getElementById('hud').appendChild(this._buildHudEl);
  }

  _updateBuildHUD() {
    if (!this._buildHudEl) return;
    this._buildHudEl.style.display = this.building.active ? 'flex' : 'none';
    const cur = document.getElementById('bh-cur-type');
    if (cur) cur.textContent = this.building.typeLabel;
  }

  // ── Game Loop ─────────────────────────────────────────────────────────────
  _startLoop() {
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      if (!this.running) return;

      this._tryShoot();
      this._updateADS();

      this.player.update(dt);
      this.camera3P.update(dt, this.shake);
      this.building?.update(this.camera);
      this.inventory.update(dt);
      this.weapons.update(dt, this.player, this.camera);
      this.pickups.update(dt, this.player);

      const remotes = this.net ? this.net.getRemotePlayers() : null;
      const activeEnemies = this.zombieWaves ?? this.enemies;
      this.projectiles.update(dt, this.player, activeEnemies, this.particles, remotes);

      if (this.enemies)     this.enemies.update(dt, this.player, this.camera);
      if (this.zombieWaves) {
        this.zombieWaves.update(dt, this.player, this.camera);
        // Hide inter-wave countdown while fighting
        if (this._zombieEl) {
          this._zombieEl.style.display =
            this.zombieWaves.state === 'intermission' ? 'block' : 'none';
        }
      }
      if (this.storm) this.storm.update(dt, this.player);
      this.particles.update(dt);
      this.shake.update(dt);
      this.muzzle.update(dt);
      this.dirDmg.update(dt);
      this.hitMark.update(dt);
      this.hud.update(dt);

      // Multiplayer: update remote player visuals + send state at 20 Hz
      if (this.net) {
        this.net.update(dt, this.camera, this.canvas);
        this._netTimer -= dt;
        if (this._netTimer <= 0) {
          this._netTimer = 0.05;
          this.net.sendState(this.player.getPosition(), this.player.getYaw());
        }
      }

      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

new Menu();
