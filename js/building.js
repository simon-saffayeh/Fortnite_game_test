import * as THREE from 'three';
import { paintedPBR, boxGeo } from './materials.js';

const GRID = 4;
const REACH = 4;


// ── Piece definitions ────────────────────────────────────────────────────────
const PIECE_DEFS = {
  wall:  { label: 'Wall',  key: 'Z' },
  floor: { label: 'Floor', key: 'X' },
  ramp:  { label: 'Ramp',  key: 'C' },
};

function buildMesh(type, ghost) {
  const color   = ghost ? 0x44aaff : 0xb07838;
  // Ghost pieces stay Lambert (need depthWrite tweak the factory doesn't expose);
  // built pieces use the PBR factory so they pick up sun specular and IBL.
  const mat = ghost
    ? new THREE.MeshLambertMaterial({
        color, transparent: true, opacity: 0.50, depthWrite: false,
      })
    : paintedPBR(color, { rough: 0.7 });

  let geo;
  if (type === 'wall') {
    geo = boxGeo(GRID, GRID, 0.32);
  } else if (type === 'floor') {
    geo = boxGeo(GRID, 0.32, GRID);
  } else {
    // Thin box tilted 45° — flat panel ramp, GRID×GRID footprint rising from 0 to GRID
    geo = boxGeo(GRID, 0.32, GRID * Math.SQRT2);
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow    = !ghost;
  mesh.receiveShadow = !ghost;

  // Mesh offset so root.position = base of piece
  if (type === 'wall')  mesh.position.y = GRID / 2;
  if (type === 'floor') mesh.position.y = 0.16;
  if (type === 'ramp')  { mesh.position.y = GRID / 2; mesh.rotation.x = -Math.PI / 4; }

  // Edge lines
  const edgeMat = new THREE.LineBasicMaterial({
    color:       ghost ? 0xffffff : 0x000000,
    transparent: true,
    opacity:     ghost ? 0.85 : 0.30,
  });
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
  edges.position.copy(mesh.position);
  edges.rotation.copy(mesh.rotation);

  const group = new THREE.Group();
  group.add(mesh);
  group.add(edges);
  return group;
}

const PIECE_HP = { wall: 150, floor: 100, ramp: 100 };

// ── BuildPiece ───────────────────────────────────────────────────────────────
class BuildPiece {
  constructor(scene, type, pos, rotY, ghost = false) {
    this.scene = scene;
    this.type  = type;
    this.ghost = ghost;
    this.hp    = ghost ? Infinity : PIECE_HP[type] ?? 100;
    this.root  = new THREE.Group();
    this.root.add(buildMesh(type, ghost));
    this.root.position.copy(pos);
    this.root.rotation.y = rotY;
    scene.add(this.root);
  }

  setTransform(pos, rotY) {
    this.root.position.copy(pos);
    this.root.rotation.y = rotY;
  }

  // Ghost-only: blue when placement is valid, red when unsupported.
  setValid(valid) {
    this.root.traverse(o => {
      if (o.isMesh) o.material.color.setHex(valid ? 0x44aaff : 0xff4444);
    });
  }

  getBounds() { return new THREE.Box3().setFromObject(this.root); }
  remove()    { this.scene.remove(this.root); }
}

// ── BuildingSystem ───────────────────────────────────────────────────────────
export class BuildingSystem {
  constructor(scene, world) {
    this.scene  = scene;
    this.world  = world;
    this.active = false;
    this.type   = 'wall';
    this.rotY   = 0;
    this.pieces = [];

    this._ghost     = null;
    this._ghostType = null;
    this._canPlace  = false;

    // Wired by main.js for multiplayer
    this.onPlace = null; // (type, x, y, z, rotY) => void
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  toggle() {
    this.active = !this.active;
    if (!this.active) this._killGhost();
  }

  setType(t) {
    if (this.type !== t) {
      this.type = t;
      this._killGhost();
      if (t === 'ramp')  this.rotY = Math.PI;
      else if (t !== 'wall') this.rotY = 0;
    }
  }

  rotate() {
    this.rotY = (this.rotY + Math.PI / 2) % (Math.PI * 2);
  }

  // Call every frame
  update(camera) {
    if (!this.active) { this._killGhost(); return; }

    // Walls and ramps auto-orient from camera horizontal direction (nearest 90°)
    if (this.type === 'wall' || this.type === 'ramp') {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const angle = Math.atan2(dir.x, dir.z);
      const snapped = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
      // Walls: normal faces you. Ramps: low end faces you (opposite of look dir).
      this.rotY = snapped;
    }

    const t = this._calcTransform(camera);
    if (!t) { this._killGhost(); this._canPlace = false; return; }

    if (!this._ghost || this._ghostType !== this.type) {
      this._killGhost();
      this._ghost     = new BuildPiece(this.scene, this.type, t.pos, this.rotY, true);
      this._ghostType = this.type;
    }

    this._ghost.setTransform(t.pos, this.rotY);

    // Pieces must be grounded or connected to an existing build — no
    // floating structures. Tint the ghost red when placement is invalid.
    this._canPlace = this._isSupported(this._ghost.getBounds());
    this._ghost.setValid(this._canPlace);
  }

  // A candidate piece (given its world-space AABB) is supported if its base
  // rests on the terrain, or it touches at least one already-placed piece.
  _isSupported(bounds) {
    const cx = (bounds.min.x + bounds.max.x) / 2;
    const cz = (bounds.min.z + bounds.max.z) / 2;
    const terrainY = this.world.getTerrainHeight(cx, cz);
    if (bounds.min.y <= terrainY + 0.4) return true;

    const expanded = bounds.clone().expandByScalar(0.25);
    for (const piece of this.pieces) {
      if (expanded.intersectsBox(piece.getBounds())) return true;
    }
    return false;
  }

  // Call on left-click while in build mode
  tryPlace(camera) {
    if (!this.active || !this._canPlace) return;
    const t = this._calcTransform(camera);
    if (!t) return;
    this._spawnPiece(this.type, t.pos, this.rotY);
    if (this.onPlace) this.onPlace(this.type, t.pos.x, t.pos.y, t.pos.z, this.rotY);
  }

  // Called by network for remote placements
  placeRemote(type, x, y, z, rotY) {
    this._spawnPiece(type, new THREE.Vector3(x, y, z), rotY);
  }

  // ── Internals ───────────────────────────────────────────────────────────────
  _spawnPiece(type, pos, rotY) {
    this.pieces.push(new BuildPiece(this.scene, type, pos, rotY, false));
  }

  _calcTransform(camera) {
    const dir    = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const origin = camera.position.clone();

    let hitPos = null;
    const steps    = 50;
    const stepSize = REACH / steps;

    for (let i = 2; i <= steps; i++) {
      const p  = origin.clone().addScaledVector(dir, i * stepSize);
      const gh = this.world.getTerrainHeight(p.x, p.z);

      if (p.y <= gh + 0.05) {
        hitPos = new THREE.Vector3(p.x, gh, p.z);
        break;
      }

      for (const piece of this.pieces) {
        if (piece.getBounds().containsPoint(p)) {
          hitPos = p.clone();
          break;
        }
      }
      if (hitPos) break;
    }

    if (!hitPos) {
      // No hit — use max-range point above terrain
      const far = origin.clone().addScaledVector(dir, REACH);
      const gh  = this.world.getTerrainHeight(far.x, far.z);
      hitPos = new THREE.Vector3(far.x, Math.max(far.y, gh), far.z);
    }

    // Snap X/Z to grid.
    // Walls sit at tile edges, not tile centers.
    // Wall local-Z is the thin axis; after rotY, that axis maps to world (sin, cos).
    // We offset the perpendicular-to-face axis by GRID/2 so the wall aligns to the edge.
    let gx, gz;
    if (this.type === 'wall') {
      const s = Math.sin(this.rotY), c = Math.cos(this.rotY);
      const half = GRID / 2;
      if (Math.abs(s) > 0.5) {
        // Wall face along Z, thickness along X → snap X to edge
        gx = Math.round((hitPos.x - half) / GRID) * GRID + half;
        gz = Math.round(hitPos.z / GRID) * GRID;
      } else {
        // Wall face along X, thickness along Z → snap Z to edge
        gx = Math.round(hitPos.x / GRID) * GRID;
        gz = Math.round((hitPos.z - half) / GRID) * GRID + half;
      }
    } else {
      gx = Math.round(hitPos.x / GRID) * GRID;
      gz = Math.round(hitPos.z / GRID) * GRID;
    }

    // Snap Y to grid, clamped above terrain
    const terrainY = this.world.getTerrainHeight(gx, gz);
    const gy       = Math.max(Math.round(hitPos.y / GRID) * GRID, terrainY);

    return { pos: new THREE.Vector3(gx, gy, gz) };
  }

  _killGhost() {
    if (this._ghost) { this._ghost.remove(); this._ghost = null; this._ghostType = null; }
    this._canPlace = false;
  }

  // ── Collision queries (called by Player) ───────────────────────────────────

  // Returns the highest build-surface Y beneath (wx, wz), or null.
  // playerY used to avoid snapping through structures from below.
  getHeightAt(wx, wz, playerY) {
    let maxH = -Infinity;
    const half = GRID / 2;

    for (const piece of this.pieces) {
      const pos  = piece.root.position;
      const rotY = piece.root.rotation.y;
      // World→local: inverse of the piece's Y rotation (Ry(-rotY)).
      const cos  = Math.cos(rotY), sin = Math.sin(rotY);
      const dx   = wx - pos.x,  dz = wz - pos.z;
      const lx   = cos * dx - sin * dz;
      const lz   = sin * dx + cos * dz;

      if (piece.type === 'floor') {
        if (Math.abs(lx) <= half && Math.abs(lz) <= half) {
          const top = pos.y + 0.32;
          if (playerY >= top - 0.4) maxH = Math.max(maxH, top);
        }
      } else if (piece.type === 'ramp') {
        if (Math.abs(lx) <= half && lz >= -half && lz <= half) {
          // Surface rises from y=0 at local z=-half to y=GRID at local z=+half,
          // matching the mesh tilt (-45° about X lifts the +Z edge).
          const surfH = pos.y + (half + lz);
          // Only snap onto ramp when player feet are within 0.5 units of the surface
          // (prevents invisible-bump when jumping up toward it from outside)
          if (playerY >= surfH - 0.5) maxH = Math.max(maxH, surfH);
        }
      }
    }

    return maxH === -Infinity ? null : maxH;
  }

  // Returns a world-space XZ push vector to resolve wall overlap, or null.
  getWallPush(wx, wy, wz, radius) {
    let pushX = 0, pushZ = 0;
    const half  = GRID / 2;   // half-width  = 2
    const halfT = 0.16;       // half-thickness

    for (const piece of this.pieces) {
      // Ramps are walkable surfaces (handled by getHeightAt), not solid walls —
      // giving them a horizontal push ejects the player sideways off the slope.
      if (piece.type !== 'wall') continue;

      const pos  = piece.root.position;
      const rotY = piece.root.rotation.y;

      if (wy + 2.1 < pos.y || wy > pos.y + GRID) continue;

      const cos = Math.cos(-rotY), sin = Math.sin(-rotY);
      const dx  = wx - pos.x,  dz = wz - pos.z;
      const lx  = cos * dx - sin * dz;
      const lz  = sin * dx + cos * dz;

      const bx = half, bz = halfT;

      if (Math.abs(lx) > bx + radius || Math.abs(lz) > bz + radius) continue;

      const cx    = Math.max(-bx, Math.min(bx, lx));
      const cz    = Math.max(-bz, Math.min(bz, lz));
      const nearX = lx - cx,  nearZ = lz - cz;
      const dist  = Math.sqrt(nearX * nearX + nearZ * nearZ);

      if (dist >= radius) continue;

      let plx, plz;
      if (dist < 0.001) {
        const overX = bx + radius - Math.abs(lx);
        const overZ = bz + radius - Math.abs(lz);
        if (overZ < overX) { plx = 0; plz = Math.sign(lz) * overZ; }
        else               { plx = Math.sign(lx) * overX; plz = 0; }
      } else {
        const mag = radius - dist;
        plx = (nearX / dist) * mag;
        plz = (nearZ / dist) * mag;
      }

      const cosR = Math.cos(rotY), sinR = Math.sin(rotY);
      pushX += cosR * plx - sinR * plz;
      pushZ += sinR * plx + cosR * plz;
    }

    return (pushX !== 0 || pushZ !== 0) ? { x: pushX, z: pushZ } : null;
  }

  // Returns true if segment p0→p1 hits any piece; deals damage and removes if destroyed.
  checkBullet(p0, p1, damage) {
    const ray = new THREE.Ray();
    ray.origin.copy(p0);
    ray.direction.subVectors(p1, p0).normalize();
    const segLen = p0.distanceTo(p1);

    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const piece = this.pieces[i];
      const box = piece.getBounds();
      const hit = ray.intersectBox(box, new THREE.Vector3());
      if (!hit) continue;
      if (ray.origin.distanceTo(hit) > segLen + 0.1) continue;

      piece.hp -= damage;
      if (piece.hp <= 0) {
        piece.remove();
        this.pieces.splice(i, 1);
      }
      return true;
    }
    return false;
  }

  // Expose for HUD
  get typeLabel() { return PIECE_DEFS[this.type]?.label ?? this.type; }
  get pieceKeys()  { return PIECE_DEFS; }
}
