import * as THREE from 'three';

// ── Weapon definitions ───────────────────────────────────────────────────────
// Each weapon is locked to exactly one rarity tier.
export const WEAPON_DEFS = {
  pistol: {
    id: 'pistol', name: 'Pistol',
    damage: 25, fireRate: 0.45, bulletSpeed: 260, range: 180,
    spread: 0.024, magSize: 12, reloadTime: 1.3,
    rarityColor: 0x888888, rarity: 'Common', auto: false, pellets: 1,
  },
  smg: {
    id: 'smg', name: 'SMG',
    damage: 16, fireRate: 0.07, bulletSpeed: 350, range: 130,
    spread: 0.058, magSize: 30, reloadTime: 1.6,
    rarityColor: 0x00cc44, rarity: 'Uncommon', auto: true, pellets: 1,
  },
  ar: {
    id: 'ar', name: 'Assault Rifle',
    damage: 30, fireRate: 0.11, bulletSpeed: 420, range: 300,
    spread: 0.026, magSize: 30, reloadTime: 2.0,
    rarityColor: 0x0088ff, rarity: 'Rare', auto: true, pellets: 1,
  },
  shotgun: {
    id: 'shotgun', name: 'Shotgun',
    damage: 24, fireRate: 0.85, bulletSpeed: 150, range: 55,
    spread: 0.13, magSize: 8, reloadTime: 2.5,
    rarityColor: 0xaa00ff, rarity: 'Epic', auto: false, pellets: 7,
  },
  sniper: {
    id: 'sniper', name: 'Sniper Rifle',
    damage: 150, fireRate: 1.6, bulletSpeed: 600, range: 950,
    spread: 0.003, magSize: 5, reloadTime: 3.2,
    rarityColor: 0xffaa00, rarity: 'Legendary', auto: false, pellets: 1,
  },
  minigun: {
    id: 'minigun', name: 'Minigun',
    damage: 20, fireRate: 0.055, bulletSpeed: 390, range: 260,
    spread: 0.058, magSize: 100, reloadTime: 5.0,
    rarityColor: 0xff1111, rarity: 'Mythic', auto: true, pellets: 1,
  },
  revolver: {
    id: 'revolver', name: 'Revolver',
    damage: 55, fireRate: 0.55, bulletSpeed: 280, range: 200,
    spread: 0.012, magSize: 6, reloadTime: 1.8,
    rarityColor: 0x888888, rarity: 'Common', auto: false, pellets: 1,
  },
  burstRifle: {
    id: 'burstRifle', name: 'Burst Rifle',
    damage: 28, fireRate: 0.10, bulletSpeed: 440, range: 280,
    spread: 0.020, magSize: 30, reloadTime: 2.1,
    rarityColor: 0x00cc44, rarity: 'Uncommon', auto: false, pellets: 1,
    burstCount: 3, burstDelay: 0.08,
  },
  heavyAR: {
    id: 'heavyAR', name: 'Heavy AR',
    damage: 42, fireRate: 0.18, bulletSpeed: 400, range: 320,
    spread: 0.018, magSize: 20, reloadTime: 2.4,
    rarityColor: 0x0088ff, rarity: 'Rare', auto: true, pellets: 1,
  },
  dualPistols: {
    id: 'dualPistols', name: 'Dual Pistols',
    damage: 30, fireRate: 0.22, bulletSpeed: 270, range: 160,
    spread: 0.030, magSize: 18, reloadTime: 1.5,
    rarityColor: 0xaa00ff, rarity: 'Epic', auto: false, pellets: 2,
  },
  rocketLauncher: {
    id: 'rocketLauncher', name: 'Rocket Launcher',
    damage: 120, fireRate: 1.8, bulletSpeed: 80, range: 400,
    spread: 0.005, magSize: 4, reloadTime: 3.5,
    rarityColor: 0xffaa00, rarity: 'Legendary', auto: false, pellets: 1,
    explosive: true, explosionRadius: 8, explosionDamage: 120,
  },
  bombLauncher: {
    id: 'bombLauncher', name: 'Nuke Launcher',
    damage: 30, fireRate: 5.0, bulletSpeed: 38, range: 480,
    spread: 0.002, magSize: 2, reloadTime: 6.0,
    rarityColor: 0xff1111, rarity: 'Mythic', auto: false, pellets: 1,
    explosive: true, explosionRadius: 45, explosionDamage: 280,
    gravity: -10,
  },
  // ── New weapons ──────────────────────────────────────────────────────────────
  handCannon: {
    id: 'handCannon', name: 'Hand Cannon',
    damage: 68, fireRate: 0.70, bulletSpeed: 320, range: 230,
    spread: 0.010, magSize: 7, reloadTime: 1.9,
    rarityColor: 0x888888, rarity: 'Common', auto: false, pellets: 1,
  },
  crossbow: {
    id: 'crossbow', name: 'Crossbow',
    damage: 98, fireRate: 1.1, bulletSpeed: 210, range: 290,
    spread: 0.004, magSize: 1, reloadTime: 1.4,
    rarityColor: 0x00cc44, rarity: 'Uncommon', auto: false, pellets: 1,
    silent: true,
  },
  scoutRifle: {
    id: 'scoutRifle', name: 'Scout Rifle',
    damage: 64, fireRate: 0.40, bulletSpeed: 470, range: 390,
    spread: 0.011, magSize: 10, reloadTime: 2.1,
    rarityColor: 0x0088ff, rarity: 'Rare', auto: false, pellets: 1,
  },
  huntingRifle: {
    id: 'huntingRifle', name: 'Hunting Rifle',
    damage: 108, fireRate: 1.05, bulletSpeed: 490, range: 430,
    spread: 0.007, magSize: 1, reloadTime: 1.9,
    rarityColor: 0xaa00ff, rarity: 'Epic', auto: false, pellets: 1,
  },
  // ── Unique weapons ───────────────────────────────────────────────────────────
  // Thunder Lance: slow electric orb — on explosion chains FULL damage to every enemy
  // within chainRadius (no falloff for chained targets). Wipe groups instantly.
  thunderLance: {
    id: 'thunderLance', name: 'Thunder Lance',
    damage: 80, fireRate: 1.5, bulletSpeed: 52, range: 360,
    spread: 0.003, magSize: 6, reloadTime: 3.2,
    rarityColor: 0xffaa00, rarity: 'Legendary', auto: false, pellets: 1,
    explosive: true, explosionRadius: 5, explosionDamage: 80,
    chainExplosion: true, chainRadius: 15, chainDamage: 60,
  },
  // Phase Rifle: bullet travels slowly — when it hits anything the player
  // instantly teleports to that location. Fire into a window, teleport inside.
  phaseRifle: {
    id: 'phaseRifle', name: 'Phase Rifle',
    damage: 45, fireRate: 1.6, bulletSpeed: 85, range: 460,
    spread: 0.002, magSize: 4, reloadTime: 2.8,
    rarityColor: 0xff1111, rarity: 'Mythic', auto: false, pellets: 1,
    teleport: true,
  },
};

// ── Gun 3D model builder ─────────────────────────────────────────────────────
const _gunModelCache = new Map();
export function buildGunModel(def, scale = 1) {
  const key = `${def.id}_${scale}`;
  const cached = _gunModelCache.get(key);
  if (cached) return cached.clone(true);
  const built = _buildGunModelRaw(def, scale);
  _gunModelCache.set(key, built);
  return built.clone(true);
}

function _buildGunModelRaw(def, scale = 1) {
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

  } else if (def.id === 'revolver') {
    g.add(box(0.11, 0.17, 0.55, 0x3a3a3a, 0, 0, 0));
    g.add(box(0.06, 0.06, 0.35, 0x111111, 0, 0.06, -0.38));
    g.add(cyl(0.07, 0.12, 0x555555, 0, 0, -0.05, Math.PI/2)); // cylinder
    g.add(box(0.10, 0.22, 0.14, 0x2a2a2a, 0, -0.16, 0.16));
    g.add(box(0.04, 0.08, 0.13, 0x111111, 0, -0.08, 0.06));

  } else if (def.id === 'burstRifle') {
    g.add(box(0.10, 0.15, 0.82, 0x3a4a2a, 0, 0, 0));
    g.add(box(0.04, 0.04, 0.30, 0x111111, 0, 0.04, -0.55));
    g.add(box(0.08, 0.10, 0.25, 0x2a3a1a, 0, -0.02, 0.50));
    g.add(box(0.07, 0.22, 0.11, def.rarityColor, 0, -0.17, 0.10));
    g.add(box(0.08, 0.17, 0.11, 0x222222, 0, -0.15, 0.28));
    g.add(box(0.04, 0.03, 0.48, 0x444444, 0, 0.10, 0.02));

  } else if (def.id === 'heavyAR') {
    g.add(box(0.13, 0.19, 1.05, 0x1a2a1a, 0, 0, 0));
    g.add(box(0.06, 0.06, 0.42, 0x111111, 0, 0.05, -0.72));
    g.add(box(0.10, 0.13, 0.34, 0x2a3a2a, 0, -0.03, 0.65));
    g.add(box(0.09, 0.28, 0.13, def.rarityColor, 0, -0.20, 0.10));
    g.add(box(0.10, 0.20, 0.13, 0x222222, 0, -0.16, 0.34));
    g.add(box(0.06, 0.04, 0.60, 0x445544, 0, 0.12, 0.02));
    g.add(cyl(0.040, 0.36, 0x222222, 0, 0.14, -0.10, Math.PI/2));

  } else if (def.id === 'dualPistols') {
    // Two pistol barrels side by side
    g.add(box(0.22, 0.17, 0.58, 0x4a3355, 0, 0, 0));
    g.add(box(0.05, 0.05, 0.36, 0x111111, -0.06, 0.06, -0.42));
    g.add(box(0.05, 0.05, 0.36, 0x111111,  0.06, 0.06, -0.42));
    g.add(box(0.08, 0.22, 0.14, def.rarityColor, 0, -0.17, 0.12));
    g.add(box(0.09, 0.20, 0.13, 0x222222, 0, -0.15, 0.28));

  } else if (def.id === 'rocketLauncher') {
    g.add(cyl(0.11, 0.90, 0x3a3a2a, 0, 0, 0, Math.PI/2)); // tube
    g.add(cyl(0.115,0.10, def.rarityColor, 0, 0, -0.46, Math.PI/2)); // front ring
    g.add(cyl(0.08, 0.08, 0x222222, 0, 0, -0.50, Math.PI/2)); // muzzle
    g.add(box(0.10, 0.25, 0.14, 0x2a2a1a, 0, -0.20, 0.22)); // grip
    g.add(box(0.04, 0.09, 0.16, 0x111111, 0, -0.09, 0.10)); // trigger
    g.add(box(0.09, 0.12, 0.18, 0x444433, 0, 0.14, 0.32)); // sight

  } else if (def.id === 'handCannon') {
    // Heavy chunky pistol — thick barrel, big grip
    g.add(box(0.16, 0.22, 0.58, 0x444444, 0, 0, 0));            // body
    g.add(box(0.09, 0.09, 0.38, 0x111111, 0, 0.08, -0.44));     // barrel
    g.add(box(0.12, 0.28, 0.16, 0x333333, 0, -0.18, 0.14));     // grip
    g.add(box(0.10, 0.07, 0.48, 0x666677, 0, 0.09, -0.04));     // slide
    g.add(box(0.05, 0.10, 0.15, 0x111111, 0, -0.09, 0.02));     // trigger guard
    g.add(box(0.06, 0.06, 0.12, 0x888888, 0, 0.10, -0.50));     // muzzle comp

  } else if (def.id === 'crossbow') {
    // Crossbow: horizontal limbs + stock
    g.add(box(0.08, 0.10, 0.80, 0x5c3d1e, 0, 0, 0));            // stock/body
    g.add(box(0.50, 0.05, 0.08, 0x4a2e14, 0, 0.06, -0.30));     // limbs (horizontal bow)
    g.add(box(0.52, 0.02, 0.02, 0x888888, 0, 0.06, -0.30));     // string
    g.add(box(0.05, 0.05, 0.36, 0x3a2a10, 0, 0.08, -0.15));     // rail / track
    g.add(box(0.10, 0.20, 0.14, 0x3a2a10, 0, -0.14, 0.28));     // pistol grip
    g.add(box(0.04, 0.07, 0.14, 0x111111, 0, -0.07, 0.14));     // trigger
    g.add(box(0.03, 0.03, 0.22, 0xccaa55, 0, 0.08, -0.16));     // bolt (arrow) on rail

  } else if (def.id === 'scoutRifle') {
    // DMR — long barrel, scope, bipod legs
    g.add(box(0.11, 0.16, 1.00, 0x3a3a4a, 0, 0, 0));            // body
    g.add(box(0.04, 0.04, 0.50, 0x111111, 0, 0.05, -0.72));     // barrel
    g.add(box(0.09, 0.10, 0.32, 0x2a2a3a, 0, -0.02, 0.60));     // stock
    g.add(box(0.08, 0.22, 0.12, def.rarityColor, 0, -0.18, 0.10)); // mag
    g.add(box(0.09, 0.18, 0.12, 0x222222, 0, -0.15, 0.30));     // grip
    g.add(cyl(0.038, 0.38, def.rarityColor, 0, 0.14, -0.08, Math.PI/2)); // scope tube
    // Bipod legs
    g.add(box(0.02, 0.14, 0.02, 0x555555, -0.06, -0.04, -0.55));
    g.add(box(0.02, 0.14, 0.02, 0x555555,  0.06, -0.04, -0.55));

  } else if (def.id === 'huntingRifle') {
    // Bolt-action — wood stock, long barrel, no mag (single shot)
    g.add(box(0.10, 0.14, 1.10, 0x6b4226, 0, 0, 0));            // wood body
    g.add(box(0.04, 0.04, 0.60, 0x111111, 0, 0.05, -0.84));     // barrel
    g.add(box(0.10, 0.12, 0.42, 0x7a4e2e, 0, -0.02, 0.60));     // wood stock
    g.add(box(0.09, 0.18, 0.12, 0x3a2a1a, 0, -0.13, 0.22));     // grip
    g.add(box(0.04, 0.07, 0.13, 0x111111, 0, -0.07, 0.10));     // trigger
    g.add(cyl(0.036, 0.32, 0x888888, 0, 0.13, -0.08, Math.PI/2)); // scope
    // Bolt handle (sticks out the side)
    g.add(box(0.16, 0.04, 0.04, 0x555555, 0.10, 0.06, 0.05));
    g.add(cyl(0.035, 0.035, 0x444444, 0.18, 0.04, 0.05, 0));    // bolt knob

  } else if (def.id === 'thunderLance') {
    // Electric orb launcher — coiled housing, glowing emissive tip
    g.add(box(0.15, 0.15, 0.82, 0x1a1a3a, 0, 0, 0));            // body
    g.add(cyl(0.07, 0.60, 0x0a0a2a, 0, 0, -0.28, Math.PI/2));  // barrel tube
    // Electric coil rings along barrel
    for (const oz of [-0.10, -0.25, -0.40, -0.55]) {
      g.add(cyl(0.09, 0.03, def.rarityColor, 0, 0, oz, Math.PI/2));
    }
    // Glowing orb muzzle
    const orbMat = new THREE.MeshBasicMaterial({ color: def.rarityColor });
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), orbMat);
    orb.position.set(0, 0, -0.62); g.add(orb);
    g.add(box(0.11, 0.24, 0.14, 0x111122, 0, -0.18, 0.22));     // grip
    g.add(box(0.04, 0.08, 0.15, 0x080810, 0, -0.08, 0.10));     // trigger
    // Energy cell on top
    g.add(box(0.06, 0.10, 0.26, def.rarityColor, 0, 0.13, 0.12));

  } else if (def.id === 'phaseRifle') {
    // Sleek futuristic teleport rifle — glowing phase coils, portal-disk muzzle
    g.add(box(0.09, 0.12, 0.95, 0x0a0a22, 0, 0, 0));
    g.add(box(0.04, 0.04, 0.55, 0x111133, 0, 0.04, -0.66));
    for (const oz of [-0.20, -0.38, -0.56]) {
      g.add(cyl(0.06, 0.025, def.rarityColor, 0, 0.04, oz, Math.PI/2));
    }
    const diskMat = new THREE.MeshBasicMaterial({ color: def.rarityColor, transparent: true, opacity: 0.9 });
    const disk = new THREE.Mesh(new THREE.CircleGeometry(0.055, 10), diskMat);
    disk.position.set(0, 0.04, -0.93); g.add(disk);
    g.add(box(0.09, 0.20, 0.13, 0x0a0a22, 0, -0.15, 0.26));
    g.add(box(0.04, 0.07, 0.13, 0x050510, 0, -0.07, 0.12));
    const crystalMat = new THREE.MeshBasicMaterial({ color: def.rarityColor });
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.045), crystalMat);
    crystal.position.set(0, 0.12, -0.15); g.add(crystal);

  } else if (def.id === 'bombLauncher') {
    g.add(cyl(0.14, 0.75, 0x1a0000, 0, 0, 0, Math.PI/2)); // fat tube
    g.add(cyl(0.145,0.12, def.rarityColor, 0, 0, -0.38, Math.PI/2)); // front ring glowing
    g.add(cyl(0.10, 0.10, 0x330000, 0, 0, -0.44, Math.PI/2)); // muzzle
    g.add(cyl(0.14, 0.12, def.rarityColor, 0, 0, 0.30, Math.PI/2)); // back ring
    g.add(box(0.11, 0.28, 0.15, 0x1a0000, 0, -0.22, 0.20)); // grip
    g.add(box(0.04, 0.10, 0.17, 0x220000, 0, -0.10, 0.08)); // trigger
    const domeMat = new THREE.MeshBasicMaterial({ color: def.rarityColor });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), domeMat);
    dome.position.set(0, 0.16, 0.05); g.add(dome);
  }

  g.scale.setScalar(scale);
  return g;
}

// ── Weapon instance (runtime ammo state) ─────────────────────────────────────
export class WeaponInstance {
  constructor(def) {
    this.def        = def;
    this.ammo       = def.magSize;
    this.reserve    = def.maxReserve !== undefined ? def.maxReserve : def.magSize * 4;
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

// ── Rarity spawn table ───────────────────────────────────────────────────────
// Rarity weights: higher index = rarer. Weights must sum to 100.
export const RARITY_POOL = [
  // Common
  { id: 'pistol',         weight: 16 },
  { id: 'revolver',       weight: 12 },
  { id: 'handCannon',     weight: 10 },
  // Uncommon
  { id: 'smg',            weight: 11 },
  { id: 'burstRifle',     weight:  9 },
  { id: 'crossbow',       weight:  7 },
  // Rare
  { id: 'ar',             weight:  9 },
  { id: 'heavyAR',        weight:  6 },
  { id: 'scoutRifle',     weight:  5 },
  // Epic
  { id: 'shotgun',        weight:  5 },
  { id: 'dualPistols',    weight:  4 },
  { id: 'huntingRifle',   weight:  3 },
  // Legendary
  { id: 'sniper',         weight:  3 },
  { id: 'rocketLauncher', weight:  2 },
  { id: 'thunderLance',   weight:  1 },
  // Mythic
  { id: 'minigun',        weight:  0.8},
  { id: 'phaseRifle',     weight:  0.5},
  { id: 'bombLauncher',   weight:  0.3},
];

export function randomWeaponDef() {
  const total = RARITY_POOL.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const entry of RARITY_POOL) {
    r -= entry.weight;
    if (r <= 0) return WEAPON_DEFS[entry.id];
  }
  return WEAPON_DEFS.pistol;
}

// ── WeaponSystem (spawns and manages all pickups) ────────────────────────────
const SPAWN_POINTS = [
  // Spread around map
  { x:  58, z:  -2 },
  { x:  70, z:   5 },
  { x:  32, z:  72 },
  { x: -22, z: -32 },
  { x: -60, z:  20 },
  { x:  42, z: -38 },
  { x: -35, z:  55 },
  { x:  18, z:  90 },
  { x: -80, z: -18 },
  { x: -78, z:  27 },
  { x: -90, z:  33 },
  { x:   0, z:  28 },
  { x:  45, z:  45 },
  { x:  14, z:-100 },
  { x:  27, z: -96 },
  { x: -42, z:  78 },
  { x: -26, z:  50 },
  { x:  52, z: -88 },
  { x: -95, z: -72 },
  { x:  88, z:  80 },

  // ── POI indoor loot ──────────────────────────────────────────────────
  // Cedar Creek (center 100, 0)
  { x: 100,  z:  0   },
  { x: 103,  z: -2   },
  { x:  97,  z:  2   },
  { x: 114,  z: -14  },  // guest cabin
  { x:  86,  z:  4   },  // shed

  // Fort Ironwatch (center -130, 50)
  { x: -130, z:  63  },  // barracks
  { x: -130, z:  32  },  // armory
  { x: -130, z:  50  },  // keep interior

  // Ancient Temple (center 35, -160)
  { x:  35,  z: -160 },
  { x:  32,  z: -162 },

  // Military Compound (center -50, 80)
  { x: -50,  z:  80  },  // main bunker
  { x: -68,  z:  72  },  // secondary bunker
  { x: -50,  z:  80  },  // rare chest

  // Olsen's Farm (center 150, -75)
  { x: 150,  z: -75  },  // farmhouse
  { x: 170,  z: -77  },  // barn 1
  { x: 133,  z: -75  },  // barn 2
  { x: 152,  z: -77  },

  // Whalen's Town (center -125, -120)
  { x: -125, z: -142 },  // church
  { x: -125, z:  -98 },  // town hall
  { x: -103, z: -120 },  // tavern
  { x: -147, z: -120 },  // blacksmith
  { x: -145, z: -128 },  // house
  { x: -133, z: -128 },  // house
  { x: -117, z: -128 },  // house
  { x: -105, z: -128 },  // house

  // Samuel's Mansion (center 190, 120) — higher rarity expected here
  { x:  190, z:  118 },  // grand hall
  { x:  187, z:  120 },  // gallery
  { x:  209, z:  120 },  // dining room
  { x:  190, z:  137 },  // ballroom
  { x:  209, z:  145 },  // kitchen
  { x:  171, z:  145 },  // library
  { x:  171, z:  164 },  // secret vault (high chance of epic/legendary)
  { x:  171, z:  164 },  // vault second chest
  { x:  171, z:  198 },  // secret exit bunker
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
    for (const s of SPAWN_POINTS) {
      const h = this.world.getTerrainHeight(s.x, s.z);
      if (h < 0.2) continue;
      const def = randomWeaponDef();
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
