// ── Procedural detail-map library ────────────────────────────────────────────
// Generates a handful of small (256×256) normal + roughness maps at boot, kept
// in memory for the whole session. The PBR factory (materials.js) plugs them
// into MeshStandardMaterial via the `detail` option — every painted surface
// picks up micro highlights without us having to ship any binary textures.
//
// All maps are generated lazily: the first call to `getDetailMaps()` triggers
// generation, and the result is cached.
//
// Categories:
//   fabric  — diagonal weave (clothing, ropes, sandbags, parachute canopy)
//   metal   — horizontal brushed streaks (gun barrels, slides, hard armour)
//   polymer — low-frequency pebble noise (grips, scope housings, crates)
//   skin    — sparse pore noise (character faces and arms)

import * as THREE from 'three';

let _maps = null;

/** Returns { fabric, metal, polymer, skin }, each { normal, roughness }. */
export function getDetailMaps() {
  if (_maps) return _maps;
  _maps = {
    fabric:  _makeFabric(256),
    metal:   _makeMetal(256),
    polymer: _makePolymer(256),
    skin:    _makeSkin(256),
  };
  return _maps;
}

// ── Map builders ────────────────────────────────────────────────────────────
// Each writes RGBA buffers into a DataTexture. Normal encoding follows the
// GL convention (Z out of surface = +Z, encoded as (n*0.5+0.5)*255).

function _makeFabric(size) {
  // Diagonal interleaved weave: stack of warp threads + weft threads,
  // alternating which is on top. We compute a height field h(u,v), then
  // derive the normal map from h via finite-difference.
  const N = size;
  const heights = new Float32Array(N * N);
  const FREQ = 28;   // thread count across the texture
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;
      // Two perpendicular thread families. A small phase shift makes the
      // crossover visible without us having to model individual fibres.
      const warp = Math.sin(u * Math.PI * 2 * FREQ + Math.PI * 0.5);
      const weft = Math.sin(v * Math.PI * 2 * FREQ);
      // Pick whichever sine is higher = thread on top; floor amount controls
      // how round each thread looks.
      heights[y * N + x] = Math.max(warp, weft) * 0.5 + 0.5;
    }
  }
  return _heightsToTextures(heights, N, {
    normalStrength: 2.4,
    roughLow: 0.78,
    roughHigh: 0.94,
  });
}

function _makeMetal(size) {
  // Brushed metal: horizontal streaks of varying intensity. We seed a few
  // random per-row offsets so the streaks aren't perfectly straight.
  const N = size;
  const heights = new Float32Array(N * N);
  const rowJitter = new Float32Array(N);
  for (let r = 0; r < N; r++) rowJitter[r] = Math.random() * 0.4 - 0.2;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      // Many short brushstrokes per row, plus per-row brightness wobble.
      const s = Math.sin(u * Math.PI * 2 * 96 + y * 0.05) * 0.5 + 0.5;
      const wobble = rowJitter[y];
      heights[y * N + x] = THREE.MathUtils.clamp(s * 0.6 + wobble * 0.4 + 0.4, 0, 1);
    }
  }
  return _heightsToTextures(heights, N, {
    normalStrength: 1.2,
    roughLow: 0.28,
    roughHigh: 0.55,
  });
}

function _makePolymer(size) {
  // Mid-frequency value noise → pebble micro-bumps. Three octaves so the
  // surface has both a base shape and a finer grain.
  const N = size;
  const heights = new Float32Array(N * N);
  const rand = _mulberry(0xb15ed1);
  const cellSize = [16, 8, 4];     // smaller = finer
  const weights  = [0.55, 0.30, 0.15];
  const grids = cellSize.map(cs => _valueNoiseGrid(N / cs, rand));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let h = 0;
      for (let o = 0; o < cellSize.length; o++) {
        h += _sampleGrid(grids[o], x / cellSize[o], y / cellSize[o]) * weights[o];
      }
      heights[y * N + x] = h;
    }
  }
  return _heightsToTextures(heights, N, {
    normalStrength: 1.6,
    roughLow: 0.55,
    roughHigh: 0.72,
  });
}

function _makeSkin(size) {
  // Pores: sparse dots at random positions, low contrast.
  const N = size;
  const heights = new Float32Array(N * N).fill(0.55);
  const rand = _mulberry(0x5c1d23);
  const PORE_COUNT = 1400;
  for (let i = 0; i < PORE_COUNT; i++) {
    const cx = Math.floor(rand() * N);
    const cy = Math.floor(rand() * N);
    const r  = 1 + Math.floor(rand() * 2);
    const depth = 0.05 + rand() * 0.08;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const xx = (cx + dx + N) % N;
        const yy = (cy + dy + N) % N;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > r) continue;
        const k = 1 - d / r;
        heights[yy * N + xx] -= depth * k;
      }
    }
  }
  return _heightsToTextures(heights, N, {
    normalStrength: 0.9,
    roughLow: 0.72,
    roughHigh: 0.86,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a heightmap to (normalMap, roughnessMap) DataTextures.
 * Normal: central-difference of h, encoded GL-style.
 * Roughness: linear interp from roughLow..roughHigh over h.
 */
function _heightsToTextures(h, N, opts) {
  const { normalStrength, roughLow, roughHigh } = opts;
  const normalData = new Uint8Array(N * N * 4);
  const roughData  = new Uint8Array(N * N * 4);
  const idx = (x, y) => ((y + N) % N) * N + ((x + N) % N);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const hC = h[idx(x, y)];
      const hL = h[idx(x - 1, y)];
      const hR = h[idx(x + 1, y)];
      const hU = h[idx(x, y - 1)];
      const hD = h[idx(x, y + 1)];
      let nx = (hL - hR) * normalStrength;
      let ny = (hU - hD) * normalStrength;
      let nz = 1.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len; ny /= len; nz /= len;
      normalData[i + 0] = Math.round((nx * 0.5 + 0.5) * 255);
      normalData[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalData[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normalData[i + 3] = 255;
      const r = roughLow + (roughHigh - roughLow) * hC;
      const rb = Math.round(THREE.MathUtils.clamp(r, 0, 1) * 255);
      // MeshStandardMaterial reads the GREEN channel of the roughnessMap.
      // Filling all three channels keeps things readable in tooling too.
      roughData[i + 0] = rb;
      roughData[i + 1] = rb;
      roughData[i + 2] = rb;
      roughData[i + 3] = 255;
    }
  }
  return {
    normal:    _makeDataTexture(normalData, N),
    roughness: _makeDataTexture(roughData, N),
  };
}

function _makeDataTexture(buf, size) {
  const t = new THREE.DataTexture(buf, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  // Normal + roughness are data, not color → no sRGB conversion.
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// 2D value-noise scaffolding for the polymer pattern.
function _mulberry(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function _valueNoiseGrid(cells, rand) {
  cells = Math.max(2, Math.ceil(cells));
  const arr = new Float32Array(cells * cells);
  for (let i = 0; i < arr.length; i++) arr[i] = rand();
  return { cells, arr };
}

function _sampleGrid(grid, fx, fy) {
  const { cells, arr } = grid;
  const x  = ((fx % cells) + cells) % cells;
  const y  = ((fy % cells) + cells) % cells;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
  const tx = x - x0, ty = y - y0;
  // Smoothstep
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = arr[y0 * cells + x0];
  const b = arr[y0 * cells + x1];
  const c = arr[y1 * cells + x0];
  const d = arr[y1 * cells + x1];
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}
