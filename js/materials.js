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
import { Graphics } from './graphics.js';

const _cachePBR     = new Map();
const _cacheLambert = new Map();

/** Stable cache key from the option bag. */
function _key(color, rough, metal, emissive, emissiveIntensity, transparent, opacity, side) {
  return `${color}|${rough}|${metal}|${emissive}|${emissiveIntensity}|${transparent ? 1 : 0}|${opacity}|${side}`;
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

  const key = _key(color, rough, metal, emissive, emissiveIntensity, transparent, opacity, side);

  if (usePBR) {
    let mat = _cachePBR.get(key);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color,
        roughness: rough,
        metalness: metal,
        emissive,
        emissiveIntensity,
        transparent,
        opacity,
        side,
        envMapIntensity: 1.0,
      });
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
  return paintedPBR(color, { rough: 0.35, metal: 0.85, ...opts });
}

/** Cloth / fabric preset — body suits, ropes, sandbags. */
export function fabricPBR(color, opts = {}) {
  return paintedPBR(color, { rough: 0.92, metal: 0.0, ...opts });
}

/** Hard plastic / polymer preset — grip frames, scope housings, crates. */
export function polymerPBR(color, opts = {}) {
  return paintedPBR(color, { rough: 0.6, metal: 0.0, ...opts });
}

/** Sub-surface / skin preset — cartoon flesh, simple matte read. */
export function skinPBR(color, opts = {}) {
  return paintedPBR(color, { rough: 0.85, metal: 0.0, ...opts });
}

/**
 * Drop-in replacement for `new THREE.MeshLambertMaterial({ color: hex })`
 * with default painted-surface PBR characteristics. Use this when migrating
 * existing inline `lm(hex)` helpers in builders.
 */
export function lambertCompat(color, opts = {}) {
  return paintedPBR(color, opts);
}
