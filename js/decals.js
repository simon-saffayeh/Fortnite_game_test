// ── Bullet impact decals ─────────────────────────────────────────────────────
// Pool of 32 textured quads. Spawned at bullet/explosion impact points,
// oriented to face along the impact normal, fading out over ~6s. LRU
// eviction: when the pool is exhausted, the oldest decal is replaced.
//
// Performance shape:
// - One shared PlaneGeometry across all decals (small allocation cost).
// - Per-decal MeshBasicMaterial (clone of the shared template) so opacity
//   can be set per instance. ~32 materials live in memory permanently.
// - Procedural texture (scorch blotch) generated once at boot — no I/O.
// - update() is a single tight loop over 32 entries with one opacity write
//   per active slot. Easily < 0.02ms.

import * as THREE from 'three';

const POOL_SIZE = 32;
const DECAL_LIFE = 6.0;

export class DecalSystem {
  constructor(scene) {
    this.scene = scene;

    // Procedural impact texture — single canvas-drawn blotch. Slight halo
    // around the dark center reads as "scorch + dust" rather than a hard dot.
    this._tex = this._makeImpactTexture();

    // One unit plane shared across the whole pool. Each decal scales the
    // mesh, not the geometry, so the geometry stays a singleton.
    this._geo = new THREE.PlaneGeometry(1, 1);

    this._pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this._tex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        polygonOffset: true,        // push toward camera to avoid z-fight
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const mesh = new THREE.Mesh(this._geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 1;         // draw after opaque world for cleaner blend
      this.scene.add(mesh);
      this._pool.push({ mesh, age: 0, life: DECAL_LIFE });
    }
    this._cursor = 0;               // round-robin for LRU eviction
  }

  /**
   * Spawn a decal at world position `pos` oriented along `normal` (pointing
   * away from the surface). Size is the diameter in world units.
   * If the pool is exhausted, the oldest decal is evicted and reused.
   */
  spawn(pos, normal, size = 0.5) {
    const slot = this._pool[this._cursor];
    this._cursor = (this._cursor + 1) % this._pool.length;

    // Position a hair off the surface to avoid co-planar z-fighting (in
    // addition to polygon offset, since some drivers handle it loosely).
    slot.mesh.position.copy(pos).addScaledVector(normal, 0.015);
    // Orient the plane so its +Z faces along the normal. lookAt expects a
    // target point; pos + normal works since it's relative direction.
    slot.mesh.lookAt(pos.clone().add(normal));
    slot.mesh.rotateZ(Math.random() * Math.PI * 2);  // visual variety
    slot.mesh.scale.setScalar(size);
    slot.mesh.material.opacity = 0.92;
    slot.mesh.visible = true;
    slot.age = 0;
    slot.life = DECAL_LIFE;
  }

  update(dt) {
    for (const s of this._pool) {
      if (!s.mesh.visible) continue;
      s.age += dt;
      if (s.age >= s.life) {
        s.mesh.visible = false;
        s.mesh.material.opacity = 0;
        continue;
      }
      // Linear fade for the last 40% of life; flat full opacity before that.
      const k = s.age / s.life;
      s.mesh.material.opacity = k > 0.6 ? 0.92 * (1 - (k - 0.6) / 0.4) : 0.92;
    }
  }

  // Procedural scorch texture: dark center with a smoky halo, edges fully
  // transparent. 128² is plenty — decals are small on screen.
  _makeImpactTexture() {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');

    // Soft outer halo — burnt brown.
    const halo = ctx.createRadialGradient(size/2, size/2, size * 0.12, size/2, size/2, size * 0.5);
    halo.addColorStop(0.00, 'rgba( 35, 22, 12, 0.90)');
    halo.addColorStop(0.50, 'rgba( 60, 40, 22, 0.45)');
    halo.addColorStop(1.00, 'rgba( 80, 55, 30, 0.00)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, size, size);

    // Dark center splat — irregular, hand-painted feel from a few overlapping
    // dark blobs at random offsets within the center.
    for (let i = 0; i < 5; i++) {
      const a   = Math.random() * Math.PI * 2;
      const r   = Math.random() * size * 0.08;
      const cx  = size/2 + Math.cos(a) * r;
      const cy  = size/2 + Math.sin(a) * r;
      const rad = size * (0.10 + Math.random() * 0.08);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0.00, 'rgba(15, 8, 4, 0.85)');
      g.addColorStop(0.60, 'rgba(25,15, 8, 0.55)');
      g.addColorStop(1.00, 'rgba(40,25,12, 0.00)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }
}
