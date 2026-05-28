import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass }     from 'three/addons/postprocessing/ShaderPass.js';
import { World }             from './world.js';
import { Player }            from './player.js';
import { ThirdPersonCamera } from './camera.js';
import { HUD }               from './ui.js';
import { ParticleSystem }    from './particles.js';
import { WeaponSystem, WeaponInstance, WeaponPickup, WEAPON_DEFS, buildGunModel } from './weapons.js';
import { Inventory }         from './inventory.js';
import { ProjectileSystem }  from './projectile.js';
import { EnemyManager }      from './enemy.js';
import { MsFranksManager, spawnProtractorBlast, tickProtractorLasers } from './boss.js';
import { Storm }             from './storm.js';
import { PickupManager, CONSUMABLE_DEFS } from './pickups.js';
import { ScreenShake, MuzzleFlash, DamageNumbers, DirectionalDamage, HitMarker } from './effects.js';
import { NetworkManager, MP_SPAWNS } from './multiplayer.js';
import { BuildingSystem } from './building.js';
import { ZombieWaveManager } from './zombie.js';
import { AudioManager } from './audio.js';
import { DeployController } from './skydive.js';
import { SpectatorController, PHASE_SPECTATING } from './spectator.js';
import { SupplyDropManager } from './supplyDrops.js';
import { AmmoSystem, AMMO_VISUAL } from './ammo.js';
import { Graphics, PRESETS } from './graphics.js';

const waveCount_hud = (w) => 3 + (w - 1) * 2; // mirrors zombie.js formula

// ── Menu / Lobby controller ───────────────────────────────────────────────────
class Menu {
  constructor() {
    this._net    = null;
    this._ready  = false;
    this._myName = localStorage.getItem('bi_name') || `Player${Math.floor(Math.random() * 90) + 10}`;

    // Lobby music — starts on first user interaction, stops when entering game
    this._music = new Audio('sounds/music/lobby_music.mp3');
    this._music.loop   = true;
    this._music.volume = 0.4;
    const startMusic = () => {
      this._music.play().catch(() => {});
      document.removeEventListener('click',   startMusic);
      document.removeEventListener('keydown', startMusic);
    };
    document.addEventListener('click',   startMusic);
    document.addEventListener('keydown', startMusic);

    document.getElementById('btn-solo').addEventListener('click', () => this._startSolo());
    document.getElementById('btn-zombie').addEventListener('click', () => this._startZombie());
    document.getElementById('btn-multiplayer').addEventListener('click', () => this._openLobby());
    document.getElementById('btn-ready').addEventListener('click', () => this._toggleReady());
    document.getElementById('btn-start-game').addEventListener('click', () => this._requestStart());
    document.getElementById('btn-lobby-back').addEventListener('click', () => location.reload());

    // Mode picker — tap-style buttons. Only the active button has the
    // `.active` class; clicking another toggles state and re-renders teams.
    for (const b of document.querySelectorAll('.lobby-mode-row .mode-btn')) {
      b.addEventListener('click', () => {
        if (!this._net?.isHost) return;
        this._matchMode = b.dataset.mode;
        for (const o of document.querySelectorAll('.lobby-mode-row .mode-btn')) {
          o.classList.toggle('active', o === b);
        }
        this._renderTeams();
      });
    }

    // Spectate button — late joiners click to drop into the running match
    // as a spectator. Hidden until the lobby learns a match is active.
    document.getElementById('btn-spectate').addEventListener('click', () => this._startSpectator());

    // Host-only state for the team picker:
    // - this._matchMode: 'solo' | 'duo'
    // - this._teams: { playerId: teamId } only meaningful in duo
    // - this._teamSelected: id of player chip the host is moving (click-to-swap)
    this._matchMode    = 'solo';
    this._teams        = {};
    this._teamSelected = null;

    // Sensitivity slider
    const sensSlider = document.getElementById('sens-slider');
    const sensValue  = document.getElementById('sens-value');
    const saved = JSON.parse(localStorage.getItem('bi_settings') || '{}');
    if (saved.sensitivity) sensSlider.value = saved.sensitivity;
    sensValue.textContent = parseFloat(sensSlider.value).toFixed(1);
    sensSlider.addEventListener('input', () => {
      sensValue.textContent = parseFloat(sensSlider.value).toFixed(1);
      const cur = JSON.parse(localStorage.getItem('bi_settings') || '{}');
      cur.sensitivity = parseFloat(sensSlider.value);
      localStorage.setItem('bi_settings', JSON.stringify(cur));
    });

    // Graphics quality picker (home screen). Auto-detected on first load
    // and persisted; LOW/MEDIUM/HIGH/ULTRA flip every renderer flag and the
    // PBR/Lambert split. Changing during a session takes effect on next match.
    const qBtns = document.querySelectorAll('.quality-btn');
    qBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.quality === Graphics.presetName);
      btn.addEventListener('click', () => {
        Graphics.setPreset(btn.dataset.quality);
        qBtns.forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    // Solo difficulty picker — Easy / Medium / Hard / Expert.
    // Persisted in bi_settings; ignored by zombie + multiplayer modes.
    this._difficulty = ['easy','medium','hard','expert'].includes(saved.difficulty)
      ? saved.difficulty : 'medium';
    const diffBtns = document.querySelectorAll('.diff-btn');
    diffBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.diff === this._difficulty);
      btn.addEventListener('click', () => {
        this._difficulty = btn.dataset.diff;
        diffBtns.forEach(b => b.classList.toggle('active', b === btn));
        const cur = JSON.parse(localStorage.getItem('bi_settings') || '{}');
        cur.difficulty = this._difficulty;
        localStorage.setItem('bi_settings', JSON.stringify(cur));
      });
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
    const difficulty     = this._difficulty;
    hs.classList.add('fade-out');
    setTimeout(() => {
      hs.style.display = 'none';
      document.getElementById('loading-screen').classList.remove('hidden');
    }, 380);
    setTimeout(() => new Game('solo', null, buildEnabled, testingEnabled, this._music, null, difficulty), 420);
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
    setTimeout(() => new Game('zombie', null, buildEnabled, testingEnabled, this._music), 420);
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
      this._net.players.set(msg.id, {
        id: msg.id, name: this._myName, ready: false, inGame: false,
      });
      this._net.setName(this._myName);
      document.getElementById('lobby-mode-row').classList.remove('hidden');
      if (msg.isHost) {
        document.getElementById('btn-start-game').classList.remove('hidden');
        this._setStatus('You are the host — wait for friends, then Start Game.');
      } else {
        document.getElementById('lobby-mode-row').classList.add('readonly');
        this._setStatus('Waiting for host to start…');
      }
      this._refreshList();
      this._renderTeams();
      this._refreshMatchStateUI();
    };

    this._net.onPlayerJoined = () => { this._refreshList(); this._renderTeams(); };
    this._net.onPlayerLeft   = (msg) => {
      // Free their team slot so the picker stays accurate.
      delete this._teams[msg.id];
      this._refreshList();
      this._renderTeams();
    };
    this._net.onPlayerReady  = () => this._refreshList();

    this._net.onHostTransfer = () => {
      document.getElementById('btn-start-game').classList.remove('hidden');
      document.getElementById('lobby-mode-row').classList.remove('readonly');
      this._setStatus('You are now the host!');
      this._renderTeams();
    };

    // Match start: only late joiners (not in inGameIds) stay in the lobby
    // — they see in-game players tagged and a Spectate button appear.
    // Players who ARE in the match transition into the loading screen.
    this._net.onGameStart = (msg) => {
      const inMatch = this._net.inGameIds.has(this._net.myId);
      if (inMatch) {
        const buildEnabled   = this._buildEnabled();
        const testingEnabled = this._testingEnabled();
        document.getElementById('lobby-screen').classList.add('hidden');
        document.getElementById('loading-screen').classList.remove('hidden');
        const busPath = msg?.busPath ?? null;
        setTimeout(() => new Game('multi', this._net, buildEnabled, testingEnabled, this._music, busPath), 120);
      } else {
        // Late joiner — re-render lobby so in-game rows pick up the tag.
        this._refreshList();
        this._refreshMatchStateUI();
      }
    };

    // When the running match ends, the lobby just refreshes: in-game tags
    // disappear and the Spectate button hides. No screen swap needed — the
    // late joiners were already sitting in the lobby.
    this._net.onMatchEnded = () => {
      this._refreshList();
      this._renderTeams();
      this._refreshMatchStateUI();
    };

    document.getElementById('lobby-screen').classList.remove('hidden');
  }

  _refreshList() {
    const ul = document.getElementById('lobby-players');
    ul.innerHTML = '';
    for (const [id, p] of this._net.players) {
      const isMe = id === this._net.myId;
      const li   = document.createElement('div');
      li.className = 'lobby-player'
        + (isMe ? ' me' : '')
        + (p.inGame ? ' in-game' : '');
      // Players currently in the running match show an IN GAME tag in
      // amber; lobby players show their ready/waiting status as before.
      const statusHTML = p.inGame
        ? `<span class="lp-ready">⚑ IN GAME</span>`
        : `<span class="lp-ready ${p.ready ? 'yes' : ''}">${p.ready ? '✓ READY' : '○ WAITING'}</span>`;
      li.innerHTML = `
        <span class="lp-name">${isMe ? this._myName : p.name}${isMe ? ' (you)' : ''}</span>
        ${statusHTML}
      `;
      ul.appendChild(li);
    }
    const total      = this._net.players.size;
    const rdy        = [...this._net.players.values()].filter(p => p.ready && !p.inGame).length;
    const inMatch    = [...this._net.players.values()].filter(p => p.inGame).length;
    // Same "real-active" gate as _refreshMatchStateUI so stale gameActive
    // state can't pin the status line on "Match in progress".
    const realActive = this._net.gameActive && inMatch > 0;
    if (realActive && !this._net.inGameIds.has(this._net.myId)) {
      this._setStatus(`Match in progress (${inMatch} playing). You'll join the next round.`);
    } else {
      this._setStatus(`${total} / 20 players — ${rdy} ready`);
    }
  }

  /**
   * Reconciles host controls + Spectate button + team picker visibility
   * with the current match state. Called whenever match state changes
   * (gameStart, matchEnded, welcome).
   */
  _refreshMatchStateUI() {
    if (!this._net) return;
    const startBtn = document.getElementById('btn-start-game');
    const specBtn  = document.getElementById('btn-spectate');
    const teamRow  = document.getElementById('lobby-mode-row');

    // `gameActive` alone isn't enough — if the server says a match is
    // running but `inGameIds` is empty (stale state from a crash, etc.),
    // there's nothing to spectate and the lobby should behave as idle.
    const realActive = this._net.gameActive && this._net.inGameIds.size > 0;
    const lateJoiner = realActive && !this._net.inGameIds.has(this._net.myId);

    if (realActive) {
      // A genuine match is running — hide host/mode controls and offer
      // late joiners a Spectate button instead.
      startBtn.classList.add('hidden');
      teamRow.classList.add('hidden');
      document.getElementById('lobby-teams').classList.add('hidden');
      specBtn.classList.toggle('hidden', !lateJoiner);
    } else {
      // Idle lobby — restore host controls.
      if (this._net.isHost) startBtn.classList.remove('hidden');
      teamRow.classList.remove('hidden');
      specBtn.classList.add('hidden');
      this._renderTeams();
    }
  }

  /**
   * Late joiner clicks "Spectate Match". Boot a Game in `multi` mode; the
   * Game constructor detects net.gameActive and starts in spectator mode
   * instead of running deploy.
   */
  _startSpectator() {
    // Only spectate when there's actually a running match with people in it.
    if (!this._net?.gameActive || this._net.inGameIds.size === 0) return;
    const buildEnabled   = this._buildEnabled();
    const testingEnabled = this._testingEnabled();
    document.getElementById('lobby-screen').classList.add('hidden');
    document.getElementById('loading-screen').classList.remove('hidden');
    setTimeout(() => new Game('multi', this._net, buildEnabled, testingEnabled, this._music, null), 120);
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
    if (this._matchMode === 'duo') {
      // Refuse a start until every player has a team (and at least 2 teams).
      this._autoFillTeams();
      const teams = new Set(Object.values(this._teams));
      if (Object.keys(this._teams).length < this._net.players.size) {
        this._setStatus('Assign every player to a team first.');
        return;
      }
      if (teams.size < 2) {
        this._setStatus('Need at least 2 teams to start a Duo.');
        return;
      }
    }
    this._net.startGame(this._matchMode, this._teams);
  }

  /**
   * Fill any unassigned players into the smallest team (round-robin) so a
   * host can hit Start without manually placing everyone. Teams are
   * letter-coded A, B, C, … with a 2-player cap each. Capped at 10 teams
   * (= up to 20 players).
   */
  _autoFillTeams() {
    const ids   = [...this._net.players.keys()];
    const cap   = 2;             // Duo team size
    const maxTeams = 10;         // 10 teams × 2 = 20 players
    const teams = {};            // teamId → [playerIds]
    const ensureTeam = (t) => teams[t] ?? (teams[t] = []);
    // Seed with whatever the host already arranged.
    for (const [pid, t] of Object.entries(this._teams)) {
      if (ids.includes(pid)) ensureTeam(t).push(pid);
    }
    const letter = (n) => String.fromCharCode(65 + n); // 0 -> A
    for (const pid of ids) {
      if (this._teams[pid]) continue;
      let placed = false;
      // Try existing teams that have room.
      for (let i = 0; i < maxTeams && !placed; i++) {
        const t = letter(i);
        const arr = ensureTeam(t);
        if (arr.length < cap) { arr.push(pid); this._teams[pid] = t; placed = true; }
      }
      if (!placed) break; // 20 players already placed
    }
  }

  /**
   * Render the team picker. Host-clickable; non-hosts see read-only.
   * The picker is hidden in Solo (FFA).
   */
  _renderTeams() {
    const container = document.getElementById('lobby-teams');
    if (!container) return;
    if (this._matchMode !== 'duo' || !this._net) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }
    container.classList.remove('hidden');

    // Make sure every player has a team slot, then group by team.
    this._autoFillTeams();
    const byTeam = {};
    for (const pid of this._net.players.keys()) {
      const t = this._teams[pid] ?? 'A';
      (byTeam[t] = byTeam[t] || []).push(pid);
    }

    container.innerHTML = '';
    const teamIds = Object.keys(byTeam).sort();
    for (const t of teamIds) {
      const div = document.createElement('div');
      div.className = 'lobby-team';
      div.dataset.team = t;
      let html = `<span class="team-title">Team ${t}</span>`;
      for (let i = 0; i < 2; i++) {
        const pid = byTeam[t][i];
        if (pid) {
          const name = this._net.players.get(pid)?.name ?? `Player ${pid}`;
          html += `<span class="team-slot" data-pid="${pid}">${name}</span>`;
        } else {
          html += `<span class="team-slot empty">(empty)</span>`;
        }
      }
      container.appendChild(div);
      div.innerHTML = html;
    }

    // Click-to-swap behavior, host-only. Click a chip to select it, then
    // click another chip to swap, or an empty slot to move there.
    if (!this._net.isHost) return;
    container.querySelectorAll('.team-slot').forEach(el => {
      el.addEventListener('click', () => {
        const pid = el.dataset.pid;
        if (this._teamSelected == null) {
          if (!pid) return;       // can't start a move from an empty slot
          this._teamSelected = pid;
          el.parentElement.classList.add('target-selected');
          return;
        }
        const targetTeam = el.parentElement.dataset.team;
        if (pid && pid !== this._teamSelected) {
          // Swap two players' team assignments.
          const a = this._teamSelected, b = pid;
          const ta = this._teams[a], tb = this._teams[b];
          this._teams[a] = tb; this._teams[b] = ta;
        } else if (!pid) {
          // Move selected to empty slot if that team has room.
          const arr = byTeam[targetTeam] ?? [];
          if (arr.length < 2) this._teams[this._teamSelected] = targetTeam;
        }
        this._teamSelected = null;
        this._renderTeams();
      });
    });
  }

  _setStatus(txt) {
    const el = document.getElementById('lobby-status');
    if (el) el.textContent = txt;
  }
}

// ── Game ──────────────────────────────────────────────────────────────────────
class Game {
  constructor(mode = 'solo', net = null, buildEnabled = false, testingEnabled = false, lobbyMusic = null, busPath = null, difficulty = 'medium') {
    this.mode           = mode;
    this.net            = net;
    this.buildEnabled   = buildEnabled;
    this.testingEnabled = testingEnabled;
    this._lobbyMusic    = lobbyMusic;
    this._busPath       = busPath;
    this.difficulty     = difficulty;
    this.deploy         = null;
    this.spectator      = null;
    this._matchOverShown = false;
    // Late-spectator: we're spinning up a Game *after* the host already
    // started the match. Skip deploy and drop straight into spectator mode
    // so the player can watch the running round from a teammate's POV.
    this._lateSpectator  = !!(mode === 'multi' && net?.gameActive
      && net?.inGameIds && !net.inGameIds.has(net.myId));
    this.supplyDrops    = null;
    this._eHeld         = false;
    this._stormPrevKey  = null;   // tracks last seen phase_state for announcements
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
      this._setupPostFX();
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, Graphics.pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled   = Graphics.shadowsEnabled;
    this.renderer.shadowMap.type      = THREE.PCFShadowMap;
    this.renderer.toneMapping         = THREE.ACESFilmicToneMapping;
    // PBR + IBL adds significant ambient energy from the baked sky envMap.
    // Stacking that on top of the original hemi/amb/sun budget overexposes
    // the scene (whites everywhere, sky blowout). Drop exposure further when
    // PBR is active — the loss is more than recovered by the IBL specular.
    this.renderer.toneMappingExposure = Graphics.pbrEnabled ? 0.78 : 1.25;
    this.renderer.outputColorSpace    = THREE.SRGBColorSpace;
  }

  /**
   * Build the post-processing chain: RenderPass → UnrealBloomPass → vignette+grain.
   * Called once after scene/camera exist, since RenderPass needs both. Cheap
   * enough on capped pixel-ratio that it costs ~1–2ms/frame on mid-range GPUs.
   */
  _setupPostFX() {
    const w = window.innerWidth, h = window.innerHeight;
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, Graphics.pixelRatioCap));
    this.composer.setSize(w, h);

    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // Bloom — strength 0.55 is moderate (not blown-out), radius 0.4 spreads
    // it naturally, threshold 0.85 ignores normal-lit surfaces and only
    // catches emissives (storm, sun, muzzle flashes, fire pits, supply-drop lids).
    if (Graphics.bloomEnabled) {
      // With PBR + IBL the average surface brightness is higher, so a 0.85
      // threshold catches a lot more than just emissives. 0.92 + reduced
      // strength gives a small headroom — sun disc / supply-drop lid /
      // storm wall still bloom; ordinary lit surfaces don't.
      const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.4, 0.4, 0.92);
      this.composer.addPass(bloom);
    }

    // ── Cel-shaded outline pass ─────────────────────────────────────────
    // Sobel-style edge detection on screen-space luminance — catches the
    // sharp color/lighting discontinuities between flat-shaded box parts,
    // which look like outlines around each piece (Fortnite/Borderlands feel).
    // 8 texture samples per pixel, threshold-gated so subtle gradients
    // don't outline themselves.
    this._outlinePass = new ShaderPass({
      uniforms: {
        tDiffuse:    { value: null },
        uResolution: { value: new THREE.Vector2(w, h) },
        uStrength:   { value: 0.45 },  // 0..1 — how dark the outline is
        uThreshold:  { value: 0.16 },  // luminance gap below this is ignored
        uThickness:  { value: 1.0 },   // pixels — sample offset radius
        uSaturate:   { value: 0.08 },  // 0..1 — extra saturation boost (cartoon)
      },
      vertexShader: /*glsl*/ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /*glsl*/ `
        uniform sampler2D tDiffuse;
        uniform vec2  uResolution;
        uniform float uStrength;
        uniform float uThreshold;
        uniform float uThickness;
        uniform float uSaturate;
        varying vec2 vUv;
        float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
        void main() {
          vec2 px = uThickness / uResolution;
          // 4-direction Sobel (cardinal-only — half the cost of full 3x3
          // Sobel and visually equivalent for outline purposes).
          float lN = lum(texture2D(tDiffuse, vUv + vec2(0.0,  px.y)).rgb);
          float lS = lum(texture2D(tDiffuse, vUv + vec2(0.0, -px.y)).rgb);
          float lE = lum(texture2D(tDiffuse, vUv + vec2( px.x, 0.0)).rgb);
          float lW = lum(texture2D(tDiffuse, vUv + vec2(-px.x, 0.0)).rgb);
          float edge = abs(lN - lS) + abs(lE - lW);
          edge = smoothstep(uThreshold, uThreshold + 0.15, edge);

          vec3 col = texture2D(tDiffuse, vUv).rgb;
          // Pseudo-toon: boost saturation by pushing each channel away from
          // its grayscale equivalent. Cheap (no HSL conversion needed) and
          // gives a stylized cartoon palette without per-material toon maps.
          float g = lum(col);
          col = mix(vec3(g), col, 1.0 + uSaturate);
          // Edge → darken toward black.
          col = mix(col, vec3(0.0), edge * uStrength);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    if (Graphics.outlineEnabled) this.composer.addPass(this._outlinePass);

    // Vignette + film grain pass. Vignette darkens corners; grain is a tiny
    // animated noise (~3% brightness wobble) for cinematic texture. Time
    // uniform is bumped each frame in the loop.
    this._grainPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uTime:    { value: 0 },
        uVignette:{ value: 0.45 },
        uGrain:   { value: 0.0 },
      },
      vertexShader: /*glsl*/ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /*glsl*/ `
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uVignette;
        uniform float uGrain;
        varying vec2 vUv;
        // Hash-based pseudo-random noise — cheap, no texture sample.
        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        void main() {
          vec4 col = texture2D(tDiffuse, vUv);
          // Vignette: subtle darkening toward the corners.
          vec2 q = vUv - 0.5;
          float vig = smoothstep(0.95, 0.45, length(q));
          col.rgb *= mix(1.0, vig, uVignette * 0.35);
          // Grain: time-animated noise, additive in luminance.
          float n = hash(vUv * vec2(1920.0, 1080.0) + uTime * 60.0);
          col.rgb += (n - 0.5) * uGrain;
          gl_FragColor = col;
        }
      `,
    });
    this._grainPass.renderToScreen = true;
    this.composer.addPass(this._grainPass);
  }

  _setupScene() {
    this.scene  = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x9ec8e8, 0.0038);
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
  }

  async _loadWorld() {
    const bar  = document.getElementById('loading-bar');
    const txt  = document.getElementById('loading-text');
    const step = (msg, pct) => { txt.textContent = msg; bar.style.width = pct + '%'; };
    const frame = () => new Promise(r => requestAnimationFrame(r));

    // ── 1. Terrain ────────────────────────────────────────────────────
    step('Generating terrain…', 12);
    await frame(); // let bar paint before synchronous terrain build
    // World needs the renderer to run the PMREM bake for IBL.
    this.world = new World(this.scene, this.renderer);
    this.world.generate();

    // ── 2. Nature ─────────────────────────────────────────────────────
    step('Planting trees…', 25);
    await this.world.loadNature();

    // ── 3. Structures ─────────────────────────────────────────────────
    step('Building structures…', 37);
    await this.world.loadFurniture();

    // ── 4. Core systems ───────────────────────────────────────────────
    step('Spawning weapons…', 50);
    await frame();

    let spawnPos;
    if (this.mode === 'solo' || this.mode === 'zombie') {
      spawnPos = this.world.getSpawnPosition();
    } else {
      const idx = (parseInt(this.net.myId) - 1) % MP_SPAWNS.length;
      const [sx, sz] = MP_SPAWNS[idx];
      spawnPos = new THREE.Vector3(sx, this.world.getTerrainHeight(sx, sz) + 1.5, sz);
    }

    this.player    = new Player(this.scene, spawnPos, this.world);
    const biSettings = JSON.parse(localStorage.getItem('bi_settings') || '{}');
    if (biSettings.sensitivity) this.player._sensMultiplier = biSettings.sensitivity;
    this.camera3P  = new ThirdPersonCamera(this.camera, this.player);
    this.particles = new ParticleSystem(this.scene);
    this.projectiles = new ProjectileSystem(this.scene, this.world);
    // Ammo system must exist before WeaponSystem so weapons can spawn
    // matching ammo piles next to themselves at world setup.
    this.ammo      = new AmmoSystem(this.scene, this.world);
    // In multiplayer, use the server's worldSeed so every client rolls
    // identical weapon types at the same SPAWN_POINTS — otherwise solo
    // RNG diverges and a spectator sees different guns than the players.
    const loadoutSeed = this.net?.worldSeed ?? null;
    this.weapons   = new WeaponSystem(this.scene, this.world, this.ammo, loadoutSeed);
    this.inventory = new Inventory(this.player);
    this.pickups   = new PickupManager(this.scene, this.world);

    // ── 5. Enemies / players ──────────────────────────────────────────
    step('Placing med kits…', 62);
    await frame();

    if (this.mode === 'solo') {
      this.enemies     = new EnemyManager(this.scene, this.world, this.projectiles, this.difficulty);
      this.zombieWaves = null;
    } else if (this.mode === 'zombie') {
      this.enemies     = null;
      this.zombieWaves = new ZombieWaveManager(this.scene, this.world, this.projectiles);
      this.zombieWaves.setParticles(this.particles);
    } else {
      this.enemies     = null;
      this.zombieWaves = null;
      const mpSpawnVecs = MP_SPAWNS.map(([x, z]) => {
        const h = this.world.getTerrainHeight(x, z);
        return new THREE.Vector3(x, h + 1.5, z);
      });
      this.net.spawnRemotePlayers(this.scene, mpSpawnVecs);
    }

    // ── Ms. Franks (Frank's Jail boss) ──────────────────────────────────
    // Solo + multiplayer both get her; zombie mode is its own thing so we
    // skip it there. Host-authoritative in MP; passive shell on non-hosts.
    if (this.mode !== 'zombie') {
      this.bossManager = new MsFranksManager({
        scene:            this.scene,
        world:            this.world,
        projectileSystem: this.projectiles,
        weapons:          this.weapons,
        particles:        this.particles,
        net:              this.net,
      });
      this.projectiles.bossManager = this.bossManager;
    } else {
      this.bossManager = null;
    }

    // ── 6. Effects, audio, building ───────────────────────────────────
    step(this.mode === 'solo' ? 'Deploying enemies…' : 'Connecting players…', 75);

    this.storm   = this.mode === 'zombie' ? null : new Storm(this.scene);
    // Multiplayer: anchor the storm clock to the shared game-start moment so
    // every client sees the same radius/phase regardless of when they land.
    if (this.storm && this.net?.gameStartTime != null) {
      this.storm.setClockStart(this.net.gameStartTime);
    }

    // Supply drops — battle-royale style hot-air-balloon crates with
    // mythic/legendary loot. Disabled in zombie mode (no storm circle).
    if (this.mode !== 'zombie') {
      this.supplyDrops = new SupplyDropManager({
        scene:   this.scene,
        world:   this.world,
        storm:   this.storm,
        pickups: this.pickups,
        weapons: this.weapons,
        ammo:    this.ammo,
        // In multiplayer the host runs the spawn timer and broadcasts;
        // non-hosts wait for messages. Solo passes null and runs locally.
        net:     this.net,
      });
    }
    this.shake   = new ScreenShake();
    this.muzzle  = new MuzzleFlash(this.scene);
    this.dmgNums = new DamageNumbers();
    this.dirDmg  = new DirectionalDamage();
    this.hitMark = new HitMarker();

    this.audio = new AudioManager();
    const audioReady = this.audio.init(); // fire off async fetch, await later

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

    this._mapOverlay = document.getElementById('map-overlay');
    this._mapTerrain = this.world.renderMapCanvas();
    this._mapOpen    = false;

    // HUD's minimap needs whichever enemy manager is active. Solo uses
    // `this.enemies`; zombie mode uses `this.zombieWaves` (set later in
    // _loadWorld); multiplayer leaves both null. We attach whichever the
    // active mode has via setEnemyManager.
    this.hud = new HUD(this.player, this.world, this.enemies, this.inventory, this.storm);
    if (this.zombieWaves) this.hud.setEnemyManager(this.zombieWaves);
    if (this.net) this.hud.setNetwork(this.net);
    this.hud.setWeaponSystem(this.weapons);
    this.hud.setPickupManager(this.pickups);
    if (this.supplyDrops) this.hud.setSupplyDrops(this.supplyDrops);
    this.hud.setCamera(this.camera, this.canvas);
    this.inventory.onHealProgress = (progress, label) => this.hud.setHealProgress(progress, label);

    // Drop a slot → spawn a world pickup at the player's feet (forward
    // offset so it doesn't clip the body). For weapons we preserve the
    // ammo/reserve state; consumables spawn one pickup per item in the
    // stack so a full stack can be recovered.
    this.inventory.onDrop = (item) => {
      if (item.isConsumable) this._spawnDroppedConsumable(item);
      else                   this._spawnDroppedWeapon(item);
    };

    if (this.testingEnabled) {
      for (const id of ['phaseRifle', 'sniper', 'rocketLauncher', 'minigun', 'bombLauncher']) {
        this.inventory.addWeapon(new WeaponInstance(WEAPON_DEFS[id]));
      }
      // Seed the shared ammo pool generously so testing-mode weapons can
      // actually be reloaded without scavenging.
      this.inventory.addAmmo('light',   600);
      this.inventory.addAmmo('medium',  300);
      this.inventory.addAmmo('heavy',    60);
      this.inventory.addAmmo('rockets',  20);
      this.inventory.addAmmo('shells',   60);
      this.player._sprintMultiplier = 2.0;
    } else {
      this.inventory.addWeapon(new WeaponInstance(WEAPON_DEFS.pistol));
      // Players start with only the loaded pistol mag — no reserve pools.
    }

    // ── 7. Shader prewarm + compile ───────────────────────────────────
    step('Charging storm…', 87);
    await frame(); // paint before GPU-blocking compile calls

    const _prewarmGroup = new THREE.Group();
    _prewarmGroup.visible = false;
    for (const id of Object.keys(WEAPON_DEFS)) {
      _prewarmGroup.add(buildGunModel(WEAPON_DEFS[id], 0.58));
      buildGunModel(WEAPON_DEFS[id], 1.15);
    }
    this.scene.add(_prewarmGroup);

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
      const mFront  = new THREE.Mesh(geo, _fxMat(THREE.FrontSide));
      const mDouble = new THREE.Mesh(geo, _fxMat(THREE.DoubleSide));
      mFront.position.set(0, -9999, 0);
      mDouble.position.set(0, -9999, 0);
      this.scene.add(mFront); this.scene.add(mDouble);
      _fxMeshes.push(mFront, mDouble);
    }

    this.renderer.compile(this.scene, this.camera);
    const _prewarmLight = new THREE.PointLight(0xff8822, 0.0001, 1);
    _prewarmLight.position.set(0, -9999, 0);
    this.scene.add(_prewarmLight);
    this.renderer.compile(this.scene, this.camera);
    this.scene.remove(_prewarmLight);

    this.scene.remove(_prewarmGroup);
    for (const m of _fxMeshes) { this.scene.remove(m); m.material.dispose(); }
    for (const g of _fxGeos) g.dispose();

    await audioReady; // audio fetches ran in parallel — should be done by now

    // ── Wire callbacks ────────────────────────────────────────────────
    this._totalEnemies = this.enemies?.enemies.length ?? 0;

    this.player.onDamage = (_amt, sourcePos) => {
      this.hud.flashDamage();
      this.shake.shake(0.22);
      if (sourcePos) this.dirDmg.show(this.player.getPosition(), this.player.getYaw(), sourcePos);
    };
    this.player.onDeath = (killerLabel) => {
      // Gather inventory contents → spawn world pickups around the body
      // → broadcast so remote clients see the same drops. We do this BEFORE
      // sending death so the drops payload rides along the death message.
      const drops = this._collectDeathDrops();
      this._spawnDeathDrops(drops, this.player.getPosition());
      if (this.net) this.net.sendDeath(drops);
      this._showDeathScreen(killerLabel);
    };

    if (this.mode === 'solo') {
      this._totalEnemies = this.enemies.enemies.length;
      this.hud.setEnemiesRemaining(this._totalEnemies, this._totalEnemies);

      this.enemies.onKill = (killedEnemy) => {
        this._killCount++;
        this.hud.addKill('Enemy Soldier', { headshot: !!killedEnemy._killedByHeadshot });
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
        const killName = e._variant === 'rager'   ? 'Rager'
                       : e._variant === 'bloater' ? 'Bloater'
                       : 'Zombie';
        this.hud.addKill(killName, { headshot: !!e._killedByHeadshot });
        // Bloaters explode on death: acid burst + proximity damage
        if (e.bloaterAoE) {
          const bp = e.root.position.clone();
          this.particles.spawnBurst(bp, { count: 22, color: 0x44ff44, speed: 5, lifetime: 0.6, size: 0.22 });
          this.particles.spawnBurst(bp, { count: 10, color: 0x88ff22, speed: 3, lifetime: 0.45, size: 0.32 });
          const pp = this.player.getPosition();
          const d  = Math.sqrt((pp.x - bp.x) ** 2 + (pp.z - bp.z) ** 2);
          if (d < 4.5) {
            this.player.takeDamage(Math.round(28 * (1 - d / 4.5)), false, bp, 'a bloater explosion');
          }
        }
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
      // Latch the opponent baseline at match start so the HUD denominator
      // doesn't shift when teammates also die (in Duo).
      this._totalOpponents = this.net.totalOpponentCount();
      this.hud.setEnemiesRemaining(this._totalOpponents, this._totalOpponents);
      document.querySelector('.er-label').textContent = 'PLAYERS';

      this.net.onLocalHit = (damage, fromId) => {
        // Friendly fire: a teammate's bullet still arrives over the wire
        // (their client can't filter for us reliably) — drop it here.
        if (this.net.isTeammate(fromId)) return;
        const srcPos = this.net.remotePlayers.get(fromId)?.root.position ?? null;
        const killerName = this.net.players.get(fromId)?.name ?? 'a player';
        this.player.takeDamage(damage, false, srcPos, killerName);
      };

      this.net.onRemoteDeath = (msg) => {
        if (this._lastHitTarget === msg.id) {
          this._playerKills++;
          this.hud.addKill(
            this.net.players.get(msg.id)?.name ?? 'Player',
            { headshot: !!this._lastHitWasHeadshot },
          );
          this.hitMark.hit(true);
          this._lastHitTarget = null;
          this._lastHitWasHeadshot = false;
        }
        // Spawn the dead player's loot drops at their body. Their client
        // attached the inventory contents to the death message before sending.
        const rp = this.net.remotePlayers.get(msg.id);
        if (rp && Array.isArray(msg.drops) && msg.drops.length) {
          this._spawnDeathDrops(msg.drops, rp.root.position);
        }
        // Victory check uses team-aware opponent count so a Duo wins as
        // long as their team still has at least one alive player even if
        // teammates are down.
        const aliveOpp = this.net.aliveOpponentCount();
        this.hud.setEnemiesRemaining(aliveOpp, this._totalOpponents);
        if (!this.player.dead && aliveOpp === 0 && !this._victoryShown) {
          this._victoryShown = true;
          setTimeout(() => this._showVictory(), 1200);
        }
      };

      // Mirror remote weapon drops: spawn a world pickup at the broadcast
      // location so the gun is visible and re-collectable by other players.
      this.net.onWeaponDropped = (msg) => {
        const def = WEAPON_DEFS[msg.weaponId];
        if (!def) return;
        const pos = new THREE.Vector3(msg.pos[0], msg.pos[1], msg.pos[2]);
        this.weapons.pickups.push(new WeaponPickup(
          this.scene, def, pos,
          { ammo: msg.ammo, reserve: msg.reserve },
        ));
      };

      this.net.onRemoteShoot = (msg) => {
        const orig = new THREE.Vector3(...msg.orig);
        const dir  = new THREE.Vector3(...msg.dir);
        // Pass the weapon def along so explosive shots (rocket, nuke) get
        // their proper bullet speed, range, and detonation visuals on the
        // receiving end — spectators included.
        const def = msg.weapon ? WEAPON_DEFS[msg.weapon] : null;
        this.projectiles.spawn(orig, dir, {
          speed:   def?.bulletSpeed ?? 180,
          damage:  0,
          faction: 'remote',
          range:   def?.range ?? 300,
          def,
        });
        // Protractor Beam fan visual — local damage isn't replicated for
        // shotgun-style weapons, but the cool laser blast should be visible
        // to everyone (spectators included) when a remote player fires it.
        if (msg.weapon === 'protractorBeam') {
          spawnProtractorBlast(this.scene, this.world, this.particles, orig, dir);
        }
        if (this.audio && msg.weapon) {
          const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
          this.audio.playAt(msg.weapon, orig, this.player.getPosition(), right);
        }
      };

      this.projectiles.onRemotePlayerHit = (targetId, damage, hitPos, headshot = false) => {
        this.net.sendHit(targetId, damage);
        this.hitMark.hit(false);
        this._lastHitTarget = targetId;
        // Remember the headshot flag so onRemoteDeath can tag the kill-feed
        // entry. Death messages arrive async over the wire, so the latest
        // bullet hit's flag is the right one to attribute to the kill.
        this._lastHitWasHeadshot = headshot;

        const rp = this.net.remotePlayers.get(targetId);
        if (rp) {
          rp.takeDamage(damage);
          const numPos = rp.getCenter().clone().add(new THREE.Vector3(0, 0.5, 0));
          this.dmgNums.show(numPos, damage, this.camera, this.canvas, headshot || damage >= 80);
          if (headshot) this.dmgNums.showHeadshot(numPos, this.camera, this.canvas);
        }
      };
    }

    this.projectiles.onExplosion = (pos, soundId) => {
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      this.audio?.playAt(soundId, pos, this.player.getPosition(), right);
    };

    this.projectiles.onEnemyHit = (pos, damage, enemy, justKilled, headshot) => {
      const numPos = pos.clone().add(new THREE.Vector3(0, 0.8, 0));
      this.dmgNums.show(numPos, damage, this.camera, this.canvas, headshot);
      if (justKilled) {
        this.dmgNums.showKill(numPos, this.camera, this.canvas);
        // Stamp the kill so the enemy-manager's onKill callback can flag
        // its kill-feed entry (and streak banner) as a headshot. Set on
        // the enemy object because onKill receives it next.
        if (enemy && headshot) enemy._killedByHeadshot = true;
      } else if (headshot) {
        // Non-fatal headshot still gets the floating tag for feedback.
        this.dmgNums.showHeadshot(numPos, this.camera, this.canvas);
      }
      this.hitMark.hit(justKilled);
    };

    // ── 8. Battle bus deploy / late-spectator ─────────────────────────
    // Match starts mid-air: ride the bus, jump, skydive, parachute in.
    // While deploy is active the loop skips normal player/enemy/storm ticks.
    // Late spectators skip deploy entirely — they're joining mid-round, so
    // we lock the local player out of gameplay and pop them into SpectatorController.
    this.storm?.update(0, this.player, false);
    if (this._lateSpectator) {
      this.deploy = null;
      // Lock the player out: dead state freezes physics + inputs and lets
      // SpectatorController take ownership of the camera.
      this.player.dead = true;
      if (this.player?.body) this.player.body.visible = false;
      // Spawn immediately so spectator has cameras to cycle to. The Game's
      // matchEnded handler reloads the page so we cleanly return to lobby.
      this.net.onMatchEnded = () => location.reload();
      // Defer one frame so the loading screen has time to fade.
      setTimeout(() => this._enterSpectator(), 250);
    } else {
      this.deploy = new DeployController(
        this.scene, this.world, this.player, this.camera, this._busPath
      );
      this.deploy.setParticles(this.particles);
    }

    // ── 9. Ready ──────────────────────────────────────────────────────
    step('Ready!', 100);
    await frame(); // let browser paint Ready! before the fade starts

    if (this._lobbyMusic) { this._lobbyMusic.pause(); this._lobbyMusic.currentTime = 0; }

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

    // Track hold-state of the E key — used by supply drops which require
    // the player to hold for OPEN_HOLD_TIME seconds.
    window.addEventListener('keyup', e => {
      if (e.code === 'KeyE') this._eHeld = false;
    });
    window.addEventListener('blur', () => { this._eHeld = false; });

    window.addEventListener('keydown', e => {
      if (!this.running) return;

      // Map is allowed during the bus/skydive deploy phase so the player can
      // study landing options. All other gameplay keys remain gated.
      if (this.deploy?.active) {
        if (e.code === 'KeyM') { this._toggleMap(); return; }
        return;
      }

      // ── Spectator key bindings (only when actively spectating) ──────
      // Cycles handle dead/disconnected targets internally via SpectatorController.
      if (this.spectator?.active) {
        if (e.code === 'KeyD' || e.code === 'ArrowRight') { this.spectator.next();     return; }
        if (e.code === 'KeyA' || e.code === 'ArrowLeft')  { this.spectator.previous(); return; }
        if (e.code === 'Escape') { location.reload(); return; }
        return; // swallow everything else — no inventory/build/etc. while spectating
      }

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
        // Mark E as held — supply drops poll this each frame.
        this._eHeld = true;

        // If near a (landed but unopened) supply drop, defer to the
        // hold-to-open mechanic and skip the instant pickup branch.
        if (this.supplyDrops?.getNearbyDrop(this.player)) return;

        const wp = this.weapons.getNearbyPickup();
        if (wp) {
          // Preserve the dropped weapon's ammo state on re-pickup.
          this.inventory.addWeapon(new WeaponInstance(wp.def, { ammo: wp.ammo, reserve: wp.reserve }));
          wp.collect();
          return;
        }
        // Ammo piles are auto-collected on proximity (see AmmoSystem.update).
        const def = this.pickups.tryCollect();
        if (def) {
          this.inventory.addConsumable(def);
          this.hud.showPickupMessage(def.label, def.color);
        }
      }

    });

    if (this.building) this._buildBuildHUD();
    this._buildInvPanel();

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.composer?.setSize(window.innerWidth, window.innerHeight);
      // Outline pass needs the new resolution so sample offsets stay 1px wide.
      if (this._outlinePass) {
        this._outlinePass.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
      }
    });
  }

  // ── Shooting ──────────────────────────────────────────────────────────────
  _tryShoot() {
    if (this.deploy?.active) { this._prevMouseDown = this.player.mouseDown; return; }
    if (this.spectator?.active) { this._prevMouseDown = this.player.mouseDown; return; }
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
    // Crouching steadies aim — tighter spread whether hip-firing or ADSing.
    const crouchMult = this.player.crouching ? 0.65 : 1.0;
    const spread = weapon.def.spread * adsMultiplier * moveMult * crouchMult;

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

    // Protractor Beam — also spawn the laser-fan + muzzle blast so the
    // player's shot looks identical to Ms. Franks'. The actual damage is
    // handled by the random-spread pellets above; this is pure visual.
    if (weapon.def.id === 'protractorBeam') {
      spawnProtractorBlast(this.scene, this.world, this.particles, origin, camDir);
    }

    // Local gunshot audio — suppressed weapons skip this entirely
    if (!weapon.def.silent) this.audio?.playLocal(weapon.def.id);

    // Broadcast shot to other players
    if (this.net) this.net.sendShoot(origin, camDir, weapon.def.id);

    const muzzlePos = origin.clone().addScaledVector(camDir, 1.2);
    if (weapon.def.flamethrower) {
      // Fire stream: orange tongue of flame, no muzzle flash, no recoil
      this.particles.spawnBurst(muzzlePos, { count: 6, color: 0xff5500, speed: 5, lifetime: 0.32, size: 0.22, gravity: -1 });
      this.particles.spawnBurst(muzzlePos, { count: 3, color: 0xffaa00, speed: 3, lifetime: 0.22, size: 0.14, gravity: -1 });
    } else if (weapon.def.silent) {
      // Suppressed: faint smoke puff, no flash, minimal camera disturbance
      this.particles.spawnBurst(muzzlePos, { count: 5, color: 0x999999, speed: 1.2, lifetime: 0.22, size: 0.09 });
      this.shake.shake(0.015);
      this.camera3P.addRecoil(0.006);
    } else {
      // Flash power scales with weapon weight (particle-effects-upgrade)
      const wid = weapon.def.id;
      const flashPow = wid === 'sniper' || wid === 'huntingRifle' ? 7
                     : wid === 'shotgun' || wid === 'rocketLauncher' || wid === 'grenadeLauncher' ? 5.5
                     : 3.5;
      this.muzzle.flash(muzzlePos, flashPow);
      this.particles.spawnBurst(muzzlePos, { count: 4, color: 0xffcc44, speed: 2.5, lifetime: 0.08, size: 0.1 });
      this.particles.spawnBurst(muzzlePos, { count: 5, color: 0xff8800, speed: 3, lifetime: 0.07, size: 0.12, gravity: 2 });
      const shakeAmt  = weapon.def.id === 'sniper' ? 0.18 : weapon.def.id === 'shotgun' ? 0.14 : 0.06;
      const recoilAmt = weapon.def.id === 'sniper' ? 0.045 : weapon.def.id === 'shotgun' ? 0.030
                      : weapon.def.id === 'ar'     ? 0.010 : 0.018;
      this.shake.shake(shakeAmt);
      this.camera3P.addRecoil(recoilAmt);
    }
  }

  // ── Storm phase announcements ─────────────────────────────────────────────
  _checkStormAnnouncement() {
    if (!this.storm || !this.hud) return;
    const info  = this.storm.getInfo();
    const key   = `${info.phase}_${info.state}`;
    const prev  = this._stormPrevKey;
    this._stormPrevKey = key;
    if (!prev || key === prev) return;   // first call or no change

    // Storm colors by phase (1-indexed)
    const phaseColors = ['', '#4477ff', '#9933ff', '#ff22bb', '#ff3300'];
    const color = phaseColors[Math.min(info.phase, phaseColors.length - 1)];

    if (info.state === 'pending') return;

    if (prev.endsWith('_pending') && info.state === 'waiting') {
      // Bus just landed everyone — first safe period begins
      this.hud.showStormAnnouncement(
        'STORM INCOMING',
        `Zone 1 closes in ${Math.ceil(info.timeLeft)}s`,
        '#4477ff',
      );
    } else if (info.state === 'shrinking') {
      this.hud.showStormAnnouncement(
        `ZONE ${info.phase} CLOSING`,
        'Move to the safe zone!',
        color,
      );
    } else if (info.state === 'waiting' && info.phase > 1) {
      this.hud.showStormAnnouncement(
        `ZONE ${info.phase}`,
        `Next close in ${Math.ceil(info.timeLeft)}s`,
        color,
      );
    } else if (info.state === 'done') {
      this.hud.showStormAnnouncement('FINAL ZONE', 'The circle will not shrink further', '#ff3300');
    }
  }

  // ── ADS ───────────────────────────────────────────────────────────────────
  _updateADS() {
    const weapDef   = this.inventory.getActive()?.def;
    const ads       = this.player.adsActive && !!weapDef;
    const scopeType = ads ? (weapDef?.hasScope ?? null) : null;
    this.camera3P.setADS(ads, scopeType);
    this.camera3P.setSprint(this.player._isSprinting && !ads);
    this.hud.setADS(ads, !!scopeType);
    this.player._scopeMultiplier = scopeType === 'sniper'  ? 0.25
                                 : scopeType === 'hunting' ? 0.35
                                 : ads ? 0.50 : 1.0;
  }

  // ── End screens ───────────────────────────────────────────────────────────
  _showDeathScreen(killerLabel) {
    const statsLabel = this.mode === 'multi'
      ? `Kills: ${this._playerKills}`
      : `Enemies remaining: ${this._totalEnemies - this._killCount}`;
    const killedByLine = killerLabel
      ? `<p class="killed-by">Eliminated by <strong>${killerLabel}</strong></p>`
      : '';

    // Spectator only makes sense in multiplayer when at least one other
    // player is still alive. In solo / zombie / final-kill cases we skip
    // straight to the lobby button.
    const canSpectate = this.mode === 'multi'
      && this.net
      && this.net.aliveRemoteCount() > 0;

    const el = document.createElement('div');
    el.id = 'death-screen';
    el.innerHTML = `<div class="end-content">
      <div class="end-icon">✕</div>
      <h1>ELIMINATED</h1>
      ${killedByLine}
      <p>${statsLabel}</p>
      <div class="end-buttons">
        ${canSpectate ? '<button id="btn-spectate">Spectate</button>' : ''}
        <button id="btn-lobby">Return to Lobby</button>
      </div>
    </div>`;
    document.body.appendChild(el);

    el.querySelector('#btn-lobby').addEventListener('click', () => {
      location.reload();
    });
    if (canSpectate) {
      el.querySelector('#btn-spectate').addEventListener('click', () => {
        el.remove();
        this._enterSpectator();
      });
    }
  }

  // ── Spectator entry / exit ────────────────────────────────────────────────
  _enterSpectator() {
    if (this.spectator?.active) return;

    // The local player mesh is left visible — other clients see our dead
    // body too (via their RemotePlayer.die()), so keeping it visible
    // locally matches what the rest of the lobby observes.

    this.spectator = new SpectatorController({
      camera: this.camera,
      net:    this.net,
      onMatchOver: () => this._showSpectatorMatchOver(),
    });
    this.spectator.start();

    // Re-acquire pointer lock so mouse stays captured for any future input.
    if (!document.pointerLockElement) this.canvas.requestPointerLock();
  }

  // Called by SpectatorController when no alive targets remain (last player
  // died or disconnected). Shown only once per match.
  _showSpectatorMatchOver() {
    if (this._matchOverShown) return;
    this._matchOverShown = true;
    // Server resets gameActive so late joiners waiting in lobby can play.
    this.net?.sendMatchEnd();

    // Tear down the spectator HUD so it doesn't overlap the prompt.
    if (this.spectator) { this.spectator.stop(); }

    const el = document.createElement('div');
    el.id = 'match-over-screen';
    el.innerHTML = `<div class="end-content">
      <div class="end-icon">⚑</div>
      <h1>MATCH OVER</h1>
      <p>Kills: ${this._playerKills}</p>
      <div class="end-buttons">
        <button id="btn-lobby-mo">Return to Lobby</button>
      </div>
    </div>`;
    document.body.appendChild(el);
    el.querySelector('#btn-lobby-mo').addEventListener('click', () => location.reload());
  }

  _showVictory() {
    // Inform the server the match is over so the lobby reopens for any
    // late joiners who connected during the round.
    this.net?.sendMatchEnd();
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

    // ── Battle-bus flight path (only while still deploying) ────────────────
    // Drawn early so storm / POI labels render over it. After deploy ends the
    // path is no longer relevant and is omitted entirely.
    if (this.deploy?.active) {
      const a = this.deploy.getBusStart();
      const b = this.deploy.getBusEnd();
      if (a && b) {
        const pa = toCanvas(a.x, a.z);
        const pb = toCanvas(b.x, b.z);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth   = 6;
        ctx.setLineDash([14, 10]);
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        // Solid outline core for legibility
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255,200,80,0.95)';
        ctx.lineWidth   = 2;
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        // Arrowhead at the END of the path indicating bus direction
        const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
        const ah = 12;
        ctx.fillStyle = 'rgba(255,200,80,0.95)';
        ctx.beginPath();
        ctx.moveTo(pb.x, pb.y);
        ctx.lineTo(pb.x - Math.cos(ang - 0.4) * ah, pb.y - Math.sin(ang - 0.4) * ah);
        ctx.lineTo(pb.x - Math.cos(ang + 0.4) * ah, pb.y - Math.sin(ang + 0.4) * ah);
        ctx.closePath(); ctx.fill();
        // "BUS" label near the midpoint
        const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
        ctx.font = 'bold 13px "Segoe UI", Arial';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,200,80,1)';
        ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.lineJoin = 'round';
        ctx.strokeText('BATTLE BUS', mx, my - 10);
        ctx.fillText('BATTLE BUS', mx, my - 10);
        ctx.restore();
      }
    }

    // ── Storm circle (hidden while the storm is still pending) ─────────────
    if (this.storm) {
      const info = this.storm.getInfo();
      if (info.state === 'pending') {
        ctx.font = 'bold 12px "Segoe UI", Arial';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(180,140,255,0.95)';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        const msg = `Storm activates in ${info.timeLeft}s`;
        ctx.strokeText(msg, W / 2, 18);
        ctx.fillText(msg, W / 2, 18);
      } else {
        const sr = (info.radius / S) * W;
        const c  = toCanvas(info.center.x, info.center.z);

        // Tinted fill outside storm wall
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, H);
        ctx.arc(c.x, c.y, sr, 0, Math.PI * 2, true); // counter-clockwise = subtract
        ctx.fillStyle = 'rgba(60,20,180,0.32)';
        ctx.fill('evenodd');
        ctx.restore();

        // Storm wall ring
        ctx.strokeStyle = 'rgba(110,80,255,0.95)';
        ctx.lineWidth   = 3;
        ctx.beginPath(); ctx.arc(c.x, c.y, sr, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(180,140,255,0.4)';
        ctx.lineWidth   = 7;
        ctx.beginPath(); ctx.arc(c.x, c.y, sr, 0, Math.PI * 2); ctx.stroke();

        // Phase label above storm ring
        const stateStr = info.state === 'waiting'   ? `Phase ${info.phase} — moves in ${info.timeLeft}s`
                       : info.state === 'shrinking'  ? `Phase ${info.phase} — closing ${info.timeLeft}s`
                       :                               'Final Zone';
        ctx.font = 'bold 12px "Segoe UI", Arial';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(180,140,255,0.95)';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeText(stateStr, W / 2, 18);
        ctx.fillText(stateStr, W / 2, 18);
      }
    }

    // ── POI labels ───────────────────────────────────────────────────────────
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

    // ── Enemy dots ───────────────────────────────────────────────────────────
    const activeEnemyList = this.zombieWaves?.enemies ?? this.enemies?.enemies ?? [];
    for (const e of activeEnemyList) {
      if (e.dead || !e.root) continue;
      const { x, y } = toCanvas(e.root.position.x, e.root.position.z);
      ctx.fillStyle = '#ef4444';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    // ── Weapon pickup dots ───────────────────────────────────────────────────
    const weaponPickups = this.hud._weaponSystem?.pickups ?? [];
    for (const p of weaponPickups) {
      if (p.collected) continue;
      const { x, y } = toCanvas(p.root.position.x, p.root.position.z);
      const col = '#' + p.def.rarityColor.toString(16).padStart(6, '0');
      ctx.fillStyle = col;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    // ── Ammo pile markers ────────────────────────────────────────────────────
    if (this.ammo) {
      for (const p of this.ammo.pickups) {
        if (p.collected) continue;
        const { x, y } = toCanvas(p.root.position.x, p.root.position.z);
        const visual = AMMO_VISUAL[p.type];
        const col = visual ? '#' + visual.color.toString(16).padStart(6, '0') : '#ffffff';
        ctx.fillStyle = col;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        // Tiny diamond, smaller than weapons to avoid clutter.
        ctx.beginPath();
        ctx.moveTo(x, y - 3); ctx.lineTo(x + 3, y);
        ctx.lineTo(x, y + 3); ctx.lineTo(x - 3, y);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }

    // ── Supply drop markers ──────────────────────────────────────────────────
    if (this.supplyDrops) {
      for (const d of this.supplyDrops.getDrops()) {
        const { x, y } = toCanvas(d.x, d.z);
        ctx.fillStyle   = '#ffaa00';
        ctx.strokeStyle = '#000';
        ctx.lineWidth   = 1.5;
        // Hollow square + cross for legibility against POI text/pickups.
        ctx.beginPath();
        ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y - 5);
        ctx.lineTo(x + 5, y + 5); ctx.lineTo(x - 5, y + 5);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3);
        ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y);
        ctx.stroke();
      }
    }

    // ── Health / shield pickup dots ──────────────────────────────────────────
    const healPickups = this.hud._pickupManager?.pickups ?? [];
    for (const p of healPickups) {
      if (p.collected) continue;
      const { x, y } = toCanvas(p.root.position.x, p.root.position.z);
      ctx.fillStyle = p.def.healHp > 0 ? '#22ee66' : '#44aaff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    // ── Remote player markers (multiplayer) ──────────────────────────────────
    if (this.net) {
      for (const [, rp] of this.net.getRemotePlayers()) {
        if (rp.dead) continue;
        const rpos = rp.root.position;
        const { x, y } = toCanvas(rpos.x, rpos.z);
        // Teammates render green, opponents orange — same palette as the
        // minimap and 3D nametag.
        const col = rp.isTeammate ? '#4ade80' : '#ff8800';
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-rp.root.rotation.y);
        ctx.fillStyle   = col;
        ctx.strokeStyle = '#000';
        ctx.lineWidth   = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, -7); ctx.lineTo(4, 5); ctx.lineTo(0, 2); ctx.lineTo(-4, 5);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.restore();
        // Name label
        ctx.font = '9px "Segoe UI", Arial';
        ctx.textAlign = 'center';
        ctx.fillStyle = col;
        ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
        ctx.strokeText(rp.name, x, y - 10);
        ctx.fillText(rp.name, x, y - 10);
      }
    }

    // ── Player arrow (centred on own position) ───────────────────────────────
    const pp  = this.player.getPosition();
    const { x: px, y: py } = toCanvas(pp.x, pp.z);
    const yaw = this.player.getYaw();

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-yaw);
    ctx.fillStyle   = '#00ff88';
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -11); ctx.lineTo(6, 7); ctx.lineTo(0, 4); ctx.lineTo(-6, 7);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // Dot at player feet
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // ── Legend ───────────────────────────────────────────────────────────────
    const legendItems = [
      { color: '#00ff88', label: 'You' },
      { color: '#ff8800', label: 'Ally' },
      { color: '#ef4444', label: 'Enemy' },
      { color: '#ffffff', label: 'Weapon' },
      { color: '#22ee66', label: 'Medkit' },
    ];
    ctx.font = '10px "Segoe UI", Arial';
    ctx.textAlign = 'left';
    const lx = 8, ly = H - 8 - legendItems.length * 14;
    legendItems.forEach(({ color, label }, i) => {
      const iy = ly + i * 14;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(lx - 2, iy - 9, 70, 12);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(lx + 4, iy - 3, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e0e0e0';
      ctx.fillText(label, lx + 12, iy);
    });
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
          detail   = item.reloading ? 'Reloading…' : `${item.ammo} / ${item.displayReserve}`;
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
          // Route through dropSlot so weapons spawn a re-collectable pickup
          // (and consumables get discarded as before).
          this.inventory.dropSlot(si);
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

  // ── Item drop ────────────────────────────────────────────────────────────
  // Spawns a world pickup carrying the dropped weapon's ammo state, placed
  // ~1.2m in front of the player (forward of the camera yaw) so it doesn't
  // get stuck inside the body. Falls back to feet position if terrain is
  // unavailable at the offset spot.
  _spawnDroppedWeapon(inst) {
    const pos = this._dropPositionForward();
    this.weapons.pickups.push(new WeaponPickup(
      this.scene, inst.def, pos,
      { ammo: inst.ammo, reserve: inst.reserve },
    ));
    // Replicate so other players (and spectators) see the dropped gun.
    this.net?.sendWeaponDropped(inst.def.id, pos, inst.ammo, inst.reserve);
  }

  // Consumable dropped on the floor — preserve stack count by spawning one
  // pickup per unit. Small random angular jitter prevents them from
  // overlapping perfectly.
  _spawnDroppedConsumable(item) {
    const count = item.count ?? 1;
    const base  = this._dropPositionForward();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const r = 0.3 + Math.random() * 0.3;
      const pos = new THREE.Vector3(
        base.x + Math.cos(a) * r,
        base.y,
        base.z + Math.sin(a) * r,
      );
      this.pickups.spawnAt(item.def, pos);
    }
  }

  // ── Death drops ─────────────────────────────────────────────────────────
  // Serialize the local player's inventory into a network-safe drop array.
  // Skips empty slots + undroppable weapons (phaseRifle). Each weapon carries
  // its loaded mag + reserve so the pickup is exactly equivalent.
  _collectDeathDrops() {
    const drops = [];
    if (!this.inventory) return drops;
    for (const s of this.inventory.slots) {
      if (!s) continue;
      if (s.isConsumable) {
        drops.push({ kind: 'consumable', id: s.def.id, count: s.count ?? 1 });
      } else if (!s.def.undroppable) {
        drops.push({
          kind: 'weapon', id: s.def.id,
          ammo: s.ammo, reserve: s.reserve ?? null,
        });
      }
    }
    return drops;
  }

  // Spawn pickups for each entry in `drops` arranged in a ring around
  // `centerPos`. Consumables expand into one pickup per stack count so the
  // entire stack is recoverable. Items land on the terrain so they're never
  // half-buried regardless of where the body fell.
  _spawnDeathDrops(drops, centerPos) {
    if (!drops?.length) return;
    const stamps = [];
    for (const d of drops) {
      if (d.kind === 'consumable') {
        for (let i = 0; i < (d.count ?? 1); i++) stamps.push(d);
      } else {
        stamps.push(d);
      }
    }
    const ringR = stamps.length === 1 ? 0.6 : 1.6;
    for (let i = 0; i < stamps.length; i++) {
      const a = (i / stamps.length) * Math.PI * 2;
      const x = centerPos.x + Math.cos(a) * ringR;
      const z = centerPos.z + Math.sin(a) * ringR;
      const groundY = this.world.getTerrainHeight(x, z);
      const baseY   = groundY >= 0 ? groundY : centerPos.y;
      const pos = new THREE.Vector3(x, baseY + 0.15, z);
      const d = stamps[i];
      if (d.kind === 'weapon') {
        const def = WEAPON_DEFS[d.id];
        if (!def) continue;
        this.weapons.pickups.push(new WeaponPickup(
          this.scene, def, pos,
          { ammo: d.ammo, reserve: d.reserve },
        ));
      } else {
        const cdef = CONSUMABLE_DEFS?.[d.id];
        if (cdef) this.pickups.spawnAt(cdef, pos);
      }
    }
  }

  // Reusable: world position ~1.2m in front of the player at terrain height.
  _dropPositionForward() {
    const pp  = this.player.getPosition();
    const yaw = this.player.getYaw();
    const fwdX = pp.x - Math.sin(yaw) * 1.2;
    const fwdZ = pp.z - Math.cos(yaw) * 1.2;
    const groundY = this.world.getTerrainHeight(fwdX, fwdZ);
    const baseY = groundY >= 0 ? groundY : pp.y;
    return new THREE.Vector3(fwdX, baseY + 0.15, fwdZ);
  }

  // ── Supply Drop HUD ───────────────────────────────────────────────────────
  _ensureSupplyHud() {
    if (this._supplyHudEl) return;
    const el = document.createElement('div');
    el.id = 'supply-hud';
    el.innerHTML = `
      <div class="sd-label">Hold <kbd>E</kbd> to open Supply Drop</div>
      <div class="sd-bar"><div class="sd-bar-fill" id="sd-bar-fill"></div></div>
    `;
    el.style.display = 'none';
    document.getElementById('hud').appendChild(el);
    this._supplyHudEl = el;
    this._supplyHudFill = el.querySelector('#sd-bar-fill');
  }

  _updateSupplyHud() {
    this._ensureSupplyHud();
    if (!this.supplyDrops) return;
    const drop = this.supplyDrops.getNearbyDrop(this.player);
    if (!drop) {
      this._supplyHudEl.style.display = 'none';
      return;
    }
    this._supplyHudEl.style.display = 'flex';
    const pct = Math.max(0, Math.min(1, drop.progressFraction));
    this._supplyHudFill.style.width = (pct * 100).toFixed(1) + '%';
  }

  /**
   * One render call. Bumps the grain pass time so the noise animates.
   * Falls back to a direct renderer.render if the composer wasn't set up
   * (defensive — should never happen in normal startup).
   */
  _render(dt = 0.016) {
    // Adaptive resolution: nudge composer pixel ratio down if frame times
    // spike, back up when they recover. No-op when dynamicResolution=false.
    Graphics.tickAdaptiveResolution(dt, this.composer, this.renderer);
    if (this.composer) {
      if (this._grainPass) this._grainPass.uniforms.uTime.value += 0.016;
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  // ── Game Loop ─────────────────────────────────────────────────────────────
  _startLoop() {
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      if (!this.running) return;

      // ── Deploy phase: battle bus / skydive / parachute ────────────
      // The deploy controller owns the player + camera; enemies, storm
      // and building stay frozen until everyone has landed.
      if (this.deploy && this.deploy.active) {
        this.deploy.update(dt);
        this.storm?.update(dt, this.player, false); // clock advances, no damage
        this.hud.update(dt);                        // keep storm timer / minimap live
        if (this.net) {
          this.net.update(dt, this.camera, this.canvas);
          this._netTimer -= dt;
          if (this._netTimer <= 0) {
            this._netTimer = 0.033;
            // Deploy phase: no weapon yet, send health for accurate HP bars.
            this.net.sendState(this.player.getPosition(), this.player.getYaw(), this.deploy.getPhaseInt(), null, null, null, this.player.health, false);
          }
        }
        this.particles.update(dt);
        this.shake.update(dt);
        // Big map (M) stays interactive during deploy so the player can
        // pick a landing spot — repaint each frame so the player arrow
        // and bus path animate live.
        if (this._mapOpen) this._drawMap();
        this._render(dt);
        return;
      }

      // ── Spectator phase: local player is dead and watching others ─────
      // World keeps simulating (storm, projectiles, remote players) so the
      // spectator sees an accurate live view. Local player physics is
      // already frozen via player.dead, so we just skip its update entirely.
      if (this.spectator?.active) {
        this.spectator.update(dt);
        if (this.storm) this.storm.update(dt, this.player);     // damage call is a no-op once dead
        if (this.net)   this.net.update(dt, this.camera, this.canvas);
        // Boss keeps animating + receiving state broadcasts while spectating.
        if (this.bossManager) this.bossManager.update(dt, this.player, this.camera);
        // Bullets fired by remaining players are still in flight; keep them moving.
        const remotes_s = this.net ? this.net.getRemotePlayers() : null;
        this.projectiles.update(dt, this.player, null, this.particles, remotes_s);
        this.particles.update(dt);
        tickProtractorLasers(dt);
        this.shake.update(dt);
        this.hud.update(dt);
        // Still broadcast our "spectating" phase so other clients can hide our model.
        if (this.net) {
          this._netTimer -= dt;
          if (this._netTimer <= 0) {
            this._netTimer = 0.1;
            this.net.sendState(this.player.getPosition(), this.player.getYaw(), PHASE_SPECTATING);
          }
        }
        this._render(dt);
        return;
      }

      // Multiplayer instant-victory: a host who started alone (or whose
      // opponents all disconnected before any kill registered) has nobody
      // left to fight. onRemoteDeath only fires on actual deaths, so this
      // covers the "no opponents to begin with" path. Fires once.
      if (this.mode === 'multi'
          && !this._victoryShown
          && !this.player.dead
          && this.net?.gameActive
          && this.net.aliveOpponentCount() === 0) {
        this._victoryShown = true;
        setTimeout(() => this._showVictory(), 1200);
      }

      this._tryShoot();
      this._updateADS();

      this.player.update(dt);
      this.camera3P.update(dt, this.shake);
      this.building?.update(this.camera);
      this.inventory.update(dt);
      this.weapons.update(dt, this.player, this.camera);
      this.pickups.update(dt, this.player);
      // Ammo auto-pickup on proximity — walking through a pile is enough.
      this.ammo?.update(dt, this.player, this.inventory, (pickup) => {
        const v = AMMO_VISUAL[pickup.type];
        this.hud.showPickupMessage(
          `+${pickup.amount} ${v?.label ?? pickup.type}`,
          v?.color ?? 0xffffff,
        );
      });

      const remotes = this.net ? this.net.getRemotePlayers() : null;
      const activeEnemies = this.zombieWaves ?? this.enemies;
      this.projectiles.update(dt, this.player, activeEnemies, this.particles, remotes);

      if (this.enemies)     this.enemies.update(dt, this.player, this.camera);
      if (this.bossManager) this.bossManager.update(dt, this.player, this.camera);
      if (this.zombieWaves) {
        this.zombieWaves.update(dt, this.player, this.camera);
        // Hide inter-wave countdown while fighting
        if (this._zombieEl) {
          this._zombieEl.style.display =
            this.zombieWaves.state === 'intermission' ? 'block' : 'none';
        }
      }
      if (this.storm) { this.storm.update(dt, this.player); this._checkStormAnnouncement(); }
      // Sun shadow camera tracks the player so the tight ortho frustum
      // stays useful far from world origin. Cheap — just a few writes.
      const pp = this.player.getPosition();
      this.world.updateShadowFollow?.(pp.x, pp.z);
      if (this.supplyDrops) {
        this.supplyDrops.update(dt, this.player, this._eHeld);
        this._updateSupplyHud();
      }
      this.particles.update(dt);
      tickProtractorLasers(dt);
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
          this._netTimer = 0.033;
          // Include weapon + ammo so spectators can read live ammo counts,
          // plus authoritative health so other clients render accurate HP bars.
          const a = this.inventory.getActive();
          const weaponId = (a && !a.isConsumable) ? a.def.id : null;
          const ammo     = (a && !a.isConsumable) ? a.ammo : null;
          const reserve  = (a && !a.isConsumable) ? a.displayReserve : null;
          this.net.sendState(this.player.getPosition(), this.player.getYaw(), 3, weaponId, ammo, reserve, this.player.health, this.player.crouching);
        }
      }

      if (this._mapOpen) this._drawMap();

      this._render(dt);
    };
    loop();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

new Menu();
