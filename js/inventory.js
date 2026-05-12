/**
 * Inventory — 5-slot weapon management.
 * Keys: 1-5 select slot | R reload | G drop | Wheel cycle
 * Pickup (E key) is handled by main.js which calls addWeapon().
 */
export class Inventory {
  constructor(player) {
    this.player     = player;
    this.slots      = new Array(5).fill(null);  // WeaponInstance | null
    this.activeSlot = 0;
    this._bindKeys();
  }

  _bindKeys() {
    window.addEventListener('keydown', e => {
      if (e.code === 'Digit1') this.selectSlot(0);
      if (e.code === 'Digit2') this.selectSlot(1);
      if (e.code === 'Digit3') this.selectSlot(2);
      if (e.code === 'Digit4') this.selectSlot(3);
      if (e.code === 'Digit5') this.selectSlot(4);
      if (e.code === 'KeyR')   this.reloadActive();
      if (e.code === 'KeyG')   this.dropActive();
    });
    window.addEventListener('wheel', e => {
      if (!document.pointerLockElement) return;
      const dir = e.deltaY > 0 ? 1 : -1;
      this.selectSlot((this.activeSlot + dir + 5) % 5);
    });
  }

  selectSlot(idx) {
    this.activeSlot = idx;
    const s = this.slots[idx];
    if (!s || s.isConsumable) {
      this.player.setHeldWeapon(null);
    } else {
      this.player.setHeldWeapon(s.def);
    }
  }

  getActive() { return this.slots[this.activeSlot] ?? null; }

  /** Add a WeaponInstance. Returns true if successful. */
  addWeapon(inst) {
    // prefer same weapon type to top-up ammo
    for (let i = 0; i < 5; i++) {
      if (this.slots[i]?.def.id === inst.def.id) {
        this.slots[i].reserve = Math.min(
          this.slots[i].reserve + inst.reserve,
          inst.def.magSize * 5
        );
        this.selectSlot(i);
        return true;
      }
    }
    // fill empty slot
    for (let i = 0; i < 5; i++) {
      if (!this.slots[i]) {
        this.slots[i] = inst;
        this.selectSlot(i);
        return true;
      }
    }
    // replace active slot
    this.slots[this.activeSlot] = inst;
    this.selectSlot(this.activeSlot);
    return true;
  }

  /** Add a consumable to inventory. Returns true. */
  addConsumable(def) {
    // Stack: if same consumable already in a slot, increment count
    for (let i = 0; i < 5; i++) {
      const s = this.slots[i];
      if (s?.isConsumable && s.def.id === def.id) {
        s.count = (s.count || 1) + 1;
        this.selectSlot(i);
        return true;
      }
    }
    // Empty slot
    for (let i = 0; i < 5; i++) {
      if (!this.slots[i]) {
        this.slots[i] = { isConsumable: true, def, count: 1 };
        this.selectSlot(i);
        return true;
      }
    }
    // Replace active
    this.slots[this.activeSlot] = { isConsumable: true, def, count: 1 };
    this.selectSlot(this.activeSlot);
    return true;
  }

  /** Use the active consumable if it is one. Returns true if used. */
  useActive(player) {
    const s = this.slots[this.activeSlot];
    if (!s?.isConsumable) return false;
    const def = s.def;
    if (def.healHp    > 0) player.health = Math.min(player.maxHealth, player.health + def.healHp);
    if (def.healShield > 0) player.healShield(def.healShield);
    s.count--;
    if (s.count <= 0) {
      this.slots[this.activeSlot] = null;
      this.player.setHeldWeapon(null);
    }
    return true;
  }

  dropActive() {
    this.slots[this.activeSlot] = null;
    this.player.setHeldWeapon(null);
  }

  reloadActive() {
    this.getActive()?.startReload();
  }

  update(dt) {
    for (const s of this.slots) if (s && !s.isConsumable) s.update(dt);
  }
}
