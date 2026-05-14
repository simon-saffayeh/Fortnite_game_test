// ── Audio system ─────────────────────────────────────────────────────────────
// Every gunshot is a per-shot one-shot sample, triggered on the same fire tick
// that spawns the muzzle flash — so audio stays frame-perfect with the visuals
// at any fire rate. Rapid fire gets per-shot pitch jitter so it doesn't sound
// like a robotic identical-click loop. Remote shots are spatialized with
// distance attenuation + stereo panning.

const SOUND_FILES = {
  // Semi-auto
  pistol:     'sounds/semi_auto_shots/pistol_shot.wav',
  shotgun:    'sounds/semi_auto_shots/shotgun_shot.wav',
  handCannon: 'sounds/semi_auto_shots/hand_cannon_shot.wav',
  sniper:     'sounds/semi_auto_shots/sniper_shot.wav',
  // Full-auto — same per-shot path, fired once per bullet
  ar:         'sounds/full_auto_sounds/assault_rifle_shot.wav',
  heavyAR:    'sounds/full_auto_sounds/assault_rifle_shot.wav',
  smg:        'sounds/full_auto_sounds/assault_rifle_shot.wav',
  minigun:    'sounds/full_auto_sounds/assault_rifle_shot.wav',
};

// Per-shot playback-rate variation (±) — keeps rapid fire from sounding robotic
const PITCH_JITTER = 0.06;

// Distance tuning (world units)
const REF_DIST  = 10;   // within this radius a shot is essentially full volume
const MAX_DIST  = 240;  // beyond this a shot is inaudible
const ROLLOFF   = 0.55; // higher = faster falloff past REF_DIST

export class AudioManager {
  constructor() {
    this.ctx        = null;
    this.masterGain = null;
    this._ready     = false;
    this.buffers    = {};   // weaponId → AudioBuffer
  }

  async init() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.75;
      this.masterGain.connect(this.ctx.destination);

      // Load each unique file once, then share buffers across weapon IDs.
      const pathToBuffer = new Map();
      const uniquePaths = [...new Set(Object.values(SOUND_FILES))];
      await Promise.all(uniquePaths.map(async p => {
        try {
          const res = await fetch(p);
          const arr = await res.arrayBuffer();
          pathToBuffer.set(p, await this.ctx.decodeAudioData(arr));
        } catch (e) { console.warn('[audio] failed to load', p, e); }
      }));
      for (const [id, path] of Object.entries(SOUND_FILES)) {
        const buf = pathToBuffer.get(path);
        if (buf) this.buffers[id] = buf;
      }
      this._ready = true;
    } catch (e) {
      console.warn('[audio] init failed', e);
    }
  }

  // Browsers start the context suspended until a user gesture.
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  _jitterRate() {
    return 1 + (Math.random() * 2 - 1) * PITCH_JITTER;
  }

  // The local player fired one bullet — full volume, no spatialization.
  // Call this once per shot for every weapon, semi- or full-auto alike.
  playLocal(weaponId) {
    const buf = this.buffers[weaponId];
    if (!buf || !this.ctx) return;
    this.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = this._jitterRate();
    const g = this.ctx.createGain();
    g.gain.value = 1.0;
    src.connect(g).connect(this.masterGain);
    src.start();
  }

  // A bullet fired elsewhere in the world (remote player). Call once per shot.
  // sourcePos / listenerPos: THREE.Vector3-like {x,y,z}
  // listenerRight: THREE.Vector3-like world-space right vector of the camera
  playAt(weaponId, sourcePos, listenerPos, listenerRight) {
    const buf = this.buffers[weaponId];
    if (!buf || !this.ctx) return;
    this.resume();

    const dx = sourcePos.x - listenerPos.x;
    const dy = sourcePos.y - listenerPos.y;
    const dz = sourcePos.z - listenerPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > MAX_DIST) return;

    // Inverse-distance falloff with a near plateau, then a linear fade
    // over the final 25% so distant shots taper smoothly to silence.
    let vol = REF_DIST / (REF_DIST + Math.max(0, dist - REF_DIST) * ROLLOFF);
    const fadeStart = MAX_DIST * 0.75;
    if (dist > fadeStart) vol *= 1 - (dist - fadeStart) / (MAX_DIST - fadeStart);
    vol = Math.max(0, Math.min(1, vol));
    if (vol <= 0.002) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = this._jitterRate();

    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    let tail = g;

    // Stereo pan from the direction-to-source projected onto camera-right.
    if (this.ctx.createStereoPanner) {
      let pan = 0;
      if (listenerRight && dist > 0.001) {
        pan = (dx * listenerRight.x + dz * listenerRight.z) / dist;
        pan = Math.max(-1, Math.min(1, pan));
      }
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = pan;
      tail.connect(panner);
      tail = panner;
    }

    // Distant shots lose their high end (air absorption feel).
    if (dist > 45) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.max(650, 16000 - (dist - 45) * 75);
      tail.connect(lp);
      tail = lp;
    }

    tail.connect(this.masterGain);
    src.start();
  }
}
