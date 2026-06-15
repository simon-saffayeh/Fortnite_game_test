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
const MAX_TIER    = 30;
const SEASON_ID   = 's1';
const SEASON_NAME = 'Season 1 — Island Outlaws';

// XP rewards for play events.
const XP = { KILL: 50, HEADSHOT_BONUS: 25, MATCH_PLAYED: 100, WIN_BONUS: 500 };

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
};

// ── Season tier track ── tier number → reward cosmetic id. 30 tiers, one
// reward each, paced so colors/badges/titles interleave with rarity climbing.
const TIER_REWARDS = [
  'title_rookie',   // 1
  'badge_star',     // 2
  'color_green',    // 3
  'badge_target',   // 4
  'color_cyan',     // 5
  'title_scavenger',// 6
  'color_blue',     // 7
  'badge_fire',     // 8
  'title_looter',   // 9
  'color_lime',     // 10
  'badge_bolt',     // 11
  'title_sharpshooter', // 12
  'color_purple',   // 13
  'badge_skull',    // 14
  'title_stormchaser',  // 15
  'color_orange',   // 16
  'badge_ghost',    // 17
  'color_gold',     // 18
  'title_survivor', // 19
  'badge_diamond',  // 20
  'color_pink',     // 21
  'badge_crown',    // 22
  'title_apex',     // 23
  'color_ice',      // 24
  'badge_trophy',   // 25
  'color_crimson',  // 26
  'title_warlord',  // 27
  'color_magma',    // 28
  'color_rainbow',  // 29
  'title_legend',   // 30
];

// Reverse lookup: cosmetic id → tier it unlocks at.
const TIER_OF = {};
TIER_REWARDS.forEach((id, i) => { TIER_OF[id] = i + 1; });

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
      claimed:   Array.isArray(s.claimed)
        ? [...new Set(s.claimed.filter(n => Number.isInteger(n) && n >= 1 && n <= MAX_TIER))]
        : [],
      equipped: {
        title: COSMETICS[eq.title]?.slot === 'title' ? eq.title : null,
        color: COSMETICS[eq.color]?.slot === 'color' ? eq.color : 'white',
        badge: COSMETICS[eq.badge]?.slot === 'badge' ? eq.badge : null,
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
    if (id === 'white') return true;             // default color always owned
    const tier = TIER_OF[id];
    return tier != null && this.isClaimed(tier);
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

  // ── Claim / equip ─────────────────────────────────────────────────────────
  claimTier(tier) {
    if (!this.isTierUnlocked(tier) || this.isClaimed(tier)) return false;
    this._state.claimed.push(tier);
    // Quality-of-life: auto-equip the freshly claimed cosmetic.
    const id = this.rewardIdAt(tier);
    const slot = COSMETICS[id]?.slot;
    if (slot) this._state.equipped[slot] = id;
    this._save();
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

  /**
   * Build decorated HTML for the local player's name (badge + title + colored
   * name). The name is escaped; used by the lobby own-entry render in main.js.
   */
  decorateNameHTML(name) {
    const anim   = this.nameColorAnim();
    const colVal = this.nameColorValue();
    const style  = anim ? '' : `color:${colVal}`;
    const cls    = anim ? `bp-name bp-anim-${anim}` : 'bp-name';
    const nameEl = `<span class="${cls}" style="${style}">${escapeHtml(name)}</span>`;
    const badge  = this.badgeGlyph();
    const title  = this.titleText();
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
      <span class="bp-chip-xp">${this.atMaxLevel ? 'MAX' : `${this.xpIntoLevel} / ${this.xpForLevel}`}</span>`;
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
        <div class="bp-track" id="bp-track"></div>
      </div>`;
    document.body.appendChild(el);
    this._overlay = el;

    el.querySelector('#bp-close-btn').addEventListener('click', () => this.closeOverlay());
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

    const track = this._overlay.querySelector('#bp-track');
    let html = '';
    for (let tier = 1; tier <= MAX_TIER; tier++) {
      const cos      = this.rewardAt(tier);
      const id       = this.rewardIdAt(tier);
      const unlocked = this.isTierUnlocked(tier);
      const claimed  = this.isClaimed(tier);
      const equipped = cos && this._state.equipped[cos.slot] === id;
      const rarCol   = RARITY_COLORS[cos?.rarity] || '#b8c0cc';

      let icon = '';
      if (cos?.slot === 'color') {
        const sw = cos.value === 'animated'
          ? `<span class="bp-swatch bp-anim-${cos.anim}"></span>`
          : `<span class="bp-swatch" style="background:${cos.value}"></span>`;
        icon = sw;
      } else if (cos?.slot === 'badge') {
        icon = `<span class="bp-reward-glyph">${cos.value}</span>`;
      } else {
        icon = `<span class="bp-reward-glyph bp-reward-title">T</span>`;
      }

      let action = '';
      if (!unlocked)      action = `<span class="bp-locked">🔒 Tier ${tier}</span>`;
      else if (!claimed)  action = `<button class="bp-btn bp-btn-claim" data-act="claim" data-tier="${tier}">CLAIM</button>`;
      else                action = `<button class="bp-btn ${equipped ? 'bp-btn-on' : ''}" data-act="equip" data-tier="${tier}">${equipped ? 'EQUIPPED' : 'EQUIP'}</button>`;

      const stateCls = !unlocked ? 'locked' : (claimed ? 'claimed' : 'ready');
      html += `
        <div class="bp-tier ${stateCls}" style="--rar:${rarCol}">
          <div class="bp-tier-num">${tier}</div>
          <div class="bp-tier-icon">${icon}</div>
          <div class="bp-tier-name">${escapeHtml(cos?.name || '—')}</div>
          <div class="bp-tier-rarity" style="color:${rarCol}">${escapeHtml(cos?.rarity || '')}</div>
          <div class="bp-tier-action">${action}</div>
        </div>`;
    }
    track.innerHTML = html;
  }
}

export const BattlePass = new BattlePassManager();
export { COSMETICS, TIER_REWARDS, XP };
