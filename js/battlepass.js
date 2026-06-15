// ── Battle Pass — progression, cosmetics, persistence + overlay UI ──────────
// Self-contained. Players earn XP from playing (kills / wins / matches),
// climb tiers, and unlock cosmetic-only rewards. No account required: progress
// is persisted to localStorage so anonymous players keep it across sessions
// (the "Cool Math Games" persistence model). Modeled on the GraphicsSettings
// singleton in graphics.js (singleton + _listeners + localStorage write-through).
//
// ACCOUNT-READY SEAM: all progress is keyed by a local `profileId`. A future
// cloud store (e.g. Firebase keyed by a Google uid) can replace LocalStore
// behind the same load()/save() contract to enable cross-device sync WITHOUT
// touching any battle-pass logic. server.js is intentionally untouched.

const STORAGE_KEY = 'bi_battlepass';
const PROFILE_KEY = 'bi_profile_id';
const SCHEMA_V    = 1;

const XP_PER_TIER = 1000;
const MAX_TIER    = 40;
const SEASON_ID   = 's1';
const SEASON_NAME = 'Season 1 — Island Outlaws';

// XP rewards for play events.
const XP = { KILL: 50, HEADSHOT_BONUS: 25, MATCH_PLAYED: 100, WIN_BONUS: 500 };

// C-Bucks — soft currency. EARNED by playing (a chunk each time a battle-pass
// tier is claimed). Spent to fast-track battle-pass tiers and to buy
// shop-exclusive cosmetics. No real-money purchases.
const TIER_SKIP_COST  = 150;         // C-Bucks to instantly advance one tier

// ── Cosmetic catalog ────────────────────────────────────────────────────────
// slot 'color'  → name text color (CSS color, or 'animated' flag for rainbow)
// slot 'title'  → text tag shown before the name
// slot 'badge'  → glyph shown before the name
// 'white' is the default name color and is always owned (not a tier reward).
const COSMETICS = {
  // colors
  white:         { slot: 'color', name: 'Default',   value: '#ffffff', rarity: 'common'    },
  color_green:   { slot: 'color', name: 'Toxic',     value: '#46e07a', rarity: 'uncommon'  },
  color_cyan:    { slot: 'color', name: 'Aqua',      value: '#3ce0d0', rarity: 'uncommon'  },
  color_blue:    { slot: 'color', name: 'Cobalt',    value: '#4aa8ff', rarity: 'rare'      },
  color_lime:    { slot: 'color', name: 'Acid',      value: '#b6ff3c', rarity: 'rare'      },
  color_purple:  { slot: 'color', name: 'Amethyst',  value: '#b96bff', rarity: 'epic'      },
  color_orange:  { slot: 'color', name: 'Ember',     value: '#ff9a3c', rarity: 'rare'      },
  color_gold:    { slot: 'color', name: 'Gold',      value: '#ffce4a', rarity: 'legendary' },
  color_pink:    { slot: 'color', name: 'Bubblegum', value: '#ff7ad1', rarity: 'epic'      },
  color_ice:     { slot: 'color', name: 'Frost',     value: '#cfe8ff', rarity: 'rare'      },
  color_crimson: { slot: 'color', name: 'Crimson',   value: '#ff4a5e', rarity: 'epic'      },
  color_magma:   { slot: 'color', name: 'Magma',     value: 'animated', rarity: 'legendary', anim: 'magma'   },
  color_rainbow: { slot: 'color', name: 'Spectrum',  value: 'animated', rarity: 'legendary', anim: 'rainbow' },

  // titles
  title_rookie:       { slot: 'title', name: 'Rookie',        value: 'Rookie',        rarity: 'common'    },
  title_scavenger:    { slot: 'title', name: 'Scavenger',     value: 'Scavenger',     rarity: 'uncommon'  },
  title_looter:       { slot: 'title', name: 'Looter',        value: 'Looter',        rarity: 'uncommon'  },
  title_sharpshooter: { slot: 'title', name: 'Sharpshooter',  value: 'Sharpshooter',  rarity: 'rare'      },
  title_stormchaser:  { slot: 'title', name: 'Storm Chaser',  value: 'Storm Chaser',  rarity: 'rare'      },
  title_survivor:     { slot: 'title', name: 'Survivor',      value: 'Survivor',      rarity: 'epic'      },
  title_apex:         { slot: 'title', name: 'Apex Predator', value: 'Apex Predator', rarity: 'epic'      },
  title_warlord:      { slot: 'title', name: 'Warlord',       value: 'Warlord',       rarity: 'legendary' },
  title_legend:       { slot: 'title', name: 'Legend',        value: 'Legend',        rarity: 'legendary' },

  // badges
  badge_star:    { slot: 'badge', name: 'Star',    value: '⭐', rarity: 'common'    },
  badge_target:  { slot: 'badge', name: 'Bullseye',value: '🎯', rarity: 'uncommon'  },
  badge_fire:    { slot: 'badge', name: 'Blaze',   value: '🔥', rarity: 'uncommon'  },
  badge_bolt:    { slot: 'badge', name: 'Bolt',    value: '⚡', rarity: 'rare'      },
  badge_skull:   { slot: 'badge', name: 'Skull',   value: '💀', rarity: 'rare'      },
  badge_ghost:   { slot: 'badge', name: 'Phantom', value: '👻', rarity: 'epic'      },
  badge_diamond: { slot: 'badge', name: 'Diamond', value: '💎', rarity: 'epic'      },
  badge_crown:   { slot: 'badge', name: 'Crown',   value: '👑', rarity: 'legendary' },
  badge_trophy:  { slot: 'badge', name: 'Trophy',  value: '🏆', rarity: 'legendary' },

  // skydive trails — equipped effect streams behind you during freefall.
  // `glyph` is shown in the UI; `fx` drives the particle emitter in skydive.js
  // ('mode' lets the emitter special-case rainbow/confetti colour cycling).
  trail_smoke:    { slot: 'trail', name: 'Smoke Trail',    value: '💨', rarity: 'uncommon',  glyph: '💨', fx: { color: 0xdedede,    mode: 'puff'     } },
  trail_flame:    { slot: 'trail', name: 'Inferno Trail',  value: '🔥', rarity: 'rare',      glyph: '🔥', fx: { color: 0xff6622,    mode: 'flame'    } },
  trail_sparkle:  { slot: 'trail', name: 'Stardust Trail', value: '✨', rarity: 'epic',      glyph: '✨', fx: { color: 0xffd95a,    mode: 'sparkle'  } },
  trail_aurora:   { slot: 'trail', name: 'Aurora Trail',   value: '🌈', rarity: 'epic',      glyph: '🌈', fx: { color: 'rainbow',   mode: 'rainbow'  } },
  trail_voltage:  { slot: 'trail', name: 'Voltage Trail',  value: '⚡', rarity: 'legendary', glyph: '⚡', fx: { color: 0x55ccff,    mode: 'volt'     } },
  trail_confetti: { slot: 'trail', name: 'Confetti Trail', value: '🎉', rarity: 'legendary', glyph: '🎉', fx: { color: 'confetti',  mode: 'confetti' } },

  // ── Shop-exclusive cosmetics ── not on the battle-pass track; bought with
  // C-Bucks in the shop. `shopPrice` marks an item as purchasable.
  color_slate:  { slot: 'color', name: 'Slate',    value: '#5b6675', rarity: 'rare',      shopPrice: 300  },
  color_royal:  { slot: 'color', name: 'Royal',    value: '#7c3aed', rarity: 'epic',      shopPrice: 500  },
  color_sunset: { slot: 'color', name: 'Sunset',   value: '#ff5e3a', rarity: 'epic',      shopPrice: 500  },
  title_vip:    { slot: 'title', name: 'VIP',      value: 'VIP',     rarity: 'legendary', shopPrice: 800  },
  title_goat:   { slot: 'title', name: 'G.O.A.T.', value: 'G.O.A.T.',rarity: 'legendary', shopPrice: 1200 },
  badge_money:  { slot: 'badge', name: 'Money',    value: '💵',      rarity: 'epic',      shopPrice: 400  },
  badge_alien:  { slot: 'badge', name: 'Alien',    value: '👽',      rarity: 'epic',      shopPrice: 400  },
};

// Ids of cosmetics sold in the shop (any catalogue entry with a shopPrice).
const SHOP_ITEMS = Object.keys(COSMETICS).filter(id => COSMETICS[id].shopPrice != null);

// ── Season tier track ── 40 tiers. Most grant a cosmetic (id string); a few
// grant C-Bucks ({ cbucks: N }) sprinkled in at milestone tiers (10/20/30/40)
// so the currency is earned through progression, not handed out every tier.
const TIER_REWARDS = [
  'title_rookie',       // 1
  'badge_star',         // 2
  'color_green',        // 3
  'trail_smoke',        // 4  ← skydive trail
  'color_cyan',         // 5
  'title_scavenger',    // 6
  'badge_target',       // 7
  'color_blue',         // 8
  'trail_flame',        // 9  ← skydive trail
  { cbucks: 500 },      // 10 ← C-Bucks reward
  'badge_fire',         // 11
  'color_lime',         // 12
  'title_looter',       // 13
  'badge_bolt',         // 14
  'color_orange',       // 15
  'title_sharpshooter', // 16
  'trail_sparkle',      // 17 ← skydive trail
  'color_ice',          // 18
  'badge_skull',        // 19
  { cbucks: 500 },      // 20 ← C-Bucks reward
  'color_purple',       // 21
  'title_stormchaser',  // 22
  'badge_ghost',        // 23
  'color_pink',         // 24
  'trail_aurora',       // 25 ← skydive trail
  'title_survivor',     // 26
  'badge_diamond',      // 27
  'color_crimson',      // 28
  'title_apex',         // 29
  { cbucks: 500 },      // 30 ← C-Bucks reward
  'color_gold',         // 31
  'trail_voltage',      // 32 ← skydive trail
  'badge_crown',        // 33
  'title_warlord',      // 34
  'color_magma',        // 35
  'badge_trophy',       // 36
  'color_rainbow',      // 37
  'trail_confetti',     // 38 ← skydive trail
  'title_legend',       // 39
  { cbucks: 500 },      // 40 ← C-Bucks reward
];

// Reverse lookup: cosmetic id → tier it unlocks at (C-Bucks tiers are skipped).
const TIER_OF = {};
TIER_REWARDS.forEach((entry, i) => { if (typeof entry === 'string') TIER_OF[entry] = i + 1; });

const RARITY_COLORS = {
  common:    '#b8c0cc',
  uncommon:  '#46e07a',
  rare:      '#4aa8ff',
  epic:      '#b96bff',
  legendary: '#ffce4a',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Persistence: LocalStore (the swappable seam) ────────────────────────────
class LocalStore {
  load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch { return null; }
  }
  save(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* quota / private mode */ }
  }
}

class BattlePassManager {
  constructor(store = new LocalStore()) {
    this._store     = store;
    this._listeners = [];
    this._debugAll  = false;   // Testing Mode: treat every cosmetic as owned
    this._profileId = this._loadProfileId();
    this._state     = this._normalize(this._store.load());
    // Persist back so a fresh profile / migrated schema lands on disk immediately.
    this._save(/* silent */ true);
  }

  _loadProfileId() {
    let id = null;
    try { id = localStorage.getItem(PROFILE_KEY); } catch { /* ignore */ }
    if (!id) {
      id = 'local-' + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem(PROFILE_KEY, id); } catch { /* ignore */ }
    }
    return id;
  }

  // Coerce whatever was on disk into a valid, forward-compatible state object.
  _normalize(raw) {
    const s = (raw && typeof raw === 'object') ? raw : {};
    const eq = (s.equipped && typeof s.equipped === 'object') ? s.equipped : {};
    return {
      v:         SCHEMA_V,
      profileId: this._profileId,
      season:    SEASON_ID,
      xp:        Number.isFinite(s.xp) ? Math.max(0, Math.floor(s.xp)) : 0,
      cbucks:    Number.isFinite(s.cbucks) ? Math.max(0, Math.floor(s.cbucks)) : 0,
      claimed:   Array.isArray(s.claimed)
        ? [...new Set(s.claimed.filter(n => Number.isInteger(n) && n >= 1 && n <= MAX_TIER))]
        : [],
      purchased: Array.isArray(s.purchased)
        ? [...new Set(s.purchased.filter(id => COSMETICS[id]?.shopPrice != null))]
        : [],
      equipped: {
        title: COSMETICS[eq.title]?.slot === 'title' ? eq.title : null,
        color: COSMETICS[eq.color]?.slot === 'color' ? eq.color : 'white',
        badge: COSMETICS[eq.badge]?.slot === 'badge' ? eq.badge : null,
        trail: COSMETICS[eq.trail]?.slot === 'trail' ? eq.trail : null,
      },
    };
  }

  _save(silent = false) {
    this._store.save(this._state);
    if (!silent) for (const fn of this._listeners) { try { fn(this); } catch { /* listener error */ } }
  }

  /** Subscribe to any progress/equip change. */
  onChange(fn) { if (typeof fn === 'function') this._listeners.push(fn); }

  // ── Progression getters ───────────────────────────────────────────────────
  get xp()         { return this._state.xp; }
  get season()     { return SEASON_NAME; }
  get maxTier()    { return MAX_TIER; }
  get level()      { return Math.min(MAX_TIER, Math.floor(this._state.xp / XP_PER_TIER) + 1); }
  get atMaxLevel() { return this.level >= MAX_TIER; }
  get xpIntoLevel(){ return this.atMaxLevel ? XP_PER_TIER : this._state.xp - (this.level - 1) * XP_PER_TIER; }
  get xpForLevel() { return XP_PER_TIER; }
  get progress()   { return this.atMaxLevel ? 1 : Math.min(1, this.xpIntoLevel / XP_PER_TIER); }

  isTierUnlocked(tier) { return this.level >= tier; }
  isClaimed(tier)      { return this._state.claimed.includes(tier); }
  rewardAt(tier)       { return COSMETICS[TIER_REWARDS[tier - 1]] || null; }
  rewardIdAt(tier)     { return TIER_REWARDS[tier - 1] || null; }

  ownsCosmetic(id) {
    if (this._debugAll) return true;             // Testing Mode unlocks everything
    if (id === 'white') return true;             // default color always owned
    if (this._state.purchased.includes(id)) return true;   // bought in the shop
    const tier = TIER_OF[id];
    return tier != null && this.isClaimed(tier);
  }

  /**
   * Testing Mode toggle. When on, every cosmetic counts as owned so the Locker
   * shows the full catalogue. This is a session-only override — it is NOT
   * persisted, so unchecking restores the player's real unlock progress.
   */
  setDebugUnlockAll(on) {
    on = !!on;
    if (on === this._debugAll) return;
    this._debugAll = on;
    if (this._locker && !this._locker.classList.contains('hidden')) this._renderLocker();
    for (const fn of this._listeners) { try { fn(this); } catch { /* listener error */ } }
  }

  // ── XP earning ────────────────────────────────────────────────────────────
  addXP(amount, reason = '') {
    amount = Math.floor(amount);
    if (!amount || amount <= 0) return;
    const before = this.level;
    this._state.xp += amount;
    this._save();
    const after = this.level;
    this._showToast(`+${amount} XP`, reason);
    if (after > before) this._showToast(`LEVEL ${after}`, 'TIER UP', true);
  }

  addKillXP({ headshot = false } = {}) {
    this.addXP(XP.KILL + (headshot ? XP.HEADSHOT_BONUS : 0), headshot ? 'Headshot' : 'Elimination');
  }

  addMatchXP({ win = false } = {}) {
    this.addXP(XP.MATCH_PLAYED + (win ? XP.WIN_BONUS : 0), win ? 'Victory Royale' : 'Match complete');
  }

  // ── C-Bucks currency ────────────────────────────────────────────────────
  get cbucks()       { return this._state.cbucks; }
  get tierSkipCost() { return TIER_SKIP_COST; }

  addCbucks(n) {
    n = Math.floor(n);
    if (n > 0) { this._state.cbucks += n; this._save(); }
  }

  canSkipTier() { return !this.atMaxLevel && this._state.cbucks >= TIER_SKIP_COST; }

  /** Spend C-Bucks to instantly advance one battle-pass tier. */
  skipTier() {
    if (!this.canSkipTier()) return false;
    this._state.cbucks -= TIER_SKIP_COST;
    this.addXP(XP_PER_TIER, 'Tier skip');   // saves + notifies + handles level-up
    return true;
  }

  /** Buy a shop-exclusive cosmetic with C-Bucks. Auto-equips on purchase. */
  buyShopItem(id) {
    const c = COSMETICS[id];
    if (!c || c.shopPrice == null) return false;
    if (this.ownsCosmetic(id)) return false;             // already owned
    if (this._state.cbucks < c.shopPrice) return false;  // can't afford
    this._state.cbucks -= c.shopPrice;
    this._state.purchased.push(id);
    this._state.equipped[c.slot] = id;                   // auto-equip
    this._save();
    this._showToast(c.name, 'Unlocked', true);
    return true;
  }

  // ── Claim / equip ─────────────────────────────────────────────────────────
  claimTier(tier) {
    if (!this.isTierUnlocked(tier) || this.isClaimed(tier)) return false;
    this._state.claimed.push(tier);
    const entry = this.rewardIdAt(tier);
    if (entry && typeof entry === 'object' && entry.cbucks) {
      // Currency tier — pays out C-Bucks.
      this._state.cbucks += entry.cbucks;
      this._save();
      this._showToast(`+${entry.cbucks} C-Bucks`, 'Tier reward');
    } else {
      // Cosmetic tier — auto-equip the freshly claimed cosmetic.
      const slot = COSMETICS[entry]?.slot;
      if (slot) this._state.equipped[slot] = entry;
      this._save();
    }
    return true;
  }

  /** Equip an owned cosmetic into its slot. Pass null to clear (color falls back to default). */
  equip(slot, id) {
    if (id == null) {
      this._state.equipped[slot] = slot === 'color' ? 'white' : null;
      this._save();
      return true;
    }
    if (COSMETICS[id]?.slot !== slot || !this.ownsCosmetic(id)) return false;
    this._state.equipped[slot] = id;
    this._save();
    return true;
  }

  get equipped() { return { ...this._state.equipped }; }

  nameColorId() { return this._state.equipped.color || 'white'; }
  nameColorValue() { return COSMETICS[this.nameColorId()]?.value ?? '#ffffff'; }
  nameColorAnim() { return COSMETICS[this.nameColorId()]?.anim ?? null; }
  titleText() { const id = this._state.equipped.title; return id ? COSMETICS[id]?.value : null; }
  badgeGlyph() { const id = this._state.equipped.badge; return id ? COSMETICS[id]?.value : null; }

  // Skydive trail — read by skydive.js to drive the freefall particle emitter.
  skydiveTrailId() { return this._state.equipped.trail || null; }
  skydiveTrailFx() { const id = this._state.equipped.trail; return id ? (COSMETICS[id]?.fx ?? null) : null; }

  /** Ids of every owned (claimed) cosmetic in a slot. 'white' always counts. */
  ownedBySlot(slot) {
    return Object.keys(COSMETICS).filter(id => COSMETICS[id].slot === slot && this.ownsCosmetic(id));
  }

  /**
   * Build decorated HTML for the local player's name (badge + title + colored
   * name). The name is escaped; used by the lobby own-entry render in main.js.
   */
  decorateNameHTML(name) {
    return this.decorateNameHTMLFor(name, this._state.equipped);
  }

  /**
   * Decorate a name from an explicit equipped set ({ color, title, badge } of
   * cosmetic ids). Used to render OTHER players in the multiplayer lobby from
   * their broadcast cosmetics; `decorateNameHTML` is the local-player shortcut.
   */
  decorateNameHTMLFor(name, equipped) {
    const colId  = (equipped && equipped.color) || 'white';
    const colCos = COSMETICS[colId]?.slot === 'color' ? COSMETICS[colId] : COSMETICS.white;
    const anim   = colCos?.anim ?? null;
    const style  = anim ? '' : `color:${colCos?.value ?? '#ffffff'}`;
    const cls    = anim ? `bp-name bp-anim-${anim}` : 'bp-name';
    const nameEl = `<span class="${cls}" style="${style}">${escapeHtml(name)}</span>`;
    const bId = equipped && equipped.badge, tId = equipped && equipped.title;
    const badge = (bId && COSMETICS[bId]?.slot === 'badge') ? COSMETICS[bId].value : null;
    const title = (tId && COSMETICS[tId]?.slot === 'title') ? COSMETICS[tId].value : null;
    const badgeEl = badge ? `<span class="bp-deco-badge">${badge}</span>` : '';
    const titleEl = title ? `<span class="bp-deco-title">${escapeHtml(title)}</span>` : '';
    return `${badgeEl}${titleEl}${nameEl}`;
  }

  // ── Home-screen level chip ──────────────────────────────────────────────────
  refreshHomeChip() {
    const chip = document.getElementById('bp-home-chip');
    if (!chip) return;
    const pct = Math.round(this.progress * 100);
    chip.innerHTML = `
      <span class="bp-chip-lv">LV ${this.level}</span>
      <span class="bp-chip-bar"><span class="bp-chip-fill" style="width:${pct}%"></span></span>
      <span class="bp-chip-xp">${this.atMaxLevel ? 'MAX' : `${this.xpIntoLevel} / ${this.xpForLevel}`}</span>
      <span class="bp-chip-cb">💲 ${this.cbucks}</span>`;
  }

  // ── Transient XP / level-up toast (in-game feedback) ────────────────────────
  _showToast(big, small = '', isLevel = false) {
    if (typeof document === 'undefined') return;
    let wrap = document.getElementById('bp-toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'bp-toast-wrap';
      document.body.appendChild(wrap);
    }
    const t = document.createElement('div');
    t.className = 'bp-toast' + (isLevel ? ' bp-toast-level' : '');
    t.innerHTML = `<span class="bp-toast-big">${escapeHtml(big)}</span>` +
                  (small ? `<span class="bp-toast-small">${escapeHtml(small)}</span>` : '');
    wrap.appendChild(t);
    // Force reflow so the entrance transition runs, then schedule removal.
    void t.offsetWidth;
    t.classList.add('show');
    setTimeout(() => { t.classList.remove('show'); }, isLevel ? 2600 : 1600);
    setTimeout(() => { t.remove(); }, isLevel ? 3000 : 2000);
  }

  // ── Full-screen overlay ─────────────────────────────────────────────────────
  openOverlay() {
    this._ensureOverlay();
    this._renderOverlay();
    this._overlay.classList.remove('hidden');
    document.exitPointerLock?.();
  }

  closeOverlay() { this._overlay?.classList.add('hidden'); }

  _ensureOverlay() {
    if (this._overlay) return;
    const el = document.createElement('div');
    el.id = 'battlepass-overlay';
    el.className = 'hidden';
    el.innerHTML = `
      <div class="bp-panel">
        <div class="bp-header">
          <div class="bp-header-titles">
            <div class="bp-season">${escapeHtml(SEASON_NAME)}</div>
            <div class="bp-sub">Play to earn XP and unlock cosmetics — no account needed, progress saves in your browser.</div>
          </div>
          <button class="bp-close" id="bp-close-btn">✕</button>
        </div>
        <div class="bp-progress-row">
          <div class="bp-level-badge" id="bp-level-badge">1</div>
          <div class="bp-progress-meta">
            <div class="bp-progress-bar"><span class="bp-progress-fill" id="bp-progress-fill"></span></div>
            <div class="bp-progress-text" id="bp-progress-text"></div>
          </div>
        </div>
        <div class="bp-cbucks-row">
          <span class="bp-cbucks-bal">💲 <b id="bp-cbucks-amt">0</b> C-Bucks</span>
          <button class="bp-btn bp-skip-btn" id="bp-skip-btn">SKIP TIER · ${TIER_SKIP_COST} C</button>
        </div>
        <div class="bp-track" id="bp-track"></div>
      </div>`;
    document.body.appendChild(el);
    this._overlay = el;

    el.querySelector('#bp-close-btn').addEventListener('click', () => this.closeOverlay());
    el.querySelector('#bp-skip-btn').addEventListener('click', () => { this.skipTier(); this._renderOverlay(); });
    // Click on dimmed backdrop (outside the panel) closes.
    el.addEventListener('click', (e) => { if (e.target === el) this.closeOverlay(); });
    // Esc closes while open.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._overlay && !this._overlay.classList.contains('hidden')) {
        this.closeOverlay();
      }
    });
    // Event delegation for claim / equip buttons.
    el.querySelector('#bp-track').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const tier = parseInt(btn.dataset.tier, 10);
      if (btn.dataset.act === 'claim') this.claimTier(tier);
      else if (btn.dataset.act === 'equip') {
        const id = this.rewardIdAt(tier);
        const slot = COSMETICS[id]?.slot;
        // Toggle: clicking an equipped item unequips it.
        if (this._state.equipped[slot] === id) this.equip(slot, null);
        else this.equip(slot, id);
      }
      this._renderOverlay();
    });
  }

  _renderOverlay() {
    if (!this._overlay) return;
    const pct = Math.round(this.progress * 100);
    this._overlay.querySelector('#bp-level-badge').textContent = this.level;
    this._overlay.querySelector('#bp-progress-fill').style.width = `${pct}%`;
    this._overlay.querySelector('#bp-progress-text').textContent =
      this.atMaxLevel ? `MAX TIER — ${this.xp} XP total`
                      : `Tier ${this.level} • ${this.xpIntoLevel} / ${this.xpForLevel} XP to Tier ${this.level + 1}`;

    this._overlay.querySelector('#bp-cbucks-amt').textContent = this.cbucks;
    const skipBtn = this._overlay.querySelector('#bp-skip-btn');
    skipBtn.disabled = !this.canSkipTier();
    skipBtn.textContent = this.atMaxLevel ? 'MAX TIER REACHED' : `SKIP TIER · ${TIER_SKIP_COST} C`;

    const track = this._overlay.querySelector('#bp-track');
    let html = '';
    for (let tier = 1; tier <= MAX_TIER; tier++) {
      const id       = this.rewardIdAt(tier);
      const isCb     = !!(id && typeof id === 'object' && id.cbucks);
      const cos      = isCb ? null : this.rewardAt(tier);
      const unlocked = this.isTierUnlocked(tier);
      const claimed  = this.isClaimed(tier);
      const equipped = cos && this._state.equipped[cos.slot] === id;
      const rarCol   = isCb ? '#ffce4a' : (RARITY_COLORS[cos?.rarity] || '#b8c0cc');

      let icon, name, rarityLabel;
      if (isCb) {
        icon = `<span class="bp-reward-glyph">💲</span>`;
        name = `${id.cbucks} C-Bucks`;
        rarityLabel = 'currency';
      } else {
        name = cos?.name || '—';
        rarityLabel = cos?.rarity || '';
        if (cos?.slot === 'color') {
          icon = cos.value === 'animated'
            ? `<span class="bp-swatch bp-anim-${cos.anim}"></span>`
            : `<span class="bp-swatch" style="background:${cos.value}"></span>`;
        } else if (cos?.slot === 'badge') {
          icon = `<span class="bp-reward-glyph">${cos.value}</span>`;
        } else if (cos?.slot === 'trail') {
          icon = `<span class="bp-reward-glyph">${cos.glyph}</span>`;
        } else {
          icon = `<span class="bp-reward-glyph bp-reward-title">T</span>`;
        }
      }

      let action = '';
      if (!unlocked)      action = `<span class="bp-locked">🔒 Tier ${tier}</span>`;
      else if (!claimed)  action = `<button class="bp-btn bp-btn-claim" data-act="claim" data-tier="${tier}">CLAIM</button>`;
      else if (isCb)      action = `<span class="bp-claimed-tag">CLAIMED</span>`;
      else                action = `<button class="bp-btn ${equipped ? 'bp-btn-on' : ''}" data-act="equip" data-tier="${tier}">${equipped ? 'EQUIPPED' : 'EQUIP'}</button>`;

      const stateCls = !unlocked ? 'locked' : (claimed ? 'claimed' : 'ready');
      html += `
        <div class="bp-tier ${stateCls}" style="--rar:${rarCol}">
          <div class="bp-tier-num">${tier}</div>
          <div class="bp-tier-icon">${icon}</div>
          <div class="bp-tier-name">${escapeHtml(name)}</div>
          <div class="bp-tier-rarity" style="color:${rarCol}">${escapeHtml(rarityLabel)}</div>
          <div class="bp-tier-action">${action}</div>
        </div>`;
    }
    track.innerHTML = html;
  }

  // ── Locker — equip-management hub, grouped by cosmetic slot ─────────────────
  openLocker() {
    this._ensureLocker();
    this._renderLocker();
    this._locker.classList.remove('hidden');
    document.exitPointerLock?.();
  }

  closeLocker() { this._locker?.classList.add('hidden'); }

  _ensureLocker() {
    if (this._locker) return;
    const el = document.createElement('div');
    el.id = 'locker-overlay';
    el.className = 'hidden';
    el.innerHTML = `
      <div class="lk-panel">
        <div class="bp-header">
          <div class="bp-header-titles">
            <div class="bp-season">🎽 LOCKER</div>
            <div class="bp-sub">Equip the rewards you've unlocked. Earn more by levelling the Battle Pass.</div>
          </div>
          <button class="bp-close" id="lk-close-btn">✕</button>
        </div>
        <div class="lk-body" id="lk-body"></div>
      </div>`;
    document.body.appendChild(el);
    this._locker = el;

    el.querySelector('#lk-close-btn').addEventListener('click', () => this.closeLocker());
    el.addEventListener('click', (e) => { if (e.target === el) this.closeLocker(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._locker && !this._locker.classList.contains('hidden')) {
        this.closeLocker();
      }
    });
    el.querySelector('#lk-body').addEventListener('click', (e) => {
      const card = e.target.closest('.lk-card[data-slot]');
      if (!card) return;
      const id = card.dataset.id === '__none__' ? null : card.dataset.id;
      this.equip(card.dataset.slot, id);
      this._renderLocker();
    });
  }

  _lockerCardHTML(slot, id, label, equipped) {
    let preview;
    if (id === null) {
      preview = `<span class="lk-none">✕</span>`;
    } else {
      const cos = COSMETICS[id];
      if (slot === 'color') {
        preview = cos.value === 'animated'
          ? `<span class="bp-swatch bp-anim-${cos.anim}"></span>`
          : `<span class="bp-swatch" style="background:${cos.value}"></span>`;
      } else if (slot === 'title') {
        preview = `<span class="lk-title-preview">${escapeHtml(cos.value)}</span>`;
      } else {
        preview = `<span class="lk-glyph">${cos.glyph ?? cos.value}</span>`;
      }
    }
    const rarCol = RARITY_COLORS[id ? COSMETICS[id].rarity : 'common'] || '#b8c0cc';
    return `
      <button class="lk-card ${equipped ? 'equipped' : ''}" data-slot="${slot}" data-id="${id ?? '__none__'}" style="--rar:${rarCol}">
        <span class="lk-preview">${preview}</span>
        <span class="lk-label">${escapeHtml(label)}</span>
        ${equipped ? '<span class="lk-tick">✓</span>' : ''}
      </button>`;
  }

  _renderLocker() {
    if (!this._locker) return;
    const sections = [
      { slot: 'color', label: 'Name Colour',   hasNone: false, noneLabel: 'Default' },
      { slot: 'title', label: 'Title',         hasNone: true,  noneLabel: 'None' },
      { slot: 'badge', label: 'Badge',         hasNone: true,  noneLabel: 'None' },
      { slot: 'trail', label: 'Skydive Trail', hasNone: true,  noneLabel: 'None' },
    ];
    let html = '';
    for (const sec of sections) {
      const equippedId = this._state.equipped[sec.slot];
      let cards = '';
      // color's always-owned 'white' acts as its default, so it needs no
      // separate "None" card; the other slots get one to clear the slot.
      if (sec.hasNone) cards += this._lockerCardHTML(sec.slot, null, sec.noneLabel, equippedId == null);
      const owned = this.ownedBySlot(sec.slot);
      for (const id of owned) cards += this._lockerCardHTML(sec.slot, id, COSMETICS[id].name, equippedId === id);
      const empty = sec.slot !== 'color' && owned.length === 0;
      html += `
        <div class="lk-section">
          <div class="lk-section-title">${escapeHtml(sec.label)}</div>
          <div class="lk-grid">${cards}</div>
          ${empty ? '<div class="lk-empty">Unlock rewards in the Battle Pass to fill this slot.</div>' : ''}
        </div>`;
    }
    this._locker.querySelector('#lk-body').innerHTML = html;
  }

  // ── Shop — buy C-Bucks (placeholder until real payments are wired up) ───────
  openShop() {
    this._ensureShop();
    this._renderShop();
    this._shop.classList.remove('hidden');
    document.exitPointerLock?.();
  }

  closeShop() { this._shop?.classList.add('hidden'); }

  _ensureShop() {
    if (this._shop) return;
    const el = document.createElement('div');
    el.id = 'shop-overlay';
    el.className = 'hidden';
    el.innerHTML = `
      <div class="shop-panel">
        <div class="bp-header">
          <div class="bp-header-titles">
            <div class="bp-season">💲 ITEM SHOP</div>
            <div class="bp-sub">Spend C-Bucks (earned by claiming Battle Pass tiers) on shop-exclusive cosmetics.</div>
          </div>
          <button class="bp-close" id="shop-close-btn">✕</button>
        </div>
        <div class="shop-balance">Balance: 💲 <b id="shop-balance-amt">0</b> C-Bucks</div>
        <div class="shop-grid" id="shop-grid"></div>
      </div>`;
    document.body.appendChild(el);
    this._shop = el;

    el.querySelector('#shop-close-btn').addEventListener('click', () => this.closeShop());
    el.addEventListener('click', (e) => { if (e.target === el) this.closeShop(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._shop && !this._shop.classList.contains('hidden')) this.closeShop();
    });
    el.querySelector('#shop-grid').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.act === 'buy') {
        this.buyShopItem(id);
      } else if (btn.dataset.act === 'equip') {
        const slot = COSMETICS[id]?.slot;
        if (this._state.equipped[slot] === id) this.equip(slot, null);   // toggle off
        else this.equip(slot, id);
      }
      this._renderShop();
    });
  }

  _renderShop() {
    if (!this._shop) return;
    this._shop.querySelector('#shop-balance-amt').textContent = this.cbucks;
    const grid = this._shop.querySelector('#shop-grid');
    grid.innerHTML = SHOP_ITEMS.map(id => {
      const c        = COSMETICS[id];
      const owned    = this.ownsCosmetic(id);
      const equipped = this._state.equipped[c.slot] === id;
      const afford   = this.cbucks >= c.shopPrice;
      const rarCol   = RARITY_COLORS[c.rarity] || '#b8c0cc';

      let preview;
      if (c.slot === 'color') {
        preview = c.value === 'animated'
          ? `<span class="bp-swatch bp-anim-${c.anim}"></span>`
          : `<span class="bp-swatch" style="background:${c.value}"></span>`;
      } else if (c.slot === 'title') {
        preview = `<span class="lk-title-preview">${escapeHtml(c.value)}</span>`;
      } else {
        preview = `<span class="lk-glyph">${c.glyph ?? c.value}</span>`;
      }

      let action;
      if (!owned) {
        action = `<button class="bp-btn bp-btn-claim shop-buy" data-act="buy" data-id="${id}" ${afford ? '' : 'disabled'}>💲 ${c.shopPrice}</button>`;
      } else {
        action = `<button class="bp-btn ${equipped ? 'bp-btn-on' : ''}" data-act="equip" data-id="${id}">${equipped ? 'EQUIPPED' : 'EQUIP'}</button>`;
      }

      return `
        <div class="lk-card" style="--rar:${rarCol}">
          <span class="lk-preview">${preview}</span>
          <span class="lk-label">${escapeHtml(c.name)}</span>
          <span class="bp-tier-rarity" style="color:${rarCol}">${escapeHtml(c.rarity)}</span>
          ${action}
        </div>`;
    }).join('');
  }
}

export const BattlePass = new BattlePassManager();
export { COSMETICS, TIER_REWARDS, XP };
