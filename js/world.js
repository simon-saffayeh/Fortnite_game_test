import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
  constructor(scene) {
    this.scene = scene;
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
    this._buildSky();
    this._buildLights();
    this._buildTerrain();
    this._buildWater();
    this._buildTrees();
    this._buildStructures();
    this._buildProps();
  }

  // ── Sky ─────────────────────────────────────────────────────────────
  _buildSky() {
    // Gradient sky using a large sphere with vertex colors
    const geo = new THREE.SphereGeometry(1800, 32, 16);
    geo.scale(-1, 1, 1); // invert normals

    const colors = [];
    const positions = geo.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i);
      const t = (y + 1800) / 3600; // 0 = bottom, 1 = top
      // horizon: warm orange/pink → zenith: deep blue
      const top    = new THREE.Color(0x1a3a6b);
      const mid    = new THREE.Color(0x5b9bd5);
      const horiz  = new THREE.Color(0xf4a261);
      let c;
      if (t > 0.5) {
        c = mid.clone().lerp(top, (t - 0.5) * 2);
      } else {
        c = horiz.clone().lerp(mid, t * 2);
      }
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
    const sky = new THREE.Mesh(geo, mat);
    this.scene.add(sky);

    // Sun disc
    const sunGeo = new THREE.CircleGeometry(40, 32);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xfffde0 });
    const sun = new THREE.Mesh(sunGeo, sunMat);
    sun.position.set(600, 800, -1200);
    this.scene.add(sun);

    // Sun glow
    const glowGeo = new THREE.CircleGeometry(80, 32);
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffd580, transparent: true, opacity: 0.2 });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.set(600, 800, -1200.5);
    this.scene.add(glow);

    // Clouds
    this._buildClouds();
  }

  _buildClouds() {
    const cloudGeo = new THREE.SphereGeometry(1, 7, 5);
    const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.88 });

    for (let i = 0; i < 24; i++) {
      const group = new THREE.Group();
      const puffs = 3 + Math.floor(Math.random() * 4);
      for (let p = 0; p < puffs; p++) {
        const mesh = new THREE.Mesh(cloudGeo, cloudMat);
        const sx = 30 + Math.random() * 50;
        const sy = 14 + Math.random() * 20;
        const sz = 20 + Math.random() * 30;
        mesh.scale.set(sx, sy, sz);
        mesh.position.set(
          (Math.random() - 0.5) * sx * 2,
          (Math.random() - 0.5) * sy * 0.5,
          (Math.random() - 0.5) * sz
        );
        group.add(mesh);
      }
      group.position.set(
        (Math.random() - 0.5) * 1200,
        250 + Math.random() * 150,
        (Math.random() - 0.5) * 1200
      );
      this.scene.add(group);
      group.userData.cloudSpeed = 0.5 + Math.random() * 1.5;
      this._clouds = this._clouds || [];
      this._clouds.push(group);
    }
  }

  // ── Lights ──────────────────────────────────────────────────────────
  _buildLights() {
    // Sky/ground hemisphere for natural ambient color separation
    const hemi = new THREE.HemisphereLight(0x87ceeb, 0x4a7c4e, 0.6);
    this.scene.add(hemi);

    const ambient = new THREE.AmbientLight(0x8ab4d8, 0.35);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffe0a0, 2.2);
    sun.position.set(200, 400, -300);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 900;
    sun.shadow.camera.left = -250;
    sun.shadow.camera.right = 250;
    sun.shadow.camera.top = 250;
    sun.shadow.camera.bottom = -250;
    sun.shadow.bias = -0.001;
    this.scene.add(sun);

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
    const flatZones = [
      { x:  100, z:    0, r: 90 },   // Cedar Creek
      { x: -130, z:   50, r: 85 },   // Fort Ironwatch
      { x:   35, z: -160, r: 90 },   // Ancient Temple
      { x:  -50, z:   80, r: 88 },   // Military Compound
      { x:  150, z:  -75, r: 100 },  // Olsen's Farm
      { x: -125, z: -120, r: 105 },  // Whalen's Town
    ];
    for (const zone of flatZones) {
      // Use the minimum height within the tight center (5 wu radius) so
      // structures are never buried by a high-median sample.
      let minH = Infinity;
      const sampleR = 5;
      for (let i = 0; i < R; i++) {
        for (let j = 0; j < R; j++) {
          const wx = (j / (R - 1) - 0.5) * S;
          const wz = (i / (R - 1) - 0.5) * S;
          if ((wx - zone.x) ** 2 + (wz - zone.z) ** 2 < sampleR * sampleR)
            minH = Math.min(minH, this.heightmap[i * R + j]);
        }
      }
      const targetH = Math.max(1.5, isFinite(minH) ? minH : 3);

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

    const R = this.resolution;
    const S = this.size;

    for (let attempt = 0; attempt < 600; attempt++) {
      const x = (Math.random() - 0.5) * S * 0.78;
      const z = (Math.random() - 0.5) * S * 0.78;
      const h = this._getHeight(x, z);
      if (h < 0.5 || h > 24) continue;

      const palm = h < 3.5;
      const group = palm
        ? this._makePalmTree(trunkMat, palmMat)
        : this._makePineTree(trunkMat, leaf1Mat, leaf2Mat);

      group.position.set(x, h, z);
      group.rotation.y = Math.random() * Math.PI * 2;
      this.scene.add(group);
      this.trees.push(group);
    }
  }

  _makePineTree(trunkMat, leaf1Mat, leaf2Mat) {
    const g = new THREE.Group();
    const height = 4 + Math.random() * 5;
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.28, height * 0.55, 7),
      trunkMat
    );
    trunk.position.y = height * 0.27;
    trunk.castShadow = true;
    g.add(trunk);

    const layers = 3 + Math.floor(Math.random() * 2);
    for (let l = 0; l < layers; l++) {
      const t = l / (layers - 1);
      const r = (0.9 - t * 0.5) * (height * 0.28);
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(r, height * 0.38, 8),
        l % 2 === 0 ? leaf1Mat : leaf2Mat
      );
      cone.position.y = height * 0.38 + l * height * 0.22;
      cone.castShadow = true;
      g.add(cone);
    }
    return g;
  }

  _makePalmTree(trunkMat, leafMat) {
    const g = new THREE.Group();
    const height = 5 + Math.random() * 4;

    // Curved trunk segments
    for (let s = 0; s < 5; s++) {
      const seg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.2, height / 5, 7),
        trunkMat
      );
      seg.position.y = (s + 0.5) * (height / 5);
      seg.rotation.x = (Math.random() - 0.5) * 0.1;
      seg.castShadow = true;
      g.add(seg);
    }

    // Palm fronds
    const fronds = 6 + Math.floor(Math.random() * 4);
    for (let f = 0; f < fronds; f++) {
      const angle = (f / fronds) * Math.PI * 2;
      const frond = new THREE.Mesh(
        new THREE.ConeGeometry(0.15, 2.5 + Math.random(), 5),
        leafMat
      );
      frond.position.y = height;
      frond.position.x = Math.cos(angle) * 0.3;
      frond.position.z = Math.sin(angle) * 0.3;
      frond.rotation.z = angle + Math.PI / 2;
      frond.rotation.x = 0.5 + Math.random() * 0.4;
      g.add(frond);
    }
    return g;
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

    // ── Fort Ironwatch ───────────────────────────────────────────────
    h = Math.max(0, this._getHeight(-130, 50));
    place(this._makeFortIronwatch(), -130, 50, 'Fort Ironwatch');
    sc.addBox(-130, h, 50,   4.5, 22, 4.5);
    sc.addBox(-150, h, 30,   3.2, 12, 3.2);
    sc.addBox(-110, h, 30,   3.2, 12, 3.2);
    sc.addBox(-150, h, 70,   3.2, 12, 3.2);
    sc.addBox(-110, h, 70,   3.2, 12, 3.2);
    sc.addBox(-130, h, 30,   10,  5,  1.5);
    sc.addBox(-130, h, 70,   10,  5,  1.5);
    sc.addBox(-150, h, 50,   1.5, 5,  10);
    sc.addBox(-110, h, 50,   1.5, 5,  10);
    // Barracks walls (w=10,h=4.5,d=8 → hw=5,hh=4.5,hd=4, doorW=2.2→dw=1.1)
    { const t=0.15,cx=-130,cz=63,hw=5,hh=4.5,hd=4,dw=1.1;
      sc.addBox(cx, h, cz+hd, hw, hh, t);
      sc.addBox(cx-hw, h, cz, t, hh, hd);
      sc.addBox(cx+hw, h, cz, t, hh, hd);
      sc.addBox(cx-(hw-dw)/2-dw/2, h, cz-hd, (hw-dw)/2, hh, t);
      sc.addBox(cx+(hw-dw)/2+dw/2, h, cz-hd, (hw-dw)/2, hh, t);
    }
    sc.addFloor(-130, h+.05, 63, 4.8, 3.8);
    // Armory walls (w=6,h=4,d=5 → hw=3,hh=4,hd=2.5, doorW=2.0→dw=1.0)
    { const t=0.15,cx=-142,cz=63,hw=3,hh=4,hd=2.5,dw=1.0;
      sc.addBox(cx, h, cz+hd, hw, hh, t);
      sc.addBox(cx-hw, h, cz, t, hh, hd);
      sc.addBox(cx+hw, h, cz, t, hh, hd);
      sc.addBox(cx-(hw-dw)/2-dw/2, h, cz-hd, (hw-dw)/2, hh, t);
      sc.addBox(cx+(hw-dw)/2+dw/2, h, cz-hd, (hw-dw)/2, hh, t);
    }

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
  async loadFurniture() {
    const loader = new GLTFLoader();
    const load = path => new Promise((res, rej) =>
      loader.load(path, g => res(g.scene), null, rej));

    // Pre-compute the bottom-Y offset for each model so it sits flush on the floor
    const floorOffset = model => {
      const box = new THREE.Box3().setFromObject(model);
      return -box.min.y; // shift up so bottom = 0
    };

    // Helper: place a loaded GLB clone at world pos with optional y-rotation and scale
    // wy = world floor Y; model bottom is automatically aligned to wy
    const place = (model, wx, wy, wz, rotY = 0, scale = 1) => {
      const obj = model.clone(true);
      obj.scale.setScalar(scale);
      obj.rotation.y = rotY;
      const offset = floorOffset(obj);
      obj.position.set(wx, wy + offset, wz);
      obj.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
      this.scene.add(obj);
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
    const hFI  = this._getHeight(-130,  50);   // Fort Ironwatch
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

    // ── Fort Ironwatch — barracks (local 0,13 → world -130, hFI, 63) ─
    const fiY = hFI + fl;
    place(bed,      -132,  fiY,  62,  Math.PI * 0.5,  1);
    place(bedTwin,  -128,  fiY,  62,  Math.PI * 0.5,  1);
    place(bedTwin,  -130,  fiY,  65,  Math.PI * 0.5,  1);
    place(desk,     -126,  fiY,  64,  0,              1);
    place(chair,    -126,  fiY,  63,  Math.PI,        1);
    place(bookcase, -134,  fiY,  63,  Math.PI * 0.5,  1);

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

  _makeFortIronwatch() {
    const g = new THREE.Group();
    const stoneMat  = new THREE.MeshLambertMaterial({ color: 0x7a7a72 });
    const darkStone = new THREE.MeshLambertMaterial({ color: 0x505048 });
    const woodMat   = new THREE.MeshLambertMaterial({ color: 0x6a4a28 });
    const roofMat   = new THREE.MeshLambertMaterial({ color: 0x3a3030 });

    const makeTower = (x, z, r, h) => {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r*1.1, h, 8), stoneMat);
      body.position.set(x, h/2, z); body.castShadow = true; g.add(body);
      for (let i = 0; i < 8; i++) {
        const angle = (i/8)*Math.PI*2;
        const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1.8, 1), stoneMat);
        m.position.set(x + Math.cos(angle)*(r-0.3), h+0.9, z + Math.sin(angle)*(r-0.3)); g.add(m);
      }
      const plat = new THREE.Mesh(new THREE.CylinderGeometry(r+0.3, r+0.3, 0.4, 8), darkStone);
      plat.position.set(x, h+0.2, z); g.add(plat);
    };

    const makeWall = (x, z, w, h, d) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stoneMat);
      wall.position.set(x, h/2, z); wall.castShadow = true; wall.receiveShadow = true; g.add(wall);
      // Battlements along top
      const isWide = w > d;
      const count = Math.floor((isWide ? w : d) / 2.5);
      for (let i = 0; i < count; i++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(isWide?1.2:d+0.4, 1.4, isWide?w/count*0.5:1.2), stoneMat);
        const offset = -((isWide?w:d)/2) + i*((isWide?w:d)/count) + (isWide?w:d)/(count*2);
        m.position.set(isWide ? offset+x : x, h+0.7, isWide ? z : offset+z); g.add(m);
      }
    };

    // Main keep
    makeTower(0, 0, 4.5, 20);
    // 4 corner towers
    makeTower(-20, -20, 3.2, 12);
    makeTower( 20, -20, 3.2, 12);
    makeTower(-20,  20, 3.2, 12);
    makeTower( 20,  20, 3.2, 12);

    // Curtain walls
    makeWall(-10, -20, 18, 5, 3);
    makeWall( 10, -20, 18, 5, 3);
    makeWall(-10,  20, 18, 5, 3);
    makeWall( 10,  20, 18, 5, 3);
    makeWall(-20, -10, 3, 5, 18);
    makeWall(-20,  10, 3, 5, 18);
    makeWall( 20, -10, 3, 5, 18);
    makeWall( 20,  10, 3, 5, 18);

    // Gatehouse (south)
    const gate = new THREE.Mesh(new THREE.BoxGeometry(8, 7, 6), stoneMat);
    gate.position.set(0, 3.5, -22); gate.castShadow = true; g.add(gate);
    const gateArch = new THREE.Mesh(new THREE.BoxGeometry(3.2, 4.5, 0.4), darkStone);
    gateArch.position.set(0, 2.25, -25.1); g.add(gateArch);
    for (const ox of [-2.5, 0, 2.5]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2, 1.5), stoneMat);
      m.position.set(ox, 7.5, -22); g.add(m);
    }

    // Barracks
    const barracksShell = this._hollowBox(10, 4.5, 8, woodMat, 2.2, 3.0); barracksShell.position.set(0, 0, 13); g.add(barracksShell);
    const bRoof = new THREE.Mesh(new THREE.ConeGeometry(7, 3, 4), roofMat);
    bRoof.position.set(0, 5.75, 13); bRoof.rotation.y = Math.PI/4; g.add(bRoof);
    const bFloor = new THREE.Mesh(new THREE.BoxGeometry(9.8, 0.15, 7.8), woodMat);
    bFloor.position.set(0, 0.07, 13); g.add(bFloor);

    // Armory
    const armoryShell = this._hollowBox(6, 4, 5, stoneMat, 2.0, 3.0); armoryShell.position.set(-12, 0, 13); g.add(armoryShell);
    const aFloor = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.15, 4.8), stoneMat);
    aFloor.position.set(-12, 0.07, 13); g.add(aFloor);

    // Well in courtyard
    const wellRim = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 0.9, 10), stoneMat);
    wellRim.position.set(10, 0.45, -5); g.add(wellRim);
    const wellTop = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.12, 6, 14), stoneMat);
    wellTop.rotation.x = Math.PI/2; wellTop.position.set(10, 0.92, -5); g.add(wellTop);
    for (const ox of [-0.85, 0.85]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.2, 6), woodMat);
      post.position.set(10+ox, 2, -5); g.add(post);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.7, 6), woodMat);
    bar.rotation.z = Math.PI/2; bar.position.set(10, 2.8, -5); g.add(bar);

    // Wooden stairs to keep
    for (let i = 0; i < 5; i++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(3, 0.35, 0.8), woodMat);
      step.position.set(0, i*0.35, -(4.5 + i*0.8)); g.add(step);
    }

    // Crates & barrels
    const crateMat = new THREE.MeshLambertMaterial({ color: 0x8a6030 });
    const barrelMat = new THREE.MeshLambertMaterial({ color: 0x6a4020 });
    for (let i = 0; i < 4; i++) {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), crateMat);
      crate.position.set(-8 + i*2.5, 0.6, 5); g.add(crate);
    }
    for (let i = 0; i < 3; i++) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.1, 10), barrelMat);
      barrel.position.set(14, 0.55, i*1.5 - 2); g.add(barrel);
    }

    // Arrow slits on keep
    for (let i = 0; i < 6; i++) {
      const angle = (i/6)*Math.PI*2;
      const slit = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.8, 0.2), darkStone);
      slit.position.set(Math.cos(angle)*4.6, 10, Math.sin(angle)*4.6);
      slit.rotation.y = angle; g.add(slit);
    }

    // Torches on walls
    const torchMat = new THREE.MeshLambertMaterial({ color: 0xff6600, emissive: 0xff3300, emissiveIntensity: 0.9 });
    for (const [tx, tz] of [[-19,-19],[19,-19],[-19,19],[19,19],[0,-21],[0,21]]) {
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.28, 6, 5), torchMat);
      flame.position.set(tx, 6.5, tz); g.add(flame);
    }

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

    for (let i = 0; i < 120; i++) {
      const x = (Math.random() - 0.5) * S * 0.75;
      const z = (Math.random() - 0.5) * S * 0.75;
      const h = this._getHeight(x, z);
      if (h < 0.2) continue;

      const r = 0.3 + Math.random() * 1.4;
      const rock = new THREE.Mesh(
        new THREE.DodecahedronGeometry(r, 0),
        rockMat
      );
      rock.position.set(x, h + r * 0.5, z);
      rock.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
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
      const a = Math.random() * Math.PI * 2;
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
}
