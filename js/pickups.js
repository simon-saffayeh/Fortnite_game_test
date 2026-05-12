import * as THREE from 'three';

const DEFS = {
  medkit: {
    id: 'medkit', label: 'Med Kit',
    healHp: 50, healShield: 0,
    color: 0x00ee66, scale: 0.9,
  },
  bigmed: {
    id: 'bigmed', label: 'Big Med',
    healHp: 100, healShield: 0,
    color: 0x00ff88, scale: 1.2,
  },
  shield: {
    id: 'shield', label: 'Shield Sip',
    healHp: 0, healShield: 25,
    color: 0x44aaff, scale: 0.8,
  },
  bigshield: {
    id: 'bigshield', label: 'Big Shield',
    healHp: 0, healShield: 50,
    color: 0x2266ff, scale: 1.15,
  },
};

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

    const lm = hex => new THREE.MeshLambertMaterial({ color: hex });

    if (def.healHp > 0) {
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
    } else {
      // Shield potion: blue sphere with glow shell
      const s = def.scale;
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.28 * s, 12, 8),
        new THREE.MeshLambertMaterial({ color: def.color, transparent: true, opacity: 0.9 })
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

    // Point light
    this._light = new THREE.PointLight(def.color, 1.0, 4.5);
    this.root.add(this._light);

    scene.add(this.root);
  }

  update(dt) {
    this._t += dt;
    this.root.position.y = this._baseY + Math.sin(this._t * 2.4) * 0.1;
    this.root.rotation.y = this._t * 0.9;
    this._light.intensity = 0.8 + Math.sin(this._t * 3.5) * 0.3;
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
      this.pickups.push(new HealthPickup(this.scene, def, new THREE.Vector3(s.x, h, s.z)));
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
  tryCollect(player) {
    const p = this._nearbyPickup;
    if (!p) return null;

    const def = p.def;
    if (def.healHp    > 0) player.health = Math.min(player.maxHealth, player.health + def.healHp);
    if (def.healShield > 0) player.healShield(def.healShield);

    p.collect();
    return def;
  }

  getNearbyPickup() { return this._nearbyPickup; }

  /** Spawn a random small loot drop at a world position (called on enemy death). */
  spawnLoot(worldPos) {
    const table = ['medkit', 'shield', 'medkit', 'shield', 'bigmed'];
    const id  = table[Math.floor(Math.random() * table.length)];
    const def = DEFS[id];
    const h   = this.world.getTerrainHeight(worldPos.x, worldPos.z);
    const pos = new THREE.Vector3(worldPos.x, Math.max(worldPos.y - 0.3, h), worldPos.z);
    this.pickups.push(new HealthPickup(this.scene, def, pos));
  }

  /** Expose all uncollected pickups for minimap rendering. */
  get uncollected() { return this.pickups.filter(p => !p.collected); }
}
