import * as THREE from 'three';

const POOL_SIZE = 120;
const _forward  = new THREE.Vector3(0, 0, 1); // cylinder's local long axis after rotateX

class Bullet {
  constructor(scene) {
    // Main tracer cylinder — longer + slightly thicker than before so it
    // reads as a streak even at 100m+. The faction-based recolor in reset()
    // still controls the tracer hue.
    const geo = new THREE.CylinderGeometry(0.04, 0.025, 2.2, 6);
    geo.rotateX(Math.PI / 2); // long axis now along local Z

    this.mat  = new THREE.MeshBasicMaterial({ color: 0xffee44 });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.visible = false;
    scene.add(this.mesh);

    // Trail mesh — a fatter, semi-transparent cylinder positioned BEHIND
    // the main bullet so each shot has a visible tail. Uses additive
    // blending so it brightens against any background. Centered slightly
    // behind the head so it streams from the muzzle outward.
    const trailGeo = new THREE.CylinderGeometry(0.10, 0.02, 4.8, 8);
    trailGeo.rotateX(Math.PI / 2);
    trailGeo.translate(0, 0, 2.4);   // shift backward (negative facing dir)
    this.trailMat = new THREE.MeshBasicMaterial({
      color: 0xffee44,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.trail = new THREE.Mesh(trailGeo, this.trailMat);
    this.trail.visible = false;
    this.mesh.add(this.trail);

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
    // Display name of whoever fired this — used in the death message so
    // bosses don't get lumped in as "an enemy bot".
    this.attacker = opts.attacker ?? null;
    this.traveled = 0;
    this.active   = true;
    this._vy      = 0; // vertical velocity for gravity arc

    const isBomb     = this.def?.id === 'bombLauncher';
    const isFlame    = this.def?.id === 'flamethrower';
    const isGrenade  = this.def?.id === 'grenadeLauncher';
    const isCrossbow = this.def?.id === 'crossbow';
    // Big projectiles (bomb/flame/grenade/crossbow bolt) hide the streak
    // trail — it looks silly behind a thrown bomb or arrow. Standard
    // bullets get a faction-tinted trail behind them.
    let showTrail = false;
    if (isBomb) {
      this.mat.color.setHex(0x111111);
      this.mesh.scale.setScalar(5);
    } else if (isFlame) {
      // Fat glowing fireball — orange blob at short range
      this.mat.color.setHex(0xff5500);
      this.mesh.scale.set(3.2, 3.2, 1.4);
    } else if (isGrenade) {
      this.mat.color.setHex(0x4a6622);
      this.mesh.scale.setScalar(3.5);
    } else if (isCrossbow) {
      // Wooden arrow — brown, elongated
      this.mat.color.setHex(0xbb8833);
      this.mesh.scale.set(1.8, 1.8, 2.8);
    } else {
      const tracerHex = this.faction === 'player' ? 0xffee44 : 0xff5522;
      this.mat.color.setHex(tracerHex);
      this.trailMat.color.setHex(tracerHex);
      this.mesh.scale.setScalar(1);
      showTrail = true;
    }
    this.trail.visible = showTrail;
    this.trailMat.opacity = showTrail ? 0.45 : 0;

    this._bounces   = 0;
    this._fuseTimer = 0;

    this.mesh.position.copy(origin);
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
    this.buildingSystem = null;
    this._tempEffects   = []; // nuclear explosion mesh effects

    // One persistent explosion light. Adding/removing a light changes the
    // scene light count and forces a full shader recompile (freeze), so we
    // keep it in the scene permanently and just modulate its intensity.
    this._explosionLight = new THREE.PointLight(0xff8822, 0, 120);
    this._explosionLight.castShadow = false;
    scene.add(this._explosionLight);

    // Callbacks wired by main.js
    this.onEnemyHit  = null;
    this.onPlayerHit = null;
    this.onExplosion = null; // (pos, defId) → void
    // (pos, reverseDir) — fired when a bullet kills against terrain / wall /
    // building so DecalSystem can paint a scorch mark. Not fired for
    // soft-target hits (no decal on an enemy chest).
    this.onImpactDecal = null;

    // Optional MsFranksManager — when set, player bullets and explosions
    // also test against the boss. Single-entity check so cost is negligible.
    this.bossManager = null;
  }

  spawn(origin, direction, opts = {}) {
    const b = this._pool.find(b => !b.active);
    if (b) b.reset(origin, direction, opts);
  }

  update(dt, player, enemyManager, particles, remotePlayers = null) {
    const pp = player.getPosition();
    const playerCenter = new THREE.Vector3(pp.x, pp.y + 1.2, pp.z);

    // Tick nuclear explosion mesh effects
    this._tempEffects = this._tempEffects.filter(fx => {
      fx.age += dt;
      const t = Math.min(1, fx.age / fx.duration);
      switch (fx.type) {
        case 'flash': {
          const s = fx.maxR * Math.min(t * 5, 1);
          fx.mesh.scale.setScalar(s);
          fx.mat.opacity = 0.85 * (1 - t);
          break;
        }
        case 'ring': {
          const s = fx.maxR * t;
          fx.mesh.scale.set(s, s, s);
          fx.mat.opacity = 0.65 * (1 - t * t);
          break;
        }
        case 'column': {
          const grow = Math.min(t * 2, 1);
          fx.mesh.scale.x = fx.mesh.scale.z = fx.maxR * grow;
          fx.mesh.scale.y = fx.maxH * grow;
          fx.mesh.position.y = fx.baseY + fx.maxH * 0.5 * grow;
          fx.mat.opacity = 0.75 * (1 - Math.max(0, t - 0.4) / 0.6);
          break;
        }
        case 'cap': {
          const emerge = Math.min(t * 3, 1);
          const s = fx.maxR * emerge;
          fx.mesh.scale.set(s, 1, s);
          fx.mesh.position.y = fx.baseY + fx.riseH * Math.min(t * 2, 1);
          fx.mat.opacity = 0.7 * (1 - Math.max(0, t - 0.5) / 0.5);
          break;
        }
        case 'light':
          fx.light.intensity = fx.maxI * (1 - t * t);
          break;
      }
      const alive = fx.age < fx.duration;
      if (!alive) {
        if (fx.mesh)  this.scene.remove(fx.mesh);
        if (fx.light) fx.light.intensity = 0; // persistent — just dim it
      }
      return alive;
    });

    for (const b of this._pool) {
      if (!b.active) continue;

      b.prevPosition.copy(b.position);

      // Gravity arc (bomb launcher arcs up, crossbow bolt + grenade drop)
      if (b.def?.gravity) {
        b._vy = (b._vy ?? 0) + b.def.gravity * dt;
        b.position.y += b._vy * dt;
        if (b.def.id === 'bombLauncher' || b.def.id === 'grenadeLauncher') {
          b.mesh.rotation.x += dt * 3;
        }

        // Fuse: explode after fuseTime regardless of surface contact
        if (b.def.fuseTime) {
          b._fuseTimer = (b._fuseTimer ?? 0) + dt;
          if (b._fuseTimer >= b.def.fuseTime) {
            this._explode(b, b.position.clone(), particles, player, enemyManager);
            this._kill(b);
            continue;
          }
        }
      }

      b.position.addScaledVector(b.direction, b.speed * dt);
      b.traveled += b.speed * dt;
      b.mesh.position.copy(b.position);

      // Expire at range
      if (b.traveled >= b.range) {
        if (b.def?.explosive) this._explode(b, b.position.clone(), particles, player, enemyManager);
        if (b.def?.teleport) this._doTeleport(b, b.position.clone(), player, particles);
        this._kill(b); continue;
      }

      // Terrain collision
      const groundY = this.world.getTerrainHeight(b.position.x, b.position.z);
      if (b.position.y < groundY) {
        // Bouncing grenades: reflect vertical velocity and skip detonation
        if (b.def?.maxBounces != null && b._bounces < b.def.maxBounces && b._vy < 0) {
          b._bounces++;
          b._vy = -b._vy * 0.42;           // dampen and reflect
          b.position.y = groundY + 0.05;   // push just above ground
          if (particles) {
            particles.spawnBurst(b.position.clone(), {
              count: 4, color: 0x667744, speed: 1.5, lifetime: 0.15, size: 0.07,
            });
          }
          continue;
        }
        if (b.def?.teleport) this._doTeleport(b, b.position.clone(), player, particles);
        if (b.def?.explosive) {
          this._explode(b, b.position.clone(), particles, player, enemyManager);
        } else if (particles) {
          if (b.def?.flamethrower) {
            particles.spawnBurst(b.position.clone(), { count: 5, color: 0xff5500, speed: 3, lifetime: 0.4, size: 0.18, gravity: -2 });
          } else {
            // ── Terrain impact — dirt spray + bright grass flecks ──
            // Brighter colors than realistic so it reads as Fortnite-cartoony.
            const impactDir = b.direction.clone().negate();
            impactDir.y = Math.abs(impactDir.y) + 0.5;
            particles.spawnSparks(b.position.clone(), impactDir, {
              count: 12, color: 0x8a6a44, speed: 6, lifetime: 0.28, size: 0.10,
            });
            particles.spawnBurst(b.position.clone(), {
              count: 10, color: 0xc8a972, speed: 2.5, lifetime: 0.38, size: 0.16, gravity: 4,
            });
            // Bright green grass flecks — small but vivid, sells "grass got hit".
            particles.spawnSparks(b.position.clone(), impactDir, {
              count: 4, color: 0x66ee33, speed: 4, lifetime: 0.55, size: 0.06,
            });
            this.onImpactDecal?.(b.position.clone(), new THREE.Vector3(0, 1, 0));
          }
        }
        this._kill(b);
        continue;
      }

      // Building collision (player-built structures — wood/timber)
      if (this.buildingSystem) {
        if (this.buildingSystem.checkBullet(b.prevPosition, b.position, b.damage)) {
          if (b.def?.teleport) this._doTeleport(b, b.position.clone(), player, particles);
          if (b.def?.explosive) {
            this._explode(b, b.position.clone(), particles, player, enemyManager);
          } else if (particles) {
            // ── Wood impact — bright yellow sparks + brown splinters + smoke ──
            const impactDir = b.direction.clone().negate();
            particles.spawnSparks(b.position.clone(), impactDir, {
              count: 10, color: 0xffd844, speed: 7, lifetime: 0.22, size: 0.08, spread: 0.65,
            });
            particles.spawnSparks(b.position.clone(), impactDir, {
              count: 8, color: 0x8c5a26, speed: 5, lifetime: 0.42, size: 0.09, spread: 0.7,
            });
            particles.spawnSmoke(b.position.clone(), { count: 3, color: 0x9a8866, lifetime: 1.0, size: 0.4 });
            this.onImpactDecal?.(b.position.clone(), impactDir);
          }
          this._kill(b);
          continue;
        }
      }

      // Static world structure collision — POI buildings.
      // Lightweight material heuristic: high impact (y > 6) likely a roof or
      // upper wall of a tall stone building (Ancient Temple, mansion);
      // low impact (y < 3) likely a wood cabin or palisade. Defaults to
      // stone-chip read for ambiguous cases.
      if (this.world.staticCollider.checkBullet(b.prevPosition, b.position)) {
        if (b.def?.teleport) this._doTeleport(b, b.position.clone(), player, particles);
        if (b.def?.explosive) {
          this._explode(b, b.position.clone(), particles, player, enemyManager);
        } else if (particles) {
          const impactDir = b.direction.clone().negate();
          const isLowWall = b.position.y < 3.0;
          if (isLowWall) {
            // Wood-cabin read — yellow sparks + brown splinters.
            particles.spawnSparks(b.position.clone(), impactDir, {
              count: 9, color: 0xffd844, speed: 6.5, lifetime: 0.22, size: 0.08, spread: 0.6,
            });
            particles.spawnSparks(b.position.clone(), impactDir, {
              count: 6, color: 0x8c5a26, speed: 4, lifetime: 0.40, size: 0.08, spread: 0.7,
            });
            particles.spawnSmoke(b.position.clone(), { count: 3, color: 0x9a8866, lifetime: 0.9, size: 0.38 });
          } else {
            // Stone-chip read — gray chips + bright white dust burst.
            particles.spawnSparks(b.position.clone(), impactDir, {
              count: 10, color: 0xd8d2c4, speed: 6, lifetime: 0.22, size: 0.08, spread: 0.6,
            });
            particles.spawnSparks(b.position.clone(), impactDir, {
              count: 6, color: 0x6a6a66, speed: 4, lifetime: 0.45, size: 0.10, spread: 0.55,
            });
            particles.spawnSmoke(b.position.clone(), { count: 4, color: 0xc0c0b8, lifetime: 1.0, size: 0.45 });
          }
          this.onImpactDecal?.(b.position.clone(), impactDir);
        }
        this._kill(b);
        continue;
      }

      // Enemy bullets → hit player
      if (b.faction === 'enemy') {
        if (segmentSphere(b.prevPosition, b.position, playerCenter, 0.88)) {
          player.takeDamage(b.damage, false, b.spawnOrigin.clone(), b.attacker ?? 'an enemy bot');
          if (this.onPlayerHit) this.onPlayerHit(b.spawnOrigin.clone());
          this._kill(b);
        }
        continue;
      }

      // Player bullets → hit remote players (multiplayer)
      if (b.faction === 'player' && remotePlayers) {
        for (const [targetId, rp] of remotePlayers) {
          // Skip teammates (duo mode) so bullets pass straight through them
          // without triggering hit markers, damage, or kill credit.
          if (rp.dead || rp.isTeammate) continue;
          if (segmentSphere(b.prevPosition, b.position, rp.getCenter(), 0.95)) {
            // Same height check used for enemies — neck-line and above.
            const headshot = b.position.y > rp.root.position.y + 1.6;
            const finalDmg = headshot ? b.damage * 1.5 : b.damage;
            if (particles) {
              if (headshot) {
                particles.spawnBurst(b.position.clone(), { count: 18, color: 0xffdd00, speed: 5, lifetime: 0.35, size: 0.16 });
              } else {
                particles.spawnBurst(b.position.clone(), { count: 12, color: 0xff2200, speed: 4, lifetime: 0.3, size: 0.15 });
              }
            }
            if (this.onRemotePlayerHit) this.onRemotePlayerHit(targetId, finalDmg, b.position.clone(), headshot);
            this._kill(b);
            break;
          }
        }
        if (!b.active) continue;
      }

      // Player bullets → hit boss (Ms. Franks). Single-entity check before
      // the enemy loop so explosives/bullets damage her even in MP where
      // enemyManager is null.
      const boss = this.bossManager?.getAliveBoss?.() ?? null;
      if (boss) {
        const bc = new THREE.Vector3(
          boss.root.position.x,
          boss.root.position.y + 1.1,
          boss.root.position.z,
        );
        if (segmentSphere(b.prevPosition, b.position, bc, 1.05)) {
          const headshot = b.position.y > boss.root.position.y + 1.95;
          const finalDmg = headshot ? b.damage * 2 : b.damage;
          const wasAlive = !boss.dead;
          this.bossManager.applyHit(finalDmg);
          if (particles) {
            particles.spawnBurst(b.position.clone(), {
              count: headshot ? 18 : 10,
              color: headshot ? 0xffdd00 : 0xff3344,
              speed: 5, lifetime: 0.3, size: 0.15,
            });
          }
          if (this.onEnemyHit) {
            this.onEnemyHit(b.position.clone(), finalDmg, boss, wasAlive && boss.dead, headshot);
          }
          this._kill(b);
          continue;
        }
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
          // Headshot: bullet impact Y above the enemy's neck line (root.y + 1.6)
          const headshot = b.position.y > enemy.root.position.y + 1.6;
          const finalDmg = headshot ? b.damage * 2 : b.damage;
          const wasDead = enemy.dead;
          enemy.takeDamage(finalDmg);
          if (particles) {
            if (b.def?.flamethrower) {
              // Flame lick: tight upward orange burst
              particles.spawnBurst(b.position.clone(), { count: 7, color: 0xff5500, speed: 4, lifetime: 0.45, size: 0.20, gravity: -3 });
            } else if (headshot) {
              particles.spawnBurst(b.position.clone(), { count: 20, color: 0xffdd00, speed: 6, lifetime: 0.35, size: 0.18 });
              particles.spawnBurst(b.position.clone(), { count: 10, color: 0xff4400, speed: 9, lifetime: 0.25, size: 0.12 });
            } else {
              particles.spawnBurst(b.position.clone(), { count: 12, color: 0xff2200, speed: 4, lifetime: 0.3, size: 0.15 });
            }
          }
          if (this.onEnemyHit) {
            this.onEnemyHit(b.position.clone(), finalDmg, enemy, !wasDead && enemy.dead, headshot);
          }
          // Phase Rifle: teleport player to impact location
          if (b.def?.teleport) {
            const tp = b.position.clone();
            tp.y = Math.max(tp.y, this.world.getTerrainHeight(tp.x, tp.z) + 0.5);
            player.root.position.copy(tp);
            player.velocity.set(0, 0, 0);
            if (particles) particles.spawnBurst(tp, { count: 30, color: 0xff1111, speed: 8, lifetime: 0.4, size: 0.2 });
          }
          this._kill(b);
          break;
        }
      }
    }
  }

  _doTeleport(b, pos, player, particles) {
    const tp = pos.clone();
    tp.y = Math.max(tp.y, this.world.getTerrainHeight(tp.x, tp.z) + 0.5);
    player.root.position.copy(tp);
    player.velocity.set(0, 0, 0);
    if (particles) particles.spawnBurst(tp, { count: 30, color: 0xff1111, speed: 8, lifetime: 0.4, size: 0.2 });
  }

  _explode(b, pos, particles, player, enemyManager) {
    const def = b.def || {};
    if (def.id === 'bombLauncher') {
      this._nuclearExplosion(pos, def, particles, player, enemyManager);
      return;
    }
    if (this.onExplosion) this.onExplosion(pos.clone(), def.id);

    const radius = def.explosionRadius ?? 8;
    const dmg    = def.explosionDamage ?? 80;

    if (particles) {
      particles.spawnBurst(pos.clone(), { count: 40, color: 0xff6600, speed: 12, lifetime: 0.6, size: 0.35 });
      particles.spawnBurst(pos.clone(), { count: 20, color: 0xffdd00, speed: 6,  lifetime: 0.4, size: 0.2  });
      particles.spawnBurst(pos.clone(), { count: 15, color: 0x888888, speed: 5,  lifetime: 0.8, size: 0.15 });
      // Lingering smoke plume
      particles.spawnSmoke(pos.clone(), { count: 10, color: 0x555544, speed: 2.5, lifetime: 2.8, size: 0.9 });
      particles.spawnSmoke(pos.clone(), { count: 6,  color: 0x333322, speed: 1.5, lifetime: 3.5, size: 1.2 });
    }

    // ── Multi-stage mesh effects ───────────────────────────────────────
    // Flash sphere + ground shockwave ring, both reusing the existing
    // _tempEffects tick logic (same flash/ring types as _nuclearExplosion,
    // just smaller and shorter). Allocations are per-explosion which is
    // fine — explosions are rare events (rocket/grenade impacts).
    // 1. Quick bright flash
    const flashGeo = new THREE.SphereGeometry(1, 12, 8);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xfff0a0, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const flashM = new THREE.Mesh(flashGeo, flashMat);
    flashM.position.copy(pos);
    flashM.scale.setScalar(0.1);
    this.scene.add(flashM);
    this._tempEffects.push({
      type: 'flash', mesh: flashM, mat: flashMat,
      age: 0, duration: 0.28, maxR: radius * 0.55,
    });

    // 2. Ground shockwave ring
    const ringGeo = new THREE.TorusGeometry(1, 0.18, 6, 36);
    ringGeo.rotateX(Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff8030, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      side: THREE.DoubleSide,
    });
    const ringM = new THREE.Mesh(ringGeo, ringMat);
    ringM.position.copy(pos);
    ringM.position.y -= 0.5;     // sit near ground level
    ringM.scale.setScalar(0.01);
    this.scene.add(ringM);
    this._tempEffects.push({
      type: 'ring', mesh: ringM, mat: ringMat,
      age: 0, duration: 0.65, maxR: radius * 1.25,
    });

    // Briefly punch the persistent explosion light too — same trick as the
    // nuclear path uses, no light add/remove (avoids shader recompile).
    this._explosionLight.position.copy(pos);
    this._tempEffects.push({
      type: 'light', light: this._explosionLight, age: 0, duration: 0.35, maxI: 6,
    });

    const pp = player.getPosition();
    const pd = Math.sqrt((pp.x-pos.x)**2 + (pp.y+1-pos.y)**2 + (pp.z-pos.z)**2);
    if (pd < radius) {
      player.takeDamage(dmg * (1 - pd / radius), false, pos.clone(), 'your own explosion');
    }

    // Boss explosion damage — separate from enemyManager since the boss
    // exists in MP too where enemyManager is null.
    const boss = this.bossManager?.getAliveBoss?.() ?? null;
    if (boss) {
      const bx = boss.root.position;
      const bd = Math.sqrt((bx.x-pos.x)**2 + (bx.y+1-pos.y)**2 + (bx.z-pos.z)**2);
      if (bd < radius) {
        const falloff = 1 - bd / radius;
        const wasAlive = !boss.dead;
        this.bossManager.applyHit(dmg * falloff);
        if (this.onEnemyHit) this.onEnemyHit(bx.clone(), dmg * falloff, boss, wasAlive && boss.dead);
      }
    }

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

  _nuclearExplosion(pos, def, particles, player, enemyManager) {
    if (this.onExplosion) this.onExplosion(pos.clone(), 'nukeExplosion');
    const radius = def.explosionRadius ?? 45;
    const dmg    = def.explosionDamage ?? 280;

    // ── Damage (quadratic falloff — devastating up close, survivable far away) ──
    const pp = player.getPosition();
    const pd = Math.sqrt((pp.x-pos.x)**2 + (pp.y+1-pos.y)**2 + (pp.z-pos.z)**2);
    if (pd < radius) {
      const f = 1 - pd / radius;
      player.takeDamage(dmg * f * f, false, pos.clone(), 'your own nuke');
    }
    if (enemyManager) {
      for (const e of enemyManager.enemies) {
        if (e.dead || !e.root) continue;
        const ex = e.root.position;
        const ed = Math.sqrt((ex.x-pos.x)**2 + (ex.y+1-pos.y)**2 + (ex.z-pos.z)**2);
        if (ed < radius) {
          const f = 1 - ed / radius;
          const wasDead = e.dead;
          e.takeDamage(dmg * f);
          if (this.onEnemyHit) this.onEnemyHit(ex.clone(), dmg * f, e, !wasDead && e.dead);
        }
      }
    }
    // Nuke also damages the boss.
    {
      const boss = this.bossManager?.getAliveBoss?.() ?? null;
      if (boss) {
        const bx = boss.root.position;
        const bd = Math.sqrt((bx.x-pos.x)**2 + (bx.y+1-pos.y)**2 + (bx.z-pos.z)**2);
        if (bd < radius) {
          const f = 1 - bd / radius;
          const wasAlive = !boss.dead;
          this.bossManager.applyHit(dmg * f);
          if (this.onEnemyHit) this.onEnemyHit(bx.clone(), dmg * f, boss, wasAlive && boss.dead);
        }
      }
    }

    // ── Particles ────────────────────────────────────────────────────────────
    if (particles) {
      // Blinding ground flash
      particles.spawnBurst(pos.clone(), { count: 100, color: 0xffffff, speed: 30, lifetime: 0.25, size: 0.9 });
      // Inner fireball
      particles.spawnBurst(pos.clone(), { count: 140, color: 0xff7700, speed: 22, lifetime: 1.4, size: 0.65 });
      particles.spawnBurst(pos.clone(), { count: 80,  color: 0xff3300, speed: 16, lifetime: 1.8, size: 0.55 });
      particles.spawnBurst(pos.clone(), { count: 60,  color: 0xffdd00, speed: 25, lifetime: 0.9, size: 0.45 });
      // Ember spray
      particles.spawnBurst(pos.clone(), { count: 120, color: 0xff2200, speed: 28, lifetime: 2.2, size: 0.22 });
      // Ground smoke ring
      particles.spawnBurst(pos.clone(), { count: 80,  color: 0x333333, speed: 18, lifetime: 3.0, size: 0.75 });
      particles.spawnBurst(pos.clone(), { count: 50,  color: 0x222222, speed: 8,  lifetime: 4.0, size: 1.0  });
      // Rising fire column — staggered heights
      const colBase = pos.clone();
      for (let h = 4; h <= 24; h += 4) {
        const p = colBase.clone().add(new THREE.Vector3(0, h, 0));
        particles.spawnBurst(p, { count: 40, color: h < 14 ? 0xff5500 : 0x884422, speed: 7, lifetime: 2.5 + h * 0.06, size: 0.55 });
      }
      // Mushroom cap
      const capPos = pos.clone().add(new THREE.Vector3(0, 26, 0));
      particles.spawnBurst(capPos, { count: 100, color: 0x553322, speed: 14, lifetime: 3.5, size: 0.8 });
      particles.spawnBurst(capPos, { count: 60,  color: 0x222211, speed: 20, lifetime: 2.8, size: 0.6 });
    }

    // ── Mesh effects ─────────────────────────────────────────────────────────
    this._spawnNuclearMeshFX(pos);
  }

  _spawnNuclearMeshFX(pos) {
    const mk = (geo, color, side = THREE.FrontSide) => {
      const mat  = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, side });
      const mesh = new THREE.Mesh(geo, mat);
      this.scene.add(mesh);
      return { mesh, mat };
    };

    // 1. Blinding flash sphere
    const { mesh: flashM, mat: flashMat } = mk(new THREE.SphereGeometry(1, 14, 10), 0xffffff);
    flashM.position.copy(pos);
    this._tempEffects.push({ type: 'flash', mesh: flashM, mat: flashMat, age: 0, duration: 0.45, maxR: 18 });

    // 2. Ground shockwave ring (flat torus)
    const { mesh: ringM, mat: ringMat } = mk(new THREE.TorusGeometry(1, 0.55, 6, 48), 0xff9944, THREE.DoubleSide);
    ringM.rotation.x = Math.PI / 2;
    ringM.position.copy(pos).setY(pos.y + 0.4);
    this._tempEffects.push({ type: 'ring', mesh: ringM, mat: ringMat, age: 0, duration: 1.8, maxR: 38 });

    // 3. Fire column (cylinder rising upward)
    const { mesh: colM, mat: colMat } = mk(new THREE.CylinderGeometry(1, 1, 1, 12), 0xff5500);
    colM.position.copy(pos);
    this._tempEffects.push({ type: 'column', mesh: colM, mat: colMat, age: 0, duration: 2.5, maxR: 9, maxH: 30, baseY: pos.y });

    // 4. Mushroom cap (torus rising)
    const { mesh: capM, mat: capMat } = mk(new THREE.TorusGeometry(1, 0.7, 8, 32), 0x553322, THREE.DoubleSide);
    capM.position.copy(pos).setY(pos.y + 20);
    this._tempEffects.push({ type: 'cap', mesh: capM, mat: capMat, age: 0, duration: 3.0, maxR: 14, baseY: pos.y + 20, riseH: 10 });

    // 5. Point light — reuse the persistent light instead of add/remove
    this._explosionLight.position.copy(pos).setY(pos.y + 5);
    this._explosionLight.intensity = 12;
    this._tempEffects.push({ type: 'light', light: this._explosionLight, age: 0, duration: 2.0, maxI: 12 });
  }

  _kill(b) {
    b.active = false;
    b.mesh.visible = false;
  }
}
