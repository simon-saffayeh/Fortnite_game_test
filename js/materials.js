// ── PBR material factory ────────────────────────────────────────────────────
// Single chokepoint for every painted surface in the game. Caches by (color,
// rough, metal, emissive, emissiveIntensity, opacity) so a 25-mesh character
// reuses ~6 materials instead of allocating 25.
//
// Respects Graphics.pbrEnabled — on LOW preset we transparently return a
// MeshLambertMaterial instead so the renderer's shader-compile cost and
// fragment cost stay at baseline.
//
// Callers should NOT mutate the returned material — it's shared. To tint a
// rarity-coloured panel emissively, use `emissive: 0xRRGGBB` in the options.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Graphics } from './graphics.js';
import { getDetailMaps } from './textures.js';

const _cachePBR     = new Map();
const _cacheLambert = new Map();
// Geometry cache: keyed by dimensions + segments + radius so a player's
// 25-mesh body reuses the same RoundedBoxGeometry instances across instances.
const _cacheGeo     = new Map();

/** Stable cache key from the option bag. */
function _key(color, rough, metal, emissive, emissiveIntensity, transparent, opacity, side, detail, normalScale, envMapIntensity) {
  return `${color}|${rough}|${metal}|${emissive}|${emissiveIntensity}|${transparent ? 1 : 0}|${opacity}|${side}|${detail ?? ''}|${normalScale ?? 1}|${envMapIntensity ?? 0.55}`;
}

/**
 * Painted surface (body panels, weapon polymer, supply-drop wood, etc).
 * Default 0.7 roughness, no metalness → reads as matte paint. Override with
 * { metal: 0.85, rough: 0.35 } for gun barrels and steel.
 *
 * @param {number} color    24-bit hex
 * @param {Object} [opts]   rough, metal, emissive (hex), emissiveIntensity,
 *                          transparent, opacity, side, _alwaysPBR (used
 *                          internally when an effect needs PBR even on LOW)
 */
export function paintedPBR(color, opts = {}) {
  const rough             = opts.rough             ?? 0.7;
  const metal             = opts.metal             ?? 0.0;
  const emissive          = opts.emissive          ?? 0x000000;
  const emissiveIntensity = opts.emissiveIntensity ?? (emissive !== 0x000000 ? 1.0 : 0.0);
  const transparent       = opts.transparent       ?? false;
  const opacity           = opts.opacity           ?? 1.0;
  const side              = opts.side              ?? THREE.FrontSide;
  const usePBR            = opts._alwaysPBR ?? Graphics.pbrEnabled;
  // 'fabric' | 'metal' | 'polymer' | 'skin' | null. Picks a procedural
  // normal+roughness map from textures.js so the surface picks up micro
  // highlights even before any baked map exists. Skipped on LOW.
  const detail            = opts.detail            ?? null;
  const normalScale       = opts.normalScale       ?? 0.6;

  const key = _key(color, rough, metal, emissive, emissiveIntensity, transparent, opacity, side, detail, normalScale, opts.envMapIntensity);

  if (usePBR) {
    let mat = _cachePBR.get(key);
    if (!mat) {
      const matOpts = {
        color,
        roughness: rough,
        metalness: metal,
        emissive,
        emissiveIntensity,
        transparent,
        opacity,
        side,
        // 0.55 keeps the sky-bake contribution visible without overdriving
        // every surface. Override per-material via opts.envMapIntensity for
        // genuinely metallic things that should still mirror the sky.
        envMapIntensity: opts.envMapIntensity ?? 0.55,
      };
      // Detail maps come from a procedural library. Only attach if the
      // current preset actually wants them and we have one for that name.
      if (detail && Graphics.envMapEnabled) {
        const maps = getDetailMaps()[detail];
        if (maps) {
          matOpts.normalMap    = maps.normal;
          matOpts.roughnessMap = maps.roughness;
          matOpts.normalScale  = new THREE.Vector2(normalScale, normalScale);
        }
      }
      mat = new THREE.MeshStandardMaterial(matOpts);
      _cachePBR.set(key, mat);
    }
    return mat;
  }

  // Lambert fallback for LOW. Emissive is preserved (Lambert supports it).
  let mat = _cacheLambert.get(key);
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({
      color,
      emissive,
      emissiveIntensity,
      transparent,
      opacity,
      side,
    });
    _cacheLambert.set(key, mat);
  }
  return mat;
}

/** Brushed-metal preset — gun barrels, slides, hard armour. */
export function metalPBR(color, opts = {}) {
  return paintedPBR(color, { rough: 0.35, metal: 0.85, detail: 'metal', normalScale: 0.4, ...opts });
}

/** Cloth / fabric preset — body suits, ropes, sandbags. */
export function fabricPBR(color, opts = {}) {
  return paintedPBR(color, { rough: 0.92, metal: 0.0, detail: 'fabric', normalScale: 0.6, ...opts });
}

/** Hard plastic / polymer preset — grip frames, scope housings, crates. */
export function polymerPBR(color, opts = {}) {
  return paintedPBR(color, { rough: 0.6, metal: 0.0, detail: 'polymer', normalScale: 0.3, ...opts });
}

/** Sub-surface / skin preset — cartoon flesh, simple matte read. */
export function skinPBR(color, opts = {}) {
  return paintedPBR(color, { rough: 0.85, metal: 0.0, detail: 'skin', normalScale: 0.2, ...opts });
}

/**
 * Drop-in replacement for `new THREE.MeshLambertMaterial({ color: hex })`
 * with default painted-surface PBR characteristics. Use this when migrating
 * existing inline `lm(hex)` helpers in builders.
 */
export function lambertCompat(color, opts = {}) {
  return paintedPBR(color, opts);
}

// ── Geometry helpers ────────────────────────────────────────────────────────
// Cached BoxGeometry-or-RoundedBoxGeometry per dimension. Returns a raw
// BoxGeometry on LOW (Graphics.bevelGeometry = false) so we pay zero extra
// vertex cost; HIGH/ULTRA use RoundedBoxGeometry with a small chamfer so
// silhouettes read as stylised stamped panels instead of voxel cubes.
//
// Cached instances are SHARED — callers must NOT mutate the returned geometry
// (e.g. don't .translate() it after; clone first if you need a unique copy).

/** Auto-chamfered box. `radius` should be ~1.5–3 % of the smallest dim. */
export function boxGeo(w, h, d, opts = {}) {
  const bevel = opts.bevel ?? Graphics.bevelGeometry;
  if (!bevel) {
    const k = `box|${w}|${h}|${d}`;
    let g = _cacheGeo.get(k);
    if (!g) { g = new THREE.BoxGeometry(w, h, d); _cacheGeo.set(k, g); }
    return g;
  }
  // RoundedBoxGeometry param ordering: (w, h, d, segments, radius). Radius is
  // clamped so it never exceeds half the smallest axis (RoundedBox will throw
  // otherwise). Segments=2 is the sweet spot — 1 looks crunchy, 3+ wastes verts.
  const minDim   = Math.min(w, h, d);
  const radius   = Math.min(opts.radius ?? Math.max(0.018, minDim * 0.07), minDim * 0.49);
  const segments = opts.segments ?? 2;
  const k = `bevel|${w}|${h}|${d}|${segments}|${radius.toFixed(4)}`;
  let g = _cacheGeo.get(k);
  if (!g) { g = new RoundedBoxGeometry(w, h, d, segments, radius); _cacheGeo.set(k, g); }
  return g;
}

/** Convenience: one-call mesh constructor. */
export function bevelBox(w, h, d, material, opts = {}) {
  const mesh = new THREE.Mesh(boxGeo(w, h, d, opts), material);
  mesh.castShadow = true;
  return mesh;
}
