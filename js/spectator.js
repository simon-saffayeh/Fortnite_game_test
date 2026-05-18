import * as THREE from 'three';

// Third-person follow-cam tuning. Kept here as named constants so the camera
// feel can be adjusted without hunting through the class body.
const FOLLOW_DIST   = 6.5;    // metres behind the spectated target
const FOLLOW_HEIGHT = 2.6;    // metres above the target's head
const LOOK_HEIGHT   = 1.6;    // height of the look-at point (chest level)
const SMOOTH_K      = 14;     // exponential smoothing rate; higher = snappier

// Player network phase numbers — keep in sync with multiplayer.js / main.js.
// Phase 4 means "this client is dead and watching"; other clients should not
// render the corresponding RemotePlayer model.
export const PHASE_SPECTATING = 4;

/**
 * SpectatorController
 *
 * Owns all behavior for the local player after death:
 *   - Hides the local player and lifts physics control of the camera.
 *   - Picks the next alive RemotePlayer to follow, third-person.
 *   - Cycles forward/back through alive players on demand.
 *   - Self-validates each frame: if the spectated target dies or
 *     disconnects, it auto-advances. If no alive targets remain, it fires
 *     `onMatchOver` once so the host Game can switch to the post-match screen.
 *
 * Designed to be inert until `start()` is called and re-entrant if `stop()`
 * happens before the next start.
 */
export class SpectatorController {
  /**
   * @param {Object} cfg
   * @param {THREE.PerspectiveCamera} cfg.camera   - the world camera
   * @param {import('./multiplayer.js').NetworkManager} cfg.net
   * @param {() => void} [cfg.onMatchOver]         - fired once when no alive targets remain
   */
  constructor({ camera, net, onMatchOver }) {
    this.camera      = camera;
    this.net         = net;
    this.onMatchOver = onMatchOver ?? null;

    this.active     = false;
    this._targetId  = null;     // id of currently spectated RemotePlayer
    this._hudEl     = null;     // DOM node, lazily built on start()
    this._smoothPos = new THREE.Vector3();
    this._smoothLook= new THREE.Vector3();
    this._initSmooth = false;   // first-frame teleport instead of easing in
    this._matchOverFired = false;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start() {
    if (this.active) return;
    this.active = true;
    this._initSmooth = false;
    this._matchOverFired = false;
    this._buildHud();
    this._pickInitialTarget();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    if (this._hudEl) { this._hudEl.remove(); this._hudEl = null; }
  }

  // ── Target selection ────────────────────────────────────────────────────

  /**
   * Returns a stable-ordered list of alive RemotePlayer ids. Stable order is
   * important so cycling feels predictable — Map iteration order in JS
   * already preserves insertion order, which matches the order players
   * joined the lobby.
   */
  _aliveIds() {
    const ids = [];
    for (const rp of this.net.remotePlayers.values()) {
      if (!rp.dead) ids.push(rp.id);
    }
    return ids;
  }

  _pickInitialTarget() {
    const ids = this._aliveIds();
    this._targetId = ids[0] ?? null;
    this._initSmooth = false;
    this._refreshHud();
  }

  /** Cycle to next (+1) or previous (-1). Returns true if a target was found. */
  _cycle(dir) {
    const ids = this._aliveIds();
    if (ids.length === 0) {
      this._targetId = null;
      this._refreshHud();
      return false;
    }
    const curIdx = ids.indexOf(this._targetId);
    // If current target died/disconnected mid-cycle, indexOf returns -1; in
    // that case advancing by `dir` from -1 lands on 0 for +1 and ids.length-1
    // for -1, which is the intuitive behavior.
    const nextIdx = curIdx === -1
      ? (dir > 0 ? 0 : ids.length - 1)
      : (curIdx + dir + ids.length) % ids.length;
    this._targetId = ids[nextIdx];
    this._initSmooth = false;   // snap camera to new target on switch
    this._refreshHud();
    return true;
  }

  next()     { return this._cycle(+1); }
  previous() { return this._cycle(-1); }

  /** Currently spectated RemotePlayer or null. */
  getTarget() {
    if (this._targetId == null) return null;
    return this.net.remotePlayers.get(this._targetId) ?? null;
  }

  // ── Per-frame update ────────────────────────────────────────────────────

  /**
   * @param {number} dt seconds since last frame
   */
  update(dt) {
    if (!this.active) return;

    // Validate current target. If it died or was removed (disconnect), try
    // to advance. If no targets remain, signal match-over once and freeze
    // the camera where it is so the screen doesn't flicker.
    let rp = this.getTarget();
    if (!rp || rp.dead) {
      const found = this.next();
      if (!found) { this._signalMatchOver(); return; }
      rp = this.getTarget();
      if (!rp) { this._signalMatchOver(); return; }
    }

    this._positionCamera(rp, dt);
    this._refreshLoadout();   // ammo readout updates as the target fires/reloads
  }

  _positionCamera(rp, dt) {
    // Target's head/torso center for the look-at point.
    const head = rp.getCenter();
    const yaw  = rp.root.rotation.y;

    // Position camera behind the target relative to its yaw. With yaw=0 the
    // RemotePlayer model faces -Z, so the camera sits at +Z behind it.
    const desiredPos = new THREE.Vector3(
      head.x + Math.sin(yaw) * FOLLOW_DIST,
      head.y + FOLLOW_HEIGHT,
      head.z + Math.cos(yaw) * FOLLOW_DIST,
    );
    // Look at the target's chest (between feet and head) so a typical viewer
    // sees them centered with some world beneath them.
    const desiredLook = new THREE.Vector3(head.x, rp.root.position.y + LOOK_HEIGHT, head.z);

    if (!this._initSmooth) {
      this._smoothPos.copy(desiredPos);
      this._smoothLook.copy(desiredLook);
      this._initSmooth = true;
    } else {
      // Framerate-independent exponential smoothing.
      const a = 1 - Math.exp(-SMOOTH_K * dt);
      this._smoothPos.lerp(desiredPos, a);
      this._smoothLook.lerp(desiredLook, a);
    }

    this.camera.position.copy(this._smoothPos);
    this.camera.lookAt(this._smoothLook);
  }

  _signalMatchOver() {
    if (this._matchOverFired) return;
    this._matchOverFired = true;
    if (this.onMatchOver) this.onMatchOver();
  }

  // ── HUD ─────────────────────────────────────────────────────────────────

  _buildHud() {
    if (this._hudEl) return;
    const el = document.createElement('div');
    el.id = 'spectator-hud';
    el.innerHTML = `
      <div class="spec-banner">
        <span class="spec-label">SPECTATING</span>
        <span class="spec-name" id="spec-name">—</span>
        <span class="spec-loadout" id="spec-loadout"></span>
      </div>
      <div class="spec-controls">
        <span><kbd>A</kbd> / <kbd>&larr;</kbd> Prev</span>
        <span><kbd>D</kbd> / <kbd>&rarr;</kbd> Next</span>
        <span><kbd>Esc</kbd> Lobby</span>
      </div>
    `;
    document.body.appendChild(el);
    this._hudEl = el;
    this._refreshHud();
  }

  _refreshHud() {
    if (!this._hudEl) return;
    const nameEl    = this._hudEl.querySelector('#spec-name');
    const loadoutEl = this._hudEl.querySelector('#spec-loadout');
    if (!nameEl) return;
    if (this._targetId == null) {
      nameEl.textContent = 'no targets';
      nameEl.classList.add('empty');
      if (loadoutEl) loadoutEl.textContent = '';
      return;
    }
    const info = this.net.players.get(this._targetId);
    nameEl.textContent = info?.name ?? `Player ${this._targetId}`;
    nameEl.classList.remove('empty');
    this._refreshLoadout();
  }

  /**
   * Per-frame ammo readout for the spectated target. Pulled from the
   * RemotePlayer's most recent `state` message (weaponId / ammo / reserve).
   * Falls back to an empty string when the target isn't holding a weapon.
   */
  _refreshLoadout() {
    if (!this._hudEl) return;
    const loadoutEl = this._hudEl.querySelector('#spec-loadout');
    if (!loadoutEl) return;
    const rp = this.getTarget();
    if (!rp || !rp.weaponId) { loadoutEl.textContent = ''; return; }
    const weaponName = WEAPON_NAMES[rp.weaponId] ?? rp.weaponId;
    const ammo    = rp.ammo    ?? '?';
    const reserve = rp.reserve ?? '?';
    loadoutEl.textContent = `${weaponName} · ${ammo} / ${reserve}`;
  }
}

// Display names for weapon ids. Keep in sync with weapons.js WEAPON_DEFS.
// (Imported as a constant rather than pulling WEAPON_DEFS to keep the
// spectator module light on imports.)
const WEAPON_NAMES = {
  pistol: 'Pistol', smg: 'SMG', ar: 'Assault Rifle', shotgun: 'Shotgun',
  sniper: 'Sniper', minigun: 'Minigun', heavyAR: 'Heavy AR',
  dualPistols: 'Dual Pistols', rocketLauncher: 'Rocket Launcher',
  bombLauncher: 'Nuke Launcher', handCannon: 'Hand Cannon',
  crossbow: 'Crossbow', huntingRifle: 'Hunting Rifle', phaseRifle: 'Phase Rifle',
};
