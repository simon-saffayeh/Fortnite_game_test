import * as THREE from 'three';

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

export class World {
  constructor(scene) {
    this.scene = scene;
    this.size = 512;
    this.heightmap = null;
    this.resolution = 128;
    this.terrainMesh = null;
    this.trees = [];
    this.structures = [];
    this.waterLevel = -2;
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

        // Island shape: fade height at edges
        const dist = Math.sqrt(nx * nx + nz * nz);
        const island = Math.max(0, 1 - (dist / 2.0));
        const falloff = island * island * (3 - 2 * island);

        const h = fbm(nx * 2.5, nz * 2.5) * 40 * falloff - 3;
        const idx = i * R + j;
        this.heightmap[idx] = h;

        const vIdx = i * R + j;
        pos.setY(vIdx, h);
      }
    }

    geo.computeVertexNormals();

    // Vertex coloring based on height
    const colors = [];
    for (let i = 0; i < pos.count; i++) {
      const h = pos.getY(i);
      let c;
      if (h < -1)       c = new THREE.Color(0xc2a86e); // sandy beach
      else if (h < 4)   c = new THREE.Color(0x4caf50); // low grass
      else if (h < 14)  c = new THREE.Color(0x388e3c); // mid grass
      else if (h < 22)  c = new THREE.Color(0x6d8c55); // highland
      else if (h < 30)  c = new THREE.Color(0x8d8d8d); // rock
      else               c = new THREE.Color(0xf0f0f0); // snow peak
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.terrainMesh = new THREE.Mesh(geo, mat);
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.castShadow = false;
    this.scene.add(this.terrainMesh);
  }

  _buildWater() {
    const geo = new THREE.PlaneGeometry(this.size * 3, this.size * 3, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({
      color: 0x006994,
      transparent: true,
      opacity: 0.78,
    });
    const water = new THREE.Mesh(geo, mat);
    water.position.y = this.waterLevel;
    this.scene.add(water);
    this._water = water;

    // Shoreline foam ring
    const foamGeo = new THREE.RingGeometry(this.size * 0.36, this.size * 0.42, 64);
    foamGeo.rotateX(-Math.PI / 2);
    const foamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 });
    const foam = new THREE.Mesh(foamGeo, foamMat);
    foam.position.y = this.waterLevel + 0.05;
    this.scene.add(foam);
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

  // ── Structures ──────────────────────────────────────────────────────
  _buildStructures() {
    // Wooden cabin
    this._placeStructure(this._makeCabin(), 60, 0);
    // Stone tower
    this._placeStructure(this._makeTower(), -80, 30);
    // Ruins cluster
    this._placeStructure(this._makeRuins(), 20, -100);
    // Hilltop bunker
    this._placeStructure(this._makeBunker(), -30, 50);
  }

  _placeStructure(group, px, pz) {
    const h = this._getHeight(px, pz);
    if (h < 0) return;
    group.position.set(px, h, pz);
    this.scene.add(group);
    this.structures.push(group);
  }

  _makeCabin() {
    const g = new THREE.Group();
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x8b6343 });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x5a3c1e });
    const winMat  = new THREE.MeshLambertMaterial({ color: 0xaaddff, transparent: true, opacity: 0.6 });

    // Walls
    const wall = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 8), wallMat);
    wall.position.y = 2.5;
    wall.castShadow = true;
    wall.receiveShadow = true;
    g.add(wall);

    // Roof
    const roof = new THREE.Mesh(new THREE.ConeGeometry(7.5, 3.5, 4), roofMat);
    roof.position.y = 6.5;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    g.add(roof);

    // Windows
    [[-5.01, 2.5, 1.5], [5.01, 2.5, -1.5]].forEach(([x, y, z]) => {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.4, 1.8), winMat);
      w.position.set(x, y, z);
      g.add(w);
    });

    // Door
    const doorMat = new THREE.MeshLambertMaterial({ color: 0x4a2800 });
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.6, 3, 0.2), doorMat);
    door.position.set(0, 1.5, 4.1);
    g.add(door);

    // Chimney
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(1.2, 3, 1.2), wallMat);
    chimney.position.set(3, 6.5, 0);
    chimney.castShadow = true;
    g.add(chimney);

    return g;
  }

  _makeTower() {
    const g = new THREE.Group();
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x777777 });
    const darkMat  = new THREE.MeshLambertMaterial({ color: 0x444444 });

    // Base
    const base = new THREE.Mesh(new THREE.CylinderGeometry(4, 5, 2, 8), stoneMat);
    base.position.y = 1;
    base.castShadow = true;
    g.add(base);

    // Tower body
    const body = new THREE.Mesh(new THREE.CylinderGeometry(3, 4, 16, 8), stoneMat);
    body.position.y = 10;
    body.castShadow = true;
    g.add(body);

    // Battlements
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const merlon = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.8, 1.2), stoneMat);
      merlon.position.set(Math.cos(angle) * 3, 19, Math.sin(angle) * 3);
      merlon.castShadow = true;
      g.add(merlon);
    }

    // Arrow slits
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2;
      const slit = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.8, 0.2), darkMat);
      slit.position.set(Math.cos(angle) * 3.1, 10, Math.sin(angle) * 3.1);
      slit.rotation.y = angle;
      g.add(slit);
    }

    return g;
  }

  _makeRuins() {
    const g = new THREE.Group();
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x888870 });

    const ruins = [
      { x: 0,   z: 0,   h: 3,  rx: 0.1,  rz: 0 },
      { x: 8,   z: 2,   h: 5,  rx: 0,    rz: 0.15 },
      { x: 4,   z: -6,  h: 2,  rx: -0.1, rz: 0.1 },
      { x: -5,  z: 3,   h: 4,  rx: 0.05, rz: -0.1 },
      { x: -8,  z: -4,  h: 6,  rx: 0,    rz: 0 },
    ];
    ruins.forEach(r => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(2 + Math.random() * 3, r.h, 0.8), stoneMat);
      wall.position.set(r.x, r.h / 2, r.z);
      wall.rotation.x = r.rx;
      wall.rotation.z = r.rz;
      wall.rotation.y = Math.random() * Math.PI;
      wall.castShadow = true;
      wall.receiveShadow = true;
      g.add(wall);
    });

    // Floor stones
    for (let i = 0; i < 8; i++) {
      const stone = new THREE.Mesh(
        new THREE.BoxGeometry(1.5 + Math.random(), 0.3, 1.5 + Math.random()),
        stoneMat
      );
      stone.position.set((Math.random() - 0.5) * 18, 0.15, (Math.random() - 0.5) * 12);
      stone.rotation.y = Math.random() * Math.PI;
      g.add(stone);
    }
    return g;
  }

  _makeBunker() {
    const g = new THREE.Group();
    const concreteMat = new THREE.MeshLambertMaterial({ color: 0x9e9e9e });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x333333 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(12, 3.5, 10), concreteMat);
    body.position.y = 1.75;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(13, 0.6, 11), concreteMat);
    roof.position.y = 3.8;
    g.add(roof);

    // Gun slit
    const slit = new THREE.Mesh(new THREE.BoxGeometry(2, 0.4, 0.2), darkMat);
    slit.position.set(0, 2, 5.1);
    g.add(slit);

    // Door
    const door = new THREE.Mesh(new THREE.BoxGeometry(2, 2.8, 0.2), darkMat);
    door.position.set(4, 1.4, 5.1);
    g.add(door);

    // Sandbags
    for (let i = 0; i < 6; i++) {
      const bag = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 4), new THREE.MeshLambertMaterial({ color: 0xb5a07a }));
      bag.scale.set(1.2, 0.7, 0.9);
      bag.position.set(-4 + i * 1.5, 3.8 + 0.35, 5.5);
      g.add(bag);
    }

    return g;
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
    // Find a flat-ish area near center
    for (let r = 5; r < 80; r += 5) {
      for (let a = 0; a < Math.PI * 2; a += 0.3) {
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const h = this._getHeight(x, z);
        if (h > 1 && h < 8) return new THREE.Vector3(x, h + 2, z);
      }
    }
    return new THREE.Vector3(0, 10, 0);
  }

  getTerrainHeight(x, z) {
    return this._getHeight(x, z);
  }

  updateClouds(dt) {
    if (!this._clouds) return;
    this._clouds.forEach(c => {
      c.position.x += c.userData.cloudSpeed * dt;
      if (c.position.x > 700) c.position.x = -700;
    });

    // Animate water gently
    if (this._water) {
      this._water.position.y = this.waterLevel + Math.sin(Date.now() * 0.0008) * 0.15;
    }
  }
}
