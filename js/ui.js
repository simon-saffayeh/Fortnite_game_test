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
    this._mmViewRange = 90; // world-units visible each side of player on minimap

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
    this._buildHealBar();
    this._buildStreakBanner();
    this._buildCompass();

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
      } else if (item.isConsumable) {
        const c = '#' + item.def.color.toString(16).padStart(6, '0');
        icon.style.background = c;
        name.textContent = item.def.label;
        ammo.textContent = `x${item.count}`;
        el.style.borderColor = i === active ? '#fff' : c + '88';
      } else {
        const c = '#' + item.def.rarityColor.toString(16).padStart(6, '0');
        icon.style.background = c;
        name.textContent = item.def.name;
        ammo.textContent = item.reloading
          ? 'Reloading...'
          : `${item.ammo} / ${item.displayReserve}`;
        el.style.borderColor = i === active ? '#fff' : c + '88';
      }
    }

    const activeItem = this.inventory.getActive();
    if (!activeItem) {
      document.getElementById('ammo-current').textContent = '--';
      document.getElementById('ammo-reserve').textContent = '--';
    } else if (activeItem.isConsumable) {
      document.getElementById('ammo-current').textContent = 'F';
      document.getElementById('ammo-reserve').textContent = `x${activeItem.count}`;
    } else {
      document.getElementById('ammo-current').textContent = activeItem.reloading ? 'RLD' : activeItem.ammo;
      document.getElementById('ammo-reserve').textContent = activeItem.displayReserve;
    }
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
    if (!this.storm) {
      if (this._stormPhaseEl) this._stormPhaseEl.textContent = '';
      if (this._stormStateEl) this._stormStateEl.textContent = '';
      if (this._stormWarn) this._stormWarn.style.display = 'none';
      return;
    }
    const info = this.storm.getInfo();

    if (info.state === 'pending') {
      this._stormPhaseEl.textContent = 'STORM INCOMING';
      this._stormStateEl.innerHTML = `Activates in <span id="storm-timer">${info.timeLeft}</span>s`;
      this._stormWarn.style.display = 'none';
      return;
    }

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
          `<span style="color:${c}">+</span> Press <b>E</b> to pick up <b>${hp.def.label}</b> <span style="opacity:0.7">(LMB to use)</span>`;
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

  // ── Heal channel bar ─────────────────────────────────────────────────────
  _buildHealBar() {
    this._healBarEl = document.createElement('div');
    this._healBarEl.id = 'heal-bar-container';
    this._healBarEl.style.display = 'none';
    this._healBarEl.innerHTML = `
      <div id="heal-bar-label">Using item…</div>
      <div id="heal-bar-track"><div id="heal-bar-fill"></div></div>
      <div id="heal-bar-hint">Stand still!</div>
    `;
    document.getElementById('hud').appendChild(this._healBarEl);
    this._healBarFill = document.getElementById('heal-bar-fill');
  }

  /** progress: 0-1 while channeling, 1.0 on complete, -1 to hide */
  setHealProgress(progress, label) {
    if (progress < 0) {
      this._healBarEl.style.display = 'none';
      return;
    }
    this._healBarEl.style.display = 'flex';
    document.getElementById('heal-bar-label').textContent = label;
    this._healBarFill.style.width = `${Math.round(progress * 100)}%`;
    const hint = document.getElementById('heal-bar-hint');
    hint.textContent = progress >= 1 ? 'Done!' : 'Stand still!';
  }

  // ── Compass bar ──────────────────────────────────────────────────────────
  // Top-center strip showing player heading with markers for storm centre,
  // supply drops, and teammates. The 360° label/tick strip is prerendered
  // once into a backing canvas; each frame we blit the slice that matches
  // the current yaw, then overlay live markers on top.
  _buildCompass() {
    // Visible canvas (what the player sees in the HUD).
    this._cWidth   = 360;          // canvas width in px
    this._cHeight  = 34;           // canvas height in px
    this._cFovDeg  = 90;           // degrees visible across the strip
    this._cPxPerDeg = this._cWidth / this._cFovDeg;

    this._compass = document.createElement('canvas');
    this._compass.id = 'compass-bar';
    this._compass.width  = this._cWidth;
    this._compass.height = this._cHeight;
    document.getElementById('hud').appendChild(this._compass);
    this._compassCtx = this._compass.getContext('2d');

    this._prerenderCompassStrip();
  }

  _prerenderCompassStrip() {
    // Strip covers 360° plus enough overlap on each side that the visible
    // window can sit anywhere without seeing the seam.
    const pxPerDeg = this._cPxPerDeg;
    const stripDeg = 360 + this._cFovDeg;
    const w = Math.ceil(stripDeg * pxPerDeg);
    const h = this._cHeight;

    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');

    ctx.font = 'bold 13px "Segoe UI", Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Ticks every 5°; medium every 15°; long with label every 45°.
    // Drawn linearly from -FOV/2 to 360+FOV/2 so the wrap zone always has
    // valid marks regardless of where the visible window lands.
    for (let d = -this._cFovDeg / 2; d <= 360 + this._cFovDeg / 2; d += 5) {
      const x = (d + this._cFovDeg / 2) * pxPerDeg;
      const isLong  = d % 45 === 0;
      const isMed   = d % 15 === 0;
      const tickH   = isLong ? 12 : isMed ? 8 : 5;
      ctx.strokeStyle = isLong ? '#ffffff' : isMed ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.3)';
      ctx.lineWidth = isLong ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 4);
      ctx.lineTo(x, 4 + tickH);
      ctx.stroke();
    }

    // Cardinal + ordinal labels.
    const labels = [
      { d:   0, t: 'N', c: '#ff6262' },  // North highlighted red so it's distinct
      { d:  45, t: 'NE', c: '#ffffff' },
      { d:  90, t: 'E', c: '#ffffff' },
      { d: 135, t: 'SE', c: '#ffffff' },
      { d: 180, t: 'S', c: '#ffffff' },
      { d: 225, t: 'SW', c: '#ffffff' },
      { d: 270, t: 'W', c: '#ffffff' },
      { d: 315, t: 'NW', c: '#ffffff' },
    ];
    // Draw each label twice (at d and d+360) so the wrap zone always has it.
    const drawAt = (deg, t, c) => {
      const x = (deg + this._cFovDeg / 2) * pxPerDeg;
      ctx.fillStyle = c;
      ctx.fillText(t, x, h - 11);
    };
    for (const l of labels) {
      drawAt(l.d, l.t, l.c);
      if (l.d < this._cFovDeg / 2) drawAt(l.d + 360, l.t, l.c);
      if (l.d > 360 - this._cFovDeg / 2) drawAt(l.d - 360, l.t, l.c);
    }

    this._compassStrip = cv;
    // Total degrees represented in the strip's x axis = stripDeg (with the
    // -FOV/2 offset baked in via xAt above).
    this._compassStripPxPerDeg = pxPerDeg;
  }

  /**
   * Player heading: 0° = facing north (-Z), 90° = east (+X), 180° = south,
   * 270° = west. Convert from Three.js yaw where yaw=0 faces -Z.
   */
  _playerHeadingDeg() {
    // yaw=0 → -Z (north → 0°); yaw=π/2 → -X (west → 270°).
    // So heading_deg = (-yaw * 180/π) mod 360.
    const yawDeg = -this.player.getYaw() * 180 / Math.PI;
    return ((yawDeg % 360) + 360) % 360;
  }

  /** Bearing to a world-space (x,z) from the player, in degrees 0..360. */
  _bearingTo(x, z) {
    const pp = this.player.getPosition();
    const dx = x - pp.x;
    const dz = z - pp.z;
    // atan2(dx, -dz) so +X=east=90°, -Z=north=0°.
    const rad = Math.atan2(dx, -dz);
    return ((rad * 180 / Math.PI) % 360 + 360) % 360;
  }

  _drawCompass() {
    if (!this._compass || !this._compassStrip) return;
    const ctx = this._compassCtx;
    const W = this._cWidth, H = this._cHeight;

    ctx.clearRect(0, 0, W, H);

    // Translucent background pad so the strip reads against bright skies.
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(0, 0, W, H);

    // Blit the strip slice centered on the current heading. The strip's
    // origin already includes the -FOV/2 offset, so we just shift by
    // heading*pxPerDeg.
    const heading = this._playerHeadingDeg();
    const srcX    = heading * this._compassStripPxPerDeg;
    ctx.drawImage(this._compassStrip, srcX, 0, W, H, 0, 0, W, H);

    // Centre indicator: small downward chevron at the top edge.
    ctx.fillStyle = '#ffd95a';
    ctx.beginPath();
    ctx.moveTo(W / 2 - 6, 0);
    ctx.lineTo(W / 2 + 6, 0);
    ctx.lineTo(W / 2,     8);
    ctx.closePath();
    ctx.fill();

    // ── Live markers ─────────────────────────────────────────────────────
    // For each marker, compute relative bearing (marker - heading), shift
    // into ±180, then drop only if outside the visible FOV.
    const halfFov = this._cFovDeg / 2;
    const drawPip = (relDeg, color, shape = 'circle') => {
      // Wrap into -180..180
      let r = ((relDeg + 540) % 360) - 180;
      if (Math.abs(r) > halfFov) return;
      const x = W / 2 + r * this._cPxPerDeg;
      const y = H - 6;
      ctx.fillStyle = color;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (shape === 'square') {
        ctx.rect(x - 3.5, y - 3.5, 7, 7);
      } else if (shape === 'diamond') {
        ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y);
        ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y); ctx.closePath();
      } else {
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
    };

    // Storm centre (purple). Skip while the storm is still in the pre-bus
    // pending state where the centre is meaningless to the player.
    if (this.storm) {
      const info = this.storm.getInfo();
      if (info.state !== 'pending' && info.center) {
        const bearing = this._bearingTo(info.center.x, info.center.z);
        drawPip(bearing - this._playerHeadingDeg(), '#a276ff');
      }
    }

    // Supply drops (gold square).
    if (this._supplyDrops) {
      for (const d of this._supplyDrops.getDrops()) {
        const bearing = this._bearingTo(d.x, d.z);
        drawPip(bearing - this._playerHeadingDeg(), '#ffaa00', 'square');
      }
    }

    // Teammates (green diamond) in multiplayer.
    if (this._net) {
      for (const [, rp] of this._net.remotePlayers) {
        if (!rp.isTeammate || rp.dead) continue;
        const bearing = this._bearingTo(rp.root.position.x, rp.root.position.z);
        drawPip(bearing - this._playerHeadingDeg(), '#4ade80', 'diamond');
      }
    }
  }

  // ── Kill feed ─────────────────────────────────────────────────────────────
  _buildKillFeed() {
    this._killFeed = document.createElement('div');
    this._killFeed.id = 'kill-feed';
    document.getElementById('hud').appendChild(this._killFeed);
    this._kills = 0;
    // Sliding-window kill timestamps for multi-kill detection.
    this._streakTimes = [];
    // STREAK_WINDOW: chain kills landing within this many seconds count
    // toward the same multi-kill. 2.5s feels punchy without rewarding
    // unrelated kills that just happen to land close together.
    this._streakWindow = 2.5;
  }

  /**
   * Record a kill for the local player.
   * @param {string} name        victim label shown in the feed
   * @param {Object} [opts]
   * @param {boolean} [opts.headshot]  flags the kill-feed entry visually
   */
  addKill(name = 'Enemy', opts = {}) {
    const { headshot = false } = opts;
    this._kills++;
    const entry = document.createElement('div');
    entry.className = 'kf-entry' + (headshot ? ' kf-headshot' : '');
    entry.textContent = headshot
      ? `✕ HEADSHOT — ${name}`
      : `✕ ${name} eliminated`;
    this._killFeed.prepend(entry);
    setTimeout(() => entry.remove(), 4000);

    // First-blood banner: only the first kill of the match. Multi-kill
    // banners cascade from later kills via the sliding window below.
    if (this._kills === 1) {
      this.showStreakBanner('FIRST BLOOD', 1);
    }

    // Multi-kill: keep only timestamps within the streak window, then
    // announce on 2+ kills in that window.
    const now = performance.now() / 1000;
    this._streakTimes = this._streakTimes.filter(t => now - t < this._streakWindow);
    this._streakTimes.push(now);
    const chain = this._streakTimes.length;
    if (chain >= 2) {
      const labels = {
        2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'QUAD KILL',
      };
      const label = labels[chain] ?? `MEGA KILL ×${chain}`;
      this.showStreakBanner(label, chain);
    }
  }

  // ── Streak banner (multi-kill announcement) ──────────────────────────────
  _buildStreakBanner() {
    this._streakBanner = document.createElement('div');
    this._streakBanner.id = 'streak-banner';
    this._streakBanner.style.opacity = '0';
    document.getElementById('hud').appendChild(this._streakBanner);
  }

  /**
   * @param {string} text
   * @param {number} tier  1 = first-blood / single, 2+ = multi-kill count.
   *                       Drives color so higher chains get hotter.
   */
  showStreakBanner(text, tier = 1) {
    const el = this._streakBanner;
    if (!el) return;
    // Color ramp: gold → orange → red as the chain climbs. Capped at red
    // so 5+ kills stay readable instead of becoming pure white-hot.
    const colors = ['#ffd95a', '#ffb347', '#ff7733', '#ff3322'];
    el.style.color = colors[Math.min(tier - 1, colors.length - 1)];
    el.textContent = text;
    // Restart the CSS animation by toggling the class off and on
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    el.style.opacity = '1';
    clearTimeout(this._streakBannerTimer);
    this._streakBannerTimer = setTimeout(() => {
      el.style.opacity = '0';
    }, 1600);
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
  // Used to swap the minimap enemy source between solo (EnemyManager) and
  // zombie mode (ZombieWaveManager). Both expose `.enemies[]`.
  setEnemyManager(em)  { this.enemyManager   = em; }
  // Multiplayer: needed so the minimap can render remote players with
  // teammate coloring. Solo / zombie modes leave this null.
  setNetwork(net)      { this._net           = net; }
  // Compass markers — gold pip for each active drop on the compass strip.
  setSupplyDrops(sd)   { this._supplyDrops   = sd; }

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

  // ── Static minimap (full-res heightmap, 256×256) ─────────────────────────
  _prerenderStaticMap() {
    const R  = this.world.resolution; // 256
    const S  = this.world.size;
    const hm = this.world.heightmap;
    const wl = this.world.waterLevel;

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = R;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(R, R);
    const d   = img.data;

    for (let iz = 0; iz < R; iz++) {
      for (let ix = 0; ix < R; ix++) {
        const h = hm[iz * R + ix];
        let r, g, b;
        if (h <= wl)  { r = 28;  g = 72;  b = 145; }
        else if (h < 2)  { r = 205; g = 172; b = 110; }
        else if (h < 14) { r = 62;  g = 118; b = 44;  }
        else if (h < 26) { r = 85;  g = 78;  b = 65;  }
        else             { r = 210; g = 214; b = 228; }
        // Subtle hillshade
        const nh = ix + 1 < R ? hm[iz * R + ix + 1] : h;
        const sh = Math.max(-22, Math.min(22, (h - nh) * 3));
        const idx = (iz * R + ix) * 4;
        d[idx]   = Math.max(0, Math.min(255, r + sh));
        d[idx+1] = Math.max(0, Math.min(255, g + sh * 0.8));
        d[idx+2] = Math.max(0, Math.min(255, b + sh * 0.5));
        d[idx+3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);


    return canvas;
  }

  // ── Main update ───────────────────────────────────────────────────────────
  update(dt) {
    this._updateStats();
    this._updateInventory();
    this._updateStorm();
    this._updatePickupPrompt();
    this._updateCrosshair();
    this._drawCompass();

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
    const p = this.player;
    const weapon = this.inventory.getActive();
    const baseSpread = weapon?.def?.spread ?? 0.024;
    const adsMultiplier = this._adsActive ? 0.4 : 1.0;
    const spread = baseSpread * adsMultiplier;

    // Scale: spread is in camera-space units; multiply by ~250 to get a pixel gap
    // that visually matches where shots actually land at normal engagement ranges.
    let gap = Math.round(spread * 250);

    // Movement / air penalties mirror the gameplay spread multipliers
    if (!this._adsActive) {
      if (p.airTime > 0.15)  gap = Math.round(gap * 2.8);
      else if (p._isSprinting) gap = Math.round(gap * 2.2);
      else if (p.isMovingInput) gap = Math.round(gap * 1.6);
    }

    gap = Math.max(2, Math.min(gap, 80));
    const ch = document.getElementById('crosshair');
    if (ch) ch.style.setProperty('--gap', gap + 'px');
  }

  _drawMinimap() {
    const ctx  = this._mmCtx;
    const SIZE = 150;                      // minimap canvas px
    const VR   = this._mmViewRange;        // world units visible each side
    const S    = this.world.size;
    const R    = this._staticMap.width;    // static map resolution (256)

    const pp  = this.player.getPosition();
    // static-map scale: R px = S world units
    const smSc = R / S;
    // minimap scale: SIZE/2 px = VR world units
    const mmSc = (SIZE / 2) / VR;

    // Source rect on static map centred on player
    const halfPx = VR * smSc;             // half source-rect size in static-map px
    const srcX = pp.x * smSc + R / 2 - halfPx;
    const srcZ = pp.z * smSc + R / 2 - halfPx;

    // Draw terrain: crop & scale static map around player
    ctx.drawImage(this._staticMap,
      srcX, srcZ, halfPx * 2, halfPx * 2,
      0, 0, SIZE, SIZE);

    ctx.save();
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
    ctx.clip();

    // Convert world pos to minimap px (player-relative, always centred)
    const toMM = (wx, wz) => ({
      x: (wx - pp.x) * mmSc + SIZE / 2,
      y: (wz - pp.z) * mmSc + SIZE / 2,
    });

    // Storm circle (hidden during the pre-bus grace period)
    if (this.storm) {
      const info = this.storm.getInfo();
      if (info.state !== 'pending') {
        const sr = info.radius * mmSc;
        const c  = toMM(info.center.x, info.center.z);
        ctx.strokeStyle = 'rgba(100,80,255,0.9)';
        ctx.lineWidth   = 2;
        ctx.beginPath(); ctx.arc(c.x, c.y, sr, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(80,40,220,0.06)'; ctx.fill();
      }
    }


    // POI labels (smaller font for minimap)
    if (this.world.pois) {
      ctx.font = 'bold 10px "Segoe UI", Arial';
      ctx.textAlign = 'center';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      for (const poi of this.world.pois) {
        const m = toMM(poi.x, poi.z);
        const dx = m.x - SIZE / 2, dy = m.y - SIZE / 2;
        if (dx * dx + dy * dy > (SIZE / 2) * (SIZE / 2)) continue;
        ctx.strokeText(poi.name, m.x, m.y);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(poi.name, m.x, m.y);
      }
    }

    // Enemy dots
    if (this.enemyManager) {
      ctx.fillStyle = '#ef4444';
      for (const e of this.enemyManager.enemies) {
        if (e.dead || !e.root) continue;
        const m = toMM(e.root.position.x, e.root.position.z);
        ctx.beginPath(); ctx.arc(m.x, m.y, 3, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Remote player dots (multiplayer). Teammates render green; everyone
    // else orange so the player can read the situation at a glance.
    if (this._net) {
      for (const [, rp] of this._net.remotePlayers) {
        if (rp.dead) continue;
        const m = toMM(rp.root.position.x, rp.root.position.z);
        ctx.fillStyle = rp.isTeammate ? '#4ade80' : '#ff8800';
        ctx.beginPath(); ctx.arc(m.x, m.y, 3, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Weapon pickup dots
    if (this._weaponSystem) {
      for (const p of this._weaponSystem.pickups) {
        if (p.collected) continue;
        const m = toMM(p.root.position.x, p.root.position.z);
        ctx.fillStyle = '#' + p.def.rarityColor.toString(16).padStart(6, '0');
        ctx.fillRect(m.x - 1.5, m.y - 1.5, 3, 3);
      }
    }

    // Health / shield pickup dots
    if (this._pickupManager) {
      for (const p of this._pickupManager.pickups) {
        if (p.collected) continue;
        const m = toMM(p.root.position.x, p.root.position.z);
        ctx.fillStyle = p.def.healHp > 0 ? '#22ee66' : '#44aaff';
        ctx.beginPath(); ctx.arc(m.x, m.y, 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Player arrow (always centred)
    ctx.save();
    ctx.translate(SIZE / 2, SIZE / 2);
    ctx.rotate(-this.player.getYaw());
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#00eeff';
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(-4, 0); ctx.lineTo(4, 0); ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.restore();

    // Border ring
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2); ctx.stroke();
  }
}
