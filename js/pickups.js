import * as THREE from 'three';
import { paintedPBR } from './materials.js';

const DEFS = {
  medkit:      { id: 'medkit',      label: 'Med Kit',      healHp: 50,  healShield: 0,  healArmour: 0,  color: 0x00ee66, scale: 0.9,  isConsumable: true, useTime: 3.0 },
  bigmed:      { id: 'bigmed',      label: 'Big Med',      healHp: 100, healShield: 0,  healArmour: 0,  color: 0x00ff88, scale: 1.2,  isConsumable: true, useTime: 5.0 },
  shield:      { id: 'shield',      label: 'Shield Sip',   healHp: 0,   healShield: 25, healArmour: 0,  color: 0x44aaff, scale: 0.8,  isConsumable: true, useTime: 2.0 },
  bigshield:   { id: 'bigshield',   label: 'Big Shield',   healHp: 0,   healShield: 50, healArmour: 0,  color: 0x2266ff, scale: 1.15, isConsumable: true, useTime: 4.0 },
  stimpack:    { id: 'stimpack',    label: 'Stim Pack',    healHp: 30,  healShield: 30, healArmour: 0,  color: 0xff6600, scale: 0.85, isConsumable: true, useTime: 1.5 },
  armourplate: { id: 'armourplate', label: 'Armour Plate', healHp: 0,   healShield: 0,  healArmour: 25, color: 0xffaa33, scale: 0.9,  isConsumable: true, useTime: 1.2 },
};

export { DEFS as CONSUMABLE_DEFS };

// ── Single pickup object ──────────────────────────────────────────────────────
class HealthPickup {
  constructor(scene, def, position) {
    this.scene     = scene;
    this.def       = def;
    this.collected = false;
    this.nearPlayer = false;
    this._t        = Math.random() * Math.PI * 2;
    this._baseY    = position.y + 0.55;

    this.root = new THREE.Group();
    this.root.position.set(position.x, this._baseY, position.z);

    const lm = hex => paintedPBR(hex);

    if (def.id === 'stimpack') {
      // Stim pack: orange syringe — cylinder body + plunger + needle
      const s = def.scale;
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.08 * s, 0.08 * s, 0.38 * s, 10),
        paintedPBR(def.color, { transparent: true, opacity: 0.85 }));
      barrel.castShadow = true; this.root.add(barrel);
      // Plunger cap (top)
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.10 * s, 0.10 * s, 0.06 * s, 10), lm(0xcc3300));
      cap.position.y = 0.22 * s; this.root.add(cap);
      // Needle (bottom)
      const needle = new THREE.Mesh(new THREE.CylinderGeometry(0.015 * s, 0.006 * s, 0.16 * s, 6), lm(0xcccccc));
      needle.position.y = -0.27 * s; this.root.add(needle);
      // Liquid fill line (inner darker band)
      const fill = new THREE.Mesh(new THREE.CylinderGeometry(0.065 * s, 0.065 * s, 0.22 * s, 10), lm(0xff4400));
      fill.position.y = 0.05 * s; this.root.add(fill);
      // Label band
      const label = new THREE.Mesh(new THREE.CylinderGeometry(0.083 * s, 0.083 * s, 0.12 * s, 10), lm(0xffffff));
      label.position.y = 0.08 * s; this.root.add(label);
    } else if (def.healHp > 0) {
      // Med kit: green box with white cross
      const s = def.scale;
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.5 * s, 0.32 * s, 0.5 * s), lm(def.color));
      body.castShadow = true;
      this.root.add(body);
      // Cross horizontal bar
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.36 * s, 0.1 * s, 0.1 * s), lm(0xffffff));
      h.position.y = 0.17 * s;
      this.root.add(h);
      // Cross vertical bar
      const v = new THREE.Mesh(new THREE.BoxGeometry(0.1 * s, 0.1 * s, 0.36 * s), lm(0xffffff));
      v.position.y = 0.17 * s;
      this.root.add(v);
      // Red lid trim
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.52 * s, 0.06 * s, 0.52 * s), lm(0xcc2222));
      lid.position.y = 0.19 * s;
      this.root.add(lid);
    } else if (def.healArmour > 0) {
      // Armour plate: octagonal metal disc with gold ring and bolt
      const s = def.scale;
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.30 * s, 0.30 * s, 0.07 * s, 8),
        paintedPBR(0x8b6914, { rough: 0.45, metal: 0.85 })
      );
      disc.castShadow = true;
      this.root.add(disc);
      const face = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28 * s, 0.28 * s, 0.02 * s, 8),
        paintedPBR(0xd4a017, { rough: 0.32, metal: 0.95 })
      );
      face.position.y = 0.045 * s;
      this.root.add(face);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.20 * s, 0.028 * s, 6, 8),
        paintedPBR(0xffcc44, { rough: 0.28, metal: 0.95 })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.05 * s;
      this.root.add(ring);
      const bolt = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055 * s, 0.055 * s, 0.09 * s, 6),
        paintedPBR(0xffe566, { rough: 0.30, metal: 0.95 })
      );
      bolt.position.y = 0.05 * s;
      this.root.add(bolt);
      this._disc = disc;
    } else {
      // Shield potion: blue sphere with glow shell
      const s = def.scale;
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.28 * s, 12, 8),
        paintedPBR(def.color, { transparent: true, opacity: 0.9, rough: 0.15, metal: 0.3 })
      );
      sphere.castShadow = true;
      this.root.add(sphere);
      // Outer glow shell
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.34 * s, 12, 8),
        new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.22, side: THREE.BackSide })
      );
      this.root.add(glow);
      // Swirl band
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(0.3 * s, 0.04 * s, 6, 20),
        lm(0xffffff)
      );
      band.rotation.x = Math.PI / 2;
      this.root.add(band);
      this._band = band;
    }

    // Ground glow
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.55 * def.scale, 24),
      new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.20, side: THREE.DoubleSide })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.52;
    this.root.add(disc);

    // No per-pickup PointLight — see WeaponPickup: dynamic lights added/removed
    // change the scene light count and force a full shader recompile (freeze).
    // The glow shell + swirl band + ground disc carry the look on their own.

    scene.add(this.root);
  }

  update(dt) {
    this._t += dt;
    this.root.position.y = this._baseY + Math.sin(this._t * 2.4) * 0.1;
    this.root.rotation.y = this._t * 0.9;
    if (this._band) this._band.rotation.y = this._t * 2;
  }

  collect() {
    this.collected = true;
    this.scene.remove(this.root);
  }
}

// ── PickupManager ─────────────────────────────────────────────────────────────
const SPAWN_LIST = [
  { id: 'medkit',    x:  40, z:  20 }, { id: 'shield',    x: -40, z:  20 },
  { id: 'medkit',    x: -20, z:  60 }, { id: 'bigshield', x:  70, z: -30 },
  { id: 'bigmed',    x:  -5, z: -55 }, { id: 'shield',    x:  55, z:  55 },
  { id: 'medkit',    x: -70, z: -20 }, { id: 'bigmed',    x:  10, z:  90 },
  { id: 'shield',    x: -50, z:  50 }, { id: 'bigshield', x:  90, z:  10 },
  { id: 'medkit',    x: -90, z: -10 }, { id: 'shield',    x:  30, z: -80 },
  { id: 'stimpack',  x:  20, z:  40 }, { id: 'stimpack',  x: -55, z: -65 },

  // ── POI indoor health loot ───────────────────────────────────────────
  // Cedar Creek — main cabin SW and NW corners, clear of sofa/table cluster
  { id: 'medkit',    x:  95,  z:  -3.5 },
  { id: 'shield',    x:  95,  z:   3.5 },
  // Frank's Jail — loot inside south-west cell and north-east cell
  { id: 'bigmed',    x: -136, z:  41   },
  { id: 'bigshield', x: -120, z:  59   },
  // Ancient Temple — open platform (no furniture)
  { id: 'shield',    x:  36,  z: -161  },
  // Military Compound — main bunker NE corner; secondary bunker NE corner
  { id: 'medkit',    x: -43,  z:  83   },
  { id: 'bigshield', x: -63,  z:  74   },
  // Olsen's Farm — farmhouse SW corner; barn west end
  { id: 'medkit',    x: 146,  z: -78   },
  { id: 'shield',    x: 163,  z: -78   },
  // Whalen's Town — church altar end; town hall east wall; tavern east wall
  { id: 'bigmed',    x: -125, z: -145  },
  { id: 'shield',    x: -118, z:  -98  },
  { id: 'medkit',    x:  -99, z: -121  },
  // Samuel's Mansion — basement storage, library, master bedroom
  { id: 'stimpack',  x:  180, z:  111, dy: 0 },  // basement storage
  { id: 'bigshield', x:  178, z:  128, dy: 5 },  // library
  { id: 'bigmed',    x:  182, z:  125, dy: 10 }, // master bedroom

  // ── Armour plate spawns — military & combat zones ──────────────────────
  { id: 'armourplate', x: -48,  z:  78  }, // Military Compound bunker
  { id: 'armourplate', x: -58,  z:  70  }, // Military Compound secondary
  { id: 'armourplate', x:  35,  z: -158 }, // Ancient Temple platform
  { id: 'armourplate', x: -130, z:  45  }, // Frank's Jail
  { id: 'armourplate', x:  92,  z:  -7  }, // Cedar Creek cabin
  { id: 'armourplate', x:  60,  z: -32  }, // Open field mid-map
  { id: 'armourplate', x: -25,  z: -60  }, // South field
  { id: 'armourplate', x:  15,  z:  88  }, // North-east field
];

export class PickupManager {
  constructor(scene, world) {
    this.scene   = scene;
    this.world   = world;
    this.pickups = [];
    this._nearbyPickup = null;
    this._spawnAll();
  }

  _spawnAll() {
    for (const s of SPAWN_LIST) {
      const h = this.world.getTerrainHeight(s.x, s.z);
      if (h < 0.2) continue;
      const def = DEFS[s.id];
      const y = h + (s.dy ?? 0);
      this.pickups.push(new HealthPickup(this.scene, def, new THREE.Vector3(s.x, y, s.z)));
    }
  }

  update(dt, player) {
    const pp = player.getPosition();
    this._nearbyPickup = null;
    let nearestDist = 3.0;

    for (const p of this.pickups) {
      if (p.collected) continue;
      p.update(dt);
      const dx = p.root.position.x - pp.x;
      const dz = p.root.position.z - pp.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      p.nearPlayer = dist < nearestDist;
      if (p.nearPlayer) { this._nearbyPickup = p; nearestDist = dist; }
    }

    this.pickups = this.pickups.filter(p => !p.collected);
  }

  /** Try to collect the nearest pickup. Returns the def if collected, null otherwise. */
  tryCollect() {
    const p = this._nearbyPickup;
    if (!p) return null;
    const def = p.def;
    p.collect();
    return def;
  }

  getNearbyPickup() { return this._nearbyPickup; }

  /** Spawn a random small loot drop at a world position (called on enemy death). */
  spawnLoot(worldPos) {
    const table = ['medkit', 'shield', 'medkit', 'shield', 'bigmed', 'armourplate'];
    const id  = table[Math.floor(Math.random() * table.length)];
    const def = DEFS[id];
    const h   = this.world.getTerrainHeight(worldPos.x, worldPos.z);
    const pos = new THREE.Vector3(worldPos.x, Math.max(worldPos.y - 0.3, h), worldPos.z);
    this.pickups.push(new HealthPickup(this.scene, def, pos));
  }

  /**
   * Spawn a specific consumable at a world position. Used by supply drops
   * (which want guaranteed Big Med / Big Shield / Stim rather than the
   * random table). Accepts a def from DEFS or its id string.
   */
  spawnAt(idOrDef, worldPos) {
    const def = (typeof idOrDef === 'string') ? DEFS[idOrDef] : idOrDef;
    if (!def) return;
    this.pickups.push(new HealthPickup(this.scene, def, worldPos.clone()));
  }

  /** Expose all uncollected pickups for minimap rendering. */
  get uncollected() { return this.pickups.filter(p => !p.collected); }
}
