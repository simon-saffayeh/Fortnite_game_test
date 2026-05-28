import * as THREE from 'three';
import { paintedPBR, boxGeo, polymerPBR } from './materials.js';
import { AMMO_PILE_AMOUNT } from './weapons.js';

// ── Visual styling per ammo type ─────────────────────────────────────────
// One source of truth: matches HUD readouts and ammo-pickup colors so the
// player can recognise types at a glance.
export const AMMO_VISUAL = {
  light:   { color: 0xf5d76e, label: 'Light Ammo'   },
  medium:  { color: 0x4cc3ff, label: 'Medium Ammo'  },
  heavy:   { color: 0xff6633, label: 'Heavy Ammo'   },
  rockets: { color: 0xff2222, label: 'Rockets'      },
  shells:  { color: 0xb56bff, label: 'Shotgun Shells' },
};

// Ammo is auto-collected on contact so the player can scoop piles by
// running through them. The world pickup radius is what counts here —
// there's no separate "near enough to prompt" range.
const AUTO_COLLECT_RADIUS = 1.7;

// ── Single ammo crate in the world ───────────────────────────────────────
class AmmoPickup {
  constructor(scene, type, amount, position) {
    this.scene  = scene;
    this.type   = type;
    this.amount = amount;
    this.collected  = false;
    this.nearPlayer = false;
    this._tBob   = Math.random() * Math.PI * 2;
    this._baseY  = position.y + 0.35;

    const visual = AMMO_VISUAL[type] ?? AMMO_VISUAL.light;
    const g = new THREE.Group();
    g.position.set(position.x, this._baseY, position.z);

    // Crate body — small wooden box w/ banded lid in the ammo-type color.
    const wood = paintedPBR(0x5a3c1e, { rough: 0.78 });
    const body = new THREE.Mesh(boxGeo(0.55, 0.4, 0.4), wood);
    body.castShadow = true;
    g.add(body);

    const lid = new THREE.Mesh(
      boxGeo(0.58, 0.1, 0.43),
      paintedPBR(visual.color, { rough: 0.5, metal: 0.3 }),
    );
    lid.position.y = 0.22;
    g.add(lid);

    // Stencilled label band — emissive so it pops against terrain.
    const stamp = new THREE.Mesh(
      boxGeo(0.4, 0.18, 0.42),
      paintedPBR(visual.color, {
        emissive: visual.color, emissiveIntensity: 0.45,
      }),
    );
    stamp.position.y = -0.02;
    g.add(stamp);

    // Pickup ring on the ground for visibility.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.035, 6, 28),
      new THREE.MeshBasicMaterial({ color: visual.color, transparent: true, opacity: 0.7 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.32;
    g.add(ring);
    this._ring = ring;

    this.scene.add(g);
    this.root = g;
  }

  update(dt) {
    this._tBob += dt;
    this.root.position.y = this._baseY + Math.sin(this._tBob * 2.0) * 0.05;
    this.root.rotation.y += dt * 0.5;
    if (this._ring) {
      const s = 1 + 0.06 * Math.sin(this._tBob * 3.0);
      this._ring.scale.set(s, s, 1);
    }
  }

  collect() {
    this.collected = true;
    this.scene.remove(this.root);
  }
}

// ── Manager: world spawns, per-frame proximity, pickup ──────────────────
export class AmmoSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./world.js').World} world
   */
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.pickups = [];
    this._nearby = null;
  }

  /**
   * Spawn an ammo pile in the world. `amount` defaults to the table value
   * for the type. Returns the spawned AmmoPickup so callers can store a
   * reference (e.g. minimap markers).
   */
  spawnPile(type, position, amount = null) {
    const visual = AMMO_VISUAL[type];
    if (!visual) return null;
    const amt = amount ?? AMMO_PILE_AMOUNT[type] ?? 10;
    const p = new AmmoPickup(this.scene, type, amt, position.clone());
    this.pickups.push(p);
    return p;
  }

  /**
   * Per-frame tick. When `inventory` is provided, ammo piles within
   * AUTO_COLLECT_RADIUS of the player are vacuumed up immediately —
   * walking through a pile is enough, no key press required.
   * `onCollected(pickup)` (optional) fires once per absorbed pickup so the
   * HUD can show a toast.
   */
  update(dt, player, inventory = null, onCollected = null) {
    const pp = player.getPosition();
    const r2 = AUTO_COLLECT_RADIUS * AUTO_COLLECT_RADIUS;

    for (const p of this.pickups) {
      if (p.collected) continue;
      p.update(dt);
      if (!inventory) continue;
      const dx = p.root.position.x - pp.x;
      const dz = p.root.position.z - pp.z;
      if (dx * dx + dz * dz < r2) {
        inventory.addAmmo(p.type, p.amount);
        p.collect();
        if (onCollected) onCollected(p);
      }
    }

    this.pickups = this.pickups.filter(p => !p.collected);
  }
}
