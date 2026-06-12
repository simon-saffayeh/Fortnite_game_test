// ── Instanced grass system ───────────────────────────────────────────────────
// One InstancedMesh of ~6000 triangular blades scattered in a disc around the
// player. Wind sway is per-blade-phase via a custom InstancedBufferAttribute;
// no per-frame CPU work after the initial layout.
//
// Key behaviour for stability: each blade has a FIXED world-space position
// once placed. As the player walks, blades that fall outside the visible disc
// get repositioned to a fresh random spot somewhere in the disc — but blades
// that remain in range NEVER move. Result: the player never sees a blade
// teleport, only blades disappearing far behind and new ones appearing far
// ahead.
//
// Performance shape:
// - 6000 blades × 1 triangle = 6k tris. Single draw call. Negligible cost.
// - Per-frame: cheap distance check per blade. Matrix upload only when at
//   least one blade actually moved (lazy needsUpdate).

import * as THREE from 'three';
import { Graphics } from './graphics.js';

const BLADE_COUNT = 6000;
const RADIUS      = 38;
const RADIUS_SQ   = RADIUS * RADIUS;
const BLADE_H     = 0.55;

// POI footprints — blades placed inside any of these get hidden so they
// don't poke through walls/floors of the buildings.
const POI_EXCLUSIONS = [
  { x:  100, z:    0, r2: 26*26 },   // Cedar Creek
  { x: -128, z:   50, r2: 28*28 },   // Frank's Jail
  { x:   35, z: -160, r2: 26*26 },   // Ancient Temple
  { x:  -50, z:   80, r2: 32*32 },   // Military Compound
  { x:  150, z:  -75, r2: 30*30 },   // Olsen's Farm
  { x: -125, z: -120, r2: 36*36 },   // Whalen's Town
  { x:  190, z:  120, r2: 30*30 },   // Samuel's Mansion
];

function _inPOI(x, z) {
  for (const p of POI_EXCLUSIONS) {
    const dx = x - p.x, dz = z - p.z;
    if (dx*dx + dz*dz < p.r2) return true;
  }
  return false;
}

// Simple 1-triangle blade geometry: two base corners + one top vertex.
function _makeBladeGeometry() {
  const g = new THREE.BufferGeometry();
  const verts = new Float32Array([
    -0.045, 0.00, 0.0,
     0.045, 0.00, 0.0,
     0.000, BLADE_H, 0.0,
  ]);
  const uvs = new Float32Array([
    0.0, 0.0,
    1.0, 0.0,
    0.5, 1.0,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
  g.setIndex([0, 1, 2]);
  return g;
}

export class GrassSystem {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this._dummy = new THREE.Object3D();

    // Per-blade persistent state. Positions/scale/rotation are world-fixed
    // once assigned, regenerated only when a blade falls out of the visible
    // disc around the player.
    this._posX    = new Float32Array(BLADE_COUNT);
    this._posY    = new Float32Array(BLADE_COUNT);
    this._posZ    = new Float32Array(BLADE_COUNT);
    this._scaleX  = new Float32Array(BLADE_COUNT);
    this._scaleY  = new Float32Array(BLADE_COUNT);
    this._scaleZ  = new Float32Array(BLADE_COUNT);
    this._rotY    = new Float32Array(BLADE_COUNT);
    this._visible = new Uint8Array(BLADE_COUNT);   // 1 = rendered, 0 = hidden (scale 0)
    // Stamp every blade as "needs initial placement" by marking with NaN.
    for (let i = 0; i < BLADE_COUNT; i++) this._posX[i] = NaN;

    const geo = _makeBladeGeometry();

    // Per-instance wind-phase so blades don't sway in lockstep.
    const phases = new Float32Array(BLADE_COUNT);
    for (let i = 0; i < BLADE_COUNT; i++) phases[i] = Math.random() * Math.PI * 2;
    geo.setAttribute('instanceWindPhase', new THREE.InstancedBufferAttribute(phases, 1));

    const mat = new THREE.MeshBasicMaterial({
      color:    0x3a8030,
      side:     THREE.DoubleSide,
      fog:      true,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.vertexShader = `
        attribute float instanceWindPhase;
        uniform float uTime;
        varying float vY;
      ` + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vY = transformed.y;
         float _weight = transformed.y / ${BLADE_H.toFixed(3)};
         float _w  = sin(uTime * 1.5 + instanceWindPhase) * 0.18;
         float _w2 = cos(uTime * 1.1 + instanceWindPhase * 1.7) * 0.08;
         transformed.x += _w  * _weight;
         transformed.z += _w2 * _weight;`,
      );
      shader.fragmentShader = `varying float vY;\n` + shader.fragmentShader.replace(
        '#include <output_fragment>',
        `gl_FragColor.rgb *= mix(0.78, 1.05, 1.0 - clamp(vY / ${BLADE_H.toFixed(3)}, 0.0, 1.0));
         #include <output_fragment>`,
      );
      mat.userData.shader = shader;
    };
    mat.customProgramCacheKey = () => 'grass_wind';

    this.mesh = new THREE.InstancedMesh(geo, mat, BLADE_COUNT);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    scene.add(this.mesh);
  }

  /**
   * Per-frame tick. Advances the wind clock and incrementally repositions
   * blades that have fallen outside the visible disc — leaving everything
   * the player can currently see exactly where it was.
   */
  update(dt, playerPos) {
    const shader = this.mesh.material.userData?.shader;
    if (shader) shader.uniforms.uTime.value += dt;
    this._refreshOutOfRange(playerPos);
  }

  // For each blade, if it's outside the disc OR hasn't been placed yet,
  // give it a fresh deterministic random position inside the disc. Blades
  // that are still in range are left alone (and so don't move on screen).
  _refreshOutOfRange(playerPos) {
    const dummy = this._dummy;
    let anyChanged = false;

    for (let i = 0; i < BLADE_COUNT; i++) {
      const px = this._posX[i];
      let needsPlace = !isFinite(px);
      if (!needsPlace) {
        const dx = this._posX[i] - playerPos.x;
        const dz = this._posZ[i] - playerPos.z;
        if (dx*dx + dz*dz > RADIUS_SQ) needsPlace = true;
      }
      if (!needsPlace) continue;

      // Pick a fresh random position somewhere in the disc around the player.
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * RADIUS;
      const nx = playerPos.x + Math.cos(a) * r;
      const nz = playerPos.z + Math.sin(a) * r;
      const ny = this.world.getTerrainHeight(nx, nz);

      // Eligibility: outside POIs, above water, below stone/snow zone.
      const eligible = !_inPOI(nx, nz) && ny >= 0.3 && ny <= 22;

      this._posX[i] = nx;
      this._posY[i] = ny;
      this._posZ[i] = nz;
      this._scaleX[i] = eligible ? 0.85 + Math.random() * 0.5 : 0;
      this._scaleY[i] = eligible ? 0.80 + Math.random() * 0.6 : 0;
      this._scaleZ[i] = eligible ? 0.85 + Math.random() * 0.5 : 0;
      this._rotY[i]   = Math.random() * Math.PI * 2;
      this._visible[i] = eligible ? 1 : 0;

      dummy.position.set(nx, ny, nz);
      dummy.scale.set(this._scaleX[i], this._scaleY[i], this._scaleZ[i]);
      dummy.rotation.set(0, this._rotY[i], 0);
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);
      anyChanged = true;
    }

    if (anyChanged) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// Re-export the gating helper so main.js doesn't need to import Graphics
// just to decide whether to create the system.
export function grassEnabledForCurrentPreset() {
  return !!Graphics.grassEnabled;
}
