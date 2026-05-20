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

    this._healing      = false;
    this._healElapsed  = 0;
    this._healDuration = 0;
    this._healSlotIdx  = -1;
    this.onHealProgress = null; // (progress: 0-1 | -1 for cancel, label: string) => void

    // Fires when a weapon is dropped (G key OR inventory panel button).
    // Receives the WeaponInstance so the host can spawn a world pickup with
    // preserved ammo/reserve state. Consumables aren't routed through this —
    // they're just discarded.
    this.onDrop = null;       // (inst: WeaponInstance) => void

    // ── Shared ammo pool ─────────────────────────────────────────────────
    // Reserve ammo is pooled by ammo type and shared across every weapon of
    // that type currently in the player's slots. Picking up an ammo pile
    // adds to the corresponding bucket. Reloading drains from it.
    // 'special' is not stored here — that's per-instance (phaseRifle).
    this.ammoPool = {
      light:   0,
      medium:  0,
      heavy:   0,
      rockets: 0,
      shells:  0,
    };

    // Fires when the shared ammo pool changes (pickup, reload, drop). The
    // HUD subscribes to refresh its readouts immediately rather than waiting
    // for the next tick's polling.
    this.onAmmoChanged = null; // (type: string, newAmount: number) => void

    this._bindKeys();
  }

  // ── Shared ammo API ────────────────────────────────────────────────────

  /** Returns the current pool amount for an ammo type, or 0 for unknown. */
  getReserve(type) {
    return this.ammoPool[type] ?? 0;
  }

  /**
   * Consume up to `amount` from the pool of the given type. Returns the
   * amount actually taken (0 if the pool was empty).
   */
  consumeAmmo(type, amount) {
    const have = this.ammoPool[type] ?? 0;
    if (have === 0 || amount <= 0) return 0;
    const take = Math.min(have, amount);
    this.ammoPool[type] = have - take;
    if (this.onAmmoChanged) this.onAmmoChanged(type, this.ammoPool[type]);
    return take;
  }

  /** Add ammo to a pool. Unknown types are silently ignored. */
  addAmmo(type, amount) {
    if (!(type in this.ammoPool) || amount <= 0) return;
    this.ammoPool[type] += amount;
    if (this.onAmmoChanged) this.onAmmoChanged(type, this.ammoPool[type]);
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

  /**
   * Add a WeaponInstance. Returns true if successful.
   *
   * Duplicate handling: with shared ammo, picking up a copy of a gun you
   * already have transfers the new weapon's *loaded* mag straight into the
   * shared pool (so the pickup isn't completely wasted) and discards the
   * gun. For special-ammo weapons (phaseRifle) the loaded mag is dropped
   * into the existing slot's reserve instead, since 'special' has no pool.
   */
  addWeapon(inst) {
    // Duplicate of an existing slot — fold the ammo in, discard the weapon.
    for (let i = 0; i < 5; i++) {
      const cur = this.slots[i];
      if (cur?.def.id === inst.def.id) {
        if (inst.def.ammoType === 'special') {
          cur.reserve = (cur.reserve ?? 0) + inst.ammo + (inst.reserve ?? 0);
        } else {
          this.addAmmo(inst.def.ammoType, inst.ammo);
        }
        this.selectSlot(i);
        return true;
      }
    }
    // Bind to this inventory so the WeaponInstance can find the shared pool.
    inst._inventory = this;
    // First empty slot wins.
    for (let i = 0; i < 5; i++) {
      if (!this.slots[i]) {
        this.slots[i] = inst;
        this.selectSlot(i);
        return true;
      }
    }
    // Slots full — displace the active slot (or another if active is
    // undroppable) and route the displaced item to onDrop so the player can
    // pick it back up. Both weapons and consumables go through the same
    // callback — main.js inspects `.isConsumable` to choose the pickup type.
    const target = this._chooseDisplaceSlot();
    if (target === -1) return false; // every slot was undroppable
    this._displace(target);
    this.slots[target] = inst;
    this.selectSlot(target);
    return true;
  }

  /**
   * Pick the slot index to displace when the inventory is full. Prefers
   * the currently-active slot unless it holds an undroppable weapon
   * (phaseRifle), in which case scan for any other droppable slot.
   * Returns -1 if every slot is undroppable (effectively unreachable in
   * normal play — there is only one undroppable weapon).
   */
  _chooseDisplaceSlot() {
    const a = this.slots[this.activeSlot];
    if (!a || a.isConsumable || !a.def?.undroppable) return this.activeSlot;
    for (let i = 0; i < 5; i++) {
      const s = this.slots[i];
      if (!s) continue;
      if (s.isConsumable || !s.def?.undroppable) return i;
    }
    return -1;
  }

  /**
   * Empty `idx` and route the displaced item to `onDrop` so the host can
   * spawn a world pickup. Weapons unbind from this inventory first so they
   * don't keep a stale shared-pool pointer.
   */
  _displace(idx) {
    const item = this.slots[idx];
    if (!item) return;
    this.slots[idx] = null;
    if (!item.isConsumable) item._inventory = null;
    if (this.onDrop) this.onDrop(item);
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
    // Slots full — displace and drop the active slot (same rule as weapons)
    // so the player can recover it.
    const target = this._chooseDisplaceSlot();
    if (target === -1) return false;
    this._displace(target);
    this.slots[target] = { isConsumable: true, def, count: 1 };
    this.selectSlot(target);
    return true;
  }

  /** Begin channeling the active consumable. Press F again to cancel. */
  useActive(_player) {
    const s = this.slots[this.activeSlot];
    if (!s?.isConsumable) return false;

    if (this._healing) {
      this._cancelHeal();
      return true;
    }

    this._healing      = true;
    this._healElapsed  = 0;
    this._healDuration = s.def.useTime ?? 3.0;
    this._healSlotIdx  = this.activeSlot;
    if (this.onHealProgress) this.onHealProgress(0, s.def.label);
    return true;
  }

  _applyHeal(slotIdx) {
    const s = this.slots[slotIdx];
    if (!s?.isConsumable) return;
    const p = this.player;
    if (s.def.healHp     > 0) p.health = Math.min(p.maxHealth, p.health + s.def.healHp);
    if (s.def.healShield  > 0) p.healShield(s.def.healShield);
    if (s.def.healArmour  > 0) p.healArmour(s.def.healArmour);
    s.count--;
    if (s.count <= 0) {
      this.slots[slotIdx] = null;
      if (slotIdx === this.activeSlot) this.player.setHeldWeapon(null);
    }
  }

  _cancelHeal() {
    this._healing     = false;
    this._healElapsed = 0;
    if (this.onHealProgress) this.onHealProgress(-1, '');
  }

  dropActive() {
    this.dropSlot(this.activeSlot);
  }

  /**
   * Drop the contents of a specific slot. For weapons, fires `onDrop` so the
   * game can spawn a world pickup that preserves the weapon's ammo state.
   * Consumables are simply discarded — they don't round-trip.
   *
   * Weapons flagged `undroppable: true` (phaseRifle) are refused so they
   * can't be picked up by other players or accidentally lost.
   */
  dropSlot(idx) {
    const item = this.slots[idx];
    if (!item) return;
    if (!item.isConsumable && item.def?.undroppable) return; // phaseRifle, etc.
    this.slots[idx] = null;
    if (idx === this.activeSlot) this.player.setHeldWeapon(null);
    if (!item.isConsumable) {
      item._inventory = null;   // unbind from the shared pool
      if (this.onDrop) this.onDrop(item);
    }
  }

  reloadActive() {
    this.getActive()?.startReload();
  }

  update(dt) {
    for (const s of this.slots) if (s && !s.isConsumable) s.update(dt);

    if (!this._healing) return;

    // Cancel if the item was removed or slot changed
    const slot = this.slots[this._healSlotIdx];
    if (!slot?.isConsumable) { this._cancelHeal(); return; }

    // Cancel if player moves
    if (this.player.isMovingInput) { this._cancelHeal(); return; }

    this._healElapsed += dt;
    const progress = Math.min(1, this._healElapsed / this._healDuration);
    if (this.onHealProgress) this.onHealProgress(progress, slot.def.label);

    if (this._healElapsed >= this._healDuration) {
      this._applyHeal(this._healSlotIdx);
      this._healing     = false;
      this._healElapsed = 0;
      if (this.onHealProgress) this.onHealProgress(1.0, slot.def.label);
      setTimeout(() => { if (this.onHealProgress) this.onHealProgress(-1, ''); }, 350);
    }
  }
}
