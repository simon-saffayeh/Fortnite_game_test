// ── Vertex-shell outlines ────────────────────────────────────────────────────
// Adds a chunky "ink line" outline around a mesh using the inverted-hull
// technique: render the mesh twice — once normally, once as a slightly
// expanded shell with reversed face culling and a solid dark color. From the
// camera, only the back faces of the expanded shell are visible, and they
// appear as a uniform-thickness outline around the original silhouette.
//
// This is THE technique used by Fortnite, Borderlands, Wind Waker, etc.
// Each outlined mesh costs +1 draw call — keep the outlined-object list
// targeted (characters, weapons, pickups, key entities).
//
// Performance shape:
// - One shared outline material per width (cached).
// - Outline mesh is added as a child of the target so it follows transforms.
// - Geometry is shared with the target (no buffer duplication).
// - Outlines hide automatically when their target hides (Three.js child
//   visibility).

import * as THREE from 'three';
import { Graphics } from './graphics.js';

const _matCache = new Map();

/** Shared dark-shell material for a given outline width. */
function _getOutlineMaterial(width, color) {
  const key = `${width.toFixed(4)}|${color}`;
  let mat = _matCache.get(key);
  if (mat) return mat;

  mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uWidth: { value: width },
    },
    vertexShader: /* glsl */ `
      uniform float uWidth;
      void main() {
        // Expand each vertex along its normal in object space. The MVP
        // pipeline then projects it as a slightly fatter version of the mesh.
        vec3 expanded = position + normal * uWidth;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(expanded, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4(uColor, 1.0);
      }
    `,
    side: THREE.BackSide,        // only back-faces of the shell render
    depthWrite: true,             // outlines should occlude properly
  });
  _matCache.set(key, mat);
  return mat;
}

/**
 * Add a vertex-shell outline around `target`. Recurses into the object graph
 * so calling this once on a character Group outlines every mesh in it.
 *
 * Opts:
 *   width      — shell expansion in world units (default 0.025)
 *   color      — outline color hex (default 0x101018, almost-black with blue cast)
 *   maxDepth   — max recursion depth (default Infinity)
 *   filter     — predicate (mesh) => boolean to skip individual meshes
 *
 * No-op when `Graphics.toonOutline` is false (LOW / MEDIUM presets).
 */
export function addOutline(target, opts = {}) {
  if (!Graphics.toonOutline) return;
  const width    = opts.width    ?? 0.025;
  const color    = opts.color    ?? 0x101018;
  const filter   = opts.filter   ?? null;
  const material = _getOutlineMaterial(width, color);

  // Snapshot the eligible meshes BEFORE adding shells. If we mutated the
  // graph during traverse(), the freshly-added shells would themselves get
  // traversed → another shell added to that shell → infinite recursion.
  const meshes = [];
  target.traverse((child) => {
    if (!child.isMesh) return;
    if (child.userData.__isOutlineShell) return;   // never outline an outline
    if (child.userData.__hasOutline) return;
    if (child.material && (child.material.transparent && child.material.opacity < 0.95)) return;
    if (child.material && child.material.isSpriteMaterial) return;
    if (filter && !filter(child)) return;
    if (!child.geometry.boundingSphere) child.geometry.computeBoundingSphere();
    const r = child.geometry.boundingSphere?.radius ?? 1;
    if (r < 0.05) return;
    meshes.push(child);
  });

  for (const child of meshes) {
    const shell = new THREE.Mesh(child.geometry, material);
    shell.castShadow = false;
    shell.receiveShadow = false;
    shell.renderOrder = -1;
    shell.userData.__isOutlineShell = true;        // mark so future passes skip
    child.add(shell);
    child.userData.__hasOutline = true;
  }
}
