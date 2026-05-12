import * as THREE from 'three';

// ── Weapon definitions ───────────────────────────────────────────────────────
// Each weapon is locked to exactly one rarity tier.
export const WEAPON_DEFS = {
  pistol: {
    id: 'pistol', name: 'Pistol',
    damage: 25, fireRate: 0.45, bulletSpeed: 130, range: 180,
    spread: 0.024, magSize: 12, reloadTime: 1.3,
    rarityColor: 0xaaaaaa, rarity: 'Common', auto: false, pellets: 1,
  },
  smg: {
    id: 'smg', name: 'SMG',
    damage: 16, fireRate: 0.07, bulletSpeed: 175, range: 130,
    spread: 0.058, magSize: 30, reloadTime: 1.6,
    rarityColor: 0x00cc55, rarity: 'Uncommon', auto: true, pellets: 1,
  },
  ar: {
    id: 'ar', name: 'Assault Rifle',
    damage: 30, fireRate: 0.11, bulletSpeed: 210, range: 300,
    spread: 0.026, magSize: 30, reloadTime: 2.0,
    rarityColor: 0x0099ff, rarity: 'Rare', auto: true, pellets: 1,
  },
  shotgun: {
    id: 'shotgun', name: 'Shotgun',
    damage: 24, fireRate: 0.85, bulletSpeed: 75, range: 55,
    spread: 0.13, magSize: 8, reloadTime: 2.5,
    rarityColor: 0xcc44ff, rarity: 'Epic', auto: false, pellets: 7,
  },
  sniper: {
    id: 'sniper', name: 'Sniper Rifle',
    damage: 150, fireRate: 1.6, bulletSpeed: 520, range: 950,
    spread: 0.003, magSize: 5, reloadTime: 3.2,
    rarityColor: 0xffaa00, rarity: 'Legendary', auto: false, pellets: 1,
  },
  minigun: {
    id: 'minigun', name: 'Minigun',
    damage: 20, fireRate: 0.055, bulletSpeed: 195, range: 260,
    spread: 0.058, magSize: 100, reloadTime: 5.0,
    rarityColor: 0xff4400, rarity: 'Mythic', auto: true, pellets: 1,
  },
};

// ── Gun 3D model builder ─────────────────────────────────────────────────────
export function buildGunModel(def, scale = 1) {
  const g = new THREE.Group();
  const m = hex => new THREE.MeshLambertMaterial({ color: hex });
  const box = (w, h, d, hex, px, py, pz) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m(hex));
    mesh.position.set(px, py, pz);
    mesh.castShadow = true;
    return mesh;
  };
  const cyl = (r, h, hex, px, py, pz, rx = 0) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 8), m(hex));
    mesh.position.set(px, py, pz);
    mesh.rotation.x = rx;
    return mesh;
  };

  if (def.id === 'pistol') {
    g.add(box(0.13, 0.19, 0.62, 0x556677, 0, 0, 0));
    g.add(box(0.07, 0.07, 0.42, 0x111111, 0, 0.07, -0.48));
    g.add(box(0.1,  0.24, 0.15, 0x333333, 0, -0.18, 0.12));
    g.add(box(0.09, 0.06, 0.42, 0x778899, 0, 0.07, -0.04));
    g.add(box(0.04, 0.09, 0.14, 0x111111, 0, -0.1,  0.00));

  } else if (def.id === 'smg') {
    // Compact body
    g.add(box(0.11, 0.15, 0.60, 0x2d4a1e, 0, 0, 0));
    // Short barrel
    g.add(box(0.05, 0.05, 0.24, 0x111111, 0, 0.04, -0.40));
    // Folded stock stub
    g.add(box(0.09, 0.10, 0.18, 0x1e3418, 0, -0.02, 0.32));
    // Tall thin magazine (colour-coded)
    g.add(box(0.08, 0.24, 0.10, def.rarityColor, 0, -0.18, 0.08));
    // Grip
    g.add(box(0.09, 0.17, 0.11, 0x222222, 0, -0.14, 0.26));
    // Trigger guard
    g.add(box(0.04, 0.07, 0.13, 0x111111, 0, -0.08, 0.12));
    // Top rail
    g.add(box(0.05, 0.03, 0.36, 0x444444, 0, 0.09, 0.02));

  } else if (def.id === 'ar') {
    g.add(box(0.11, 0.17, 0.95, 0x2a2a2a, 0, 0, 0));
    g.add(box(0.05, 0.05, 0.38, 0x111111, 0, 0.04, -0.64));
    g.add(box(0.09, 0.11, 0.30, 0x3a3a3a, 0, -0.03, 0.60));
    g.add(box(0.08, 0.26, 0.13, def.rarityColor, 0, -0.19, 0.10));
    g.add(box(0.09, 0.19, 0.13, 0x222222, 0, -0.16, 0.32));
    g.add(box(0.05, 0.04, 0.55, 0x555566, 0, 0.11, 0.00));
    g.add(cyl(0.035, 0.32, 0x222222, 0, 0.13, -0.08, Math.PI / 2));

  } else if (def.id === 'shotgun') {
    g.add(box(0.12, 0.15, 1.05, 0x5c3d1e, 0, 0, 0));
    g.add(box(0.15, 0.09, 0.62, 0x555566, 0, 0.08, -0.48));
    g.add(box(0.14, 0.11, 0.24, 0x4a3020, 0, 0.02, -0.22));
    g.add(box(0.10, 0.13, 0.32, 0x4a2800, 0, -0.02, 0.52));
    g.add(box(0.10, 0.21, 0.14, 0x3a2010, 0, -0.13, 0.32));
    g.add(box(0.04, 0.08, 0.16, 0x111111, 0, -0.09, 0.16));

  } else if (def.id === 'sniper') {
    g.add(box(0.10, 0.14, 1.35, 0x1a1a3a, 0, 0, 0));
    g.add(box(0.04, 0.04, 0.72, 0x111111, 0, 0.05, -0.95));
    g.add(box(0.09, 0.10, 0.38, 0x2a2a4a, 0, -0.02, 0.62));
    g.add(box(0.09, 0.19, 0.13, 0x1a1a3a, 0, -0.13, 0.26));
    g.add(box(0.07, 0.19, 0.11, 0x2a2a5a, 0, -0.12, 0.06));
    g.add(cyl(0.042, 0.48, def.rarityColor, 0, 0.13, -0.10, Math.PI / 2));
    const lensL = new THREE.Mesh(new THREE.CircleGeometry(0.035, 8), new THREE.MeshBasicMaterial({ color: 0x44aaff }));
    lensL.position.set(0, 0.13, -0.34); g.add(lensL);
    g.add(box(0.03, 0.18, 0.03, 0x555566, -0.10, -0.04, -0.55));
    g.add(box(0.03, 0.18, 0.03, 0x555566,  0.10, -0.04, -0.55));

  } else if (def.id === 'minigun') {
    // Central housing
    g.add(box(0.22, 0.18, 0.90, 0x2a2416, 0, 0, 0));
    // Three barrels arranged in a triangle cluster
    g.add(cyl(0.044, 0.76, 0x555566,  0,     0.10, -0.56, Math.PI / 2));  // top
    g.add(cyl(0.044, 0.76, 0x555566, -0.08, -0.05, -0.56, Math.PI / 2));  // bottom-left
    g.add(cyl(0.044, 0.76, 0x555566,  0.08, -0.05, -0.56, Math.PI / 2));  // bottom-right
    // Barrel collar ring (rarity colour)
    g.add(cyl(0.14, 0.08, def.rarityColor, 0, 0, -0.22, Math.PI / 2));
    // Front muzzle ring
    g.add(cyl(0.14, 0.05, 0x333322, 0, 0, -0.68, Math.PI / 2));
    // Ammo drum (vertical cylinder at back)
    g.add(cyl(0.12, 0.20, 0x332200, 0, -0.04, 0.30, 0));
    // Pistol grip + trigger guard
    g.add(box(0.10, 0.26, 0.13, 0x1a1410, 0, -0.20, 0.24));
    g.add(box(0.04, 0.08, 0.16, 0x111111, 0, -0.10, 0.12));
  }

  g.scale.setScalar(scale);
  return g;
}

// ── Weapon instance (runtime ammo state) ─────────────────────────────────────
export class WeaponInstance {
  constructor(def) {
    this.def        = def;
    this.ammo       = def.magSize;
    this.reserve    = def.magSize * 4;
    this.reloading  = false;
    this._reloadT   = 0;
    this.fireCooldown = 0;
  }

  update(dt) {
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (this.reloading) {
      this._reloadT -= dt;
      if (this._reloadT <= 0) this._finishReload();
    }
  }

  canFire()  { return !this.reloading && this.fireCooldown <= 0 && this.ammo > 0; }

  fire() {
    if (!this.canFire()) return false;
    this.ammo--;
    this.fireCooldown = this.def.fireRate;
    if (this.ammo === 0) this.startReload();
    return true;
  }

  startReload() {
    if (this.reloading || this.ammo === this.def.magSize || this.reserve === 0) return;
    this.reloading = true;
    this._reloadT  = this.def.reloadTime;
  }

  _finishReload() {
    const need = this.def.magSize - this.ammo;
    const take = Math.min(need, this.reserve);
    this.ammo    += take;
    this.reserve -= take;
    this.reloading = false;
  }
}

// ── World pickup ─────────────────────────────────────────────────────────────
export class WeaponPickup {
  constructor(scene, def, position) {
    this.scene     = scene;
    this.def       = def;
    this.collected = false;
    this.nearPlayer = false;
    this._t        = Math.random() * Math.PI * 2;
    this._baseY    = position.y + 0.9;

    this.root = new THREE.Group();
    this.root.position.set(position.x, this._baseY, position.z);

    this._gun = buildGunModel(def, 1.15);
    this._gun.rotation.x = Math.PI / 2;
    this.root.add(this._gun);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.52, 0.045, 8, 40),
      new THREE.MeshBasicMaterial({ color: def.rarityColor, transparent: true, opacity: 0.85 })
    );
    ring.rotation.x = Math.PI / 2;
    this.root.add(ring);
    this._ring = ring;

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.6, 32),
      new THREE.MeshBasicMaterial({ color: def.rarityColor, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.85;
    this.root.add(disc);

    this._light = new THREE.PointLight(def.rarityColor, 1.4, 5.5);
    this.root.add(this._light);

    scene.add(this.root);
  }

  update(dt) {
    this._t += dt;
    this.root.position.y = this._baseY + Math.sin(this._t * 2.2) * 0.12;
    this._gun.rotation.y = this._t * 1.1;
    this._ring.rotation.z = this._t * 0.7;
    this._light.intensity = 1.0 + Math.sin(this._t * 4) * 0.4;
  }

  collect() {
    this.collected = true;
    this.scene.remove(this.root);
  }
}

// ── WeaponSystem (spawns and manages all pickups) ────────────────────────────
// More common weapons have more spawns; Mythic has just two.
const SPAWN_LIST = [
  // Common — Pistol (5 spawns, spread around map)
  { id: 'pistol',  x:  58, z:  -2 },
  { id: 'pistol',  x:  70, z:   5 },
  { id: 'pistol',  x:  32, z:  72 },
  { id: 'pistol',  x: -22, z: -32 },
  { id: 'pistol',  x: -60, z:  20 },

  // Uncommon — SMG (4 spawns)
  { id: 'smg',     x:  42, z: -38 },
  { id: 'smg',     x: -35, z:  55 },
  { id: 'smg',     x:  18, z:  90 },
  { id: 'smg',     x: -80, z: -18 },

  // Rare — Assault Rifle (4 spawns)
  { id: 'ar',      x: -78, z:  27 },
  { id: 'ar',      x: -90, z:  33 },
  { id: 'ar',      x:   0, z:  28 },
  { id: 'ar',      x:  45, z:  45 },

  // Epic — Shotgun (3 spawns)
  { id: 'shotgun', x:  14, z:-100 },
  { id: 'shotgun', x:  27, z: -96 },
  { id: 'shotgun', x: -42, z:  78 },

  // Legendary — Sniper (2 spawns, far out)
  { id: 'sniper',  x: -26, z:  50 },
  { id: 'sniper',  x:  52, z: -88 },

  // Mythic — Minigun (2 spawns, deep map)
  { id: 'minigun', x: -95, z: -72 },
  { id: 'minigun', x:  88, z:  80 },
];

export class WeaponSystem {
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
      const def = WEAPON_DEFS[s.id];
      this.pickups.push(new WeaponPickup(this.scene, def, new THREE.Vector3(s.x, h, s.z)));
    }
  }

  update(dt, player) {
    const pp = player.getPosition();
    this._nearbyPickup = null;
    let nearestDist = 3.5;

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

  getNearbyPickup() { return this._nearbyPickup; }
}
