import * as THREE from 'three';
import { Enemy } from './enemy.js';

const TOTAL_WAVES      = 10;
const INTERMISSION_SEC = 15;

function waveCount(w)  { return 3 + (w - 1) * 2; }         // 3,5,7…21
function waveHP(w)     { return Math.round(100 * (1 + (w - 1) * 0.35)); }
function waveDmgMult(w){ return 1 + (w - 1) * 0.22; }
function waveSpeed(w)  { return 1 + (w - 1) * 0.08; }      // subtle speed increase

export class ZombieWaveManager {
  constructor(scene, world, projectiles) {
    this.scene       = scene;
    this.world       = world;
    this.projectiles = projectiles;
    this.enemies     = [];

    this.wave        = 0;
    this.state       = 'intermission'; // 'fighting' | 'intermission' | 'complete'
    this._timer      = 5;              // 5-second countdown before wave 1

    // Callbacks wired by Game
    this.onKill               = null; // (enemy) => void
    this.onWaveStart          = null; // (waveNum) => void
    this.onWaveEnd            = null; // (waveNum) => void
    this.onAllWavesComplete   = null; // () => void
    this.onIntermissionTick   = null; // (secsLeft, waveNum) => void
  }

  get aliveCount() { return this.enemies.filter(e => !e.dead).length; }

  _spawnWave(w) {
    const count    = waveCount(w);
    const hp       = waveHP(w);
    const dmgMult  = waveDmgMult(w);
    const spdMult  = waveSpeed(w);
    const S        = this.world.size * 0.38;  // safe spawn radius bound
    const baseR    = 55 + w * 4;

    let spawned = 0, attempts = 0;
    while (spawned < count && attempts < count * 8) {
      attempts++;
      const angle = Math.random() * Math.PI * 2;
      const dist  = baseR + (Math.random() - 0.5) * 20;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      if (Math.abs(x) > S || Math.abs(z) > S) continue;
      const h = this.world.getTerrainHeight(x, z);
      if (h < 0.8) continue;

      const e = new Enemy(this.scene, this.world, new THREE.Vector3(x, h + 0.42, z));
      e.health    = hp;
      e.maxHealth = hp;
      e._dmgMult  = dmgMult;
      e._spdMult  = spdMult;
      e.onDeath   = (enemy) => { if (this.onKill) this.onKill(enemy); };
      this.enemies.push(e);
      spawned++;
    }
  }

  _startNextWave() {
    this.wave++;
    this._spawnWave(this.wave);
    this.state = 'fighting';
    if (this.onWaveStart) this.onWaveStart(this.wave);
  }

  update(dt, player, camera) {
    for (const e of this.enemies) {
      if (!e.dead) e.update(dt, player, this.projectiles, camera);
    }

    if (this.state === 'fighting') {
      if (this.enemies.length > 0 && this.aliveCount === 0) {
        if (this.wave >= TOTAL_WAVES) {
          this.state = 'complete';
          if (this.onAllWavesComplete) this.onAllWavesComplete();
        } else {
          this.state  = 'intermission';
          this._timer = INTERMISSION_SEC;
          if (this.onWaveEnd) this.onWaveEnd(this.wave);
        }
      }
    } else if (this.state === 'intermission') {
      this._timer -= dt;
      if (this.onIntermissionTick) {
        this.onIntermissionTick(Math.max(0, Math.ceil(this._timer)), this.wave + 1);
      }
      if (this._timer <= 0) this._startNextWave();
    }
  }

  get totalWaves() { return TOTAL_WAVES; }
}
