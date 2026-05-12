/**
 * EntityManager — manages all non-player game entities.
 * Currently manages only the "future enemies" placeholder system.
 * Designed for easy extension: add enemy types, NPCs, vehicles, etc.
 */

export class EntityManager {
  constructor(scene, world) {
    this.scene  = scene;
    this.world  = world;
    this.entities = [];

    // Spawn pools ready for future use
    this.enemyPool  = [];
    this.vehiclePool = [];
    this.npcPool    = [];
  }

  /**
   * Called each frame.
   * @param {number} dt - delta time in seconds
   * @param {Player} player - reference to the local player
   */
  update(dt, player) {
    for (const entity of this.entities) {
      entity.update(dt, player);
    }
    // Remove dead entities
    this.entities = this.entities.filter(e => !e.dead);
  }

  /**
   * Spawn an enemy at a world position.
   * Stub — implement enemy logic in a separate enemy.js and call this.
   * @param {string} type - enemy variant key
   * @param {THREE.Vector3} pos
   */
  spawnEnemy(type, pos) {
    // TODO: import and instantiate Enemy classes per type
    console.log(`[EntityManager] spawnEnemy("${type}") at`, pos);
  }

  /**
   * Spawn an NPC (non-combat, dialogue / quest).
   */
  spawnNPC(type, pos) {
    console.log(`[EntityManager] spawnNPC("${type}") at`, pos);
  }

  /** Remove all entities — used for round reset in future multiplayer. */
  clearAll() {
    for (const e of this.entities) {
      if (e.root) this.scene.remove(e.root);
    }
    this.entities = [];
  }

  get count()       { return this.entities.length; }
  get enemyCount()  { return this.entities.filter(e => e.type === 'enemy').length; }
}

/**
 * BaseEntity — all game entities extend this.
 */
export class BaseEntity {
  constructor(scene, world) {
    this.scene  = scene;
    this.world  = world;
    this.root   = null;
    this.health = 100;
    this.dead   = false;
    this.type   = 'base';
  }

  update(dt, player) {}

  takeDamage(amount) {
    this.health -= amount;
    if (this.health <= 0) this._die();
  }

  _die() {
    this.dead = true;
    if (this.root) this.scene.remove(this.root);
  }
}
