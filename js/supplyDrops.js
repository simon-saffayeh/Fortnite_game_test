import * as THREE from 'three';
import { WEAPON_DEFS, WeaponPickup } from './weapons.js';
import { paintedPBR } from './materials.js';

// ── Tunables ──────────────────────────────────────────────────────────────
// Times are seconds, distances are world metres.
const SPAWN_HEIGHT       = 90;     // metres above terrain at spawn
const DESCENT_SPEED      = 5.0;    // descent rate while still in the air
const LAND_OFFSET        = 1.6;    // basket bottom rests this far above ground
const OPEN_HOLD_TIME     = 2.0;    // seconds of held E required to open
const OPEN_RADIUS        = 3.5;    // proximity required to open
const FIRST_SPAWN_DELAY  = 60;     // seconds after match start before first drop
const SPAWN_INTERVAL     = 45;     // seconds between subsequent drops
const STORM_INSET        = 0.85;   // spawn within this fraction of storm radius
const MARKER_PULSE_HZ    = 1.4;
const STILLNESS_GRACE    = 0.15;   // small grace so micro-input twitches don't reset

// Loot tables: only mythic / legendary weapons land in drops; heals are the
// strong tier (no small medkits or shield-sips).
const DROP_WEAPONS = ['sniper', 'rocketLauncher', 'minigun', 'bombLauncher', 'phaseRifle'];
const DROP_HEALS   = ['bigmed', 'bigshield', 'stimpack'];

// Drop lifecycle states. Kept as integer enums for cheap comparisons.
const DESCENDING = 0;
const LANDED     = 1;
const OPENING    = 2;
const OPENED     = 3;

// ── Single supply drop entity ────────────────────────────────────────────
class SupplyDrop {
  /**
   * @param {THREE.Scene} scene
   * @param {number} x       world X of landing target
   * @param {number} z       world Z of landing target
   * @param {number} groundY terrain height at (x,z) — drop will rest here
   */
  constructor(scene, x, z, groundY) {
    this.scene   = scene;
    this.x       = x;
    this.z       = z;
    this.groundY = groundY;
    this.state   = DESCENDING;

    // Hold-to-open progress (0..OPEN_HOLD_TIME).
    this.openProgress = 0;
    this._dead = false;

    // Y is animated each frame; world Y of the basket bottom.
    this._currentY = groundY + SPAWN_HEIGHT;
    this._tBob = Math.random() * Math.PI * 2;
    this._stillTimer = 0;   // time since last movement input (for grace window)

    this._buildBalloon();
    this._buildMarker();
    this._updateTransforms();
  }

  // ── Visuals ────────────────────────────────────────────────────────────

  _buildBalloon() {
    const g = new THREE.Group();

    // Balloon canopy — hemispherical, gold/red striped via material groups.
    const balloonGeo = new THREE.SphereGeometry(2.8, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.65);
    balloonGeo.computeVertexNormals();
    const stripeA = paintedPBR(0xd62828, { rough: 0.85 });   // fabric-like canopy
    const stripeB = paintedPBR(0xfcbf49, { rough: 0.85 });
    // Assign alternating material indices per face to get stripes.
    // (Cheap: just by face index modulo so we avoid a custom shader.)
    const indexCount = balloonGeo.index.count;
    balloonGeo.clearGroups();
    const stripes = 8;
    const per = Math.floor(indexCount / stripes);
    for (let i = 0; i < stripes; i++) {
      const start = i * per;
      const count = (i === stripes - 1) ? indexCount - start : per;
      balloonGeo.addGroup(start, count, i % 2);
    }
    const balloon = new THREE.Mesh(balloonGeo, [stripeA, stripeB]);
    balloon.position.y = 3.5;
    balloon.castShadow = true;
    g.add(balloon);

    // Cap / vent at the top of the balloon.
    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.5, 0.4, 10),
      paintedPBR(0x3a2a18, { rough: 0.85 }),
    );
    top.position.y = 6.4;
    g.add(top);

    // Basket / crate — the loot container.
    const basket = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.4, 2.2),
      paintedPBR(0x6b4423, { rough: 0.78 }),
    );
    basket.position.y = 0.7;
    basket.castShadow = true;
    g.add(basket);

    // Crate banding (lighter wood strips for detail).
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(2.3, 0.18, 2.3),
      paintedPBR(0x8b5a2b, { rough: 0.75 }),
    );
    band.position.y = 0.4; g.add(band);
    const band2 = band.clone(); band2.position.y = 1.0; g.add(band2);

    // Emissive lid trim signaling rarity.
    const lid = new THREE.Mesh(
      new THREE.BoxGeometry(2.3, 0.12, 2.3),
      paintedPBR(0xffaa00, { emissive: 0xffaa00, emissiveIntensity: 0.6, metal: 0.6, rough: 0.4 }),
    );
    lid.position.y = 1.42;
    g.add(lid);
    this._lid = lid;

    // Ropes from balloon rim to basket corners.
    const ropeMat = new THREE.LineBasicMaterial({ color: 0x222222 });
    const balloonRim = 3.5;       // y of balloon equator-ish line
    const basketTop  = 1.4;
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const pts = [
        new THREE.Vector3(dx * 1.1, basketTop, dz * 1.1),
        new THREE.Vector3(dx * 2.0, balloonRim, dz * 2.0),
      ];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      g.add(new THREE.Line(geo, ropeMat));
    }

    // Flame puff inside the balloon, gently emissive.
    const flame = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 8, 6),
      paintedPBR(0xffaa44, { emissive: 0xff6622, emissiveIntensity: 1.2 }),
    );
    flame.position.y = 2.1;
    g.add(flame);
    this._flame = flame;

    this.scene.add(g);
    this.root = g;
  }

  _buildMarker() {
    // Glowing ring on the ground at the landing spot.
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(3.2, 0.18, 8, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffaa00, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    g.add(ring);
    this._markerRing = ring;

    // Vertical light beam — visible at a distance, signals "stuff here".
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.25, SPAWN_HEIGHT, 6, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffaa00, transparent: true, opacity: 0.18, side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    beam.position.y = SPAWN_HEIGHT / 2;
    g.add(beam);
    this._markerBeam = beam;

    g.position.set(this.x, this.groundY + 0.05, this.z);
    this.scene.add(g);
    this._marker = g;
  }

  _updateTransforms() {
    this.root.position.set(this.x, this._currentY - LAND_OFFSET, this.z);
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  update(dt) {
    this._tBob += dt;

    if (this.state === DESCENDING) {
      this._currentY -= DESCENT_SPEED * dt;
      const restY = this.groundY + LAND_OFFSET;
      if (this._currentY <= restY) {
        this._currentY = restY;
        this.state = LANDED;
        // Once landed the beam is no longer useful — hide it.
        if (this._markerBeam) this._markerBeam.visible = false;
      }
    } else {
      // Subtle bob on the basket once landed for life.
      this._currentY = this.groundY + LAND_OFFSET + Math.sin(this._tBob * 1.6) * 0.04;
    }

    // Marker ring pulses — bigger on landing approach for spotting.
    if (this._markerRing) {
      const pulse = 1 + 0.15 * Math.sin(this._tBob * Math.PI * 2 * MARKER_PULSE_HZ);
      this._markerRing.scale.setScalar(pulse);
    }
    // Flame flicker
    if (this._flame) {
      this._flame.scale.setScalar(0.9 + 0.18 * Math.sin(this._tBob * 14));
    }

    this._updateTransforms();
  }

  /**
   * Player attempts to open. Caller passes whether E is held and whether
   * the player has movement input (WASD pressed). Stand-still requirement
   * uses a small grace window so micro inputs don't fully reset progress.
   *
   * Returns true on the frame the drop fully opens.
   */
  tryOpen(dt, player, eHeld) {
    if (this.state === OPENED || this.state === DESCENDING || this._dead) return false;

    const pp = player.getPosition();
    const dx = pp.x - this.x, dz = pp.z - this.z;
    const inRange = (dx * dx + dz * dz) < OPEN_RADIUS * OPEN_RADIUS;
    const moving  = !!player.isMovingInput;

    if (moving) this._stillTimer = 0;
    else        this._stillTimer += dt;
    const still = this._stillTimer >= STILLNESS_GRACE || !moving;

    if (eHeld && inRange && !moving) {
      this.state = OPENING;
      this.openProgress = Math.min(OPEN_HOLD_TIME, this.openProgress + dt);
      if (this.openProgress >= OPEN_HOLD_TIME) {
        this.state = OPENED;
        return true;
      }
    } else {
      // Decay quickly when interrupted, so re-engaging feels responsive.
      if (this.openProgress > 0) this.openProgress = Math.max(0, this.openProgress - dt * 2);
      if (this.state === OPENING && this.openProgress === 0) this.state = LANDED;
    }
    return false;
  }

  /** Distance from drop centre to (x,z), squared. */
  distSq(x, z) {
    const dx = x - this.x, dz = z - this.z;
    return dx * dx + dz * dz;
  }

  remove() {
    if (this._dead) return;
    this._dead = true;
    if (this.root)   this.scene.remove(this.root);
    if (this._marker) this.scene.remove(this._marker);
  }

  get dead() { return this._dead; }
  get progressFraction() { return this.openProgress / OPEN_HOLD_TIME; }
}

// ── Public manager ───────────────────────────────────────────────────────
export class SupplyDropManager {
  /**
   * @param {Object} cfg
   * @param {THREE.Scene} cfg.scene
   * @param {import('./world.js').World} cfg.world
   * @param {import('./storm.js').Storm} cfg.storm
   * @param {import('./pickups.js').PickupManager} cfg.pickups
   * @param {import('./weapons.js').WeaponSystem} cfg.weapons
   * @param {import('./ammo.js').AmmoSystem} [cfg.ammo]
   * @param {import('./multiplayer.js').NetworkManager} [cfg.net] — when
   *   present, the manager runs in host-authoritative mode:
   *     • Only the host runs the spawn timer; non-hosts wait for
   *       `supplyDropSpawn` messages and render the drops they describe.
   *     • Any client can open a drop; the open is broadcast so every client
   *       spawns identical loot at identical scattered positions (the
   *       scatter angle is part of the spawn message).
   *   In solo (net=null) everything happens locally as before.
   */
  constructor({ scene, world, storm, pickups, weapons, ammo = null, net = null }) {
    this.scene   = scene;
    this.world   = world;
    this.storm   = storm;
    this.pickups = pickups;
    this.weapons = weapons;
    this.ammo    = ammo;
    this.net     = net;
    this.drops   = [];

    // Monotonic counter used to mint stable drop IDs for the host. Format
    // `${hostId}_${counter}` so IDs don't collide if hosts swap mid-match.
    this._spawnCounter = 0;
    this._spawnTimer = FIRST_SPAWN_DELAY;

    if (net) {
      net.onSupplyDropSpawn = (msg) => this._receiveSpawn(msg);
      net.onSupplyDropOpen  = (msg) => this._receiveOpen(msg.dropId);
    }
  }

  /** Whether this client should run the spawn timer locally. */
  _isAuthority() {
    return !this.net || this.net.isHost;
  }

  /**
   * @param {number} dt
   * @param {import('./player.js').Player} player
   * @param {boolean} eHeld   true while the player is holding the use key
   */
  update(dt, player, eHeld) {
    // Spawn timer only runs on the authority (solo, or MP host). Non-hosts
    // are passive — they create drops only when the host announces them.
    if (this._isAuthority()) {
      const allowSpawn = !this.storm || this.storm.getInfo().state !== 'pending';
      if (allowSpawn) {
        this._spawnTimer -= dt;
        if (this._spawnTimer <= 0) {
          if (this._spawnDrop()) this._spawnTimer = SPAWN_INTERVAL;
          else                   this._spawnTimer = 5; // retry shortly if no valid spot
        }
      }
    }

    // Update every drop. When the local player completes an open, we route
    // through the network so all clients see the same outcome.
    for (const d of this.drops) d.update(dt);
    for (const d of this.drops) {
      if (d.tryOpen(dt, player, eHeld)) this._onLocalOpen(d);
    }

    this.drops = this.drops.filter(d => !d.dead);
  }

  // ── Spawning ──────────────────────────────────────────────────────────

  /**
   * Pick a landing point + pre-roll the loot contents, then either spawn
   * locally (solo) or announce via the host's supplyDropSpawn message
   * (multiplayer). Pre-rolling is the key trick that keeps every client's
   * loot identical: weapon, heals, and scatter angle are all decided once
   * on the host and carried in the message.
   *
   * Returns false if the chosen point was unusable (water, OOB) so the
   * caller can retry quickly.
   */
  _spawnDrop() {
    let cx = 0, cz = 0, r = 180;
    if (this.storm) {
      const info = this.storm.getInfo();
      cx = info.center.x;
      cz = info.center.z;
      r  = info.radius * STORM_INSET;
    }
    const angle = Math.random() * Math.PI * 2;
    const rad   = Math.sqrt(Math.random()) * r;
    const x = cx + Math.cos(angle) * rad;
    const z = cz + Math.sin(angle) * rad;

    const groundY = this.world.getTerrainHeight(x, z);
    if (groundY < 0.5) return false;

    // Pre-roll the loot the moment we decide where to spawn. Replication
    // works because every client uses these values verbatim when it
    // eventually opens the drop.
    const weaponId = DROP_WEAPONS[Math.floor(Math.random() * DROP_WEAPONS.length)];
    const healIds  = [
      DROP_HEALS[Math.floor(Math.random() * DROP_HEALS.length)],
      DROP_HEALS[Math.floor(Math.random() * DROP_HEALS.length)],
    ];
    const baseAngle = Math.random() * Math.PI * 2;
    const id = `${this.net?.myId ?? 'solo'}_${++this._spawnCounter}`;

    const data = { id, x, z, groundY, weaponId, healIds, baseAngle };

    if (this.net) {
      // Send to server; the broadcast echoes back to *this* client too, so
      // _receiveSpawn is what actually creates the drop. Avoids forking the
      // local-vs-remote spawn paths.
      this.net.sendSupplyDropSpawn(data);
    } else {
      this._createDrop(data);
    }
    return true;
  }

  /**
   * Materialise a drop from authoritative data. Called both for the host's
   * own spawn (via echo of `supplyDropSpawn`) and for non-host clients.
   */
  _createDrop(data) {
    const d = new SupplyDrop(this.scene, data.x, data.z, data.groundY);
    d.id        = data.id;
    d.weaponId  = data.weaponId;
    d.healIds   = data.healIds;
    d.baseAngle = data.baseAngle;
    this.drops.push(d);
  }

  _receiveSpawn(msg) {
    // Defensive: ignore duplicate IDs (host could re-send on a bad frame).
    if (this.drops.some(d => d.id === msg.id)) return;
    this._createDrop(msg);
  }

  /**
   * The local player finished holding E on a drop. In MP we broadcast the
   * open; in solo we just process it directly. Either path ends at
   * `_doOpen` which is idempotent (later duplicate messages no-op).
   */
  _onLocalOpen(drop) {
    if (this.net) {
      this.net.sendSupplyDropOpen(drop.id);
      // We *also* open locally so the opener gets immediate feedback —
      // _doOpen is idempotent so the echoed message is a no-op.
    }
    this._doOpen(drop);
  }

  _receiveOpen(dropId) {
    const drop = this.drops.find(d => d.id === dropId);
    if (drop) this._doOpen(drop);
  }

  _doOpen(drop) {
    if (drop.dead || drop._opened) return; // idempotent guard
    drop._opened = true;
    this._spawnLoot(drop);
  }

  // ── Loot spawning ─────────────────────────────────────────────────────

  _spawnLoot(drop) {
    // All loot positions are deterministic functions of (drop.x, drop.z,
    // drop.baseAngle), so every client lays them out identically. The
    // scatter places items around the crate at ~1.8 m so the player has to
    // walk around to gather everything rather than scooping a stacked pile.
    const baseAngle = drop.baseAngle ?? 0;
    const weaponId  = drop.weaponId  ?? DROP_WEAPONS[0];
    const healIds   = drop.healIds   ?? [DROP_HEALS[0], DROP_HEALS[1]];

    const wDef = WEAPON_DEFS[weaponId];
    const includeAmmo = !!(this.ammo && wDef.ammoType && wDef.ammoType !== 'special');
    const total = 1 + (includeAmmo ? 1 : 0) + 2;
    let slotIdx = 0;
    const slotAt = (radius) => {
      const a = baseAngle + (slotIdx / total) * Math.PI * 2;
      slotIdx++;
      return new THREE.Vector3(
        drop.x + Math.cos(a) * radius,
        drop.groundY + 0.4,
        drop.z + Math.sin(a) * radius,
      );
    };

    this.weapons.pickups.push(new WeaponPickup(this.scene, wDef, slotAt(1.8)));

    if (includeAmmo) this.ammo.spawnPile(wDef.ammoType, slotAt(1.8));

    for (const healId of healIds) {
      const hPos = slotAt(1.8);
      hPos.y = drop.groundY + 0.55;
      this.pickups.spawnAt(healId, hPos);
    }

    drop.remove();
  }

  // ── Public queries ────────────────────────────────────────────────────

  /**
   * Returns the landed drop the player is currently near, or null. Used by
   * the HUD to show the "Hold E to open" prompt and progress bar.
   */
  getNearbyDrop(player) {
    const pp = player.getPosition();
    let best = null;
    let bestDist = OPEN_RADIUS * OPEN_RADIUS;
    for (const d of this.drops) {
      if (d.state === DESCENDING || d.state === OPENED) continue;
      const ds = d.distSq(pp.x, pp.z);
      if (ds < bestDist) { best = d; bestDist = ds; }
    }
    return best;
  }

  /** All non-dead drops, for minimap rendering. */
  getDrops() { return this.drops; }
}

// Re-export the open-hold time so HUD code can format progress with the same
// reference value used here.
export const SUPPLY_OPEN_HOLD_TIME = OPEN_HOLD_TIME;
