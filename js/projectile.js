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
    this.prevPosition = new THREE.Vector3();
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
    this.prevPosition.copy(origin);
    this.direction.copy(dir).normalize();
    this.speed    = opts.speed    ?? 150;
    this.damage   = opts.damage   ?? 20;
    this.faction  = opts.faction  ?? 'player';
    this.range    = opts.range    ?? 200;
    this.def      = opts.def      ?? null;
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

// Returns true if the line segment from p0 to p1 passes within radius of center.
// Fixes bullet tunneling through targets when speed > hitbox size per frame.
function segmentSphere(p0, p1, center, radius) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const fx = p0.x - center.x, fy = p0.y - center.y, fz = p0.z - center.z;
  const a = dx*dx + dy*dy + dz*dz;
  if (a === 0) return fx*fx + fy*fy + fz*fz < radius*radius;
  const b = 2 * (fx*dx + fy*dy + fz*dz);
  const c = fx*fx + fy*fy + fz*fz - radius*radius;
  const disc = b*b - 4*a*c;
  if (disc < 0) return false;
  const t = (-b - Math.sqrt(disc)) / (2*a);
  return t >= 0 && t <= 1;
}

export class ProjectileSystem {
  constructor(scene, world) {
    this.scene          = scene;
    this.world          = world;
    this._pool          = Array.from({ length: POOL_SIZE }, () => new Bullet(scene));
    this.buildingSystem = null; // set by main.js after building is created

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

      b.prevPosition.copy(b.position);
      b.position.addScaledVector(b.direction, b.speed * dt);
      b.traveled += b.speed * dt;
      b.mesh.position.copy(b.position);

      // Expire at range
      if (b.traveled >= b.range) {
        if (b.def?.explosive) this._explode(b, b.position.clone(), particles, player, enemyManager);
        this._kill(b); continue;
      }

      // Terrain collision
      const groundY = this.world.getTerrainHeight(b.position.x, b.position.z);
      if (b.position.y < groundY) {
        if (b.def?.explosive) {
          this._explode(b, b.position.clone(), particles, player, enemyManager);
        } else if (particles) {
          particles.spawnBurst(b.position.clone(), {
            count: 5, color: 0x998866, speed: 2.5, lifetime: 0.2, size: 0.1,
          });
        }
        this._kill(b);
        continue;
      }

      // Building collision (player-built structures)
      if (this.buildingSystem) {
        if (this.buildingSystem.checkBullet(b.prevPosition, b.position, b.damage)) {
          if (b.def?.explosive) {
            this._explode(b, b.position.clone(), particles, player, enemyManager);
          } else if (particles) {
            particles.spawnBurst(b.position.clone(), {
              count: 6, color: 0xb07838, speed: 3, lifetime: 0.25, size: 0.1,
            });
          }
          this._kill(b);
          continue;
        }
      }

      // Static world structure collision (POI buildings, walls, etc.)
      if (this.world.staticCollider.checkBullet(b.prevPosition, b.position)) {
        if (b.def?.explosive) {
          this._explode(b, b.position.clone(), particles, player, enemyManager);
        } else if (particles) {
          particles.spawnBurst(b.position.clone(), {
            count: 6, color: 0x998877, speed: 3, lifetime: 0.25, size: 0.1,
          });
        }
        this._kill(b);
        continue;
      }

      // Enemy bullets → hit player
      if (b.faction === 'enemy') {
        if (segmentSphere(b.prevPosition, b.position, playerCenter, 0.88)) {
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
          if (segmentSphere(b.prevPosition, b.position, rp.getCenter(), 0.95)) {
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
        if (segmentSphere(b.prevPosition, b.position, ec, 0.95)) {
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

  _explode(b, pos, particles, player, enemyManager) {
    const def = b.def || {};
    const radius = def.explosionRadius ?? 8;
    const dmg    = def.explosionDamage ?? 80;

    // Big particle burst
    if (particles) {
      particles.spawnBurst(pos.clone(), { count: 40, color: 0xff6600, speed: 12, lifetime: 0.6, size: 0.35 });
      particles.spawnBurst(pos.clone(), { count: 20, color: 0xffdd00, speed: 6,  lifetime: 0.4, size: 0.2  });
      particles.spawnBurst(pos.clone(), { count: 15, color: 0x888888, speed: 5,  lifetime: 0.8, size: 0.15 });
    }

    // Player splash damage
    const pp = player.getPosition();
    const pd = Math.sqrt((pp.x-pos.x)**2 + (pp.y+1-pos.y)**2 + (pp.z-pos.z)**2);
    if (pd < radius) {
      const falloff = 1 - pd / radius;
      player.takeDamage(dmg * falloff, false, pos.clone());
    }

    // Enemy splash damage
    if (enemyManager) {
      for (const e of enemyManager.enemies) {
        if (e.dead || !e.root) continue;
        const ex = e.root.position;
        const ed = Math.sqrt((ex.x-pos.x)**2 + (ex.y+1-pos.y)**2 + (ex.z-pos.z)**2);
        if (ed < radius) {
          const falloff = 1 - ed / radius;
          const wasDead = e.dead;
          e.takeDamage(dmg * falloff);
          if (this.onEnemyHit) this.onEnemyHit(ex.clone(), dmg * falloff, e, !wasDead && e.dead);
        }
      }
    }
  }

  _kill(b) {
    b.active = false;
    b.mesh.visible = false;
  }
}
