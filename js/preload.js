// ── Asset preloader ──────────────────────────────────────────────────────────
// Match start (Game._loadWorld) pulls a lot over the network the first time:
// every gun/explosion sound, the nature .glb models, and the terrain textures.
// On slow connections that fetch is what makes some players load in minutes
// after a round has already begun.
//
// This warms the browser cache for those files while the player is still in the
// menu / lobby (dead time), so the real match-start loader hits the cache
// instead of the network and everyone deploys at roughly the same time.
//
// Best-effort only: failures are ignored, requests are low priority, and it
// runs once per page load. It never blocks anything — if a path is stale the
// worst case is that one file simply isn't pre-warmed.

import { SOUND_PATHS } from './audio.js';

// Nature models loaded by world.loadNature(). Keep in sync with that list.
const NATURE_MODELS = [
  'objects/nature/Pine.glb',
  'objects/nature/Pine-699sFuLCN2.glb',
  'objects/nature/Pine-79gmlLnweB.glb',
  'objects/nature/Tree.glb',
  'objects/nature/Twisted Tree.glb',
  'objects/nature/Bush.glb',
  'objects/nature/Bush with Flowers.glb',
  'objects/nature/Fern.glb',
  'objects/nature/Tall Grass.glb',
  'objects/nature/Flower Group.glb',
  'objects/nature/Mushroom.glb',
  'objects/nature/Rock Medium.glb',
  'objects/nature/Plant.glb',
  'objects/nature/Plant Big-MbhbP7JrTI.glb',
];

// Terrain PBR textures loaded by world._loadTerrainTextures().
const TERRAIN_TEXTURES = [
  'textures/grass/Grass004_1K-JPG_Color.jpg',
  'textures/grass/Grass004_1K-JPG_NormalGL.jpg',
  'textures/rock/Ground081_2K-JPG_Color.jpg',
  'textures/rock/Ground081_2K-JPG_NormalGL.jpg',
  'textures/sand/Ground054_2K-JPG_Color.jpg',
  'textures/sand/Ground054_2K-JPG_NormalGL.jpg',
  'textures/snow/Snow014_2K-JPG_Color.jpg',
  'textures/snow/Snow014_2K-JPG_NormalGL.jpg',
];

let _started = false;

/**
 * Kick off background prefetch of all heavy match assets. Idempotent — safe to
 * call from several places (menu load, entering the lobby); only the first call
 * does work.
 */
export function preloadGameAssets() {
  if (_started || typeof fetch !== 'function') return;
  _started = true;

  const urls = [...SOUND_PATHS, ...NATURE_MODELS, ...TERRAIN_TEXTURES];
  for (const url of urls) {
    // encodeURI handles the spaces in some model filenames so the prefetch
    // request matches the URL the loaders later request (browser-normalised).
    fetch(encodeURI(url), { priority: 'low' }).catch(() => { /* best-effort */ });
  }
}
