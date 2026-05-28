import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Graphics } from './graphics.js';
import { paintedPBR, polymerPBR } from './materials.js';

// ── Seeded PRNG (LCG) — for reproducible tree/prop/cloud placement ───────────
const WORLD_SEED = 42;
function makePRNG(seed = WORLD_SEED) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s, 1664525) + 1013904223 | 0;
    return (s >>> 0) / 0x100000000;
  };
}

// Simple seeded noise — no external dependency needed
function hash(n) {
  let x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

function noise2D(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix + iz * 57);
  const b = hash(ix + 1 + iz * 57);
  const c = hash(ix + (iz + 1) * 57);
  const d = hash(ix + 1 + (iz + 1) * 57);
  return a + (b - a) * ux + (c - a) * uz + (d - a + (a - b - c + d) * ux) * uz;
}

function fbm(x, z, octaves = 6) {
  let val = 0, amp = 0.5, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    val += noise2D(x * freq, z * freq) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return val / max;
}

// Ridged noise — inverted absolute value gives sharp mountain ridges
function ridged(x, z, octaves = 5) {
  let val = 0, amp = 0.5, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    val += (1.0 - Math.abs(noise2D(x * freq, z * freq) * 2 - 1)) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2.2;
  }
  return val / max;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── StaticCollider ────────────────────────────────────────────────────────────
// Axis-aligned wall boxes and horizontal floor surfaces for world structures.
class StaticCollider {
  constructor() { this._boxes = []; this._floors = []; }

  // yBase = world-space bottom of box, height = total height
  addBox(cx, yBase, cz, hw, height, hd) {
    this._boxes.push({ cx, y: yBase, cz, hw, height, hd });
  }
  addFloor(cx, yFloor, cz, hw, hd) {
    this._floors.push({ cx, y: yFloor, cz, hw, hd });
  }

  getHeightAt(wx, wz, playerY) {
    let maxH = null;
    for (const f of this._floors) {
      if (Math.abs(wx - f.cx) <= f.hw && Math.abs(wz - f.cz) <= f.hd) {
        if (playerY >= f.y - 0.4) {
          maxH = maxH === null ? f.y : Math.max(maxH, f.y);
        }
      }
    }
    return maxH;
  }

  // Returns true if the line segment from p0 to p1 passes through any collision box.
  checkBullet(p0, p1) {
    // Slab method (Kay-Kajiya) for segment–AABB intersection.
    const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
    for (const b of this._boxes) {
      const x0 = b.cx - b.hw, x1 = b.cx + b.hw;
      const y0 = b.y,         y1 = b.y + b.height;
      const z0 = b.cz - b.hd, z1 = b.cz + b.hd;
      let tmin = 0, tmax = 1;
      for (const [o, d, lo, hi] of [
        [p0.x, dx, x0, x1],
        [p0.y, dy, y0, y1],
        [p0.z, dz, z0, z1],
      ]) {
        if (Math.abs(d) < 1e-9) {
          if (o < lo || o > hi) { tmin = 1; break; }
        } else {
          let t1 = (lo - o) / d, t2 = (hi - o) / d;
          if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
          tmin = Math.max(tmin, t1);
          tmax = Math.min(tmax, t2);
          if (tmin > tmax) break;
        }
      }
      if (tmin <= tmax) return true;
    }
    return false;
  }

  /**
   * Like checkBullet but returns the parametric distance (0..1) along the
   * segment where the first wall hit occurs, or 1 if the segment passes
   * cleanly. Used to truncate visual beams (laser, tracer) so they don't
   * pierce walls even though the damage projectile already stops cleanly.
   */
  raycastDistance(p0, p1) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
    let bestT = 1;
    for (const b of this._boxes) {
      const x0 = b.cx - b.hw, x1 = b.cx + b.hw;
      const y0 = b.y,         y1 = b.y + b.height;
      const z0 = b.cz - b.hd, z1 = b.cz + b.hd;
      let tmin = 0, tmax = 1;
      for (const [o, d, lo, hi] of [
        [p0.x, dx, x0, x1],
        [p0.y, dy, y0, y1],
        [p0.z, dz, z0, z1],
      ]) {
        if (Math.abs(d) < 1e-9) {
          if (o < lo || o > hi) { tmin = 1; break; }
        } else {
          let t1 = (lo - o) / d, t2 = (hi - o) / d;
          if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
          tmin = Math.max(tmin, t1);
          tmax = Math.min(tmax, t2);
          if (tmin > tmax) break;
        }
      }
      if (tmin <= tmax && tmin >= 0 && tmin < bestT) bestT = tmin;
    }
    return bestT;
  }

  getWallPush(wx, wy, wz, radius) {
    let pushX = 0, pushZ = 0;
    for (const b of this._boxes) {
      if (wy + 2.1 < b.y || wy > b.y + b.height) continue;
      const dx = wx - b.cx, dz = wz - b.cz;
      if (Math.abs(dx) > b.hw + radius || Math.abs(dz) > b.hd + radius) continue;
      const cx    = Math.max(-b.hw, Math.min(b.hw, dx));
      const cz2   = Math.max(-b.hd, Math.min(b.hd, dz));
      const nearX = dx - cx, nearZ = dz - cz2;
      const dist  = Math.sqrt(nearX * nearX + nearZ * nearZ);
      if (dist >= radius) continue;
      let plx, plz;
      if (dist < 0.001) {
        const overX = b.hw + radius - Math.abs(dx);
        const overZ = b.hd + radius - Math.abs(dz);
        if (overZ < overX) { plx = 0; plz = Math.sign(dz) * overZ; }
        else               { plx = Math.sign(dx) * overX; plz = 0; }
      } else {
        const mag = radius - dist;
        plx = (nearX / dist) * mag; plz = (nearZ / dist) * mag;
      }
      pushX += plx; pushZ += plz;
    }
    return (pushX !== 0 || pushZ !== 0) ? { x: pushX, z: pushZ } : null;
  }
}

export class World {
  constructor(scene, renderer = null) {
    this.scene = scene;
    this.renderer = renderer;          // required for PMREM bake; null skips IBL
    this.size = 800;
    this.heightmap = null;
    this.resolution = 256;
    this.terrainMesh = null;
    this.trees = [];
    this.structures = [];
    this.waterLevel = -2;
    this.staticCollider = new StaticCollider();
  }

  generate() {
    this._rng = makePRNG(WORLD_SEED);
    this._buildSky();
    this._buildLights();
    this._buildTerrain();
    this._buildWater();
    this._buildTrees();
    this._buildStructures();
    this._buildProps();
    // Final pass: walk the scene graph and swap every plain Lambert material
    // for a cached PBR equivalent so structures/trees/props pick up real
    // specular response from the baked sky envMap. ShaderMaterial (terrain,
    // water) and glTF-imported materials are skipped.
    this._promoteMaterialsToPBR();
  }

  _promoteMaterialsToPBR() {
    if (!Graphics.pbrEnabled) return;
    const upgrade = (mat) => {
      if (!mat || !mat.isMeshLambertMaterial) return mat;
      if (mat.map || mat.normalMap) return mat;   // textured (glTF) — leave alone
      return paintedPBR(mat.color.getHex(), {
        emissive:          mat.emissive ? mat.emissive.getHex() : 0x000000,
        emissiveIntensity: mat.emissiveIntensity ?? 1.0,
        transparent:       mat.transparent,
        opacity:           mat.opacity,
        side:              mat.side,
      });
    };
    this.scene.traverse(obj => {
      if (!obj.isMesh && !obj.isInstancedMesh) return;
      const m = obj.material;
      if (Array.isArray(m)) obj.material = m.map(upgrade);
      else                  obj.material = upgrade(m);
    });
  }

  // ── Sky ─────────────────────────────────────────────────────────────
  _buildSky() {
    // HIGH/MEDIUM/ULTRA: physically-based atmospheric Sky from three/addons.
    // LOW: the original cheap inverted-sphere gradient (no per-pixel cost).
    if (Graphics.skyShaderEnabled) {
      this._buildSkyShader();
    } else {
      this._buildSkyGradient();
    }
    // Clouds layer is preset-gated (cloudCount). Skip entirely on extreme low.
    if (Graphics.cloudCount > 0) this._buildClouds();
  }

  // Original cheap path — vertex-coloured sphere + sun disc + glow.
  _buildSkyGradient() {
    const geo = new THREE.SphereGeometry(1800, 32, 16);
    geo.scale(-1, 1, 1);

    const colors = [];
    const positions = geo.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i);
      const t = (y + 1800) / 3600;
      const top    = new THREE.Color(0x1a3a6b);
      const mid    = new THREE.Color(0x5b9bd5);
      const horiz  = new THREE.Color(0xf4a261);
      let c;
      if (t > 0.5) c = mid.clone().lerp(top, (t - 0.5) * 2);
      else         c = horiz.clone().lerp(mid, t * 2);
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide,
    }));
    this.scene.add(sky);

    const sunGeo = new THREE.CircleGeometry(40, 32);
    const sun = new THREE.Mesh(sunGeo, new THREE.MeshBasicMaterial({ color: 0xfffde0 }));
    sun.position.set(600, 800, -1200);
    this.scene.add(sun);

    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(80, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd580, transparent: true, opacity: 0.2 }),
    );
    glow.position.set(600, 800, -1200.5);
    this.scene.add(glow);
  }

  // Atmospheric Sky shader + PMREM-baked environment for IBL. Sun direction
  // is aligned with the directional light in _buildLights so highlights match
  // shadow direction. PMREM bake is one-time on world load (~80 ms).
  _buildSkyShader() {
    // Sun direction matches the existing directional light at (200, 400, -300).
    // Compute elevation/azimuth from that vector so terrain + Sky agree.
    const sunWorld = new THREE.Vector3(200, 400, -300);
    const sunDir   = sunWorld.clone().normalize();
    this._sunDir   = sunDir.clone();

    const sky = new Sky();
    sky.scale.setScalar(450000);
    const u = sky.material.uniforms;
    // Soft late-afternoon atmosphere — keeps the sky readable as sky without
    // blowing past the bloom threshold or dumping IBL energy. Each knob
    // contributes:
    //   rayleigh    — overall sky scattering brightness (blue channel dominant)
    //   turbidity   — haze around the sun, affects both sky and sun-disc spread
    //   mie*        — directional/glow scattering toward the sun
    u.turbidity.value        = 1.0;
    u.rayleigh.value         = 0.35;
    // Mie controls the sun-glow halo. Earlier passes kept producing a
    // bright ring around the sun, so mie is pushed near-zero: the sun
    // disc is barely visible and there's no halation at all. Direct sun
    // illumination still comes from the DirectionalLight, which is
    // separate from the Sky shader.
    u.mieCoefficient.value   = 0.0001;
    u.mieDirectionalG.value  = 0.40;
    u.sunPosition.value.copy(sunDir);
    this.scene.add(sky);
    this._sky = sky;

    // Background sample of the sky drives ambient fallback when scene.environment
    // is unavailable (e.g. envMap bake skipped). Cheap colour pick at horizon.
    this.scene.background = new THREE.Color(0x9ec8e8);

    // PMREM bake — converts the sky render into a roughness-prefiltered env
    // map used by every MeshStandardMaterial for IBL (image-based lighting).
    // Without this PBR materials look flat/grey indoors.
    if (Graphics.envMapEnabled && this.renderer) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      pmrem.compileEquirectangularShader();
      // Render the sky into a small cubemap and prefilter for roughness mips.
      // Using `fromScene` with just the sky group keeps the bake fast and
      // avoids picking up unfinished terrain colour.
      const skyOnlyScene = new THREE.Scene();
      const skyClone = sky.clone();
      skyClone.material = sky.material;       // share uniforms
      skyOnlyScene.add(skyClone);
      const envRT = pmrem.fromScene(skyOnlyScene, 0.04);
      this.scene.environment = envRT.texture;
      this._envMap = envRT.texture;
      pmrem.dispose();
    }
  }

  _buildClouds() {
    const rng = this._rng;
    const cloudGeo = new THREE.SphereGeometry(1, 7, 5);
    // Clouds stay Lambert-cheap regardless of preset — PBR on clouds would
    // pick up sun specular and look like wet glass at low altitude.
    const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.88 });

    const cloudCount = Graphics.cloudCount ?? 24;
    for (let i = 0; i < cloudCount; i++) {
      const group = new THREE.Group();
      const puffs = 3 + Math.floor(rng() * 4);
      for (let p = 0; p < puffs; p++) {
        const mesh = new THREE.Mesh(cloudGeo, cloudMat);
        const sx = 30 + rng() * 50;
        const sy = 14 + rng() * 20;
        const sz = 20 + rng() * 30;
        mesh.scale.set(sx, sy, sz);
        mesh.position.set(
          (rng() - 0.5) * sx * 2,
          (rng() - 0.5) * sy * 0.5,
          (rng() - 0.5) * sz
        );
        group.add(mesh);
      }
      group.position.set(
        (rng() - 0.5) * 1200,
        250 + rng() * 150,
        (rng() - 0.5) * 1200
      );
      this.scene.add(group);
      group.userData.cloudSpeed = 0.5 + rng() * 1.5;
      this._clouds = this._clouds || [];
      this._clouds.push(group);
    }
  }

  // ── Lights ──────────────────────────────────────────────────────────
  _buildLights() {
    // When PBR + IBL are active, ambient + hemi contribute on TOP of the
    // baked envMap; without dialling them down the scene blows out. On LOW
    // (no IBL) keep the original warmer values so shading stays the same.
    // These are aggressive on purpose — IBL already delivers wraparound
    // sky+ground contribution, so hemi/ambient are mostly for tint.
    const iblActive = Graphics.envMapEnabled && Graphics.pbrEnabled;
    const hemiInt   = iblActive ? 0.20 : 1.00;
    const ambInt    = iblActive ? 0.08 : 0.60;
    const sunInt    = iblActive ? 1.80 : 2.60;

    const hemi = new THREE.HemisphereLight(0x9ed7ff, 0x6a9968, hemiInt);
    this.scene.add(hemi);

    const ambient = new THREE.AmbientLight(0xbcd6ee, ambInt);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfff1c8, sunInt);
    sun.position.set(200, 400, -300);
    sun.castShadow = Graphics.shadowsEnabled;
    const smap = Graphics.shadowMapSize ?? 1024;
    sun.shadow.mapSize.set(smap, smap);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 750;
    // Tight ortho — the shadow camera now follows the player (see
    // updateShadowFollow) so we don't need to cover the whole 340-unit map.
    // At 60 units half-width with 1024 texels, that's ~9 texels per metre
    // (vs ~3 with the old 170-unit bounds) — much sharper close-up shadows
    // at no extra cost.
    sun.shadow.camera.left = -60;
    sun.shadow.camera.right = 60;
    sun.shadow.camera.top = 60;
    sun.shadow.camera.bottom = -60;
    sun.shadow.bias = -0.001;
    this.scene.add(sun);
    // Target must live in the scene graph for transforms to update.
    this.scene.add(sun.target);
    // Expose for per-frame follow updates.
    this._sun = sun;
    this._sunOffset = new THREE.Vector3(200, 400, -300);

    const fill = new THREE.DirectionalLight(0xa0c8ff, 0.5);
    fill.position.set(-200, 100, 200);
    this.scene.add(fill);
  }

  // ── Terrain ─────────────────────────────────────────────────────────
  _buildTerrain() {
    const R = this.resolution;
    const S = this.size;
    const geo = new THREE.PlaneGeometry(S, S, R - 1, R - 1);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    this.heightmap = new Float32Array(R * R);

    for (let i = 0; i < R; i++) {
      for (let j = 0; j < R; j++) {
        const nx = (i / R) * 4 - 2;
        const nz = (j / R) * 4 - 2;

        // Slightly elliptical island shape for visual variety
        const dist = Math.sqrt(nx * nx * 0.88 + nz * nz * 1.12);
        const island  = Math.max(0, 1.0 - dist / 1.9);
        const falloff = island * island * (3 - 2 * island);

        // Gentle domain warp for organic coastlines without choppiness
        const wx = fbm(nx * 0.9 + 1.7, nz * 0.9 + 9.2, 3) - 0.5;
        const wz = fbm(nx * 0.9 + 8.3, nz * 0.9 + 2.8, 3) - 0.5;
        const sx = nx + wx * 0.25, sz = nz + wz * 0.25;

        // Low-frequency base gives broad, rolling hills — fewer octaves = smoother
        const base = fbm(sx * 1.4, sz * 1.4, 5);

        // Very subtle ridge accent only on the highest peaks (no sharp spikes)
        const r = ridged(sx * 1.8, sz * 1.8, 3);
        const ridgeBlend = clamp((base - 0.60) * 4.0, 0, 1);
        const combined = base * 0.92 + r * 0.08 * ridgeBlend;

        const h = combined * 44 * falloff - 3;
        const idx = i * R + j;
        this.heightmap[idx] = h;
        pos.setY(idx, h);
      }
    }

    // Flatten terrain around each POI so structures sit on level ground
    // Sort largest-radius-first so smaller zones always apply last and win any overlap conflict.
    const flatZones = [
      { x:  100, z:    0, r: 90 },   // Cedar Creek
      { x: -118, z:   50, r: 55  },  // Frank's Jail — small radius so it applies AFTER
                                      // Military Compound (r=88) and wins the overlap.
                                      // Hard r=46.75 still covers the full compound footprint
                                      // (max extent ~38 from centroid).
      { x:   35, z: -160, r: 90 },   // Ancient Temple
      { x:  -50, z:   80, r: 88 },   // Military Compound
      { x:  150, z:  -75, r: 100 },  // Olsen's Farm
      { x: -125, z: -120, r: 105 },  // Whalen's Town
      { x:  190, z:  120, r: 85  },  // Samuel's Mansion + secret tunnel route + exit
    ].sort((a, b) => b.r - a.r);
    // Pre-compute target heights from the raw heightmap before any zone modifies it.
    const rawHeightmap = this.heightmap.slice();
    const rawGet = (x, z) => {
      const hx = (x / S + 0.5) * (R - 1), hz = (z / S + 0.5) * (R - 1);
      const ix = Math.floor(hx), iz = Math.floor(hz);
      if (ix < 0 || ix >= R - 1 || iz < 0 || iz >= R - 1) return -2;
      const fx = hx - ix, fz = hz - iz;
      return rawHeightmap[iz*R+ix]*(1-fx)*(1-fz) + rawHeightmap[iz*R+(ix+1)]*fx*(1-fz) +
             rawHeightmap[(iz+1)*R+ix]*(1-fx)*fz + rawHeightmap[(iz+1)*R+(ix+1)]*fx*fz;
    };
    for (const zone of flatZones) {
      const targetH = Math.max(1.5, rawGet(zone.x, zone.z));

      // 85% of radius is fully flat, outer 15% fades cubically back to terrain
      const hardR = zone.r * 0.85;
      for (let i = 0; i < R; i++) {
        for (let j = 0; j < R; j++) {
          const wx = (j / (R - 1) - 0.5) * S;
          const wz = (i / (R - 1) - 0.5) * S;
          const d = Math.sqrt((wx - zone.x) ** 2 + (wz - zone.z) ** 2);
          if (d >= zone.r) continue;
          let blend;
          if (d <= hardR) {
            blend = 1.0;
          } else {
            const s = 1.0 - (d - hardR) / (zone.r - hardR);
            blend = s * s * s;
          }
          const idx = i * R + j;
          this.heightmap[idx] = this.heightmap[idx] * (1 - blend) + targetH * blend;
          pos.setY(idx, this.heightmap[idx]);
        }
      }
    }

    geo.computeVertexNormals();

    const loader = new THREE.TextureLoader();
    const loadTex = (path, sRGB = true) => {
      const t = loader.load(path);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 16;
      if (sRGB) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };

    const tGrass     = loadTex('textures/grass/Grass004_1K-JPG_Color.jpg');
    const tGrassNorm = loadTex('textures/grass/Grass004_1K-JPG_NormalGL.jpg', false);
    const tRock      = loadTex('textures/rock/Ground081_2K-JPG_Color.jpg');
    const tRockNorm  = loadTex('textures/rock/Ground081_2K-JPG_NormalGL.jpg', false);
    const tSand      = loadTex('textures/sand/Ground054_2K-JPG_Color.jpg');
    const tSandNorm  = loadTex('textures/sand/Ground054_2K-JPG_NormalGL.jpg', false);
    const tSnow      = loadTex('textures/snow/Snow014_2K-JPG_Color.jpg');
    const tSnowNorm  = loadTex('textures/snow/Snow014_2K-JPG_NormalGL.jpg', false);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tGrass:     { value: tGrass },
        tGrassNorm: { value: tGrassNorm },
        tRock:      { value: tRock },
        tRockNorm:  { value: tRockNorm },
        tSand:      { value: tSand },
        tSandNorm:  { value: tSandNorm },
        tSnow:      { value: tSnow },
        tSnowNorm:  { value: tSnowNorm },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vTangent;
        varying vec3 vBitangent;
        varying float vHeight;
        varying vec3 vWorldPos;
        void main() {
          vec3 n = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
          // Build a tangent frame from world normal
          vec3 up   = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
          vec3 t    = normalize(cross(up, n));
          vec3 b    = cross(n, t);
          vNormal    = n;
          vTangent   = t;
          vBitangent = b;
          vHeight   = position.y;
          vec4 wp   = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform sampler2D tGrass;     uniform sampler2D tGrassNorm;
        uniform sampler2D tRock;      uniform sampler2D tRockNorm;
        uniform sampler2D tSand;      uniform sampler2D tSandNorm;
        uniform sampler2D tSnow;      uniform sampler2D tSnowNorm;
        varying vec3 vNormal;
        varying vec3 vTangent;
        varying vec3 vBitangent;
        varying float vHeight;
        varying vec3 vWorldPos;

        // Decode a GL normal map sample into tangent-space normal
        vec3 decodeNormal(sampler2D nm, vec2 uv) {
          vec3 n = texture2D(nm, uv).rgb * 2.0 - 1.0;
          return normalize(n);
        }

        // Transform tangent-space normal to world space
        vec3 toWorld(vec3 tn) {
          return normalize(vTangent * tn.x + vBitangent * tn.y + vNormal * tn.z);
        }

        void main() {
          float h = vHeight;
          vec3  geoN = normalize(vNormal);
          float slope = 1.0 - geoN.y;

          // UV scales
          vec2 uvA = vWorldPos.xz * 0.018;
          vec2 uvB = vWorldPos.xz * 0.09;
          vec2 uvC = vWorldPos.xz * 0.38;

          // --- Albedo sampling ---
          vec3 sand  = mix(texture2D(tSand,  uvA * 1.3).rgb, texture2D(tSand,  uvB * 1.3).rgb, 0.45);
          vec3 grass = mix(texture2D(tGrass, uvA).rgb,       texture2D(tGrass, uvB).rgb, 0.40);
               grass = mix(grass, texture2D(tGrass, uvC).rgb, 0.18);

          // Triplanar rock
          vec3 triBlend = abs(geoN);
          triBlend = pow(triBlend, vec3(5.0));
          triBlend /= triBlend.x + triBlend.y + triBlend.z;
          vec3 rockXZ = mix(texture2D(tRock, vWorldPos.xz * 0.020).rgb, texture2D(tRock, vWorldPos.xz * 0.095).rgb, 0.45);
          vec3 rockXY = mix(texture2D(tRock, vWorldPos.xy * 0.020).rgb, texture2D(tRock, vWorldPos.xy * 0.095).rgb, 0.45);
          vec3 rockZY = mix(texture2D(tRock, vWorldPos.zy * 0.020).rgb, texture2D(tRock, vWorldPos.zy * 0.095).rgb, 0.45);
          vec3 rock   = rockXZ * triBlend.y + rockXY * triBlend.z + rockZY * triBlend.x;
               rock   = mix(rock, texture2D(tRock, uvC * 0.6).rgb, 0.14);

          vec3 snow  = mix(texture2D(tSnow, uvA * 0.55).rgb, texture2D(tSnow, uvB * 0.55).rgb, 0.40);

          // --- Blend weights ---
          float wSand  = 1.0 - smoothstep(-2.5, 1.8, h);
          float wGrass = smoothstep(-2.5, 1.8, h) * (1.0 - smoothstep(0.28, 0.50, slope)) * (1.0 - smoothstep(18.0, 26.0, h));
          float wRock  = smoothstep(0.28, 0.50, slope) + smoothstep(18.0, 26.0, h) * (1.0 - smoothstep(28.0, 38.0, h));
          float wSnow  = smoothstep(28.0, 38.0, h);
          float wTotal = wSand + wGrass + wRock + wSnow + 0.0001;
          wSand /= wTotal; wGrass /= wTotal; wRock /= wTotal; wSnow /= wTotal;

          vec3 color = sand * wSand + grass * wGrass + rock * wRock + snow * wSnow;

          // --- Normal map blending ---
          vec3 nSand  = decodeNormal(tSandNorm,  uvA * 1.3);
          vec3 nGrass = decodeNormal(tGrassNorm, uvB);
          vec3 nRock  = decodeNormal(tRockNorm,  uvB * 0.95);
          vec3 nSnow  = decodeNormal(tSnowNorm,  uvA * 0.55);
          vec3 tn     = normalize(nSand * wSand + nGrass * wGrass + nRock * wRock + nSnow * wSnow);
          vec3 n      = toWorld(tn);

          // --- Lighting ---
          vec3  sunDir = normalize(vec3(200.0, 400.0, -300.0));
          float diff   = max(dot(n, sunDir), 0.0);
          float hemi   = dot(n, vec3(0.0, 1.0, 0.0)) * 0.5 + 0.5;
          vec3  amb    = mix(vec3(0.16, 0.24, 0.16), vec3(0.40, 0.58, 0.70), hemi);
          color = color * (amb + vec3(0.98, 0.88, 0.66) * diff * 0.82);

          // --- Fog ---
          float fogDist = length(vWorldPos - cameraPosition);
          float fogF    = 1.0 - exp(-0.0045 * 0.0045 * fogDist * fogDist);
          color = mix(color, vec3(0.529, 0.808, 0.922), clamp(fogF, 0.0, 1.0));

          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });

    this.terrainMesh = new THREE.Mesh(geo, mat);
    this.terrainMesh.receiveShadow = true;
    this.scene.add(this.terrainMesh);
  }

  _buildWater() {
    const S = this.size;
    this._waterUniforms = { time: { value: 0 } };

    const mat = new THREE.ShaderMaterial({
      uniforms: this._waterUniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `
        uniform float time;
        varying vec2 vUv;
        varying float vWave;
        void main() {
          vUv = uv;
          vec3 p = position;
          float w = sin(p.x * 0.07 + time * 1.1) * 0.28
                  + sin(p.z * 0.11 + time * 0.85) * 0.22
                  + sin((p.x + p.z) * 0.05 + time * 1.4) * 0.16;
          p.y += w;
          vWave = w;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform float time;
        varying vec2 vUv;
        varying float vWave;
        void main() {
          float ripple = sin(vUv.x * 38.0 + time * 1.8) * sin(vUv.y * 38.0 + time * 1.4) * 0.5 + 0.5;
          vec3 deep    = vec3(0.01, 0.22, 0.38);
          vec3 shallow = vec3(0.08, 0.48, 0.68);
          vec3 foam    = vec3(0.60, 0.85, 0.96);
          vec3 color   = mix(deep, shallow, ripple * 0.55 + 0.28);
          color = mix(color, foam, smoothstep(0.22, 0.44, vWave + 0.3) * 0.55);
          gl_FragColor = vec4(color, 0.82);
        }
      `,
    });

    const geo = new THREE.PlaneGeometry(S * 3, S * 3, 48, 48);
    geo.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(geo, mat);
    water.position.y = this.waterLevel;
    this.scene.add(water);
    this._waterMat = mat;
  }

  // ── Trees ───────────────────────────────────────────────────────────
  _buildTrees() {
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5c3d1e });
    const leaf1Mat = new THREE.MeshLambertMaterial({ color: 0x2d7a2d });
    const leaf2Mat = new THREE.MeshLambertMaterial({ color: 0x1a5c1a });
    const palmMat  = new THREE.MeshLambertMaterial({ color: 0x8bc34a });

    const S = this.size;
    const rng = this._rng;

    // Trees never move and aren't collision objects, so instead of ~2400 small
    // meshes (one Group of cylinders/cones per tree) we bake every part's
    // transform into its geometry and merge into one static mesh per material.
    // Result is pixel-identical but turns ~2400 draw calls into 4.
    const buckets = { trunk: [], leaf1: [], leaf2: [], palm: [] };
    const treeMat = new THREE.Matrix4();

    const treeAttempts = Graphics.treeAttempts ?? 600;
    for (let attempt = 0; attempt < treeAttempts; attempt++) {
      const x = (rng() - 0.5) * S * 0.78;
      const z = (rng() - 0.5) * S * 0.78;
      const h = this._getHeight(x, z);
      if (h < 0.5 || h > 24) continue;

      treeMat.makeRotationY(rng() * Math.PI * 2);
      treeMat.setPosition(x, h, z);

      const parts = (h < 3.5) ? this._makePalmTree(rng) : this._makePineTree(rng);
      for (const part of parts) {
        part.geo.applyMatrix4(treeMat);   // bake tree world transform
        buckets[part.bucket].push(part.geo);
      }

      // Trunk collider — thin box, ~4m tall, covers torso-to-head level so
      // bullets can't phase through a tree and players can hide behind one.
      // The existing slab method + bounding-box early exit make this cheap
      // even with ~600 trees: distant boxes drop out in a single subtract.
      this.staticCollider.addBox(x, h, z, 0.30, 4.0, 0.30);
    }

    const addMerged = (geos, mat, castShadow) => {
      if (!geos.length) return;
      const merged = mergeGeometries(geos);
      geos.forEach(g => g.dispose());
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = castShadow;
      this.scene.add(mesh);
      this.trees.push(mesh);
    };
    addMerged(buckets.trunk, trunkMat, true);   // pine + palm trunks (cast)
    addMerged(buckets.leaf1, leaf1Mat, true);   // pine cones (cast)
    addMerged(buckets.leaf2, leaf2Mat, true);   // pine cones (cast)
    addMerged(buckets.palm,  palmMat,  false);  // palm fronds (no shadow, as before)
  }

  // Returns [{ geo, bucket }] — each geometry has its part-local transform
  // already baked in, ready to be merged by _buildTrees.
  _makePineTree(rng = Math.random) {
    const parts = [];
    const height = 4 + rng() * 5;

    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, height * 0.55, 7);
    trunkGeo.translate(0, height * 0.27, 0);
    parts.push({ geo: trunkGeo, bucket: 'trunk' });

    const layers = 3 + Math.floor(rng() * 2);
    for (let l = 0; l < layers; l++) {
      const t = l / (layers - 1);
      const r = (0.9 - t * 0.5) * (height * 0.28);
      const coneGeo = new THREE.ConeGeometry(r, height * 0.38, 8);
      coneGeo.translate(0, height * 0.38 + l * height * 0.22, 0);
      parts.push({ geo: coneGeo, bucket: l % 2 === 0 ? 'leaf1' : 'leaf2' });
    }
    return parts;
  }

  _makePalmTree(rng = Math.random) {
    const parts = [];
    const height = 5 + rng() * 4;
    const m = new THREE.Matrix4();

    // Curved trunk segments
    for (let s = 0; s < 5; s++) {
      const segGeo = new THREE.CylinderGeometry(0.12, 0.2, height / 5, 7);
      m.makeRotationX((rng() - 0.5) * 0.1);
      m.setPosition(0, (s + 0.5) * (height / 5), 0);
      segGeo.applyMatrix4(m);
      parts.push({ geo: segGeo, bucket: 'trunk' });
    }

    // Palm fronds
    const fronds = 6 + Math.floor(rng() * 4);
    for (let f = 0; f < fronds; f++) {
      const angle = (f / fronds) * Math.PI * 2;
      const frondGeo = new THREE.ConeGeometry(0.15, 2.5 + rng(), 5);
      m.makeRotationFromEuler(new THREE.Euler(0.5 + rng() * 0.4, 0, angle + Math.PI / 2));
      m.setPosition(Math.cos(angle) * 0.3, height, Math.sin(angle) * 0.3);
      frondGeo.applyMatrix4(m);
      parts.push({ geo: frondGeo, bucket: 'palm' });
    }
    return parts;
  }

  // ── Points of Interest ──────────────────────────────────────────────
  get pois() { return this._pois; }

  // ── Structures ──────────────────────────────────────────────────────
  _buildStructures() {
    this._pois = [];
    const sc = this.staticCollider;
    const place = (group, px, pz, name) => {
      this._placeStructure(group, px, pz);
      this._pois.push({ name, x: px, z: pz });
    };

    let h;
    // ── Cedar Creek ──────────────────────────────────────────────────
    h = Math.max(0, this._getHeight(100, 0));
    place(this._makeCedarCreek(), 100, 0, 'Cedar Creek');
    // Main cabin walls (w=14,h=6,d=9 → hw=7,hh=6,hd=4.5, doorW=2.2→dw=1.1)
    { const t=0.15,cx=100,cz=0,hw=7,hh=6,hd=4.5,dw=1.1;
      sc.addBox(cx, h, cz+hd, hw, hh, t);       // back
      sc.addBox(cx-hw, h, cz, t, hh, hd);        // left
      sc.addBox(cx+hw, h, cz, t, hh, hd);        // right
      sc.addBox(cx-(hw-dw)/2-dw/2, h, cz-hd, (hw-dw)/2, hh, t); // front-left
      sc.addBox(cx+(hw-dw)/2+dw/2, h, cz-hd, (hw-dw)/2, hh, t); // front-right
    }
    sc.addFloor(100, h+.05, 0,  6.8, 4.3);
    // Shed walls (w=7,h=4,d=6 → hw=3.5,hh=4,hd=3, doorW=2.0→dw=1.0)
    { const t=0.15,cx=86,cz=4,hw=3.5,hh=4,hd=3,dw=1.0;
      sc.addBox(cx, h, cz+hd, hw, hh, t);
      sc.addBox(cx-hw, h, cz, t, hh, hd);
      sc.addBox(cx+hw, h, cz, t, hh, hd);
      sc.addBox(cx-(hw-dw)/2-dw/2, h, cz-hd, (hw-dw)/2, hh, t);
      sc.addBox(cx+(hw-dw)/2+dw/2, h, cz-hd, (hw-dw)/2, hh, t);
    }
    sc.addFloor(86,  h+.05, 4, 3.3, 2.8);
    // Guest cabin walls (w=8,h=4,d=6 → hw=4,hh=4,hd=3, doorW=1.8→dw=0.9)
    { const t=0.15,cx=114,cz=-14,hw=4,hh=4,hd=3,dw=0.9;
      sc.addBox(cx, h, cz+hd, hw, hh, t);
      sc.addBox(cx-hw, h, cz, t, hh, hd);
      sc.addBox(cx+hw, h, cz, t, hh, hd);
      sc.addBox(cx-(hw-dw)/2-dw/2, h, cz-hd, (hw-dw)/2, hh, t);
      sc.addBox(cx+(hw-dw)/2+dw/2, h, cz-hd, (hw-dw)/2, hh, t);
    }
    sc.addBox(110, h, -10,  1.3, 3.2, 1.3);

    // ── Frank's Jail ─────────────────────────────────────────────────
    h = Math.max(0, this._getHeight(-128, 50));
    place(this._makeFranksJail(), -128, 50, "Frank's Jail");
    // Cellblock outer walls (center -128, 50; 20×30 with door gap on south)
    sc.addBox(-128,    h, 65,    10,    8, 0.3);   // back wall
    sc.addBox(-138,    h, 50,    0.3,   8, 15);    // west wall
    sc.addBox(-118,    h, 50,    0.3,   8, 15);    // east wall
    sc.addBox(-133.875,h, 35,    4.125, 8, 0.3);   // front-left of door
    sc.addBox(-122.125,h, 35,    4.125, 8, 0.3);   // front-right of door
    // 4 watchtowers at compound corners — base pillar (slightly shorter
    // than 16 m so the balcony floor above can lift the player), balcony
    // deck, and a vertical ladder mounted on the east face. Ladder params
    // mirror _makeFranksJail's LADDER_*.
    const towerWorlds = [[-141, 31], [-95, 31], [-141, 69], [-95, 69]];
    const LADDER_RUNGS_C = 40;
    const LADDER_RISE_C  = 0.4;
    const LADDER_OFF_X_C = 1.7;
    for (const [wx, wz] of towerWorlds) {
      // Base column — height 15.7 keeps the top clear so the balcony deck
      // floor (at h + 16.3) is reachable via auto-step from the top rung.
      sc.addBox(wx, h, wz, 1.5, 15.7, 1.5);
      // Balcony deck — walkable surface.
      sc.addFloor(wx, h + 16.3, wz, 2.5, 2.5);
      // Solid sheet just under the deck so bullets fired from below can't
      // pass through and hit players standing on it. Sits 0.4 m below the
      // deck top so it never wall-pushes a player whose feet are at h+16.3.
      sc.addBox(wx, h + 15.85, wz, 2.5, 0.1, 2.5);
      // Ladder: stacked floor colliders at the same (x, z). Walking into
      // the ladder's footprint snaps the player up one rung per frame
      // because each rung is within auto-step range of the one below.
      for (let i = 0; i < LADDER_RUNGS_C; i++) {
        sc.addFloor(
          wx + LADDER_OFF_X_C, h + LADDER_RISE_C * (i + 1), wz,
          0.5, 0.4,
        );
      }
    }
    // Yard fence (east, south, north of yard — west side is cellblock east wall)
    sc.addBox(-97,     h, 50,    0.15, 5,  11);    // east fence
    sc.addBox(-107,    h, 39,    10,   5,  0.15);  // south fence
    sc.addBox(-107,    h, 61,    10,   5,  0.15);  // north fence
    // Walkable surfaces — both the cellblock interior floor and the exercise
    // yard. yFloor = h + 0.05 matches the slab top in _makeFranksJail so the
    // player stands flush with the visible concrete pad.
    sc.addFloor(-128, h + 0.05, 50, 10, 15);       // cellblock floor
    sc.addFloor(-107, h + 0.05, 50, 10, 11);       // exercise yard floor
    // (Removed: phantom "barracks" + "armory" collision rooms. They had
    // no visible meshes in _makeFranksJail and created invisible walls —
    // notably the barracks south wall at z=59, which sliced through the
    // cellblock interior.)

    // ── Ancient Temple ───────────────────────────────────────────────
    h = Math.max(0, this._getHeight(35, -160));
    place(this._makeAncientTemple(), 35, -160, 'Ancient Temple');
    sc.addBox(35,  h, -160, 6.1, 4.5, 2.1);
    sc.addBox(23,  h, -160, 1.5, 6.5, 1.5);
    sc.addBox(47,  h, -160, 1.5, 6.5, 1.5);
    sc.addBox(35,  h, -172, 5.1, 3.5, 1.5);

    // ── Military Compound ────────────────────────────────────────────
    h = Math.max(0, this._getHeight(-50, 80));
    place(this._makeMilitaryCompound(), -50, 80, 'Military Compound');
    // Main bunker walls (w=18,h=4.5,d=12 → hw=9,hh=4.5,hd=6, doorW=2.2→dw=1.1)
    { const t=0.15,cx=-50,cz=80,hw=9,hh=4.5,hd=6,dw=1.1;
      sc.addBox(cx, h, cz+hd, hw, hh, t);
      sc.addBox(cx-hw, h, cz, t, hh, hd);
      sc.addBox(cx+hw, h, cz, t, hh, hd);
      sc.addBox(cx-(hw-dw)/2-dw/2, h, cz-hd, (hw-dw)/2, hh, t);
      sc.addBox(cx+(hw-dw)/2+dw/2, h, cz-hd, (hw-dw)/2, hh, t);
    }
    sc.addFloor(-50, h+.05, 80, 8.8, 5.8);
    // Secondary bunker walls (w=12,h=3.5,d=8 → hw=6,hh=3.5,hd=4, doorW=2.0→dw=1.0)
    { const t=0.15,cx=-68,cz=72,hw=6,hh=3.5,hd=4,dw=1.0;
      sc.addBox(cx, h, cz+hd, hw, hh, t);
      sc.addBox(cx-hw, h, cz, t, hh, hd);
      sc.addBox(cx+hw, h, cz, t, hh, hd);
      sc.addBox(cx-(hw-dw)/2-dw/2, h, cz-hd, (hw-dw)/2, hh, t);
      sc.addBox(cx+(hw-dw)/2+dw/2, h, cz-hd, (hw-dw)/2, hh, t);
    }
    sc.addFloor(-68, h+.05, 72, 5.8, 3.8);
    sc.addBox(-37, h, 66,   2.5, 10, 2.5);
    sc.addBox(-63, h, 66,   2.5, 10, 2.5);

    // ── Olsen's Farm ─────────────────────────────────────────────────
    h = Math.max(0, this._getHeight(150, -75));
    place(this._makeOlsensFarm(), 150, -75, "Olsen's Farm");
    // Farmhouse walls (w=12,h=7,d=9 → hw=6,hh=7,hd=4.5, doorW=2.2→dw=1.1)
    { const t=0.15,cx=150,cz=-75,hw=6,hh=7,hd=4.5,dw=1.1;
      sc.addBox(cx, h, cz+hd, hw, hh, t);
      sc.addBox(cx-hw, h, cz, t, hh, hd);
      sc.addBox(cx+hw, h, cz, t, hh, hd);
      sc.addBox(cx-(hw-dw)/2-dw/2, h, cz-hd, (hw-dw)/2, hh, t);
      sc.addBox(cx+(hw-dw)/2+dw/2, h, cz-hd, (hw-dw)/2, hh, t);
    }
    sc.addFloor(150, h+.05, -75, 5.8, 4.3);
    // Large barn walls (w=16,h=8,d=10 → hw=8,hh=8,hd=5, doorW=3.5→dw=1.75)
    { const t=0.15,cx=170,cz=-77,hw=8,hh=8,hd=5,dw=1.75;
      sc.addBox(cx, h, cz+hd, hw, hh, t);
      sc.addBox(cx-hw, h, cz, t, hh, hd);
      sc.addBox(cx+hw, h, cz, t, hh, hd);
      sc.addBox(cx-(hw-dw)/2-dw/2, h, cz-hd, (hw-dw)/2, hh, t);
      sc.addBox(cx+(hw-dw)/2+dw/2, h, cz-hd, (hw-dw)/2, hh, t);
    }
    sc.addFloor(170, h+.05, -77, 7.8, 4.8);
    // Second barn walls (w=10,h=6,d=8 → hw=5,hh=6,hd=4, doorW=2.2→dw=1.1)
    { const t=0.15,cx=133,cz=-75,hw=5,hh=6,hd=4,dw=1.1;
      sc.addBox(cx, h, cz+hd, hw, hh, t);
      sc.addBox(cx-hw, h, cz, t, hh, hd);
      sc.addBox(cx+hw, h, cz, t, hh, hd);
      sc.addBox(cx-(hw-dw)/2-dw/2, h, cz-hd, (hw-dw)/2, hh, t);
      sc.addBox(cx+(hw-dw)/2+dw/2, h, cz-hd, (hw-dw)/2, hh, t);
    }
    sc.addFloor(133, h+.05, -75, 4.8, 3.8);
    sc.addBox(158, h, -88,  1.5, 11, 1.5);

    // ── Whalen's Town ────────────────────────────────────────────────
    h = Math.max(0, this._getHeight(-125, -120));
    place(this._makeWhalenssTown(), -125, -120, "Whalen's Town");
    // Church walls (w=8,h=8,d=10 → hw=4,hh=8,hd=5, doorW=2.5→dw=1.25)
    { const t=0.15,cx=-125,cz=-142,hw=4,hh=8,hd=5,dw=1.25;
      sc.addBox(cx, h, cz+hd, hw, hh, t);
      sc.addBox(cx-hw, h, cz, t, hh, hd);
      sc.addBox(cx+hw, h, cz, t, hh, hd);
      sc.addBox(cx-(hw-dw)/2-dw/2, h, cz-hd, (hw-dw)/2, hh, t);
      sc.addBox(cx+(hw-dw)/2+dw/2, h, cz-hd, (hw-dw)/2, hh, t);
    }
    sc.addFloor(-125, h+.05, -142, 3.8, 4.8);
    // Town hall walls (w=16,h=8,d=12 → hw=8,hh=8,hd=6, doorW=3.0→dw=1.5)
    { const t=0.15,cx=-125,cz=-98,hw=8,hh=8,hd=6,dw=1.5;
      sc.addBox(cx, h, cz+hd, hw, hh, t);
      sc.addBox(cx-hw, h, cz, t, hh, hd);
      sc.addBox(cx+hw, h, cz, t, hh, hd);
      sc.addBox(cx-(hw-dw)/2-dw/2, h, cz-hd, (hw-dw)/2, hh, t);
      sc.addBox(cx+(hw-dw)/2+dw/2, h, cz-hd, (hw-dw)/2, hh, t);
    }
    sc.addFloor(-125, h+.05, -98, 7.8, 5.8);
    // Tavern walls (w=10,h=6.5,d=8 → hw=5,hh=6.5,hd=4, doorW=2.2→dw=1.1)
    { const t=0.15,cx=-103,cz=-120,hw=5,hh=6.5,hd=4,dw=1.1;
      sc.addBox(cx, h, cz+hd, hw, hh, t);
      sc.addBox(cx-hw, h, cz, t, hh, hd);
      sc.addBox(cx+hw, h, cz, t, hh, hd);
      sc.addBox(cx-(hw-dw)/2-dw/2, h, cz-hd, (hw-dw)/2, hh, t);
      sc.addBox(cx+(hw-dw)/2+dw/2, h, cz-hd, (hw-dw)/2, hh, t);
    }
    sc.addFloor(-103, h+.05, -120, 4.8, 3.8);
    sc.addBox(-147, h, -120, 4.6, 5,  3.6);
    sc.addFloor(-147, h+.05, -120, 4.3, 3.3);
    for (const wh of [
      { ox:-20, oz:-8, hw:3.6, hd:3.1 }, { ox:-8, oz:-8, hw:3.1, hd:2.6 },
      { ox:  6, oz:-8, hw:4.1, hd:3.1 }, { ox:18, oz:-8, hw:3.1, hd:2.6 },
      { ox:-20, oz: 8, hw:3.6, hd:3.1 }, { ox:-8, oz: 8, hw:3.1, hd:2.6 },
      { ox:  6, oz: 8, hw:4.1, hd:3.1 }, { ox:18, oz: 8, hw:3.1, hd:2.6 },
    ]) {
      const t=0.15,cx=-125+wh.ox,cz=-120+wh.oz,hw2=wh.hw,hh=6.5,hd2=wh.hd,dw=0.8;
      sc.addBox(cx, h, cz+hd2, hw2, hh, t);
      sc.addBox(cx-hw2, h, cz, t, hh, hd2);
      sc.addBox(cx+hw2, h, cz, t, hh, hd2);
      sc.addBox(cx-(hw2-dw)/2-dw/2, h, cz-hd2, (hw2-dw)/2, hh, t);
      sc.addBox(cx+(hw2-dw)/2+dw/2, h, cz-hd2, (hw2-dw)/2, hh, t);
      sc.addFloor(-125+wh.ox, h+.05, -120+wh.oz, wh.hw-.3, wh.hd-.3);
    }

    // ── Samuel's Mansion ─────────────────────────────────────────────
    // Three-level mansion centered at (190, 120). Local origin → world via
    // W(x) = 190 + local_x, N(z) = 120 + local_z.
    h = Math.max(0, this._getHeight(190, 120));
    place(this._makeSamuelsMansion(), 190, 120, "Samuel's Mansion");

    {
      const W = (x) => 190 + x;
      const N = (z) => 120 + z;
      const t = 0.15;
      const yB = h;          // basement floor
      const yG = h + 5;      // ground floor
      const yU = h + 10;     // upper floor

      // ── Outer walls (full height y..y+15) ───────────────────────────
      // South wall: door opening at local x=-1.5..+1.5, y=5..8.5 (h+5..h+8.5)
      sc.addBox(W(-8.375), yB,        N(-14), 6.625, 15,  t);  // SW panel
      sc.addBox(W( 8.375), yB,        N(-14), 6.625, 15,  t);  // SE panel
      sc.addBox(W( 0),     yB,        N(-14), 1.5,   5,   t);  // below-door (basement)
      sc.addBox(W( 0),     h + 8.5,   N(-14), 1.5,   6.5, t);  // above-door
      // North wall: tunnel exit opening at x=-1.5..+1.5, y=0..3.2 in basement
      sc.addBox(W(-8.375), yB,        N( 14), 6.625, 15,   t);
      sc.addBox(W( 8.375), yB,        N( 14), 6.625, 15,   t);
      sc.addBox(W( 0),     h + 3.2,   N( 14), 1.5,   11.8, t);  // above-tunnel + floors
      // West/East walls (full height)
      sc.addBox(W(-16), yB, N(0), t, 15, 14);
      sc.addBox(W( 16), yB, N(0), t, 15, 14);

      // ── Ground-floor interior partitions (y=h+5..h+10) ──────────────
      // x=-7 wall (Drawing/Library west of it; Foyer/Great Hall east)
      sc.addBox(W(-7), yG, N(-11.5), 0.1, 5, 2.5);
      sc.addBox(W(-7), yG, N( 0),    0.1, 5, 7);
      sc.addBox(W(-7), yG, N( 11.5), 0.1, 5, 2.5);
      // x=+7 wall (Dining/Kitchen east of it)
      sc.addBox(W( 7), yG, N(-11.5), 0.1, 5, 2.5);
      sc.addBox(W( 7), yG, N( 0),    0.1, 5, 7);
      sc.addBox(W( 7), yG, N( 11.5), 0.1, 5, 2.5);
      // z=-2 wall (Foyer ↔ Great Hall, door at x=-1.5..+1.5)
      sc.addBox(W(-4.25), yG, N(-2), 2.75, 5, 0.1);
      sc.addBox(W( 4.25), yG, N(-2), 2.75, 5, 0.1);
      // z=0 walls (Drawing↔Library and Dining↔Kitchen, doors at x=±11)
      sc.addBox(W(-14.25), yG, N(0), 1.75, 5, 0.1);
      sc.addBox(W( -8.25), yG, N(0), 1.25, 5, 0.1);
      sc.addBox(W(  8.25), yG, N(0), 1.25, 5, 0.1);
      sc.addBox(W( 14.25), yG, N(0), 1.75, 5, 0.1);

      // ── Upper-floor interior partitions (y=h+10..h+15) ──────────────
      // x=-2 wall, doors at z=±7
      sc.addBox(W(-2), yU, N(-11.5), 0.1, 5, 2.5);
      sc.addBox(W(-2), yU, N( 0),    0.1, 5, 7);
      sc.addBox(W(-2), yU, N( 11.5), 0.1, 5, 2.5);
      // x=+2 wall
      sc.addBox(W( 2), yU, N(-11.5), 0.1, 5, 2.5);
      sc.addBox(W( 2), yU, N( 0),    0.1, 5, 7);
      sc.addBox(W( 2), yU, N( 11.5), 0.1, 5, 2.5);
      // z=0 walls (no doors — separating N/S bedrooms)
      sc.addBox(W(-9), yU, N(0), 7, 5, 0.1);   // x: -16..-2
      sc.addBox(W( 9), yU, N(0), 7, 5, 0.1);   // x: +2..+16

      // ── Walkable floor surfaces ──────────────────────────────────────
      // Ground floor (yG) — hole at world x=199..203, z=121..128 for cellar stair
      sc.addFloor(W(0),     yG, N(-6.5),  16,   7.5);    // south slab
      sc.addFloor(W(0),     yG, N( 11),   16,   3);      // north slab
      sc.addFloor(W(-3.5),  yG, N( 4.5),  12.5, 3.5);    // west of hole
      sc.addFloor(W( 14.5), yG, N( 4.5),  1.5,  3.5);    // east of hole
      // Upper floor (yU) — hole at world x=187..193, z=128..134 for grand stair
      sc.addFloor(W(0),    yU, N(-3),    16,   11);
      sc.addFloor(W(-9.5), yU, N( 11),   6.5,  3);
      sc.addFloor(W( 9.5), yU, N( 11),   6.5,  3);

      // ── Stairs (collision floors, 13 steps each) ─────────────────────
      const stairFloors = (cx, cz, hw, dir, y0, y1) => {
        const steps = 13;
        const rise = (y1 - y0) / steps;
        const run = 0.5;
        for (let i = 0; i < steps; i++) {
          const yTop = y0 + rise * (i + 1);
          let x = cx, z = cz, fw = hw, fd = 0.25;
          if (dir === 'north')      z = cz + run * (i + 0.5);
          else if (dir === 'south') z = cz - run * (i + 0.5);
          else if (dir === 'east')  { x = cx + run * (i + 0.5); fw = 0.25; fd = hw; }
          else if (dir === 'west')  { x = cx - run * (i + 0.5); fw = 0.25; fd = hw; }
          sc.addFloor(x, yTop, z, fw, fd);
        }
      };
      stairFloors(W(0),   N(-20.5), 3.5, 'north', yB, yG);  // front porch (rising N to door)
      stairFloors(W(0),   N(7.75),  3,   'north', yG, yU);  // grand stair
      // Cellar stair (descending): same steps but with y decreasing.
      {
        const steps = 13;
        const rise = 5 / steps;
        const run = 0.5;
        for (let i = 0; i < steps; i++) {
          const yTop = yG - rise * (i + 1);
          sc.addFloor(W(11), yTop, N(1 + run * (i + 0.5)), 2, 0.25);
        }
      }

      // ── Secret tunnel (L-shape, basement → west mouth at surface ruin)
      // North run interior: x∈[-1.65,+1.65], z∈[14, 68.35]
      // Corner: x∈[-1.65,+1.65], z∈[68.35, 71.65]
      // West run: x∈[-19, +1.65], z∈[68.35, 71.65]
      // Walls follow the outer perimeter of the L (west mouth is OPEN).
      sc.addBox(W( 1.65), yB, N(42.825), 0.15, 3.2, 28.825);   // east wall (full L)
      sc.addBox(W(-1.65), yB, N(41.175), 0.15, 3.2, 27.175);   // N-run west (stops at corner)
      sc.addBox(W(-8.675), yB, N(71.65), 10.325, 3.2, 0.15);   // L north wall
      sc.addBox(W(-10.325), yB, N(68.35), 8.675, 3.2, 0.15);   // W-run south (gap at corner)
      // Tunnel floor (defensive — terrain should match yB everywhere here)
      sc.addFloor(W(0),     yB, N(42.825), 1.65,  28.825);     // north run + corner
      sc.addFloor(W(-8.675), yB, N(70),    10.325, 1.65);      // west run

      // ── Secret exit chamber (surface ruin north of tunnel west end) ──
      // Tunnel west run opens onto terrain at world (171, 190). Surface ruin
      // sits a few meters north and acts as a hidden landmark for the exit.
      const hEx = h;
      const exitGroup = this._makeMansionExit();
      exitGroup.position.set(171, hEx, 195);
      this.scene.add(exitGroup);
      this.structures.push(exitGroup);
      // Partial ruin walls (matches _makeMansionExit visual)
      sc.addBox(171, hEx, 198.8, 3.75, 3.2, 0.2);   // south wall
      sc.addBox(167.0, hEx, 195, 0.2, 3.8, 5);      // west wall
    }
  }

  _placeStructure(group, px, pz) {
    const h = this._getHeight(px, pz);
    if (h < 0) return;
    group.position.set(px, h, pz);
    this.scene.add(group);
    this.structures.push(group);
  }

  // Makes a hollow building shell: floor + 4 walls + roof cap, with a door gap in the front (−z face).
  // Returns a THREE.Group. doorW = door opening width, doorH = door opening height.
  _hollowBox(w, totalH, d, mat, doorW = 2.2, doorH = 3.0) {
    const g = new THREE.Group();
    const t = 0.3; // wall thickness
    const wallMat = mat;

    // Floor
    const floor = new THREE.Mesh(new THREE.BoxGeometry(w, t, d), wallMat);
    floor.position.set(0, t / 2, 0); floor.receiveShadow = true; g.add(floor);

    // Roof cap (thin)
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w, t, d), wallMat);
    roof.position.set(0, totalH - t / 2, 0); g.add(roof);

    // Back wall (full)
    const back = new THREE.Mesh(new THREE.BoxGeometry(w, totalH, t), wallMat);
    back.position.set(0, totalH / 2, d / 2); back.castShadow = true; g.add(back);

    // Left wall (full)
    const left = new THREE.Mesh(new THREE.BoxGeometry(t, totalH, d), wallMat);
    left.position.set(-w / 2, totalH / 2, 0); left.castShadow = true; g.add(left);

    // Right wall (full)
    const right = new THREE.Mesh(new THREE.BoxGeometry(t, totalH, d), wallMat);
    right.position.set(w / 2, totalH / 2, 0); right.castShadow = true; g.add(right);

    // Front wall — split into left panel, right panel, lintel
    const sideW = (w - doorW) / 2;
    if (sideW > 0.01) {
      const fL = new THREE.Mesh(new THREE.BoxGeometry(sideW, totalH, t), wallMat);
      fL.position.set(-w / 2 + sideW / 2, totalH / 2, -d / 2); fL.castShadow = true; g.add(fL);
      const fR = new THREE.Mesh(new THREE.BoxGeometry(sideW, totalH, t), wallMat);
      fR.position.set(w / 2 - sideW / 2, totalH / 2, -d / 2); fR.castShadow = true; g.add(fR);
    }
    // Lintel above door
    const lintelH = totalH - doorH;
    if (lintelH > 0.1) {
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorW, lintelH, t), wallMat);
      lintel.position.set(0, doorH + lintelH / 2, -d / 2); g.add(lintel);
    }

    return g;
  }

  // ── Furniture loader ────────────────────────────────────────────────
  // Render every placement of a GLB model as one InstancedMesh per sub-mesh,
  // instead of one cloned Group per placement. Pixel-identical (shared geometry,
  // material and shadows) but collapses hundreds of draw calls into a handful.
  // placements: [{ wx, wy, wz, rotY, scale }] — wy is the world floor Y; the
  // model's bottom is auto-aligned to it (matching the old per-clone behaviour).
  _instanceClones(model, placements) {
    if (!placements.length) return;
    model.updateMatrixWorld(true);

    // Bottom-Y offset at scale 1 (Y-rotation doesn't change it; scale is linear).
    const baseOffset = -new THREE.Box3().setFromObject(model).min.y;
    const rootInv = new THREE.Matrix4().copy(model.matrixWorld).invert();

    const subMeshes = [];
    model.traverse(c => { if (c.isMesh) subMeshes.push(c); });

    const yAxis  = new THREE.Vector3(0, 1, 0);
    const quat   = new THREE.Quaternion();
    const pos    = new THREE.Vector3();
    const scl    = new THREE.Vector3();
    const placeM = new THREE.Matrix4();
    const finalM = new THREE.Matrix4();

    for (const src of subMeshes) {
      // Sub-mesh transform relative to the model root.
      const localM = new THREE.Matrix4().multiplyMatrices(rootInv, src.matrixWorld);
      const inst = new THREE.InstancedMesh(src.geometry, src.material, placements.length);
      inst.castShadow = true;
      inst.receiveShadow = true;

      placements.forEach((p, i) => {
        quat.setFromAxisAngle(yAxis, p.rotY);
        pos.set(p.wx, p.wy + baseOffset * p.scale, p.wz);
        scl.setScalar(p.scale);
        placeM.compose(pos, quat, scl);
        finalM.multiplyMatrices(placeM, localM);
        inst.setMatrixAt(i, finalM);
      });
      inst.instanceMatrix.needsUpdate = true;
      // Instances span the whole map; recompute the bounding volume so the
      // renderer frustum-culls the group correctly instead of by instance 0.
      inst.computeBoundingSphere();
      this.scene.add(inst);
    }
  }

  async loadFurniture() {
    const loader = new GLTFLoader();
    const load = path => new Promise((res, rej) =>
      loader.load(path, g => res(g.scene), null, rej));

    // Collect placements per model, then instance them all at the end.
    const _placements = new Map();
    const place = (model, wx, wy, wz, rotY = 0, scale = 1) => {
      let arr = _placements.get(model);
      if (!arr) { arr = []; _placements.set(model, arr); }
      arr.push({ wx, wy, wz, rotY, scale });
    };

    // Load all models (parallel)
    let bed, bedTwin, bookcase, chair, chair2, closet, desk, nightstand,
        officeChair, shortCloset, sofa, sofa2, sofa3, stool, table, table2;
    try {
      [bed, bedTwin, bookcase, chair, chair2, closet, desk, nightstand,
       officeChair, shortCloset, sofa, sofa2, sofa3, stool, table, table2] =
        await Promise.all([
          load('objects/Bed Double.glb'),
          load('objects/Bed Twin.glb'),
          load('objects/Bookcase with Books.glb'),
          load('objects/Chair.glb'),
          load('objects/Chair-9kIjuRFMFw.glb'),
          load('objects/Closet.glb'),
          load('objects/Desk.glb'),
          load('objects/Night Stand.glb'),
          load('objects/Office Chair.glb'),
          load('objects/Short Closet.glb'),
          load('objects/Sofa.glb'),
          load('objects/Sofa-X5kQPKzAWp.glb'),
          load('objects/Sofa-vuo7KBehok.glb'),
          load('objects/Stool.glb'),
          load('objects/Table.glb'),
          load('objects/Table-yYEEJzKxb4.glb'),
        ]);
    } catch (e) {
      console.warn('Some furniture failed to load:', e);
      return;
    }

    // Log rendered sizes for debugging
    const sizeOf = m => { const b = new THREE.Box3().setFromObject(m); const s = new THREE.Vector3(); b.getSize(s); return s; };
    console.log('[furniture] chair size:', sizeOf(chair));
    console.log('[furniture] bed size:', sizeOf(bed));
    console.log('[furniture] table size:', sizeOf(table));

    // Ground heights at each POI (sampled once)
    const hCC  = this._getHeight(100,   0);    // Cedar Creek
    const hFJ  = this._getHeight(-128,  50);   // Frank's Jail
    const hMC  = this._getHeight(-50,   80);   // Military Compound
    const hOF  = this._getHeight(150,  -75);   // Olsen's Farm
    const hWT  = this._getHeight(-125, -120);  // Whalen's Town
    const fl   = 0.15; // floor slab thickness offset

    // ── Cedar Creek (center 100, 0) ────────────────────────────────
    const ccY = hCC + fl;
    // Main cabin — living room feel
    place(sofa,      100,  ccY, -1,   Math.PI,       1);
    place(table,     100,  ccY,  1.5, 0,             1);
    place(chair,     97.5, ccY,  1.5, Math.PI * 0.5, 1);
    place(chair2,    102.5,ccY,  1.5, -Math.PI * 0.5,1);
    place(bookcase,  106,  ccY,  1,   Math.PI * 0.5, 1);
    // Bedroom corner
    place(bed,       103,  ccY, -1.5, Math.PI * 0.5, 1);
    place(nightstand,103,  ccY,  0.2, 0,             1);

    // Guest cabin (local 14, 0, -14 → world 114, hCC, -14)
    place(bedTwin,   114,  ccY, -13.5, Math.PI * 0.5, 1);
    place(nightstand,114,  ccY, -12,   0,              1);
    place(shortCloset,116, ccY, -15,   Math.PI,        1);

    // Shed (-14, 0, 4 → world 86, hCC, 4)
    place(desk,      86,   ccY,  3.5,  0,              1);
    place(stool,     87.5, ccY,  3.5,  0,              1);

    // ── Frank's Jail — cellblock has built-in concrete cots, no extra furniture ─
    const fjY = hFJ + fl;
    void fjY;

    // ── Military Compound — main bunker (world -50, hMC, 80) ──────
    const mcY = hMC + fl;
    place(desk,      -48,  mcY,  79,  0,              1);
    place(officeChair,-49, mcY,  80,  Math.PI,        1);
    place(desk,      -45,  mcY,  79,  0,              1);
    place(officeChair,-46, mcY,  80,  Math.PI,        1);
    place(table2,    -55,  mcY,  81,  0,              1);
    place(chair,     -54,  mcY,  82,  Math.PI,        1);
    place(chair2,    -56,  mcY,  82,  Math.PI,        1);
    place(bookcase,  -58,  mcY,  79,  Math.PI * 0.5,  1);

    // Secondary bunker (world -68, hMC, 72)
    place(desk,      -66,  mcY,  71,  0,              1);
    place(officeChair,-67, mcY,  72,  Math.PI,        1);
    place(stool,     -70,  mcY,  73,  0,              1);

    // ── Olsen's Farm — farmhouse (world 150, hOF, -75) ────────────
    const ofY = hOF + fl;
    // Kitchen/dining
    place(table,     150,  ofY, -74.5, 0,             1);
    place(chair,     148,  ofY, -74.5, Math.PI * 0.5, 1);
    place(chair2,    152,  ofY, -74.5, -Math.PI * 0.5,1);
    place(chair,     150,  ofY, -73,   Math.PI,        1);
    // Bedroom
    place(bed,       153,  ofY, -77,   Math.PI * 0.5, 1);
    place(nightstand,153,  ofY, -75.8, 0,             1);
    place(closet,    154.5,ofY, -77,   Math.PI,        1);

    // Barn 1 (world 170, hOF, -77) — work/storage feel
    place(table2,    170,  ofY, -76.5, 0,             1);
    place(stool,     171.5,ofY, -76.5, 0,             1);
    place(stool,     168.5,ofY, -76.5, 0,             1);

    // Barn 2 (world 133, hOF, -75)
    place(table2,    133,  ofY, -74.5, 0,             1);
    place(stool,     134.5,ofY, -74.5, 0,             1);

    // ── Whalen's Town (center -125, -120) ─────────────────────────
    const wtY = hWT + fl;
    // Church (world -125, hWT, -142): pews feel — use chairs in rows
    for (let i = 0; i < 3; i++) {
      place(chair,  -123 + i * 2, wtY, -141, Math.PI, 1);
      place(chair2, -123 + i * 2, wtY, -140, Math.PI, 1);
    }

    // Town hall (world -125, hWT, -98): meeting room
    place(table,    -125,  wtY, -97.5, 0,             1);
    place(table2,   -125,  wtY, -99,   0,             1);
    place(chair,    -127,  wtY, -97.5, Math.PI * 0.5, 1);
    place(chair2,   -123,  wtY, -97.5,-Math.PI * 0.5, 1);
    place(chair,    -127,  wtY, -99,   Math.PI * 0.5, 1);
    place(chair2,   -123,  wtY, -99,  -Math.PI * 0.5, 1);
    place(bookcase, -132,  wtY, -98,   Math.PI * 0.5, 1);
    place(bookcase, -132,  wtY, -100,  Math.PI * 0.5, 1);

    // Tavern (world -103, hWT, -120): tables + stools
    place(table,    -103,  wtY, -119,  0,             1);
    place(stool,    -101.5,wtY, -119,  0,             1);
    place(stool,    -104.5,wtY, -119,  0,             1);
    place(table,    -103,  wtY, -121.5,0,             1);
    place(stool,    -101.5,wtY, -121.5,0,             1);
    place(stool,    -104.5,wtY, -121.5,0,             1);
    place(sofa2,    -107,  wtY, -120,  Math.PI * 0.5, 1);

    // Blacksmith (world -147, hWT, -120): work desk
    place(desk,     -147,  wtY, -119,  0,             1);
    place(stool,    -147,  wtY, -121,  0,             1);

    // 8 houses: 4 north (wz=-128) and 4 south (wz=-112)
    // House centers at wx = -125 + ox for ox in [-20,-8,6,18]
    const houseFurniture = [
      // north row
      { wx:-145, wz:-128, m1:bed,     m2:nightstand, m3:shortCloset },
      { wx:-133, wz:-128, m1:bedTwin, m2:nightstand, m3:null },
      { wx:-119, wz:-128, m1:bed,     m2:nightstand, m3:sofa3 },
      { wx:-107, wz:-128, m1:bedTwin, m2:nightstand, m3:null },
      // south row
      { wx:-145, wz:-112, m1:bed,     m2:nightstand, m3:shortCloset },
      { wx:-133, wz:-112, m1:bedTwin, m2:nightstand, m3:null },
      { wx:-119, wz:-112, m1:bed,     m2:nightstand, m3:sofa3 },
      { wx:-107, wz:-112, m1:bedTwin, m2:nightstand, m3:null },
    ];
    for (const hf of houseFurniture) {
      place(hf.m1,  hf.wx - 1.5, wtY, hf.wz, Math.PI * 0.5, 1);
      place(hf.m2,  hf.wx - 1.5, wtY, hf.wz + 1.5, 0, 1);
      if (hf.m3) place(hf.m3, hf.wx + 1.5, wtY, hf.wz, Math.PI, 1);
    }

    // ── Samuel's Mansion furniture ───────────────────────────────────────
    // Three-level mansion at world (190, 120). Y levels:
    //   basement floor = hSM + fl
    //   ground floor   = hSM + 5 + fl
    //   upper floor    = hSM + 10 + fl
    const hSM  = this._getHeight(190, 120);
    const smB  = hSM + fl;        // basement
    const smG  = hSM + 5 + fl;    // ground floor
    const smU  = hSM + 10 + fl;   // upper floor

    // ── GROUND FLOOR ────────────────────────────────────────────────────
    // Foyer (x=183..197, z=106..118)
    place(sofa,        190,  smG, 109,   Math.PI,        1);
    place(table,       190,  smG, 112,   0,              1);
    place(chair,       187,  smG, 112,   Math.PI * 0.5,  1);
    place(chair2,      193,  smG, 112,   -Math.PI * 0.5, 1);
    place(nightstand,  185,  smG, 117,   0,              1);

    // Drawing Room (x=174..183, z=106..120) — SW corner
    place(sofa2,       176,  smG, 108,   0,              1);
    place(sofa3,       181,  smG, 116,   Math.PI,        1);
    place(table2,      178,  smG, 116,   0,              1);
    place(chair,       175.5, smG, 113, Math.PI * 0.5,  1);

    // Dining Room (x=197..206, z=106..120) — SE corner
    place(table,       202,  smG, 110,   0,              1);
    place(table2,      202,  smG, 113,   0,              1);
    place(table,       202,  smG, 116,   0,              1);
    place(chair,       199.5, smG, 110,  Math.PI * 0.5,  1);
    place(chair2,      204.5, smG, 110, -Math.PI * 0.5,  1);
    place(chair,       199.5, smG, 113,  Math.PI * 0.5,  1);
    place(chair2,      204.5, smG, 113, -Math.PI * 0.5,  1);
    place(chair,       199.5, smG, 116,  Math.PI * 0.5,  1);
    place(chair2,      204.5, smG, 116, -Math.PI * 0.5,  1);

    // Great Hall (x=183..197, z=118..134) — central, with grand stair at z=128..134
    place(sofa,        185,  smG, 121,   Math.PI * 0.5,  1);
    place(sofa,        195,  smG, 121,  -Math.PI * 0.5,  1);
    place(table,       190,  smG, 125,   0,              1);
    place(chair,       188,  smG, 125,   Math.PI * 0.5,  1);
    place(chair2,      192,  smG, 125,  -Math.PI * 0.5,  1);

    // Library (x=174..183, z=120..134) — NW corner
    place(bookcase,    175,  smG, 122,   Math.PI * 0.5,  1);
    place(bookcase,    175,  smG, 125,   Math.PI * 0.5,  1);
    place(bookcase,    175,  smG, 128,   Math.PI * 0.5,  1);
    place(bookcase,    175,  smG, 131,   Math.PI * 0.5,  1);
    place(desk,        180,  smG, 132,   Math.PI,        1);
    place(officeChair, 180,  smG, 130.5, 0,              1);
    place(sofa3,       181,  smG, 124,  -Math.PI * 0.5,  1);

    // Kitchen (x=197..206, z=120..134) — NE corner, cellar stair at x=199..203, z=121..128
    place(desk,        205,  smG, 122,   Math.PI,        1);  // counter along east wall
    place(desk,        205,  smG, 125,   Math.PI,        1);
    place(stool,       203.5, smG, 122, 0,               1);
    place(stool,       203.5, smG, 125, 0,               1);
    place(table2,      199,  smG, 131,   0,              1);  // prep table near north wall
    place(stool,       200.5, smG, 131, 0,               1);
    place(stool,       197.5, smG, 131, 0,               1);

    // ── UPPER FLOOR ─────────────────────────────────────────────────────
    // SW Bedroom (x=174..188, z=106..120)
    place(bed,         181,  smU, 109,   Math.PI * 0.5,  1);
    place(nightstand,  181,  smU, 112,   0,              1);
    place(closet,      176,  smU, 117,   Math.PI * 0.5,  1);
    place(chair,       186,  smU, 117,  -Math.PI * 0.5,  1);

    // SE Bedroom (x=192..206, z=106..120)
    place(bedTwin,     199,  smU, 109,   Math.PI * 0.5,  1);
    place(bedTwin,     199,  smU, 112,   Math.PI * 0.5,  1);
    place(nightstand,  204,  smU, 111,   Math.PI,        1);
    place(shortCloset, 195,  smU, 117,   Math.PI * 0.5,  1);

    // Master Bedroom NW (x=174..188, z=120..134)
    place(bed,         182,  smU, 122,   Math.PI,        1);
    place(nightstand,  179,  smU, 122,   0,              1);
    place(nightstand,  185,  smU, 122,   0,              1);
    place(closet,      176,  smU, 132,   Math.PI * 0.5,  1);
    place(sofa2,       186,  smU, 131,  -Math.PI * 0.5,  1);
    place(table2,      183,  smU, 131,   0,              1);

    // NE Bedroom (x=192..206, z=120..134)
    place(bed,         199,  smU, 122,   Math.PI,        1);
    place(nightstand,  202,  smU, 122,   0,              1);
    place(desk,        204,  smU, 131,   Math.PI,        1);
    place(officeChair, 204,  smU, 129.5, 0,              1);
    place(bookcase,    194,  smU, 132,   Math.PI * 0.5,  1);

    // ── BASEMENT ────────────────────────────────────────────────────────
    // Storage crates and a workbench near the cellar stair landing (x=199..203, z=121..128)
    place(desk,        202,  smB, 130,   Math.PI,        1);
    place(stool,       202,  smB, 128.5, 0,              1);
    place(table2,      198,  smB, 130,   0,              1);
    // West storage area
    place(shortCloset, 178,  smB, 109,   Math.PI * 0.5,  1);
    place(bookcase,    178,  smB, 113,   Math.PI * 0.5,  1);
    // Reading nook in the basement (rare for a basement, but Samuel was eccentric)
    place(sofa3,       186,  smB, 109,   0,              1);
    place(nightstand,  189,  smB, 109,   Math.PI,        1);

    // Render all collected placements as instanced meshes.
    for (const [model, list] of _placements) this._instanceClones(model, list);
  }

  // ── Samuel's Mansion ────────────────────────────────────────────────
  // Three-level mansion: basement (y=0..5, at terrain level), ground floor
  // (y=5..10, raised on a stone podium), upper floor (y=10..15). Front porch
  // steps connect terrain to the ground-floor door. Secret tunnel runs from a
  // hidden basement bookcase north then west to the exit bunker.
  _makeSamuelsMansion() {
    const g = new THREE.Group();

    const ext     = new THREE.MeshLambertMaterial({ color: 0x8e8275 }); // warm stone
    const roofM   = new THREE.MeshLambertMaterial({ color: 0x201e1c }); // dark slate
    const winM    = new THREE.MeshLambertMaterial({ color: 0x88aabb, transparent: true, opacity: 0.5 });
    const woodM   = new THREE.MeshLambertMaterial({ color: 0x2e1a08 }); // dark walnut
    const goldM   = new THREE.MeshLambertMaterial({ color: 0xb08c28 });
    const carpM   = new THREE.MeshLambertMaterial({ color: 0x7a1010 }); // deep red carpet
    const floorM  = new THREE.MeshLambertMaterial({ color: 0x5a4528 }); // interior wood floor
    const lightWd = new THREE.MeshLambertMaterial({ color: 0x4a3418 });
    const darkS   = new THREE.MeshLambertMaterial({ color: 0x3a3730 }); // basement stone
    const crateM  = new THREE.MeshLambertMaterial({ color: 0x4a3010 });
    const ironM   = new THREE.MeshLambertMaterial({ color: 0x555555 });
    const flameM  = new THREE.MeshLambertMaterial({ color: 0xff6600, emissive: new THREE.Color(0x441100) });

    const box = (w, h, d, mat, x, y, z, shadow = true) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      if (shadow) m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    const win = (x, y, z, w, h, d) => box(w, h, d, winM, x, y, z);
    const torch = (x, y, z) => {
      box(0.07, 0.5, 0.07, woodM, x, y, z, false);
      const fl = new THREE.Mesh(new THREE.SphereGeometry(0.14, 6, 5), flameM);
      fl.position.set(x, y + 0.32, z); g.add(fl);
    };
    // Stepped visual stair from yBottom up to yTop in given cardinal direction.
    // Player traversal is handled by matching collision floors added in _buildStructures.
    const stairs = (cx, cz, halfW, dir, yBottom, yTop, mat = woodM) => {
      const steps = 13;
      const rise  = (yTop - yBottom) / steps;
      const run   = 0.5;
      for (let i = 0; i < steps; i++) {
        const yTopStep = yBottom + rise * (i + 1);
        let x = cx, z = cz, sw = halfW * 2, sd = run;
        if (dir === 'north')      z = cz + run * (i + 0.5);
        else if (dir === 'south') z = cz - run * (i + 0.5);
        else if (dir === 'east')  { x = cx + run * (i + 0.5); sw = run; sd = halfW * 2; }
        else if (dir === 'west')  { x = cx - run * (i + 0.5); sw = run; sd = halfW * 2; }
        box(sw, Math.abs(rise), sd, mat, x, yTopStep - Math.abs(rise) / 2, z);
      }
    };

    // ── BASEMENT (y=0..5) — dark stone walls forming the podium beneath
    //    the ground floor. Floor at y=0 sits at world terrain level.
    box(32, 0.3, 28, darkS, 0, 0.15, 0);                         // basement floor
    box(32, 5, 0.3, darkS, 0, 2.5, -14);                          // south wall (solid)
    // North wall is built in panels below to leave the tunnel mouth open.
    box(0.3, 5, 28, darkS, -16, 2.5, 0);                          // west wall
    box(0.3, 5, 28, darkS,  16, 2.5, 0);                          // east wall
    // Support columns (avoid x=9..13,z=1..8 — basement stair landing zone)
    for (const [cx, cz] of [[-10, -7], [-10, 7], [-10, 0], [0, -8], [0, 0], [0, 8], [10, -10], [10, 10]]) {
      box(0.6, 4.7, 0.6, darkS, cx, 2.35, cz);
    }
    // Wine racks along the west wall
    for (const zw of [-10, -5, 0, 5, 10]) {
      box(0.4, 3.5, 1.6, woodM, -15.4, 1.75, zw);
      // Bottle suggestions (small darker boxes)
      for (let by = 0; by < 5; by++) {
        box(0.5, 0.15, 1.4, new THREE.MeshLambertMaterial({ color: 0x2a1a08 }),
            -15.2, 0.5 + by * 0.6, zw);
      }
    }
    // Storage crates scattered around the basement
    for (const [cx, cz, sz] of [
      [12, -10, 1.3], [13.2, -8.5, 1.0], [13, 9, 1.3],
      [11, 10, 1.0], [4, -12, 1.2], [-4, -12, 1.2], [6, 12, 1.0],
    ]) {
      box(sz, sz, sz, crateM, cx, sz / 2, cz);
    }
    // Wall torches
    torch(-15.4, 3.5, -10); torch(-15.4, 3.5, 0); torch(-15.4, 3.5, 10);
    torch(15.4, 3.5, -10); torch(15.4, 3.5, 10);
    torch(0, 3.5, -13.5);
    // Secret bookcase concealing the tunnel entrance (north wall, center)
    // Tunnel opening is built into the north wall at x=-1.5..1.5, y=0..3.2
    // (handled below as wall segments). The bookcase sits just in front, ajar.
    const secBookcase = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 4.0, 0.32),
      new THREE.MeshLambertMaterial({ color: 0x120a02 })
    );
    secBookcase.position.set(0, 2.0, 13.4); secBookcase.rotation.y = 0.08;
    secBookcase.castShadow = true; g.add(secBookcase);
    // Suggest books on the secret bookcase
    for (let by = 0; by < 3; by++) for (let bx = -1; bx <= 1; bx++) {
      box(0.7, 0.6, 0.18, new THREE.MeshLambertMaterial({ color: [0x4a2010,0x2a4a30,0x1a3a5a][bx+1] }),
          bx * 0.9, 0.8 + by * 1.1, 13.25, false);
    }

    // Basement north wall — split into side panels + lintel so the tunnel
    // opening (x=-1.5..1.5, y=0..3.2) stays clear.
    box(13.25, 5, 0.3, darkS, -16 + 13.25 / 2, 2.5, 14);
    box(13.25, 5, 0.3, darkS,  16 - 13.25 / 2, 2.5, 14);
    box(3,    1.8, 0.3, darkS, 0, 4.1, 14);   // lintel above the tunnel mouth

    // ── GROUND FLOOR (y=5..10) ───────────────────────────────────────────
    // Ground-floor slab. Hole at x=9..13, z=1..8 for basement stair.
    // Build as 4 panels:
    box(32, 0.3, 15, floorM, 0,           5 - 0.15, -14 + 15 / 2);  // south slab
    box(32, 0.3, 6,  floorM, 0,           5 - 0.15,   8 + 6 / 2);   // north slab
    box(25, 0.3, 7,  floorM, -16 + 25 / 2, 5 - 0.15,  1 + 7 / 2);   // west of hole
    box(3,  0.3, 7,  floorM,  13 + 3 / 2, 5 - 0.15,   1 + 7 / 2);   // east of hole

    // Ground-floor exterior walls (y=5..10). Front door opening at z=-14, x=-1.5..1.5.
    box(13.25, 5, 0.3, ext, -16 + 13.25 / 2, 7.5, -14);
    box(13.25, 5, 0.3, ext,  16 - 13.25 / 2, 7.5, -14);
    box(3, 1.5, 0.3, ext, 0, 9.25, -14);                              // lintel
    box(32, 5, 0.3, ext, 0, 7.5,  14);                                // north
    box(0.3, 5, 28, ext, -16, 7.5, 0);                                // west
    box(0.3, 5, 28, ext,  16, 7.5, 0);                                // east
    // Windows
    win(-11, 7.5, -14.05, 1.8, 2, 0.05); win(11, 7.5, -14.05, 1.8, 2, 0.05);
    win(-16.05, 7.5, -7, 0.05, 2, 1.8);  win(-16.05, 7.5, 7, 0.05, 2, 1.8);
    win( 16.05, 7.5, -7, 0.05, 2, 1.8);  win( 16.05, 7.5, 7, 0.05, 2, 1.8);
    win(-7, 7.5, 14.05, 1.8, 2, 0.05);   win(7, 7.5, 14.05, 1.8, 2, 0.05);

    // Interior partitions on ground floor.
    // x=-7 wall (Drawing/Library on west of it, Foyer/Great Hall on east)
    //   Doorways: Drawing↔Foyer (z=-9..-7), Library↔Great Hall (z=7..9)
    box(0.2, 5, 5,  ext, -7, 7.5, -11.5);                             // z: -14..-9
    box(0.2, 5, 14, ext, -7, 7.5, 0);                                 // z: -7..+7
    box(0.2, 5, 5,  ext, -7, 7.5,  11.5);                             // z: +9..+14
    box(0.2, 1.5, 2, ext, -7, 9.25, -8);                              // lintel south door
    box(0.2, 1.5, 2, ext, -7, 9.25,  8);                              // lintel north door
    // x=+7 wall (mirror)
    box(0.2, 5, 5,  ext,  7, 7.5, -11.5);
    box(0.2, 5, 14, ext,  7, 7.5, 0);
    box(0.2, 5, 5,  ext,  7, 7.5,  11.5);
    box(0.2, 1.5, 2, ext,  7, 9.25, -8);
    box(0.2, 1.5, 2, ext,  7, 9.25,  8);
    // z=-2 wall separating Foyer from Great Hall, x=-7..+7. Door at x=-1.5..1.5.
    box(5.5, 5, 0.2, ext, -7 + 5.5 / 2, 7.5, -2);
    box(5.5, 5, 0.2, ext,  7 - 5.5 / 2, 7.5, -2);
    box(3, 1.5, 0.2, ext, 0, 9.25, -2);
    // z=0 wall Drawing↔Library (x=-16..-7), door at x=-11
    box(3.5, 5, 0.2, ext, -16 + 3.5 / 2, 7.5, 0);
    box(2.5, 5, 0.2, ext,  -7 - 2.5 / 2, 7.5, 0);
    box(3, 1.5, 0.2, ext, -11, 9.25, 0);
    // z=0 wall Dining↔Kitchen (x=+7..+16), door at x=+11
    box(3.5, 5, 0.2, ext,  16 - 3.5 / 2, 7.5, 0);
    box(2.5, 5, 0.2, ext,   7 + 2.5 / 2, 7.5, 0);
    box(3, 1.5, 0.2, ext,  11, 9.25, 0);

    // Foyer carpet runner + columns + chandelier
    box(3, 0.05, 11, carpM, 0, 5.18, -8);
    for (const cx of [-5, 5]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 4.5, 8), goldM);
      col.position.set(cx, 7.4, -10); col.castShadow = true; g.add(col);
    }
    const chand = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.06, 6, 12), goldM);
    chand.rotation.x = Math.PI / 2; chand.position.set(0, 9.6, -8); g.add(chand);
    // Great Hall parquet tiles
    for (let xi = -3; xi <= 3; xi++) for (let zi = 0; zi <= 5; zi++) {
      box(2, 0.05, 1.9, (xi + zi) % 2 === 0 ? woodM : lightWd, xi * 2, 5.18, 4 + zi * 2);
    }
    // Great Hall chandelier
    const chand2 = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.07, 6, 12), goldM);
    chand2.rotation.x = Math.PI / 2; chand2.position.set(0, 9.6, 6); g.add(chand2);

    // Grand staircase up to upper floor — in Great Hall, rising north.
    // Bottom (i=0) at z=8, top (i=12) at z=14 lining up with upper-floor edge.
    stairs(0, 7.75, 3, 'north', 5, 10);
    box(0.15, 1.2, 6.5, woodM, -3, 7.5, 11);
    box(0.15, 1.2, 6.5, woodM,  3, 7.5, 11);

    // Basement staircase down — in Kitchen, descending north
    {
      const steps = 13;
      const rise  = 5 / steps;
      const run   = 0.5;
      for (let i = 0; i < steps; i++) {
        const yTop = 5 - rise * (i + 1);
        box(4, rise, run, woodM, 11, yTop + rise / 2, 1 + run * (i + 0.5));
      }
    }
    box(0.15, 1.2, 7, woodM,  9, 5.2, 4.5);  // west rail
    box(0.15, 1.2, 7, woodM, 13, 5.2, 4.5);  // east rail
    // Stairwell trim around the floor opening
    box(4, 0.3, 0.2, lightWd, 11, 5.1, 1.1);
    box(4, 0.3, 0.2, lightWd, 11, 5.1, 7.9);

    // ── UPPER FLOOR (y=10..15) ───────────────────────────────────────────
    // Upper-floor slab with hole at x=-3..+3, z=8..14 for the grand staircase
    box(32, 0.3, 22, floorM, 0,           10 - 0.15, -14 + 22 / 2);
    box(13, 0.3, 6,  floorM, -16 + 13 / 2, 10 - 0.15, 8 + 6 / 2);
    box(13, 0.3, 6,  floorM,  16 - 13 / 2, 10 - 0.15, 8 + 6 / 2);

    // Upper-floor exterior walls (y=10..15)
    box(32, 5, 0.3, ext, 0, 12.5, -14);
    box(32, 5, 0.3, ext, 0, 12.5,  14);
    box(0.3, 5, 28, ext, -16, 12.5, 0);
    box(0.3, 5, 28, ext,  16, 12.5, 0);
    // Windows (upper)
    win(-11, 12.5, -14.05, 1.6, 1.8, 0.05);
    win(  0, 12.5, -14.05, 1.6, 1.8, 0.05);
    win( 11, 12.5, -14.05, 1.6, 1.8, 0.05);
    win(-16.05, 12.5, -7, 0.05, 1.8, 1.6); win(-16.05, 12.5, 7, 0.05, 1.8, 1.6);
    win( 16.05, 12.5, -7, 0.05, 1.8, 1.6); win( 16.05, 12.5, 7, 0.05, 1.8, 1.6);
    win(-7, 12.5, 14.05, 1.6, 1.8, 0.05);  win(7, 12.5, 14.05, 1.6, 1.8, 0.05);

    // Upper floor partitions: central N-S hallway, 4 corner bedrooms.
    // x=-2 wall, doorways at z=-7 and z=+7
    box(0.2, 5, 5, ext, -2, 12.5, -11.5);
    box(0.2, 5, 8, ext, -2, 12.5, -3);
    box(0.2, 5, 8, ext, -2, 12.5,  3);
    box(0.2, 5, 5, ext, -2, 12.5,  11.5);
    box(0.2, 1.5, 2, ext, -2, 14.25, -7); box(0.2, 1.5, 2, ext, -2, 14.25, 7);
    // x=+2 wall mirror
    box(0.2, 5, 5, ext,  2, 12.5, -11.5);
    box(0.2, 5, 8, ext,  2, 12.5, -3);
    box(0.2, 5, 8, ext,  2, 12.5,  3);
    box(0.2, 5, 5, ext,  2, 12.5,  11.5);
    box(0.2, 1.5, 2, ext, 2, 14.25, -7); box(0.2, 1.5, 2, ext, 2, 14.25, 7);
    // z=0 walls splitting north/south bedrooms
    box(14, 5, 0.2, ext, -16 + 14 / 2, 12.5, 0);
    box(14, 5, 0.2, ext,  16 - 14 / 2, 12.5, 0);
    // Hallway runner
    box(3.5, 0.05, 28, carpM, 0, 10.18, 0);

    // ── ROOF (y=15) ──────────────────────────────────────────────────────
    box(33, 0.4, 29, roofM, 0, 15.2, 0);
    const peak = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 17, 5, 4), roofM);
    peak.rotation.y = Math.PI / 4; peak.position.set(0, 17.7, 0); g.add(peak);
    for (const cx of [-10, 10]) box(1.4, 6, 1.4, ext, cx, 18.4, -5);

    // ── FRONT PORCH (outside south, terrain → ground-floor door) ─────────
    // 13 steps rising NORTH: bottom (i=0) at z=-20.25 (terrain), top (i=12)
    // at z=-14.25 just south of the front door.
    stairs(0, -20.5, 3.5, 'north', 0, 5, ext);
    // Porch railings (along stair sides)
    for (const sx of [-3.5, 3.5]) box(0.25, 1.6, 6.5, ext, sx, 2.5, -17.5);
    // Door-side lanterns
    torch(-3, 6.8, -14.3); torch(3, 6.8, -14.3);

    // ── SECRET TUNNEL ────────────────────────────────────────────────────
    // L-shaped passage. North run from basement (local z=14) to corner at
    // z=68.35..71.65, then west run from x=+1.65 down to x=-19 (world 171).
    // Interior: 3.3 wide × 3.2 tall. The west end is OPEN onto terrain so
    // the player can step out beside the surface ruin.
    const tStartZ  = 14;
    const tCornerS = 68.35;  // south face of the corner / north end of north-run walls
    const tCornerN = 71.65;  // north face of the corner / west run's north wall
    const tEndX    = -19;

    // North run interior: x∈[-1.65,+1.65], z∈[tStartZ, tCornerS]
    const nLen     = tCornerS - tStartZ;        // 54.35
    const nCenterZ = (tStartZ + tCornerS) / 2;
    box(3.3, 0.2, nLen, darkS, 0,    0.1, nCenterZ);                 // floor
    box(3.3, 0.2, nLen, darkS, 0,    3.4, nCenterZ);                 // ceiling
    // Walls share the full L east boundary (z up to tCornerN) — added below.
    // North-run west wall (stops at corner)
    box(0.3, 3.2, nLen, darkS, -1.65, 1.8, nCenterZ);
    for (let tz = tStartZ + 4; tz < tCornerS - 4; tz += 5) {
      box(3.3, 0.22, 0.22, woodM, 0, 3.15, tz);
    }
    for (let tz = tStartZ + 6; tz < tCornerS; tz += 14) torch(-1.55, 1.9, tz);

    // Corner + west run: floor + ceiling cover x∈[tEndX, +1.65], z∈[tCornerS, tCornerN]
    const wLen     = 1.65 - tEndX;             // 20.65
    const wCenterX = (tEndX + 1.65) / 2;       // -8.675
    const wCenterZ = (tCornerS + tCornerN) / 2; // 70
    box(wLen, 0.2, 3.3, darkS, wCenterX, 0.1, wCenterZ);
    box(wLen, 0.2, 3.3, darkS, wCenterX, 3.4, wCenterZ);

    // Full L east wall: x=+1.65, z=tStartZ..tCornerN
    const eLen = tCornerN - tStartZ;           // 57.65
    box(0.3, 3.2, eLen, darkS, 1.65, 1.8, (tStartZ + tCornerN) / 2);

    // Full L north wall: z=tCornerN, x=tEndX..+1.65
    box(wLen, 3.2, 0.3, darkS, wCenterX, 1.8, tCornerN);

    // West-run south wall: z=tCornerS, x=tEndX..-1.65 (gap at corner mouth)
    const sLen     = -1.65 - tEndX;             // 17.35
    const sCenterX = (tEndX + -1.65) / 2;       // -10.325
    box(sLen, 3.2, 0.3, darkS, sCenterX, 1.8, tCornerS);

    // West run beams + torches
    for (let tx = tEndX + 4; tx < 0; tx += 5) {
      box(0.22, 0.22, 3.3, woodM, tx, 3.15, wCenterZ);
    }
    for (let tx = tEndX + 6; tx < -2; tx += 9) torch(tx, 1.9, tCornerS + 0.1);

    // West mouth — iron-bar grate (visual only; player passes through).
    for (let by = 0; by < 4; by++) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6), ironM);
      bar.position.set(tEndX + 0.15, 1.7, tCornerS + 0.4 + by * 0.7); g.add(bar);
    }

    return g;
  }

  // ── Mansion secret exit (surface ruin) ─────────────────────────────
  // Visible landmark just north of the tunnel's west mouth. No underground
  // bunker — the tunnel itself is the underground passage. The trapdoor
  // visual and rubble suggest a forgotten cellar entrance that's actually
  // sealed; the real way in is the basement bookcase.
  _makeMansionExit() {
    const g = new THREE.Group();
    const ruinM = new THREE.MeshLambertMaterial({ color: 0x6a5f4e });
    const mossM = new THREE.MeshLambertMaterial({ color: 0x3d5c2a });
    const woodM = new THREE.MeshLambertMaterial({ color: 0x2e1a08 });

    // Partial walls — the ruin is open on the south side so the player
    // can walk in from the tunnel mouth (which lies a few units south).
    const nw = new THREE.Mesh(new THREE.BoxGeometry(7.5, 3.2, 0.4), ruinM);
    nw.position.set(0, 1.6, 3.8); nw.castShadow = true; g.add(nw);    // north wall
    const ww = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3.8, 10), ruinM);
    ww.position.set(-4.0, 1.9, 0); ww.castShadow = true; g.add(ww);   // west wall
    const ewTop = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.8, 6), ruinM);
    ewTop.position.set(4.0, 2.9, -1); ewTop.castShadow = true; g.add(ewTop);  // crumbled east

    // Rubble chunks scattered around
    for (const [dx, dz, dry, sc] of [
      [-2, 3, 0.3, 0.8], [1.5, 3.0, 1.1, 0.6],
      [3, -4, 0.7, 0.9], [-1, -1, 1.5, 0.7], [-2.5, -3, 0.4, 0.55],
    ]) {
      const chunk = new THREE.Mesh(new THREE.BoxGeometry(sc, sc * 0.5, sc * 0.7), ruinM);
      chunk.position.set(dx, sc * 0.25, dz); chunk.rotation.y = dry;
      chunk.castShadow = true; g.add(chunk);
    }
    // Moss patches
    for (const [dx, dz] of [[-3.5, 2], [0, 3.5], [3, 1], [-1.5, -3]]) {
      const moss = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 1.0), mossM);
      moss.position.set(dx, 0.08, dz); g.add(moss);
    }
    // Sealed trapdoor (decoy — the real entry is the basement bookcase)
    const trap = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 1.8), woodM);
    trap.position.set(0, 0.12, 0); g.add(trap);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.08, 0.12), woodM);
    handle.position.set(0, 0.18, 0); g.add(handle);

    return g;
  }

  // ── Nature GLB loader ───────────────────────────────────────────────
  async loadNature() {
    const loader = new GLTFLoader();
    const load = path => new Promise((res, rej) =>
      loader.load(path, g => res(g.scene), null, rej));

    // ── Building footprint exclusion zones ────────────────────────────────
    // Axis-aligned rectangles (world coords) covering every enclosed building
    // interior plus a small margin past the outer walls. Tree / bush / rock
    // placement skips any position inside one of these so foliage never
    // spawns inside houses, cabins, or other shells. Each entry is
    // [xMin, xMax, zMin, zMax]. Add new buildings here when they're built.
    const FOOTPRINT_MARGIN = 1.0;  // extra metres around each rectangle
    const buildings = [
      // ── Cedar Creek ──
      [ 93,   107,  -4.5,  4.5 ],   // main cabin (14×9 @ 100,0)
      [ 82.5, 89.5,  1,    7   ],   // shed (7×6 @ 86,4)
      [110,   118, -17,  -11   ],   // guest cabin (8×6 @ 114,-14)
      // ── Frank's Jail ──
      [-138, -118, 35,    65   ],   // cellblock (20×30 @ -128,50)
      [-117,  -97, 39,    61   ],   // exercise yard (20×22 @ -107,50)
      // ── Military Compound ──
      [ -59,  -41, 74,    86   ],   // main bunker (18×12 @ -50,80)
      [ -74,  -62, 68,    76   ],   // secondary bunker (12×8 @ -68,72)
      // ── Olsen's Farm ──
      [144,   156, -79.5, -70.5],   // farmhouse (12×9 @ 150,-75)
      [162,   178, -82,   -72  ],   // barn 1 (16×10 @ 170,-77)
      [128,   138, -79,   -71  ],   // barn 2 (10×8 @ 133,-75)
      // ── Whalen's Town ── (north & south rows of 8 houses)
      [-148.5,-141.5,-131,-125],    // house @ -145,-128 (7×6)
      [-136,  -130, -130.5,-125.5], // house @ -133,-128 (6×5)
      [-123,  -115, -131,  -125],   // house @ -119,-128 (8×6)
      [-110,  -104, -130.5,-125.5], // house @ -107,-128 (6×5)
      [-148.5,-141.5,-115, -109],   // house @ -145,-112 (7×6)
      [-136,  -130, -114.5,-109.5], // house @ -133,-112 (6×5)
      [-123,  -115, -115,  -109],   // house @ -119,-112 (8×6)
      [-110,  -104, -114.5,-109.5], // house @ -107,-112 (6×5)
      [-129,  -121, -147,  -137  ], // church (8×10 @ -125,-142)
      [-133,  -117, -104,  -92   ], // town hall (16×12 @ -125,-98)
      [-108,   -98, -124,  -116  ], // tavern (10×8 @ -103,-120)
      [-151,  -143, -123.5,-116.5], // blacksmith (8×7 @ -147,-120)
      // ── Samuel's Mansion ──
      [ 174,  206,  106,   134  ],  // basement / main footprint (32×28 @ 190,120)
    ];

    // Returns true if (wx, wz) lies inside any building footprint (with margin).
    const isInsideBuilding = (wx, wz) => {
      const m = FOOTPRINT_MARGIN;
      for (const b of buildings) {
        if (wx >= b[0] - m && wx <= b[1] + m &&
            wz >= b[2] - m && wz <= b[3] + m) return true;
      }
      return false;
    };

    // Collect placements per model, then instance them all at the end.
    const _placements = new Map();
    const placeNature = (model, wx, wz, rotY = 0, scale = 1) => {
      // Skip anything overlapping a building interior so trees don't spawn
      // inside houses, the jail, bunkers, etc.
      if (isInsideBuilding(wx, wz)) return;
      const wy = this._getHeight(wx, wz);
      if (wy < 0) return;
      let arr = _placements.get(model);
      if (!arr) { arr = []; _placements.set(model, arr); }
      arr.push({ wx, wy, wz, rotY, scale });
    };

    // Load the subset of models we'll use
    let pine, pine2, pine3, tree, twistedTree, bush, bushFlowers,
        fern, tallGrass, flowerGroup, mushroom, rockMed, plant, plantBig;
    try {
      [pine, pine2, pine3, tree, twistedTree, bush, bushFlowers,
       fern, tallGrass, flowerGroup, mushroom, rockMed, plant, plantBig] =
        await Promise.all([
          load('objects/nature/Pine.glb'),
          load('objects/nature/Pine-699sFuLCN2.glb'),
          load('objects/nature/Pine-79gmlLnweB.glb'),
          load('objects/nature/Tree.glb'),
          load('objects/nature/Twisted Tree.glb'),
          load('objects/nature/Bush.glb'),
          load('objects/nature/Bush with Flowers.glb'),
          load('objects/nature/Fern.glb'),
          load('objects/nature/Tall Grass.glb'),
          load('objects/nature/Flower Group.glb'),
          load('objects/nature/Mushroom.glb'),
          load('objects/nature/Rock Medium.glb'),
          load('objects/nature/Plant.glb'),
          load('objects/nature/Plant Big-MbhbP7JrTI.glb'),
        ]);
    } catch (e) {
      console.warn('[nature] Some models failed to load:', e);
      return;
    }

    const hOF = this._getHeight(150, -75);   // Olsen's Farm ground Y
    const PI  = Math.PI;

    // ── Olsen's Farm — nature dressing ──────────────────────────────────────
    // Trees around the farm perimeter
    const farmTrees = [
      // North fence line
      { x: 138, z: -90, m: pine,        r: 0,        s: 1.2 },
      { x: 142, z: -92, m: pine2,       r: PI*0.3,   s: 1.0 },
      { x: 146, z: -91, m: tree,        r: PI*0.7,   s: 1.1 },
      { x: 162, z: -90, m: pine3,       r: PI*0.5,   s: 1.3 },
      { x: 168, z: -92, m: pine,        r: PI*1.2,   s: 0.9 },
      { x: 174, z: -90, m: pine2,       r: PI*0.8,   s: 1.1 },
      { x: 180, z: -91, m: tree,        r: PI*0.2,   s: 1.0 },
      // South side
      { x: 140, z: -60, m: twistedTree, r: 0,        s: 1.0 },
      { x: 155, z: -58, m: pine,        r: PI*0.6,   s: 1.2 },
      { x: 168, z: -60, m: tree,        r: PI*1.1,   s: 1.1 },
      // West side
      { x: 124, z: -80, m: twistedTree, r: PI*0.4,   s: 0.9 },
      { x: 122, z: -70, m: pine3,       r: PI*0.9,   s: 1.0 },
      // East side
      { x: 182, z: -80, m: pine2,       r: PI*1.3,   s: 1.2 },
      { x: 183, z: -70, m: pine,        r: 0,        s: 1.0 },
    ];
    for (const t of farmTrees) placeNature(t.m, t.x, t.z, t.r, t.s);

    // Ground cover: bushes, ferns, flowers around paths and borders
    const farmGroundCover = [
      // Along barn approaches
      { x: 143, z: -76, m: bushFlowers, r: 0,       s: 1 },
      { x: 144, z: -72, m: fern,        r: PI*0.5,  s: 1 },
      { x: 156, z: -69, m: bush,        r: PI*0.3,  s: 1 },
      { x: 157, z: -72, m: flowerGroup, r: 0,       s: 1 },
      { x: 160, z: -68, m: fern,        r: PI*0.8,  s: 1 },
      // Around farmhouse
      { x: 142, z: -80, m: bushFlowers, r: PI*0.2,  s: 1 },
      { x: 142, z: -74, m: fern,        r: PI*1.0,  s: 1 },
      { x: 158, z: -80, m: bush,        r: PI*0.6,  s: 1 },
      { x: 158, z: -74, m: flowerGroup, r: PI*0.4,  s: 1 },
      // Near barn 1 (170, -77)
      { x: 162, z: -82, m: fern,        r: 0,       s: 1 },
      { x: 178, z: -82, m: bush,        r: PI*1.1,  s: 1 },
      { x: 178, z: -72, m: bushFlowers, r: PI*0.7,  s: 1 },
      { x: 162, z: -72, m: flowerGroup, r: PI*0.3,  s: 1 },
      // Near barn 2 (133, -75)
      { x: 126, z: -80, m: fern,        r: PI*0.5,  s: 1 },
      { x: 126, z: -70, m: bush,        r: PI*0.9,  s: 1 },
      { x: 139, z: -68, m: flowerGroup, r: 0,       s: 1 },
      { x: 140, z: -82, m: fern,        r: PI*1.3,  s: 1 },
      // Scattered mushrooms
      { x: 148, z: -88, m: mushroom,    r: 0,       s: 1.2 },
      { x: 166, z: -86, m: mushroom,    r: PI*0.6,  s: 1.0 },
      { x: 128, z: -76, m: mushroom,    r: PI*1.2,  s: 0.9 },
      // Tall grass tufts near fence
      { x: 150, z: -88, m: tallGrass,   r: 0,       s: 1 },
      { x: 164, z: -89, m: tallGrass,   r: PI*0.4,  s: 1 },
      { x: 136, z: -87, m: tallGrass,   r: PI*0.9,  s: 1 },
      { x: 176, z: -88, m: tallGrass,   r: PI*1.5,  s: 1 },
      // Plants by farmhouse walls
      { x: 143, z: -79, m: plant,       r: 0,       s: 1 },
      { x: 157, z: -79, m: plantBig,    r: PI,      s: 1 },
      { x: 150, z: -70, m: plant,       r: PI*0.5,  s: 1 },
      // Rocks
      { x: 135, z: -83, m: rockMed,     r: PI*0.3,  s: 1 },
      { x: 175, z: -83, m: rockMed,     r: PI*1.0,  s: 1.2 },
      { x: 152, z: -86, m: rockMed,     r: PI*0.7,  s: 0.8 },
    ];
    for (const gc of farmGroundCover) placeNature(gc.m, gc.x, gc.z, gc.r, gc.s);

    // ── GLB trees scattered across the map ───────────────────────────────────
    // Strategic clusters to enrich the island without overwhelming the POIs.
    // Uses a fixed list so placement is deterministic (no Math.random).
    const mapTrees = [
      // North-west forest
      { x: -60,  z: -30,  m: pine,        r: 0,        s: 1.1 },
      { x: -55,  z: -22,  m: pine2,       r: PI*0.7,   s: 1.2 },
      { x: -65,  z: -18,  m: tree,        r: PI*0.3,   s: 1.0 },
      { x: -72,  z: -28,  m: twistedTree, r: PI*1.1,   s: 1.0 },
      { x: -62,  z: -40,  m: pine3,       r: PI*0.5,   s: 1.3 },
      { x: -50,  z: -35,  m: pine,        r: PI*0.9,   s: 1.1 },
      { x: -78,  z: -14,  m: tree,        r: PI*1.4,   s: 1.0 },
      // Between Cedar Creek and Ancient Temple
      { x:  58,  z: -55,  m: pine,        r: PI*0.2,   s: 1.0 },
      { x:  65,  z: -65,  m: pine2,       r: PI*0.8,   s: 1.1 },
      { x:  50,  z: -75,  m: twistedTree, r: PI*1.2,   s: 0.9 },
      { x:  72,  z: -80,  m: pine3,       r: 0,        s: 1.2 },
      { x:  45,  z: -50,  m: tree,        r: PI*0.6,   s: 1.0 },
      // South-east coastline
      { x: 100,  z: -110, m: pine,        r: PI*0.3,   s: 1.1 },
      { x: 110,  z: -120, m: pine2,       r: PI*1.0,   s: 1.0 },
      { x:  90,  z: -125, m: twistedTree, r: PI*0.5,   s: 0.9 },
      { x: 120,  z: -105, m: tree,        r: PI*1.3,   s: 1.2 },
      // East ridge near Olsen's Farm approach
      { x: 120,  z: -45,  m: pine,        r: 0,        s: 1.0 },
      { x: 128,  z: -52,  m: pine3,       r: PI*0.6,   s: 1.1 },
      { x: 118,  z: -58,  m: tree,        r: PI*1.1,   s: 1.0 },
      // Near Military Compound (avoid buildings, stay outside)
      { x: -22,  z:  72,  m: pine,        r: PI*0.4,   s: 1.0 },
      { x: -18,  z:  82,  m: pine2,       r: PI*0.9,   s: 1.1 },
      { x: -30,  z:  95,  m: twistedTree, r: PI*0.2,   s: 0.9 },
      { x: -38,  z: 100,  m: pine3,       r: PI*1.0,   s: 1.0 },
      // Frank's Jail surroundings (kept outside compound footprint)
      { x: -98,  z:  28,  m: pine,        r: 0,        s: 1.2 },
      { x: -100, z:  72,  m: twistedTree, r: PI*0.4,   s: 1.0 },
      { x: -148, z:  30,  m: pine2,       r: PI*1.3,   s: 1.1 },
      { x: -150, z:  70,  m: pine3,       r: PI*0.8,   s: 1.2 },
      // Whalen's Town approach
      { x: -100, z: -105, m: pine,        r: PI*1.0,   s: 1.0 },
      { x: -95,  z: -115, m: pine2,       r: PI*0.3,   s: 1.1 },
      { x: -102, z: -128, m: tree,        r: PI*0.6,   s: 1.0 },
      { x: -148, z: -100, m: twistedTree, r: PI*1.2,   s: 0.9 },
      { x: -152, z: -110, m: pine3,       r: PI*0.1,   s: 1.1 },
      // Central area sparse trees
      { x:  20,  z:  35,  m: pine,        r: 0,        s: 1.0 },
      { x:  28,  z:  28,  m: pine2,       r: PI*0.5,   s: 1.1 },
      { x:  12,  z:  45,  m: tree,        r: PI*1.0,   s: 1.0 },
      { x: -15,  z:  20,  m: twistedTree, r: PI*0.4,   s: 0.9 },
      { x:  35,  z:  18,  m: pine3,       r: PI*1.3,   s: 1.0 },
      // Ancient Temple surroundings
      { x:  15,  z: -140, m: twistedTree, r: PI*0.8,   s: 1.0 },
      { x:  55,  z: -148, m: pine,        r: PI*0.2,   s: 1.1 },
      { x:  60,  z: -162, m: pine2,       r: PI*1.0,   s: 1.0 },
      { x:  12,  z: -172, m: twistedTree, r: PI*0.6,   s: 0.9 },
    ];
    for (const t of mapTrees) placeNature(t.m, t.x, t.z, t.r, t.s);

    // Render all collected placements as instanced meshes.
    for (const [model, list] of _placements) this._instanceClones(model, list);
  }

  _makeCedarCreek() {
    const g = new THREE.Group();
    const logMat   = new THREE.MeshLambertMaterial({ color: 0x8b6343 });
    const darkWood = new THREE.MeshLambertMaterial({ color: 0x5a3c1e });
    const roofMat  = new THREE.MeshLambertMaterial({ color: 0x4a3018 });
    const winMat   = new THREE.MeshLambertMaterial({ color: 0xaaddff, transparent: true, opacity: 0.6 });
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x888070 });
    const plankMat = new THREE.MeshLambertMaterial({ color: 0xa0784a });

    // ─ Main cabin ─
    const shell = this._hollowBox(14, 6, 9, logMat, 2.2, 3.5); shell.position.set(0, 0, 0); g.add(shell);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(9, 4, 4), roofMat);
    roof.position.set(0, 7.5, 0); roof.rotation.y = Math.PI/4; roof.castShadow = true; g.add(roof);
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(1.4, 4, 1.4), stoneMat);
    chimney.position.set(4, 8, 0); chimney.castShadow = true; g.add(chimney);
    const porch = new THREE.Mesh(new THREE.BoxGeometry(14, 0.25, 3.5), plankMat);
    porch.position.set(0, 0.12, -6.25); g.add(porch);
    for (const px of [-5.5, 0, 5.5]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 2.5, 6), darkWood);
      post.position.set(px, 1.25, -7.8); g.add(post);
    }
    const porchRoof = new THREE.Mesh(new THREE.BoxGeometry(14, 0.2, 3.5), roofMat);
    porchRoof.position.set(0, 2.6, -6.25); g.add(porchRoof);
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.8, 3.2, 0.2), darkWood);
    door.position.set(0, 1.6, -4.6); g.add(door);
    for (const [wx, wz] of [[-4, -4.6],[4, -4.6],[-7.1, 0],[7.1, 0]]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.5, 2), winMat);
      win.position.set(wx, 3, wz); g.add(win);
    }
    const cabinFloor = new THREE.Mesh(new THREE.BoxGeometry(13.8, 0.15, 8.8), plankMat);
    cabinFloor.position.set(0, 0.07, 0); cabinFloor.receiveShadow = true; g.add(cabinFloor);

    // ─ Tool shed ─
    const shedShell = this._hollowBox(7, 4, 6, logMat, 2.0, 3.0); shedShell.position.set(-14, 0, 4); g.add(shedShell);
    const shedRoof = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.25, 6.5), roofMat);
    shedRoof.position.set(-14, 4.12, 4); g.add(shedRoof);
    const shedFloor = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.15, 5.8), plankMat);
    shedFloor.position.set(-14, 0.07, 4); g.add(shedFloor);

    // ─ Outhouse ─
    const outhouse = new THREE.Mesh(new THREE.BoxGeometry(2.5, 3, 2.5), darkWood);
    outhouse.position.set(10, 1.5, -10); outhouse.castShadow = true; g.add(outhouse);
    const outhouseRoof = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.2, 2.8), roofMat);
    outhouseRoof.position.set(10, 3.1, -10); g.add(outhouseRoof);

    // ─ Woodpile ─
    const logPileMat = new THREE.MeshLambertMaterial({ color: 0x7a4a20 });
    for (let i = 0; i < 4; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 3, 7), logPileMat);
      log.rotation.z = Math.PI/2; log.position.set(-5, 0.22 + i*0.44, -8); g.add(log);
    }

    // ─ Firepit ─
    const fireRing = new THREE.Mesh(new THREE.TorusGeometry(1, 0.22, 6, 12), stoneMat);
    fireRing.rotation.x = Math.PI/2; fireRing.position.set(5, 0.2, -12); g.add(fireRing);
    const ember = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.2, 8),
      new THREE.MeshLambertMaterial({ color: 0xff4400 }));
    ember.position.set(5, 0.1, -12); g.add(ember);
    for (let i = 0; i < 3; i++) {
      const angle = (i/3)*Math.PI*2;
      const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 2, 7), logPileMat);
      seat.rotation.z = Math.PI/2;
      seat.position.set(5 + Math.cos(angle)*2.2, 0.35, -12 + Math.sin(angle)*2.2);
      seat.rotation.y = angle; g.add(seat);
    }

    // ─ Dock / pier ─
    for (let i = 0; i < 5; i++) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.2, 0.9), plankMat);
      plank.position.set(6, 0.1, 5 + i*2); g.add(plank);
    }
    for (const px2 of [5.1, 6.9]) {
      for (let i = 0; i < 3; i++) {
        const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 2, 6), darkWood);
        pile.position.set(px2, 0, 6 + i*4); g.add(pile);
      }
    }

    // ─ Fence perimeter ─
    const fMat = new THREE.MeshLambertMaterial({ color: 0x9a7a50 });
    for (let i = 0; i < 14; i++) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.4, 0.2), fMat);
      post.position.set(-10 + i*2.5, 0.7, -15); g.add(post);
    }
    const fRail = new THREE.Mesh(new THREE.BoxGeometry(32, 0.12, 0.1), fMat);
    fRail.position.set(6, 1.1, -15); g.add(fRail);

    // ─ Garden patch ─
    const soilMat = new THREE.MeshLambertMaterial({ color: 0x5a3a18 });
    const soil = new THREE.Mesh(new THREE.BoxGeometry(8, 0.15, 5), soilMat);
    soil.position.set(-10, 0.07, -10); g.add(soil);
    const plantMat = new THREE.MeshLambertMaterial({ color: 0x2d8b22 });
    for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) {
      const plant = new THREE.Mesh(new THREE.SphereGeometry(0.25, 5, 4), plantMat);
      plant.position.set(-13 + c*1.5, 0.5, -12 + r*1.8); g.add(plant);
    }

    // ─ Second cabin / guest house ─
    const gShell = this._hollowBox(8, 4, 6, logMat, 1.8, 3.0); gShell.position.set(14, 0, -14); g.add(gShell);
    const gRoof = new THREE.Mesh(new THREE.ConeGeometry(6, 3, 4), roofMat);
    gRoof.position.set(14, 5.25, -14); gRoof.rotation.y = Math.PI/4; g.add(gRoof);
    const gFloor = new THREE.Mesh(new THREE.BoxGeometry(7.8, 0.15, 5.8), plankMat);
    gFloor.position.set(14, 0.07, -14); g.add(gFloor);

    // ─ Hunting stand (tall platform) ─
    for (const [lx, lz] of [[-18,-14],[-16,-14],[-18,-12],[-16,-12]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 5, 6), darkWood);
      leg.position.set(lx, 2.5, lz); g.add(leg);
    }
    const stand = new THREE.Mesh(new THREE.BoxGeometry(3, 0.2, 3), plankMat);
    stand.position.set(-17, 5.1, -13); g.add(stand);
    const sRail = new THREE.Mesh(new THREE.BoxGeometry(3, 0.8, 0.1), darkWood);
    sRail.position.set(-17, 5.5, -11.5); g.add(sRail);

    return g;
  }

  _makeFranksJail() {
    const g = new THREE.Group();
    const concrete     = new THREE.MeshLambertMaterial({ color: 0x8a8a86 });
    const darkConcrete = new THREE.MeshLambertMaterial({ color: 0x5a5a56 });
    const barsMat      = new THREE.MeshLambertMaterial({ color: 0x33363c });
    const barbedMat    = new THREE.MeshLambertMaterial({ color: 0x222222 });
    const fenceMat     = new THREE.MeshLambertMaterial({ color: 0x4a4a4a });
    const yardMat      = new THREE.MeshLambertMaterial({ color: 0x6a6258 });
    const lightMat     = new THREE.MeshLambertMaterial({
      color: 0xfff0a0, emissive: 0xffcc66, emissiveIntensity: 1.0,
    });
    const slitMat = new THREE.MeshBasicMaterial({ color: 0x111416 });

    // ── Cellblock (20 wide × 30 deep × 8 tall, door faces −Z) ────────────
    // Floor slab is buried so its top sits right at terrain level (y=0.05
    // local just to avoid z-fighting with the terrain mesh). The slab body
    // extends 1.5m down to mask any minor terrain noise at the building edges.
    const floor = new THREE.Mesh(new THREE.BoxGeometry(20, 1.5, 30), darkConcrete);
    floor.position.set(0, -0.7, 0); floor.receiveShadow = true; g.add(floor);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(20, 0.4, 30), concrete);
    roof.position.set(0, 8.2, 0); roof.castShadow = true; g.add(roof);

    // Outer walls — 0.6m thick, 8m tall
    const wallBack = new THREE.Mesh(new THREE.BoxGeometry(20, 8, 0.6), concrete);
    wallBack.position.set(0, 4, 15); wallBack.castShadow = true; g.add(wallBack);
    const wallW = new THREE.Mesh(new THREE.BoxGeometry(0.6, 8, 30), concrete);
    wallW.position.set(-10, 4, 0); wallW.castShadow = true; g.add(wallW);
    const wallE = new THREE.Mesh(new THREE.BoxGeometry(0.6, 8, 30), concrete);
    wallE.position.set(10, 4, 0); wallE.castShadow = true; g.add(wallE);
    // Front wall with 3.5m door gap
    const frontL = new THREE.Mesh(new THREE.BoxGeometry(8.25, 8, 0.6), concrete);
    frontL.position.set(-5.875, 4, -15); g.add(frontL);
    const frontR = new THREE.Mesh(new THREE.BoxGeometry(8.25, 8, 0.6), concrete);
    frontR.position.set(5.875, 4, -15); g.add(frontR);
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(3.5, 2.5, 0.6), darkConcrete);
    lintel.position.set(0, 6.75, -15); g.add(lintel);

    // ── Cell partitions (perpendicular to corridor) ──────────────────────
    // 3 cells per side, separators at z = -13.5, -4.5, 4.5, 13.5
    const partZ = [-13.5, -4.5, 4.5, 13.5];
    for (const cz of partZ) {
      const wp = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 0.4), concrete);
      wp.position.set(-6, 4, cz); g.add(wp);
      const ep = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 0.4), concrete);
      ep.position.set(6, 4, cz); g.add(ep);
    }

    // Vertical bars facing the corridor (skip middle 2m for cell door)
    const makeBars = (x) => {
      for (let i = 0; i < 3; i++) {
        const z0 = partZ[i], z1 = partZ[i+1];
        const zMid = (z0 + z1) / 2;
        const barCount = 14;
        for (let b = 0; b < barCount; b++) {
          const t = b / (barCount - 1);
          const z = z0 + 0.4 + (z1 - z0 - 0.8) * t;
          if (z > zMid - 1 && z < zMid + 1) continue;
          const bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 7.5, 0.12), barsMat);
          bar.position.set(x, 3.75, z); g.add(bar);
        }
        // Horizontal crossbars (top + mid)
        const top = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, z1 - z0 - 0.6), barsMat);
        top.position.set(x, 7.4, zMid); g.add(top);
        const mid = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, z1 - z0 - 0.6), barsMat);
        mid.position.set(x, 3.75, zMid); g.add(mid);
      }
    };
    makeBars(-2);
    makeBars( 2);

    // Concrete cot in each cell (along outer wall)
    for (let i = 0; i < 3; i++) {
      const zMid = (partZ[i] + partZ[i+1]) / 2;
      const cotW = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.5, 6.5), darkConcrete);
      cotW.position.set(-8, 0.75, zMid); g.add(cotW);
      const cotE = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.5, 6.5), darkConcrete);
      cotE.position.set(8, 0.75, zMid); g.add(cotE);
    }

    // Corridor fluorescent strip lights
    for (let i = 0; i < 5; i++) {
      const z = -12 + i * 6;
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 2.5), lightMat);
      lamp.position.set(0, 7.9, z); g.add(lamp);
    }

    // "FRANK'S JAIL" sign over door
    const sign = new THREE.Mesh(new THREE.BoxGeometry(11, 2, 0.25), darkConcrete);
    sign.position.set(0, 9.5, -15.15); g.add(sign);

    // ── Exercise yard (east of cellblock, fenced) ────────────────────────
    // Same trick: buried slab with top a hair above terrain.
    const yardFloor = new THREE.Mesh(new THREE.BoxGeometry(20, 1, 22), yardMat);
    yardFloor.position.set(21, -0.45, 0); yardFloor.receiveShadow = true; g.add(yardFloor);

    const fencePost = (x, z) => {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 5, 0.3), fenceMat);
      post.position.set(x, 2.5, z); g.add(post);
    };
    const fencePanel = (x, z, w, vertical) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, 4.6),
        new THREE.MeshBasicMaterial({ color: 0x555555, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
      );
      m.position.set(x, 2.5, z);
      if (vertical) m.rotation.y = Math.PI / 2;
      g.add(m);
    };
    // East fence (x=31, z=-11..11)
    for (let i = 0; i <= 11; i++) fencePost(31, -11 + i * 2);
    fencePanel(31, 0, 22, true);
    // South fence (z=-11, x=11..31)
    for (let i = 0; i <= 10; i++) fencePost(11 + i * 2, -11);
    fencePanel(21, -11, 20, false);
    // North fence (z=11, x=11..31)
    for (let i = 0; i <= 10; i++) fencePost(11 + i * 2, 11);
    fencePanel(21, 11, 20, false);

    // Barbed wire across fence tops
    const barbedTop = (x, z, len, alongX) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, len, 5), barbedMat);
      m.position.set(x, 5.1, z);
      if (alongX) m.rotation.z = Math.PI / 2;
      else m.rotation.x = Math.PI / 2;
      g.add(m);
    };
    barbedTop(31, 0, 22, false);
    barbedTop(21, -11, 20, true);
    barbedTop(21,  11, 20, true);

    // Basketball hoop in yard
    const hoopPost = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 5, 8), darkConcrete);
    hoopPost.position.set(28, 2.5, 0); g.add(hoopPost);
    const backboard = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 1.8, 2.6),
      new THREE.MeshLambertMaterial({ color: 0xddd5b5 })
    );
    backboard.position.set(27.5, 4.5, 0); g.add(backboard);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.5, 0.06, 6, 14),
      new THREE.MeshLambertMaterial({ color: 0xff4400 })
    );
    rim.rotation.x = Math.PI / 2; rim.position.set(26.8, 4, 0); g.add(rim);

    // ── 4 watchtowers at compound corners ────────────────────────────────
    // Each tower: solid 16 m base pillar with a vertical ladder mounted on
    // the east face, leading to an open balcony deck under a canopy roof.
    // The balcony is a sniper perch — players can stand on it but cannot
    // enter an interior (there is none). Ladder params are mirrored
    // verbatim by the collision setup in _buildStructures.
    const LADDER_RUNGS = 40;            // 40 × 0.4 m = 16 m total climb
    const LADDER_RISE  = 0.4;
    const LADDER_OFF_X = 1.7;           // distance from tower centre (east face)

    const makeWatchtower = (x, z) => {
      // Solid base
      const base = new THREE.Mesh(new THREE.BoxGeometry(3, 16, 3), concrete);
      base.position.set(x, 8, z); base.castShadow = true; g.add(base);

      // Vertical ladder on the east face — two side rails and horizontal
      // rungs. Player walks into it and the stacked collision floors lift
      // them to the balcony level.
      const rail = (dz) => {
        const r = new THREE.Mesh(new THREE.BoxGeometry(0.08, 16.2, 0.08), darkConcrete);
        r.position.set(x + LADDER_OFF_X, 8.1, z + dz);
        g.add(r);
      };
      rail(-0.3);
      rail( 0.3);
      for (let i = 0; i < LADDER_RUNGS; i++) {
        const ry = LADDER_RISE * (i + 1);
        const rung = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.7), darkConcrete);
        rung.position.set(x + LADDER_OFF_X, ry, z);
        g.add(rung);
      }

      // Balcony deck (open platform replacing the old booth).
      const deck = new THREE.Mesh(new THREE.BoxGeometry(5, 0.3, 5), concrete);
      deck.position.set(x, 16.15, z); deck.receiveShadow = true; g.add(deck);

      // Corner posts holding the canopy roof.
      for (const [dx, dz] of [[-2.35,-2.35],[2.35,-2.35],[-2.35,2.35],[2.35,2.35]]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.8, 0.3), darkConcrete);
        post.position.set(x + dx, 17.7, z + dz); post.castShadow = true; g.add(post);
      }

      // Canopy roof above
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.3, 5.5), concrete);
      canopy.position.set(x, 19.25, z); canopy.castShadow = true; g.add(canopy);

      // Searchlight mounted on one of the corner posts.
      const sl = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.7, 8), lightMat);
      sl.rotation.z = Math.PI / 2;
      sl.position.set(x + (x < 10 ? 2 : -2), 18, z);
      g.add(sl);
    };
    makeWatchtower(-13, -19);
    makeWatchtower( 33, -19);
    makeWatchtower(-13,  19);
    makeWatchtower( 33,  19);

    return g;
  }

  _makeAncientTemple() {
    const g = new THREE.Group();
    const stoneMat  = new THREE.MeshLambertMaterial({ color: 0xb0a888 });
    const darkStone = new THREE.MeshLambertMaterial({ color: 0x7a7060 });
    const mossStone = new THREE.MeshLambertMaterial({ color: 0x7a8860 });

    // Grand staircase
    for (let i = 0; i < 5; i++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(18 - i*0.8, 0.6, 2), stoneMat);
      step.position.set(0, i*0.6, -10 + i*2); step.receiveShadow = true; g.add(step);
    }

    // Temple platform
    const platform = new THREE.Mesh(new THREE.BoxGeometry(24, 0.8, 20), stoneMat);
    platform.position.set(0, 0.4, 2); platform.receiveShadow = true; g.add(platform);

    // Columns — 2 rows of 5, some broken
    const makeColumn = (x, z, h, broken = false) => {
      const colH = broken ? h * (0.4 + 0.4) : h;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.8, colH, 10), stoneMat);
      col.position.set(x, colH/2 + 0.8, z); col.castShadow = true; g.add(col);
      if (!broken) {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(2, 0.5, 2), stoneMat);
        cap.position.set(x, colH + 0.8 + 0.25, z); g.add(cap);
      } else {
        const fallen = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, h*0.5, 10), mossStone);
        fallen.rotation.z = Math.PI/2; fallen.position.set(x + h*0.25, 0.65 + 0.8, z + 2); g.add(fallen);
      }
    };
    for (let i = 0; i < 5; i++) makeColumn(-10 + i*5, -5, 9, i===2);
    for (let i = 0; i < 5; i++) makeColumn(-10 + i*5, 10, 9, i===1 || i===4);
    makeColumn(-12, 2, 9, true);
    makeColumn( 12, 2, 9);
    makeColumn(-12, 5, 9);
    makeColumn( 12, 5, 9, true);

    // Broken lintel beams
    for (let i = 0; i < 4; i++) {
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.8, 1), stoneMat);
      lintel.position.set(-8.5 + i*5, 10.3, -5);
      lintel.rotation.z = (i%2===0 ? 0.08 : -0.08); g.add(lintel);
    }
    const rearLintel = new THREE.Mesh(new THREE.BoxGeometry(22, 0.8, 1), stoneMat);
    rearLintel.position.set(0, 10.3, 10); g.add(rearLintel);

    // Inner temple walls (ruined)
    const wallSegs = [
      { x:  0, z:  2, w: 12, h: 6,   d: 1.5 },
      { x: -8, z:  2, w: 1.5,h: 7,   d: 10  },
      { x:  8, z:  2, w: 1.5,h: 4.5, d: 10  },
      { x:  0, z:  9, w: 8,  h: 3.5, d: 1.5 },
      { x: -3, z: -2, w: 4,  h: 2.5, d: 1.5 },
    ];
    wallSegs.forEach(({ x, z, w, h, d }) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mossStone);
      wall.position.set(x, h/2 + 0.8, z); wall.castShadow = true; wall.receiveShadow = true; g.add(wall);
    });

    // Altar at centre
    const altarBase = new THREE.Mesh(new THREE.BoxGeometry(4, 0.5, 2.5), stoneMat);
    altarBase.position.set(0, 1.3, 3); g.add(altarBase);
    const altarTop = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.25, 3), darkStone);
    altarTop.position.set(0, 1.8, 3); g.add(altarTop);
    for (const ox of [-1.5, 0, 1.5]) {
      const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.5, 6),
        new THREE.MeshLambertMaterial({ color: 0xf0e0b0 }));
      candle.position.set(ox, 2.1, 3); g.add(candle);
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.12, 5, 4),
        new THREE.MeshLambertMaterial({ color: 0xff8800, emissive: 0xff4400, emissiveIntensity: 0.8 }));
      flame.position.set(ox, 2.45, 3); g.add(flame);
    }

    // Underground entrance
    const entrance = new THREE.Mesh(new THREE.BoxGeometry(4, 0.3, 4), darkStone);
    entrance.position.set(3, 0.95, -8); g.add(entrance);
    for (let i = 0; i < 4; i++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.3, 0.9), darkStone);
      step.position.set(3, 0.8 - i*0.3, -6 - i*0.9); g.add(step);
    }
    for (const ox of [-2, 2]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.5, 0.5), darkStone);
      post.position.set(ox + 3, 2.05, -8); g.add(post);
    }
    const doorLintel = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.5, 0.5), darkStone);
    doorLintel.position.set(3, 3.05, -8); g.add(doorLintel);

    // Treasure chest
    const chestMat = new THREE.MeshLambertMaterial({ color: 0xd4a017 });
    const chest = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 1), chestMat);
    chest.position.set(-2, 1.3, 4); g.add(chest);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.4, 1), new THREE.MeshLambertMaterial({ color: 0xb8860b }));
    lid.position.set(-2, 2, 4); lid.rotation.x = -0.5; g.add(lid);

    // Rubble scattered around
    for (const [rx, rz] of [[6,-8],[-10,6],[8,12],[-5,-6],[12,-4],[-8,10],[3,-12],[-12,-2],[9,5],[-4,8]]) {
      const rubble = new THREE.Mesh(
        new THREE.BoxGeometry(1 + (rx%3)*0.5, 0.3 + (rz%2)*0.8, 0.8 + (rx%2)*0.7),
        (rx+rz)%3===0 ? mossStone : stoneMat);
      rubble.position.set(rx, 0.9, rz); rubble.rotation.y = rx*0.5; g.add(rubble);
    }

    return g;
  }

  _makeMilitaryCompound() {
    const g = new THREE.Group();
    const concMat  = new THREE.MeshLambertMaterial({ color: 0x9a9a8a });
    const darkMat  = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });
    const metalMat = new THREE.MeshLambertMaterial({ color: 0x5a6a5a });
    const sandMat  = new THREE.MeshLambertMaterial({ color: 0xb5a07a });
    const fenceMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
    const heliMat  = new THREE.MeshLambertMaterial({ color: 0x404030 });
    const jeepMat  = new THREE.MeshLambertMaterial({ color: 0x4a5a38 });

    // ─ Main bunker ─
    const mainShell = this._hollowBox(18, 4.5, 12, concMat, 2.2, 3.0); mainShell.position.set(0, 0, 0); g.add(mainShell);
    const mainRoof = new THREE.Mesh(new THREE.BoxGeometry(19.5, 0.7, 13.5), concMat);
    mainRoof.position.set(0, 4.85, 0); g.add(mainRoof);
    for (const ox of [-5, 0, 5]) {
      const slit = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 0.3), darkMat);
      slit.position.set(ox, 2.8, 6.2); g.add(slit);
    }
    const mainDoor = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3, 0.2), darkMat);
    mainDoor.position.set(6, 1.5, 6.2); g.add(mainDoor);
    const mainFloor = new THREE.Mesh(new THREE.BoxGeometry(17.8, 0.15, 11.8), concMat);
    mainFloor.position.set(0, 0.07, 0); g.add(mainFloor);

    // ─ Secondary bunker ─
    const secShell = this._hollowBox(12, 3.5, 8, concMat, 2.0, 3.0); secShell.position.set(-18, 0, -8); g.add(secShell);
    const secRoof = new THREE.Mesh(new THREE.BoxGeometry(13, 0.6, 9), concMat);
    secRoof.position.set(-18, 3.8, -8); g.add(secRoof);
    const secSlit = new THREE.Mesh(new THREE.BoxGeometry(2, 0.4, 0.2), darkMat);
    secSlit.position.set(-18, 2, -4.2); g.add(secSlit);
    const secDoor = new THREE.Mesh(new THREE.BoxGeometry(2, 2.6, 0.2), darkMat);
    secDoor.position.set(-14, 1.3, -4.2); g.add(secDoor);
    const secFloor = new THREE.Mesh(new THREE.BoxGeometry(11.8, 0.15, 7.8), concMat);
    secFloor.position.set(-18, 0.07, -8); g.add(secFloor);

    // ─ Guard towers ─
    const makeGuardTower = (x, z) => {
      const base = new THREE.Mesh(new THREE.BoxGeometry(4, 8, 4), concMat);
      base.position.set(x, 4, z); base.castShadow = true; g.add(base);
      const plat = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.5, 5.5), metalMat);
      plat.position.set(x, 8.25, z); g.add(plat);
      for (const [rw, rh, rd, rx2, rz2] of [
        [5.5,0.8,0.15,x,z-2.67],[5.5,0.8,0.15,x,z+2.67],
        [0.15,0.8,5.5,x-2.67,z],[0.15,0.8,5.5,x+2.67,z]
      ]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(rw,rh,rd), metalMat);
        rail.position.set(rx2, 8.65, rz2); g.add(rail);
      }
      const light = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 0.8, 8), metalMat);
      light.rotation.x = Math.PI/4; light.position.set(x, 9.2, z+0.5); g.add(light);
    };
    makeGuardTower(13, -14);
    makeGuardTower(-13, -14);

    // ─ Perimeter fence ─
    for (const [x, z, w, d] of [[0,-22,34,0.2],[0,22,34,0.2],[-17,0,0.2,44],[17,0,0.2,44]]) {
      const fence = new THREE.Mesh(new THREE.BoxGeometry(w, 2.5, d), fenceMat);
      fence.position.set(x, 1.25, z); g.add(fence);
    }
    for (let i = -4; i <= 4; i++) {
      for (const pz of [-22, 22]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3, 0.3), fenceMat);
        post.position.set(i*4, 1.5, pz); g.add(post);
      }
    }

    // ─ Sandbag barriers ─
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 8; i++) {
        const bag = new THREE.Mesh(new THREE.SphereGeometry(0.55, 6, 4), sandMat);
        bag.scale.set(1.3, 0.7, 0.95);
        bag.position.set(-12 + i*2, 5.2 + row*0.65, 8 + row*0.3); g.add(bag);
      }
    }
    for (let i = 0; i < 5; i++) {
      const bag = new THREE.Mesh(new THREE.SphereGeometry(0.55, 6, 4), sandMat);
      bag.scale.set(1.3, 0.7, 0.95); bag.position.set(-4 + i*2, 0.38, 8); g.add(bag);
    }

    // ─ Fuel tanks ─
    for (let i = 0; i < 3; i++) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 2.5, 10), metalMat);
      tank.rotation.z = Math.PI/2; tank.position.set(6, 0.8, -14 + i*3); g.add(tank);
    }

    // ─ Crate stacks ─
    const crateMat2 = new THREE.MeshLambertMaterial({ color: 0x6a5030 });
    for (const [cx, cy, cz] of [[10,0,-5],[10,1.3,-5],[12,0,-5],[10,0,-7],[10,0,10],[12,0,10]]) {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.3, 1.3), crateMat2);
      crate.position.set(cx, cy+0.65, cz); g.add(crate);
    }

    // ─ Radar dish ─
    const dishPole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 5, 8), metalMat);
    dishPole.position.set(-8, 7.5, 0); g.add(dishPole);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(1.8, 12, 8, 0, Math.PI*2, 0, Math.PI/2), metalMat);
    dish.rotation.x = -Math.PI/3; dish.position.set(-8, 10.5, 0); g.add(dish);

    // ─ Helicopter pad ─
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 0.2, 12), heliMat);
    pad.position.set(10, 0.1, 15); g.add(pad);
    const hBar = new THREE.Mesh(new THREE.BoxGeometry(4, 0.05, 0.5), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    hBar.position.set(10, 0.22, 15); g.add(hBar);
    const hLeft = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 3.5), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    hLeft.position.set(8, 0.22, 15); g.add(hLeft);
    const hRight = hLeft.clone(); hRight.position.set(12, 0.22, 15); g.add(hRight);

    // ─ Jeep ─
    const jeepBody = new THREE.Mesh(new THREE.BoxGeometry(4.5, 1.4, 2.2), jeepMat);
    jeepBody.position.set(-5, 1, 15); g.add(jeepBody);
    const jeepCab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 2.0), jeepMat);
    jeepCab.position.set(-4.5, 2.15, 15); g.add(jeepCab);
    for (const [wx, wz] of [[-7,14],[-7,16],[-3,14],[-3,16]]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 10), darkMat);
      wheel.rotation.z = Math.PI/2; wheel.position.set(wx, 0.5, wz); g.add(wheel);
    }

    return g;
  }

  // ── Olsen's Farm ─────────────────────────────────────────────────────
  _makeOlsensFarm() {
    const g = new THREE.Group();
    const woodMat    = new THREE.MeshLambertMaterial({ color: 0x7a5230 });
    const plankMat   = new THREE.MeshLambertMaterial({ color: 0x9e7c50 });
    const roofMat    = new THREE.MeshLambertMaterial({ color: 0x7a1a1a });
    const leafMat    = new THREE.MeshLambertMaterial({ color: 0x2e8b34 });
    const trunkMat   = new THREE.MeshLambertMaterial({ color: 0x5a3318 });
    const stoneMat   = new THREE.MeshLambertMaterial({ color: 0x8a8070 });
    const metalMat   = new THREE.MeshLambertMaterial({ color: 0x7a7070 });

    const hayMat   = new THREE.MeshLambertMaterial({ color: 0xd4a832 });
    const darkDoor = new THREE.MeshLambertMaterial({ color: 0x4a2800 });
    const floorMatA = new THREE.MeshLambertMaterial({ color: 0x8b6d40 });
    const winMat2  = new THREE.MeshLambertMaterial({ color: 0xaaddff, transparent: true, opacity: 0.6 });

    // ─ Farmhouse (larger, 2-story feel) ─
    const houseShell = this._hollowBox(12, 7, 9, plankMat, 2.2, 3.5); houseShell.position.set(0, 0, 0); g.add(houseShell);
    const houseRoof = new THREE.Mesh(new THREE.ConeGeometry(8.5, 4, 4), roofMat);
    houseRoof.position.set(0, 8.5, 0); houseRoof.rotation.y = Math.PI/4; houseRoof.castShadow = true; g.add(houseRoof);
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(1.4, 4, 1.4), stoneMat);
    chimney.position.set(3.5, 9, 0); g.add(chimney);
    const porch = new THREE.Mesh(new THREE.BoxGeometry(12, 0.2, 3), plankMat);
    porch.position.set(0, 0.1, -6); g.add(porch);
    for (const px of [-4.5, 0, 4.5]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 2.5, 6), woodMat);
      post.position.set(px, 1.25, -7.3); g.add(post);
    }
    const porchRoof = new THREE.Mesh(new THREE.BoxGeometry(12, 0.2, 3), roofMat);
    porchRoof.position.set(0, 2.6, -6); g.add(porchRoof);
    const hDoor = new THREE.Mesh(new THREE.BoxGeometry(2, 3.5, 0.2), darkDoor);
    hDoor.position.set(0, 1.75, -4.6); g.add(hDoor);
    for (const [wx, wz] of [[-3,-4.6],[3,-4.6],[-6.1,0],[6.1,0],[-3,4.6],[3,4.6]]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.4, 1.8), winMat2);
      win.position.set(wx, 3, wz); g.add(win);
    }
    const hFloor = new THREE.Mesh(new THREE.BoxGeometry(11.8, 0.15, 8.8), floorMatA);
    hFloor.position.set(0, 0.07, 0); hFloor.receiveShadow = true; g.add(hFloor);

    // ─ Large barn ─
    const barnShell = this._hollowBox(16, 8, 10, woodMat, 3.5, 5.5); barnShell.position.set(20, 0, -2); g.add(barnShell);
    const barnRoof = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 9, 5, 4), roofMat);
    barnRoof.position.set(20, 9.5, -2); barnRoof.rotation.y = Math.PI/4; barnRoof.scale.x = 2; g.add(barnRoof);
    const barnDoor = new THREE.Mesh(new THREE.BoxGeometry(4, 5.5, 0.2), darkDoor);
    barnDoor.position.set(20, 2.75, 5.1); g.add(barnDoor);
    const barnFloor = new THREE.Mesh(new THREE.BoxGeometry(15.8, 0.15, 9.8), floorMatA);
    barnFloor.position.set(20, 0.07, -2); g.add(barnFloor);

    // ─ Second barn / storage ─
    const barn2Shell = this._hollowBox(10, 6, 8, woodMat, 2.2, 3.0); barn2Shell.position.set(-17, 0, 0); g.add(barn2Shell);
    const barn2Roof = new THREE.Mesh(new THREE.ConeGeometry(7, 3.5, 4), roofMat);
    barn2Roof.position.set(-17, 7.25, 0); barn2Roof.rotation.y = Math.PI/4; g.add(barn2Roof);
    const barn2Floor = new THREE.Mesh(new THREE.BoxGeometry(9.8, 0.15, 7.8), floorMatA);
    barn2Floor.position.set(-17, 0.07, 0); g.add(barn2Floor);

    // ─ Grain silo ─
    const silo = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 12, 12), metalMat);
    silo.position.set(8, 6, -13); silo.castShadow = true; g.add(silo);
    const siloDome = new THREE.Mesh(new THREE.SphereGeometry(2, 12, 8, 0, Math.PI*2, 0, Math.PI/2), metalMat);
    siloDome.position.set(8, 12, -13); g.add(siloDome);

    // ─ Water tower ─
    const wtMat = new THREE.MeshLambertMaterial({ color: 0x6a4020 });
    for (const [ox, oz] of [[-1.2,-1.2],[1.2,-1.2],[-1.2,1.2],[1.2,1.2]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 7, 6), wtMat);
      leg.position.set(ox - 16, 3.5, oz - 12); g.add(leg);
    }
    const wtTank = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 3.5, 12), woodMat);
    wtTank.position.set(-16, 9, -12); g.add(wtTank);
    const wtRoof = new THREE.Mesh(new THREE.ConeGeometry(2.4, 1.5, 12), roofMat);
    wtRoof.position.set(-16, 11, -12); g.add(wtRoof);

    // ─ Chicken coop ─
    const coop = new THREE.Mesh(new THREE.BoxGeometry(5, 2.5, 4), plankMat);
    coop.position.set(-8, 1.25, -13); coop.castShadow = true; g.add(coop);
    const coopRoof = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.2, 4.5), roofMat);
    coopRoof.position.set(-8, 2.6, -13); g.add(coopRoof);
    const fMat = new THREE.MeshLambertMaterial({ color: 0x9a7a50 });
    for (let i = 0; i < 5; i++) {
      const fp = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.2, 0.15), fMat);
      fp.position.set(-5 + i*1.5, 0.6, -16); g.add(fp);
    }
    const coopRail = new THREE.Mesh(new THREE.BoxGeometry(8, 0.1, 0.1), fMat);
    coopRail.position.set(-8, 1.1, -16); g.add(coopRail);

    // ─ Tractor ─
    const tractorMat = new THREE.MeshLambertMaterial({ color: 0x228822 });
    const tireMat    = new THREE.MeshLambertMaterial({ color: 0x222222 });
    const tBody = new THREE.Mesh(new THREE.BoxGeometry(4, 1.8, 2.5), tractorMat);
    tBody.position.set(-5, 1.3, 8); g.add(tBody);
    const tCab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.5, 2.2), tractorMat);
    tCab.position.set(-4, 2.65, 8); g.add(tCab);
    for (const [wx, wz, r] of [[-6.5,7,0.9],[-6.5,9,0.9],[-3.5,7,0.6],[-3.5,9,0.6]]) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.5, 12), tireMat);
      wh.rotation.z = Math.PI/2; wh.position.set(wx, r, wz); g.add(wh);
    }

    // ─ Orchard (5×5 grid) ─
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const tx = col*5.5 + 30, tz = row*5.5 - 14;
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 2.5, 7), trunkMat);
        trunk.position.set(tx, 1.25, tz); trunk.castShadow = true; g.add(trunk);
        const canopy = new THREE.Mesh(new THREE.SphereGeometry(1.8, 9, 7), leafMat);
        canopy.position.set(tx, 3.8, tz); canopy.castShadow = true; g.add(canopy);
        if ((row+col)%2===0) {
          const apple = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 5),
            new THREE.MeshLambertMaterial({ color: 0xcc2200 }));
          apple.position.set(tx+0.6, 3, tz+0.8); g.add(apple);
        }
      }
    }

    // ─ Crop rows ─
    const cropMat = new THREE.MeshLambertMaterial({ color: 0x5aaa22 });
    for (let row = 0; row < 6; row++) {
      const crop = new THREE.Mesh(new THREE.BoxGeometry(14, 0.5, 0.5), cropMat);
      crop.position.set(-8, 0.25, 14 + row*2.2); g.add(crop);
    }

    // ─ Hay bales ─
    for (let i = 0; i < 5; i++) {
      const bale = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 1.4, 10), hayMat);
      bale.rotation.z = Math.PI/2; bale.position.set(12 + i*2.2, 0.9, 8); g.add(bale);
    }

    // ─ Fence perimeter ─
    const fencePostMat = new THREE.MeshLambertMaterial({ color: 0x9a7a50 });
    for (let i = 0; i < 16; i++) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.4, 0.2), fencePostMat);
      post.position.set(-22 + i*3.5, 0.7, -20); g.add(post);
    }
    const fRail = new THREE.Mesh(new THREE.BoxGeometry(56, 0.12, 0.1), fencePostMat);
    fRail.position.set(-0.5, 1.1, -20); g.add(fRail);

    // ─ Water trough ─
    const trough = new THREE.Mesh(new THREE.BoxGeometry(3, 0.8, 1), stoneMat);
    trough.position.set(-13, 0.4, 8); g.add(trough);

    return g;
  }

  // ── Whalen's Town ────────────────────────────────────────────────────
  _makeWhalenssTown() {
    const g = new THREE.Group();
    const stoneMat  = new THREE.MeshLambertMaterial({ color: 0x8a7e70 });
    const brickMat  = new THREE.MeshLambertMaterial({ color: 0x9a5a3a });
    const roofMat   = new THREE.MeshLambertMaterial({ color: 0x3a3030 });
    const plankMat  = new THREE.MeshLambertMaterial({ color: 0x9e7c50 });
    const whiteMat  = new THREE.MeshLambertMaterial({ color: 0xddddd0 });
    const winMat    = new THREE.MeshLambertMaterial({ color: 0x88ccff, transparent: true, opacity: 0.55 });
    const cobbleMat = new THREE.MeshLambertMaterial({ color: 0x706858 });
    const darkWood  = new THREE.MeshLambertMaterial({ color: 0x4a3010 });
    const wardFloor = new THREE.MeshLambertMaterial({ color: 0x7a6850 });

    const makeHouse = (x, z, w, d, h, mat) => {
      const gr = new THREE.Group();
      const bodyShell = this._hollowBox(w, h, d, mat, 1.6, 2.8); bodyShell.position.set(0, 0, 0); gr.add(bodyShell);
      const roof2 = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w,d)*0.75, 3, 4), roofMat);
      roof2.position.y = h + 1.5; roof2.rotation.y = Math.PI/4; roof2.castShadow = true; gr.add(roof2);
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 1.4), winMat);
      win.position.set(w/2+0.01, h*0.6, 0); gr.add(win);
      const win2 = win.clone(); win2.position.set(-(w/2+0.01), h*0.6, 0); gr.add(win2);
      const fl = new THREE.Mesh(new THREE.BoxGeometry(w-0.2, 0.15, d-0.2), wardFloor);
      fl.position.y = 0.07; fl.receiveShadow = true; gr.add(fl);
      gr.position.set(x, 0, z);
      return gr;
    };

    // ─ North row of houses ─
    g.add(makeHouse(-20, -8, 7, 6, 5.5, brickMat));
    g.add(makeHouse( -8, -8, 6, 5, 5,   stoneMat));
    g.add(makeHouse(  6, -8, 8, 6, 5.5, brickMat));
    g.add(makeHouse( 18, -8, 6, 5, 4.5, plankMat));

    // ─ South row of houses ─
    g.add(makeHouse(-20, 8, 7, 6, 5.5, plankMat));
    g.add(makeHouse( -8, 8, 6, 5, 5,   brickMat));
    g.add(makeHouse(  6, 8, 8, 6, 5.5, stoneMat));
    g.add(makeHouse( 18, 8, 6, 5, 4.5, brickMat));

    // ─ Church (north end) ─
    const churchShell = this._hollowBox(8, 8, 10, whiteMat, 2.5, 4.0); churchShell.position.set(0, 0, -22); g.add(churchShell);
    const steepleBase = new THREE.Mesh(new THREE.BoxGeometry(3, 4, 3), whiteMat);
    steepleBase.position.set(0, 10, -22); g.add(steepleBase);
    const steeple = new THREE.Mesh(new THREE.ConeGeometry(1.8, 6, 4), roofMat);
    steeple.position.set(0, 15, -22); steeple.rotation.y = Math.PI/4; steeple.castShadow = true; g.add(steeple);
    const cDoor = new THREE.Mesh(new THREE.BoxGeometry(3, 4, 0.2), darkWood);
    cDoor.position.set(0, 2, -17.1); g.add(cDoor);
    for (const ox of [-2.5, 2.5]) {
      const cWin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.5, 1.5), winMat);
      cWin.position.set(ox, 5, -17.1); g.add(cWin);
    }
    const goldMat = new THREE.MeshLambertMaterial({ color: 0xd4a000 });
    const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.5, 0.3), goldMat);
    crossV.position.set(0, 19.5, -22); g.add(crossV);
    const crossH = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.3, 0.3), goldMat);
    crossH.position.set(0, 19.5, -22); g.add(crossH);
    const churchFloor = new THREE.Mesh(new THREE.BoxGeometry(7.8, 0.15, 9.8), wardFloor);
    churchFloor.position.set(0, 0.07, -22); g.add(churchFloor);

    // ─ Town hall (south end, prominent) ─
    const townHallShell = this._hollowBox(16, 8, 12, stoneMat, 3.0, 5.0); townHallShell.position.set(0, 0, 22); g.add(townHallShell);
    const thRoof = new THREE.Mesh(new THREE.BoxGeometry(17, 0.7, 13), roofMat);
    thRoof.position.set(0, 8.35, 22); g.add(thRoof);
    for (const ox of [-5, -2, 2, 5]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 7, 8), whiteMat);
      col.position.set(ox, 3.5, 16.1); col.castShadow = true; g.add(col);
    }
    const thSign = new THREE.Mesh(new THREE.BoxGeometry(7, 1, 0.2), new THREE.MeshLambertMaterial({ color: 0x5a3818 }));
    thSign.position.set(0, 6.5, 16.1); g.add(thSign);
    const thDoor = new THREE.Mesh(new THREE.BoxGeometry(3, 5, 0.2), darkWood);
    thDoor.position.set(0, 2.5, 16.1); g.add(thDoor);
    const thFloor = new THREE.Mesh(new THREE.BoxGeometry(15.8, 0.15, 11.8), wardFloor);
    thFloor.position.set(0, 0.07, 22); g.add(thFloor);

    // ─ Tavern (east side) ─
    const tavernShell = this._hollowBox(10, 6.5, 8, plankMat, 2.2, 3.5); tavernShell.position.set(22, 0, 0); g.add(tavernShell);
    const tavRoof = new THREE.Mesh(new THREE.ConeGeometry(7, 4, 4), roofMat);
    tavRoof.position.set(22, 8, 0); tavRoof.rotation.y = Math.PI/4; g.add(tavRoof);
    const tavSign = new THREE.Mesh(new THREE.BoxGeometry(4, 0.8, 0.15), new THREE.MeshLambertMaterial({ color: 0x7a3010 }));
    tavSign.position.set(22, 5.5, 4.2); g.add(tavSign);
    const signPost = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2, 6), darkWood);
    signPost.position.set(24, 5, 4.1); g.add(signPost);
    const tavFloor = new THREE.Mesh(new THREE.BoxGeometry(9.8, 0.15, 7.8), wardFloor);
    tavFloor.position.set(22, 0.07, 0); g.add(tavFloor);

    // ─ Blacksmith (west side) ─
    const smithBase = new THREE.Mesh(new THREE.BoxGeometry(8, 4, 7), stoneMat);
    smithBase.position.set(-22, 2, 0); smithBase.castShadow = true; g.add(smithBase);
    const smithRoof = new THREE.Mesh(new THREE.BoxGeometry(9, 0.3, 8), roofMat);
    smithRoof.position.set(-22, 4.15, 0); g.add(smithRoof);
    const forge = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5),
      new THREE.MeshLambertMaterial({ color: 0xff5500, emissive: 0xff2200, emissiveIntensity: 0.6 }));
    forge.position.set(-22, 0.75, -2); g.add(forge);
    const anvil = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.4),
      new THREE.MeshLambertMaterial({ color: 0x3a3a3a }));
    anvil.position.set(-20, 0.25, 1); g.add(anvil);
    const smithFloor = new THREE.Mesh(new THREE.BoxGeometry(7.8, 0.15, 6.8), wardFloor);
    smithFloor.position.set(-22, 0.07, 0); g.add(smithFloor);

    // ─ Main streets ─
    const streetMat = new THREE.MeshLambertMaterial({ color: 0x5a5248 });
    const streetH = new THREE.Mesh(new THREE.BoxGeometry(60, 0.08, 6), streetMat);
    streetH.position.set(0, 0.04, 0); streetH.receiveShadow = true; g.add(streetH);
    const streetV = new THREE.Mesh(new THREE.BoxGeometry(6, 0.08, 70), streetMat);
    streetV.position.set(0, 0.04, 0); g.add(streetV);

    // ─ Cobblestone market square ─
    for (let i = -4; i <= 4; i++) for (let j = -3; j <= 3; j++) {
      if (Math.abs(i) < 2 && Math.abs(j) < 2) continue; // well area
      const stone = new THREE.Mesh(new THREE.BoxGeometry(1.6+Math.abs(i%3)*0.3, 0.1, 1.6+Math.abs(j%3)*0.3), cobbleMat);
      stone.position.set(i*2, 0.05, j*2); stone.receiveShadow = true; g.add(stone);
    }

    // ─ Market stalls (4 around well) ─
    const tentColors = [0xc0392b, 0x2980b9, 0xf39c12, 0x27ae60];
    for (let i = 0; i < 4; i++) {
      const angle = (i/4)*Math.PI*2 + Math.PI/4;
      const sx = Math.cos(angle)*9, sz = Math.sin(angle)*9;
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(4, 0.15, 3),
        new THREE.MeshLambertMaterial({ color: tentColors[i] }));
      canopy.position.set(sx, 2.8, sz); canopy.rotation.x = 0.15; g.add(canopy);
      for (const [ox, oz] of [[-1.5,-1],[1.5,-1]]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.8, 6),
          new THREE.MeshLambertMaterial({ color: 0x8a6030 }));
        post.position.set(sx+ox, 1.4, sz+oz); g.add(post);
      }
      const counter = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.2, 0.8),
        new THREE.MeshLambertMaterial({ color: 0x8a6030 }));
      counter.position.set(sx, 1.2, sz+0.5); g.add(counter);
    }

    // ─ Well in town square ─
    const wellBase = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.4, 1, 10), stoneMat);
    wellBase.position.set(0, 0.5, 0); g.add(wellBase);
    const wellRim = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.14, 6, 14), stoneMat);
    wellRim.rotation.x = Math.PI/2; wellRim.position.set(0, 1.05, 0); g.add(wellRim);
    for (const ox of [-0.9, 0.9]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.2, 6), darkWood);
      post.position.set(ox, 2.1, 0); g.add(post);
    }
    const wellBar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.8, 6), darkWood);
    wellBar.rotation.z = Math.PI/2; wellBar.position.set(0, 2.9, 0); g.add(wellBar);

    // ─ Street lamps ─
    const lampMat = new THREE.MeshLambertMaterial({ color: 0x555550 });
    const glowMat = new THREE.MeshLambertMaterial({ color: 0xffee88, emissive: 0xffcc00, emissiveIntensity: 0.8 });
    for (const [lx, lz] of [[-12,-12],[12,-12],[-12,12],[12,12],[-12,0],[12,0],[0,-16],[0,16]]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 4.5, 7), lampMat);
      pole.position.set(lx, 2.25, lz); g.add(pole);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), glowMat);
      lamp.position.set(lx, 4.7, lz); g.add(lamp);
    }

    // ─ Barrels & crates ─
    const barrelMat = new THREE.MeshLambertMaterial({ color: 0x6a4020 });
    const crateMat  = new THREE.MeshLambertMaterial({ color: 0x8a6030 });
    for (const [bx, bz] of [[14,-4],[14,-6],[14,4],[-14,4],[-14,-4],[-14,-6]]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.1, 10), barrelMat);
      barrel.position.set(bx, 0.55, bz); g.add(barrel);
    }
    for (const [cx, cy, cz] of [[16,0,6],[16,1.3,6],[16,0,8]]) {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), crateMat);
      crate.position.set(cx, cy+0.6, cz); g.add(crate);
    }

    return g;
  }

  // ── Map canvas ───────────────────────────────────────────────────────
  renderMapCanvas() {
    const R = this.resolution;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = R;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(R, R);
    const d = imgData.data;

    for (let iz = 0; iz < R; iz++) {
      for (let ix = 0; ix < R; ix++) {
        const h = this.heightmap[iz * R + ix];
        let r, g, b;
        if      (h <= -1.5) { r = 28;  g = 72;  b = 145; }
        else if (h <  2)    { r = 205; g = 172; b = 110; }
        else if (h <  14)   { r = 62;  g = 118; b = 44;  }
        else if (h <  26)   { r = 85;  g = 78;  b = 65;  }
        else                { r = 210; g = 214; b = 228; }
        // Subtle shading from neighboring height difference
        const right = ix + 1 < R ? this.heightmap[iz * R + ix + 1] : h;
        const shade = clamp((h - right) * 3, -28, 28);
        const idx = (iz * R + ix) * 4;
        d[idx] = clamp(r + shade, 0, 255);
        d[idx+1] = clamp(g + shade * 0.8, 0, 255);
        d[idx+2] = clamp(b + shade * 0.5, 0, 255);
        d[idx+3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  // ── Props ────────────────────────────────────────────────────────────
  _buildProps() {
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x888880 });
    const S = this.size;

    const rng = this._rng;
    for (let i = 0; i < 120; i++) {
      const x = (rng() - 0.5) * S * 0.75;
      const z = (rng() - 0.5) * S * 0.75;
      const h = this._getHeight(x, z);
      if (h < 0.2) continue;

      const r = 0.3 + rng() * 1.4;
      const rock = new THREE.Mesh(
        new THREE.DodecahedronGeometry(r, 0),
        rockMat
      );
      rock.position.set(x, h + r * 0.5, z);
      rock.rotation.set(
        rng() * Math.PI,
        rng() * Math.PI,
        rng() * Math.PI
      );
      rock.castShadow = true;
      this.scene.add(rock);
    }

    // Chest loot boxes
    const chestMat = new THREE.MeshLambertMaterial({ color: 0xd4a017 });
    const chestLidMat = new THREE.MeshLambertMaterial({ color: 0xb8860b });
    const chestPositions = [
      [65, 0], [-85, 28], [18, -105], [-28, 52], [30, 80], [-60, -60]
    ];
    chestPositions.forEach(([px, pz]) => {
      const h = this._getHeight(px, pz);
      if (h < 0) return;
      const chest = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 1), chestMat);
      body.position.y = 0.5;
      chest.add(body);
      const lid = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.4, 1), chestLidMat);
      lid.position.y = 1.2;
      lid.rotation.x = -0.4;
      chest.add(lid);
      chest.position.set(px, h, pz);
      this.scene.add(chest);
    });
  }

  // ── Heightmap Query ─────────────────────────────────────────────────
  _getHeight(x, z) {
    const R = this.resolution;
    const S = this.size;
    const hx = (x / S + 0.5) * (R - 1);
    const hz = (z / S + 0.5) * (R - 1);
    // ix = column (x direction), iz = row (z direction)
    const ix = Math.floor(hx), iz = Math.floor(hz);
    if (ix < 0 || ix >= R - 1 || iz < 0 || iz >= R - 1) return this.waterLevel;
    const fx = hx - ix, fz = hz - iz;
    // Heightmap stored as [row * R + col] = [iz * R + ix]
    const h00 = this.heightmap[iz * R + ix];
    const h10 = this.heightmap[iz * R + (ix + 1)];
    const h01 = this.heightmap[(iz + 1) * R + ix];
    const h11 = this.heightmap[(iz + 1) * R + (ix + 1)];
    return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) +
           h01 * (1 - fx) * fz + h11 * fx * fz;
  }

  getSpawnPosition() {
    // Random spawn anywhere on the playable island, above water, below peaks
    for (let attempt = 0; attempt < 400; attempt++) {
      const a = Math.random() * Math.PI * 2;   // intentionally unseeded — different each match
      const r = 40 + Math.random() * 170;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = this._getHeight(x, z);
      if (h > 1.5 && h < 22) return new THREE.Vector3(x, h + 2, z);
    }
    return new THREE.Vector3(0, 10, 0);
  }

  getTerrainHeight(x, z) {
    return this._getHeight(x, z);
  }

  updateClouds(dt) {
    if (this._clouds) {
      this._clouds.forEach(c => {
        c.position.x += c.userData.cloudSpeed * dt;
        if (c.position.x > 700) c.position.x = -700;
      });
    }
    if (this._waterMat) this._waterMat.uniforms.time.value += dt;
  }

  /**
   * Move the sun's shadow camera so its tight orthographic frustum stays
   * centred on the player. Without this the sharper bounds set in
   * _buildLights would only catch shadows near origin. Snapping to whole
   * texels in light-space avoids the "shadow shimmer" while the camera
   * follows a continuously moving target.
   */
  updateShadowFollow(playerX, playerZ) {
    if (!this._sun) return;
    // Snap to the texel size in light-space so shadows don't crawl as the
    // camera follows the player. World units per shadow texel:
    const worldPerTexel = (this._sun.shadow.camera.right - this._sun.shadow.camera.left) /
                          this._sun.shadow.mapSize.x;
    const sx = Math.round(playerX / worldPerTexel) * worldPerTexel;
    const sz = Math.round(playerZ / worldPerTexel) * worldPerTexel;
    this._sun.position.set(sx + this._sunOffset.x, this._sunOffset.y, sz + this._sunOffset.z);
    this._sun.target.position.set(sx, 0, sz);
    this._sun.target.updateMatrixWorld();
  }
}
