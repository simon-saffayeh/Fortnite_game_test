import * as THREE from 'three';
import { World }             from './world.js';
import { Player }            from './player.js';
import { ThirdPersonCamera } from './camera.js';
import { HUD }               from './ui.js';
import { ParticleSystem }    from './particles.js';
import { WeaponSystem, WeaponInstance, WEAPON_DEFS } from './weapons.js';
import { Inventory }         from './inventory.js';
import { ProjectileSystem }  from './projectile.js';
import { EnemyManager }      from './enemy.js';
import { Storm }             from './storm.js';
import { PickupManager }     from './pickups.js';
import { ScreenShake, MuzzleFlash, DamageNumbers, DirectionalDamage, HitMarker } from './effects.js';
import { NetworkManager, MP_SPAWNS } from './multiplayer.js';

// ── Menu / Lobby controller ───────────────────────────────────────────────────
class Menu {
  constructor() {
    this._net    = null;
    this._ready  = false;
    this._myName = localStorage.getItem('bi_name') || `Player${Math.floor(Math.random() * 90) + 10}`;

    document.getElementById('btn-solo').addEventListener('click', () => this._startSolo());
    document.getElementById('btn-multiplayer').addEventListener('click', () => this._openLobby());
    document.getElementById('btn-ready').addEventListener('click', () => this._toggleReady());
    document.getElementById('btn-start-game').addEventListener('click', () => this._requestStart());
    document.getElementById('btn-lobby-back').addEventListener('click', () => location.reload());

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

  _startSolo() {
    const hs = document.getElementById('home-screen');
    hs.classList.add('fade-out');
    setTimeout(() => {
      hs.style.display = 'none';
      document.getElementById('loading-screen').classList.remove('hidden');
    }, 380);
    setTimeout(() => new Game('solo', null), 420);
  }

  async _openLobby() {
    const hs = document.getElementById('home-screen');
    hs.classList.add('fade-out');
    setTimeout(() => hs.style.display = 'none', 380);

    this._net = new NetworkManager();
    const wsUrl = `ws://${window.location.host}/ws`;

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
      document.getElementById('lobby-screen').classList.add('hidden');
      document.getElementById('loading-screen').classList.remove('hidden');
      setTimeout(() => new Game('multi', this._net), 120);
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
  constructor(mode = 'solo', net = null) {
    this.mode   = mode;
    this.net    = net;
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
    this._setupRenderer();
    this._setupScene();
    await this._loadWorld();
    this._setupEvents();
    this._startLoop();
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
    this.scene.fog = new THREE.FogExp2(0x87ceeb, 0.0045);
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

    // ── Spawn position ───────────────────────────────────────────────────
    let spawnPos;
    if (this.mode === 'solo') {
      spawnPos = this.world.getSpawnPosition();
    } else {
      const idx = (parseInt(this.net.myId) - 1) % MP_SPAWNS.length;
      const [sx, sz] = MP_SPAWNS[idx];
      const sh = this.world.getTerrainHeight(sx, sz);
      spawnPos = new THREE.Vector3(sx, sh + 1.5, sz);
    }

    this.player    = new Player(this.scene, spawnPos, this.world);
    this.camera3P  = new ThirdPersonCamera(this.camera, this.player);
    this.particles = new ParticleSystem(this.scene);

    // ── Combat systems ────────────────────────────────────────────────
    this.projectiles = new ProjectileSystem(this.scene, this.world);

    if (this.mode === 'solo') {
      this.enemies = new EnemyManager(this.scene, this.world, this.projectiles);
    } else {
      this.enemies = null;
      // Build spawn point vectors for remote players
      const mpSpawnVecs = MP_SPAWNS.map(([x, z]) => {
        const h = this.world.getTerrainHeight(x, z);
        return new THREE.Vector3(x, h + 1.5, z);
      });
      this.net.spawnRemotePlayers(this.scene, mpSpawnVecs);
    }

    this.weapons   = new WeaponSystem(this.scene, this.world);
    this.inventory = new Inventory(this.player);
    this.pickups   = new PickupManager(this.scene, this.world);
    this.storm     = new Storm(this.scene);

    // ── Effects ───────────────────────────────────────────────────────
    this.shake   = new ScreenShake();
    this.muzzle  = new MuzzleFlash(this.scene);
    this.dmgNums = new DamageNumbers();
    this.dirDmg  = new DirectionalDamage();
    this.hitMark = new HitMarker();

    // ── HUD ───────────────────────────────────────────────────────────
    this.hud = new HUD(this.player, this.world, this.enemies, this.inventory, this.storm);
    this.hud.setWeaponSystem(this.weapons);
    this.hud.setPickupManager(this.pickups);

    // ── Starting pistol ───────────────────────────────────────────────
    this.inventory.addWeapon(new WeaponInstance(WEAPON_DEFS.pistol));

    // ── Wire callbacks ────────────────────────────────────────────────
    this._totalEnemies = this.enemies?.enemies.length ?? 0;

    this.player.onDamage = (_amt, sourcePos) => {
      this.hud.flashDamage();
      this.shake.shake(0.22);
      if (sourcePos) this.dirDmg.show(this.player.getPosition(), this.player.getYaw(), sourcePos);
    };
    this.player.onDeath = () => {
      if (this.net) this.net.sendDeath();
      this._showDeathScreen();
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
    } else {
      // Multiplayer enemy-remaining → players remaining
      const totalPlayers = this.net.players.size;
      this.hud.setEnemiesRemaining(totalPlayers - 1, totalPlayers - 1);
      document.querySelector('.er-label').textContent = 'PLAYERS';

      // Incoming damage from other players
      this.net.onLocalHit = (damage, fromId) => {
        const srcPos = this.net.remotePlayers.get(fromId)?.root.position ?? null;
        this.player.takeDamage(damage, false, srcPos);
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

    this.projectiles.onEnemyHit = (pos, damage, _enemy, justKilled) => {
      const numPos = pos.clone().add(new THREE.Vector3(0, 0.8, 0));
      this.dmgNums.show(numPos, damage, this.camera, this.canvas, damage >= 80);
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
      if (!document.pointerLockElement) this.canvas.requestPointerLock();
    });

    window.addEventListener('keydown', e => {
      if (!this.running) return;
      if (e.code === 'KeyE') {
        const wp = this.weapons.getNearbyPickup();
        if (wp) {
          this.inventory.addWeapon(new WeaponInstance(wp.def));
          wp.collect();
          return;
        }
        const def = this.pickups.tryCollect(this.player);
        if (def) this.hud.showPickupMessage(def.label, def.healHp > 0 ? 0x00ee66 : 0x44aaff);
      }
    });

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
    const weapon = this.inventory?.getActive();
    if (!weapon) { this._prevMouseDown = this.player.mouseDown; return; }

    const now   = this.player.mouseDown;
    const prev  = this._prevMouseDown;
    const shoot = weapon.def.auto ? now : (now && !prev);
    this._prevMouseDown = now;
    if (!shoot || !weapon.fire()) return;

    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const origin = this.player.getPosition().clone().add(new THREE.Vector3(0, 1.55, 0));
    const adsMultiplier = this.player.adsActive ? 0.4 : 1.0;
    const spread = weapon.def.spread * adsMultiplier;

    for (let p = 0; p < weapon.def.pellets; p++) {
      const dir = camDir.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * spread * 2,
        (Math.random() - 0.5) * spread * 2,
        (Math.random() - 0.5) * spread * 2,
      )).normalize();
      this.projectiles.spawn(origin.clone(), dir, {
        speed: weapon.def.bulletSpeed, damage: weapon.def.damage,
        faction: 'player', range: weapon.def.range,
      });
    }

    // Broadcast shot to other players
    if (this.net) this.net.sendShoot(origin, camDir);

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
  }

  // ── End screens ───────────────────────────────────────────────────────────
  _showDeathScreen() {
    const label = this.mode === 'multi' ? `Kills: ${this._playerKills}` : `Enemies remaining: ${this._totalEnemies - this._killCount}`;
    const el = document.createElement('div');
    el.id = 'death-screen';
    el.innerHTML = `<div class="end-content">
      <div class="end-icon">✕</div>
      <h1>ELIMINATED</h1>
      <p>${label}</p>
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
      this.inventory.update(dt);
      this.weapons.update(dt, this.player, this.camera);
      this.pickups.update(dt, this.player);

      const remotes = this.net ? this.net.getRemotePlayers() : null;
      this.projectiles.update(dt, this.player, this.enemies, this.particles, remotes);

      if (this.enemies) this.enemies.update(dt, this.player, this.camera);
      this.storm.update(dt, this.player);
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
