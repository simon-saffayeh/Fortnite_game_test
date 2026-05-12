import * as THREE from 'three';

const POOL_SIZE = 120;
const _forward  = new THREE.Vector3(0, 0, 1); // cylinder's local long axis after rotateX

class Bullet {
  constructor(scene) {
    // Cylinder along Z, thin and elongated — looks like a bullet tracer
    const geo = new THREE.CylinderGeometry(0.022, 0.022, 0.42, 5);
    geo.rotateX(Math.PI / 2); // long axis now along local Z

    this.mat  = new THREE.MeshBasicMaterial({ color: 0xffee44 });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.active      = false;
    this.position    = new THREE.Vector3();
    this.direction   = new THREE.Vector3();
    this.spawnOrigin = new THREE.Vector3();
    this.speed       = 150;
    this.damage      = 20;
    this.faction     = 'player';
    this.range       = 200;
    this.traveled    = 0;
  }

  reset(origin, dir, opts) {
    this.spawnOrigin.copy(origin);
    this.position.copy(origin);
    this.direction.copy(dir).normalize();
    this.speed    = opts.speed    ?? 150;
    this.damage   = opts.damage   ?? 20;
    this.faction  = opts.faction  ?? 'player';
    this.range    = opts.range    ?? 200;
    this.traveled = 0;
    this.active   = true;

    // Color by faction
    this.mat.color.setHex(this.faction === 'player' ? 0xffee44 : 0xff5522);

    this.mesh.position.copy(origin);
    // Orient cylinder along direction
    this.mesh.quaternion.setFromUnitVectors(_forward, this.direction);
    this.mesh.visible = true;
  }
}

export class ProjectileSystem {
  constructor(scene, world) {
    this.scene  = scene;
    this.world  = world;
    this._pool  = Array.from({ length: POOL_SIZE }, () => new Bullet(scene));

    // Callbacks wired by main.js
    this.onEnemyHit = null;  // (hitPos, damage, enemy) => void
    this.onPlayerHit = null; // (sourcePos) => void
  }

  spawn(origin, direction, opts = {}) {
    const b = this._pool.find(b => !b.active);
    if (b) b.reset(origin, direction, opts);
  }

  update(dt, player, enemyManager, particles, remotePlayers = null) {
    const pp = player.getPosition();
    const playerCenter = new THREE.Vector3(pp.x, pp.y + 1.2, pp.z);

    for (const b of this._pool) {
      if (!b.active) continue;

      b.position.addScaledVector(b.direction, b.speed * dt);
      b.traveled += b.speed * dt;
      b.mesh.position.copy(b.position);

      // Expire at range
      if (b.traveled >= b.range) { this._kill(b); continue; }

      // Terrain collision
      const groundY = this.world.getTerrainHeight(b.position.x, b.position.z);
      if (b.position.y < groundY) {
        if (particles) particles.spawnBurst(b.position.clone(), {
          count: 5, color: 0x998866, speed: 2.5, lifetime: 0.2, size: 0.1,
        });
        this._kill(b);
        continue;
      }

      // Enemy bullets → hit player
      if (b.faction === 'enemy') {
        if (b.position.distanceTo(playerCenter) < 0.88) {
          player.takeDamage(b.damage, false, b.spawnOrigin.clone());
          if (this.onPlayerHit) this.onPlayerHit(b.spawnOrigin.clone());
          this._kill(b);
        }
        continue;
      }

      // Player bullets → hit remote players (multiplayer)
      if (b.faction === 'player' && remotePlayers) {
        for (const [targetId, rp] of remotePlayers) {
          if (rp.dead) continue;
          if (b.position.distanceTo(rp.getCenter()) < 0.95) {
            if (particles) particles.spawnBurst(b.position.clone(), {
              count: 12, color: 0xff2200, speed: 4, lifetime: 0.3, size: 0.15,
            });
            if (this.onRemotePlayerHit) this.onRemotePlayerHit(targetId, b.damage);
            this._kill(b);
            break;
          }
        }
        if (!b.active) continue;
      }

      // Player bullets → hit enemies
      if (!enemyManager) continue;
      for (const enemy of enemyManager.enemies) {
        if (enemy.dead) continue;
        const ec = new THREE.Vector3(
          enemy.root.position.x,
          enemy.root.position.y + 1.1,
          enemy.root.position.z
        );
        if (b.position.distanceTo(ec) < 0.95) {
          const wasDead = enemy.dead;
          enemy.takeDamage(b.damage);
          if (particles) particles.spawnBurst(b.position.clone(), {
            count: 12, color: 0xff2200, speed: 4, lifetime: 0.3, size: 0.15,
          });
          if (this.onEnemyHit) {
            this.onEnemyHit(b.position.clone(), b.damage, enemy, !wasDead && enemy.dead);
          }
          this._kill(b);
          break;
        }
      }
    }
  }

  _kill(b) {
    b.active = false;
    b.mesh.visible = false;
  }
}
