export class HUD {
  constructor(player, world, enemyManager, inventory, storm) {
    this.player       = player;
    this.world        = world;
    this.enemyManager = enemyManager;
    this.inventory    = inventory;
    this.storm        = storm;

    this._healthBar  = document.getElementById('health-bar');
    this._healthVal  = document.getElementById('health-value');
    this._shieldBar  = document.getElementById('shield-bar');
    this._shieldVal  = document.getElementById('shield-value');
    this._minimap    = document.getElementById('minimap');
    this._mmCtx      = this._minimap.getContext('2d');
    this._mapScale   = 150 / world.size;

    this._pickupManager = null;
    this._adsActive     = false;

    this._buildInventoryBar();
    this._buildStormHUD();
    this._buildPickupPrompt();
    this._buildKillFeed();
    this._buildDamageOverlay();
    this._buildSniperScope();
    this._buildEnemiesRemaining();
    this._buildPickupMessage();

    this._staticMap      = this._prerenderStaticMap();
    this._mmTimer        = 0;
    this._lowHealthPulse = 0;
  }

  // ── Inventory bar (5 slots) ──────────────────────────────────────────────
  _buildInventoryBar() {
    const bar = document.createElement('div');
    bar.id = 'inv-bar';
    document.getElementById('hud').appendChild(bar);

    this._invSlots = [];
    for (let i = 0; i < 5; i++) {
      const slot = document.createElement('div');
      slot.className = 'inv-slot';
      slot.innerHTML = `
        <div class="inv-num">${i + 1}</div>
        <div class="inv-icon"></div>
        <div class="inv-name">Empty</div>
        <div class="inv-ammo"></div>
      `;
      bar.appendChild(slot);
      this._invSlots.push(slot);
    }
  }

  _updateInventory() {
    const slots  = this.inventory.slots;
    const active = this.inventory.activeSlot;

    for (let i = 0; i < 5; i++) {
      const el   = this._invSlots[i];
      const item = slots[i];
      const icon = el.querySelector('.inv-icon');
      const name = el.querySelector('.inv-name');
      const ammo = el.querySelector('.inv-ammo');

      el.classList.toggle('active', i === active);

      if (!item) {
        icon.style.background = 'none';
        name.textContent = 'Empty';
        ammo.textContent = '';
        el.style.borderColor = '';
      } else {
        const c = '#' + item.def.rarityColor.toString(16).padStart(6, '0');
        icon.style.background = c;
        name.textContent = item.def.name;
        ammo.textContent = item.reloading
          ? 'Reloading...'
          : `${item.ammo} / ${item.reserve}`;
        el.style.borderColor = i === active ? '#fff' : c + '88';
      }
    }

    const activeItem = this.inventory.getActive();
    document.getElementById('ammo-current').textContent = activeItem
      ? (activeItem.reloading ? 'RLD' : activeItem.ammo)
      : '--';
    document.getElementById('ammo-reserve').textContent = activeItem
      ? activeItem.reserve
      : '--';
  }

  // ── Storm HUD ────────────────────────────────────────────────────────────
  _buildStormHUD() {
    const el = document.createElement('div');
    el.id = 'storm-hud';
    el.innerHTML = `
      <div id="storm-phase">STORM PHASE 1</div>
      <div id="storm-state">Moving in <span id="storm-timer">--</span>s</div>
    `;
    document.getElementById('hud').appendChild(el);

    this._stormPhaseEl = document.getElementById('storm-phase');
    this._stormStateEl = document.getElementById('storm-state');

    this._stormWarn = document.createElement('div');
    this._stormWarn.id = 'storm-warn';
    this._stormWarn.innerHTML = `⚠ OUTSIDE STORM &nbsp;–&nbsp; <span id="storm-dmg">0</span> dmg/s`;
    this._stormWarn.style.display = 'none';
    document.getElementById('hud').appendChild(this._stormWarn);
    this._stormDmgEl = document.getElementById('storm-dmg');
  }

  _updateStorm() {
    const info = this.storm.getInfo();
    this._stormPhaseEl.textContent = `STORM PHASE ${info.phase}`;

    if (info.state === 'waiting') {
      this._stormStateEl.innerHTML = `Moving in <span id="storm-timer">${info.timeLeft}</span>s`;
    } else if (info.state === 'shrinking') {
      this._stormStateEl.innerHTML = `<span style="color:#ff6622">STORM CLOSING – ${info.timeLeft}s</span>`;
    } else {
      this._stormStateEl.innerHTML = `<span style="color:#ff2222">FINAL ZONE</span>`;
    }

    if (info.playerOutside) {
      this._stormWarn.style.display = 'flex';
      this._stormDmgEl.textContent = info.dmgPerSec.toFixed(1);
    } else {
      this._stormWarn.style.display = 'none';
    }
  }

  // ── Pickup prompt ─────────────────────────────────────────────────────────
  _buildPickupPrompt() {
    this._pickupPrompt = document.createElement('div');
    this._pickupPrompt.id = 'pickup-prompt';
    this._pickupPrompt.style.display = 'none';
    document.getElementById('hud').appendChild(this._pickupPrompt);
  }

  _updatePickupPrompt() {
    // Weapon pickup takes priority
    if (this._weaponSystem) {
      const wp = this._weaponSystem.getNearbyPickup();
      if (wp) {
        const c = '#' + wp.def.rarityColor.toString(16).padStart(6, '0');
        this._pickupPrompt.style.display = 'block';
        this._pickupPrompt.innerHTML =
          `<span style="color:${c}">■</span> Press <b>E</b> to pick up <b>${wp.def.name}</b> <span class="rarity-tag" style="color:${c}">[${wp.def.rarity}]</span>`;
        return;
      }
    }

    // Health / shield pickup
    if (this._pickupManager) {
      const hp = this._pickupManager.getNearbyPickup();
      if (hp) {
        const c = '#' + hp.def.color.toString(16).padStart(6, '0');
        this._pickupPrompt.style.display = 'block';
        this._pickupPrompt.innerHTML =
          `<span style="color:${c}">+</span> Press <b>E</b> to use <b>${hp.def.label}</b>`;
        return;
      }
    }

    this._pickupPrompt.style.display = 'none';
  }

  // ── Sniper scope overlay ──────────────────────────────────────────────────
  _buildSniperScope() {
    this._scopeEl = document.createElement('div');
    this._scopeEl.id = 'sniper-scope';

    const lens  = document.createElement('div'); lens.className  = 'scope-lens';
    const hLine = document.createElement('div'); hLine.className = 'scope-h';
    const vLine = document.createElement('div'); vLine.className = 'scope-v';
    const dot   = document.createElement('div'); dot.className   = 'scope-dot';

    this._scopeEl.append(lens, hLine, vLine, dot);
    document.body.appendChild(this._scopeEl);
  }

  // ── Enemies remaining counter ─────────────────────────────────────────────
  _buildEnemiesRemaining() {
    this._erEl = document.createElement('div');
    this._erEl.id = 'enemies-remaining';
    this._erEl.innerHTML = `
      <div class="er-label">ENEMIES</div>
      <div class="er-count" id="er-count">-- / --</div>
    `;
    document.getElementById('hud').appendChild(this._erEl);
  }

  // ── Pickup toast message ──────────────────────────────────────────────────
  _buildPickupMessage() {
    this._pickupMsgEl = document.createElement('div');
    this._pickupMsgEl.id = 'pickup-message';
    document.getElementById('hud').appendChild(this._pickupMsgEl);
  }

  // ── Kill feed ─────────────────────────────────────────────────────────────
  _buildKillFeed() {
    this._killFeed = document.createElement('div');
    this._killFeed.id = 'kill-feed';
    document.getElementById('hud').appendChild(this._killFeed);
    this._kills = 0;
  }

  addKill(name = 'Enemy') {
    this._kills++;
    const entry = document.createElement('div');
    entry.className = 'kf-entry';
    entry.textContent = `✕ ${name} eliminated`;
    this._killFeed.prepend(entry);
    setTimeout(() => entry.remove(), 4000);
  }

  // ── Damage overlay (red flash) ────────────────────────────────────────────
  _buildDamageOverlay() {
    this._dmgOverlay = document.createElement('div');
    this._dmgOverlay.style.cssText = `
      position:fixed;inset:0;pointer-events:none;z-index:9;opacity:0;
      background:radial-gradient(ellipse at center,transparent 22%,rgba(220,0,0,0.6) 100%);
      transition:opacity 0.08s;
    `;
    document.body.appendChild(this._dmgOverlay);
  }

  flashDamage() {
    this._dmgOverlay.style.opacity = '1';
    clearTimeout(this._dmgFadeT);
    this._dmgFadeT = setTimeout(() => { this._dmgOverlay.style.opacity = '0'; }, 140);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  setWeaponSystem(ws)  { this._weaponSystem  = ws; }
  setPickupManager(pm) { this._pickupManager = pm; }

  setEnemiesRemaining(count, total) {
    const el = document.getElementById('er-count');
    if (el) el.textContent = `${count} / ${total}`;
  }

  showPickupMessage(label, color) {
    const hex = '#' + (color & 0xffffff).toString(16).padStart(6, '0');
    const el  = this._pickupMsgEl;
    el.style.color        = hex;
    el.style.borderColor  = hex + '66';
    el.textContent = `+ ${label}`;
    el.style.display = 'block';
    // Restart CSS animation
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(this._pickupMsgT);
    this._pickupMsgT = setTimeout(() => { el.style.display = 'none'; }, 2000);
  }

  setADS(active, sniper = false) {
    this._adsActive = active;
    const ch = document.getElementById('crosshair');
    // Hide crosshair only for sniper — it has its own scope reticle.
    // Regular ADS keeps the crosshair visible (just tighter via _updateCrosshair).
    if (ch) ch.style.opacity = (active && sniper) ? '0' : '1';
    if (this._scopeEl) this._scopeEl.classList.toggle('active', active && sniper);
  }

  // ── Static minimap ────────────────────────────────────────────────────────
  _prerenderStaticMap() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 150;
    const ctx = canvas.getContext('2d');
    const S   = this.world.size;
    const sc  = this._mapScale;
    const R   = this.world.resolution;
    const hm  = this.world.heightmap;

    ctx.fillStyle = '#1a5276';
    ctx.fillRect(0, 0, 150, 150);

    const step = Math.max(1, Math.floor(R / 55));
    for (let i = 0; i < R; i += step) {
      for (let j = 0; j < R; j += step) {
        const h  = hm[i * R + j];
        if (h <= this.world.waterLevel) continue;
        const wx = (j / R - 0.5) * S;
        const wz = (i / R - 0.5) * S;
        const mx = wx * sc + 75;
        const mz = wz * sc + 75;
        const t  = Math.min(1, Math.max(0, h / 30));
        const g  = Math.floor(55 + t * 110);
        ctx.fillStyle = `rgb(15,${g},15)`;
        ctx.fillRect(mx, mz, step * sc + 1, step * sc + 1);
      }
    }

    ctx.fillStyle = '#9e8060';
    for (const s of this.world.structures) {
      ctx.fillRect(s.position.x * sc + 75 - 2, s.position.z * sc + 75 - 2, 5, 5);
    }
    return canvas;
  }

  // ── Main update ───────────────────────────────────────────────────────────
  update(dt) {
    this._updateStats();
    this._updateInventory();
    this._updateStorm();
    this._updatePickupPrompt();
    this._updateCrosshair();

    this._mmTimer += dt;
    if (this._mmTimer >= 0.1) {
      this._mmTimer = 0;
      this._drawMinimap();
    }
  }

  _updateStats() {
    const p    = this.player;
    const hPct = (p.health / p.maxHealth) * 100;
    const sPct = (p.shield / p.maxShield) * 100;

    this._healthBar.style.width = hPct + '%';
    this._healthVal.textContent = Math.ceil(p.health);
    this._shieldBar.style.width = sPct + '%';
    this._shieldVal.textContent = Math.ceil(p.shield);

    if (hPct > 50)      this._healthBar.style.background = 'linear-gradient(90deg,#22c55e,#86efac)';
    else if (hPct > 25) this._healthBar.style.background = 'linear-gradient(90deg,#f59e0b,#fcd34d)';
    else                this._healthBar.style.background = 'linear-gradient(90deg,#ef4444,#fca5a5)';

    if (hPct < 30) {
      this._lowHealthPulse += 0.06;
      const v = (Math.sin(this._lowHealthPulse) + 1) / 2;
      this._dmgOverlay.style.background =
        `radial-gradient(ellipse at center,transparent 22%,rgba(200,0,0,${(0.25 + v * 0.22).toFixed(2)}) 100%)`;
      if (!this._dmgFadeT) this._dmgOverlay.style.opacity = '1';
    } else {
      this._lowHealthPulse = 0;
    }
  }

  _updateCrosshair() {
    const p      = this.player;
    const moving = Math.abs(p.velocity.x) > 0.5 || Math.abs(p.velocity.z) > 0.5;
    let gap = 6;
    if (this._adsActive)    gap = 3;   // tightest when aiming
    else if (!p.grounded)   gap = 22;
    else if (p._isSprinting) gap = 18;
    else if (moving)        gap = 12;
    const ch = document.getElementById('crosshair');
    if (ch) ch.style.setProperty('--gap', gap + 'px');
  }

  _drawMinimap() {
    const ctx = this._mmCtx;
    ctx.drawImage(this._staticMap, 0, 0);

    ctx.save();
    ctx.beginPath();
    ctx.arc(75, 75, 74, 0, Math.PI * 2);
    ctx.clip();

    const sc = this._mapScale;

    // Storm safe-zone circle
    if (this.storm) {
      const info = this.storm.getInfo();
      const sr   = info.radius * sc;
      const cx   = info.center.x * sc + 75;
      const cz   = info.center.z * sc + 75;
      ctx.strokeStyle = 'rgba(100,80,255,0.9)';
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.arc(cx, cz, sr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(80,40,220,0.06)';
      ctx.fill();
    }

    // Enemy dots
    if (this.enemyManager) {
      ctx.fillStyle = '#ef4444';
      for (const e of this.enemyManager.enemies) {
        if (e.dead || !e.root) continue;
        const mx = e.root.position.x * sc + 75;
        const mz = e.root.position.z * sc + 75;
        ctx.beginPath();
        ctx.arc(mx, mz, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Weapon pickup dots
    if (this._weaponSystem) {
      for (const p of this._weaponSystem.pickups) {
        if (p.collected) continue;
        const c = '#' + p.def.rarityColor.toString(16).padStart(6, '0');
        ctx.fillStyle = c;
        ctx.fillRect(p.root.position.x * sc + 75 - 1.5, p.root.position.z * sc + 75 - 1.5, 3, 3);
      }
    }

    // Health / shield pickup dots
    if (this._pickupManager) {
      for (const p of this._pickupManager.pickups) {
        if (p.collected) continue;
        ctx.fillStyle = p.def.healHp > 0 ? '#22ee66' : '#44aaff';
        ctx.beginPath();
        ctx.arc(p.root.position.x * sc + 75, p.root.position.z * sc + 75, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Player dot + direction arrow
    const pp = this.player.getPosition();
    const mx = pp.x * sc + 75;
    const mz = pp.z * sc + 75;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(mx, mz, 4, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(mx, mz);
    ctx.rotate(-this.player.getYaw());
    ctx.fillStyle = '#00eeff';
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(-4, 0); ctx.lineTo(4, 0); ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.restore();

    // Border ring
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.arc(75, 75, 74, 0, Math.PI * 2); ctx.stroke();
  }
}
