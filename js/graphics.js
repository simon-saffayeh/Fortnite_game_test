// ── Graphics quality presets + dynamic resolution scaler ────────────────────
// Single source of truth for every "should we draw the expensive thing?"
// decision in the renderer. Read by main.js (renderer/postFX), world.js
// (sky/IBL/shadows), particles, and materials.js (PBR vs Lambert).
//
// Storage: persisted into localStorage `bi_settings.quality` so the user's
// pick survives reloads.

const PRESETS = {
  low: {
    label:               'LOW',
    shadowMapSize:       512,
    shadowsEnabled:      true,
    pixelRatioCap:       1.0,
    bloomEnabled:        false,
    outlineEnabled:      true,
    smaaEnabled:         false,
    grassEnabled:        false,
    toonShading:         false,
    toonOutline:         false,
    stylizedWater:       false,
    cartoonGrade:        false,
    grainEnabled:        false,
    pbrEnabled:          false,         // keep Lambert — cheapest shader
    envMapEnabled:       false,         // no PMREM bake, no IBL
    skyShaderEnabled:    false,         // keep the cheap inverted sphere
    bevelGeometry:       false,         // raw BoxGeometry, no rounded edges
    particleMultiplier:  0.5,
    ambientDustCount:    120,
    cloudCount:          8,
    treeAttempts:        300,
    decalsEnabled:       false,
    ssaoEnabled:         false,
    taaEnabled:          false,
    volumetricEnabled:   false,
    waterReflection:     false,
    dynamicResolution:   false,         // off — was producing permanent blur
  },
  medium: {
    label:               'MEDIUM',
    shadowMapSize:       1024,
    shadowsEnabled:      true,
    pixelRatioCap:       1.25,
    bloomEnabled:        true,
    outlineEnabled:      true,
    smaaEnabled:         true,
    grassEnabled:        true,
    toonShading:         false,
    toonOutline:         false,
    stylizedWater:       true,
    cartoonGrade:        true,
    grainEnabled:        true,
    pbrEnabled:          true,
    envMapEnabled:       true,
    skyShaderEnabled:    true,
    bevelGeometry:       false,
    particleMultiplier:  0.8,
    ambientDustCount:    220,
    cloudCount:          18,
    treeAttempts:        500,
    decalsEnabled:       false,
    ssaoEnabled:         false,
    taaEnabled:          false,
    volumetricEnabled:   false,
    waterReflection:     false,
    dynamicResolution:   false,
  },
  high: {
    label:               'HIGH',
    shadowMapSize:       1024,
    shadowsEnabled:      true,
    pixelRatioCap:       1.5,
    bloomEnabled:        true,
    outlineEnabled:      true,
    smaaEnabled:         true,
    grassEnabled:        true,
    toonShading:         true,
    toonOutline:         true,
    stylizedWater:       true,
    cartoonGrade:        true,
    grainEnabled:        true,
    pbrEnabled:          true,
    envMapEnabled:       true,
    skyShaderEnabled:    true,
    bevelGeometry:       true,
    particleMultiplier:  1.0,
    ambientDustCount:    350,
    cloudCount:          24,
    treeAttempts:        600,
    decalsEnabled:       true,
    ssaoEnabled:         false,
    taaEnabled:          false,
    volumetricEnabled:   false,
    waterReflection:     true,
    dynamicResolution:   false,
  },
  ultra: {
    label:               'ULTRA',
    shadowMapSize:       2048,
    shadowsEnabled:      true,
    pixelRatioCap:       2.0,
    bloomEnabled:        true,
    outlineEnabled:      true,
    smaaEnabled:         true,
    grassEnabled:        true,
    toonShading:         true,
    toonOutline:         true,
    stylizedWater:       true,
    cartoonGrade:        true,
    grainEnabled:        true,
    pbrEnabled:          true,
    envMapEnabled:       true,
    skyShaderEnabled:    true,
    bevelGeometry:       true,
    particleMultiplier:  1.4,
    ambientDustCount:    500,
    cloudCount:          32,
    treeAttempts:        800,
    decalsEnabled:       true,
    ssaoEnabled:         true,
    taaEnabled:          true,
    volumetricEnabled:   true,
    waterReflection:     true,
    dynamicResolution:   false,         // user asked for ultra; trust them
  },
};

// Best-effort GPU tier sniff. webgl debug_renderer_info exposes the underlying
// adapter on most browsers; we look for known mobile/integrated keywords. Worst
// case (string unreadable) we fall back to MEDIUM, which is the safest middle.
function _detectInitialPreset() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return 'low';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const r   = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
    const s   = (r || '').toLowerCase();
    // Discrete / desktop signals → HIGH default.
    if (/(rtx|radeon rx|geforce gtx 1[67]|geforce rtx|apple m[1-9])/.test(s)) return 'high';
    // Mobile / very low signals → LOW.
    if (/(mali|adreno|powervr|intel\(r\) hd|intel iris)/.test(s)) return 'low';
    return 'medium';
  } catch {
    return 'medium';
  }
}

class GraphicsSettings {
  constructor() {
    const saved = JSON.parse(localStorage.getItem('bi_settings') || '{}');
    const name  = ['low','medium','high','ultra'].includes(saved.quality)
      ? saved.quality
      : _detectInitialPreset();
    this._name = name;
    this._copyPreset(PRESETS[name]);

    // Dynamic resolution scaler state.
    this._frameTimes  = [];
    this._curScale    = 1.0;
    this._scaleFloor  = 0.6;
    this._scaleCeil   = 1.0;
    this._scaleAdjustCooldown = 0;
  }

  _copyPreset(p) {
    for (const k of Object.keys(p)) this[k] = p[k];
  }

  /** Active preset name, lowercase. */
  get presetName() { return this._name; }

  /** Mutate to a different preset. Persisted to localStorage. */
  setPreset(name) {
    if (!PRESETS[name] || name === this._name) return;
    this._name = name;
    this._copyPreset(PRESETS[name]);
    const cur = JSON.parse(localStorage.getItem('bi_settings') || '{}');
    cur.quality = name;
    localStorage.setItem('bi_settings', JSON.stringify(cur));
    this._curScale = 1.0;
    for (const fn of this._listeners) fn(this);
  }

  /** Subscribe to preset changes. main.js uses this to swap shadow map size. */
  onChange(fn) {
    (this._listeners = this._listeners || []).push(fn);
  }

  /**
   * Per-frame hook. Pass the deltaTime in seconds and the EffectComposer (or
   * renderer) to scale. Adjusts pixel ratio downward if frame times climb,
   * back up when they recover. No-op if dynamicResolution is false.
   *
   * Returns true when the scale changed this tick.
   */
  tickAdaptiveResolution(dt, composer, renderer) {
    if (!this.dynamicResolution) return false;
    // First few seconds: collect a window without taking action so startup
    // shader-compile spikes don't trigger an immediate downscale.
    this._scaleAdjustCooldown -= dt;
    this._frameTimes.push(dt);
    if (this._frameTimes.length > 60) this._frameTimes.shift();
    if (this._scaleAdjustCooldown > 0) return false;
    if (this._frameTimes.length < 30) return false;

    const avgMs = (this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length) * 1000;
    let target = this._curScale;
    if (avgMs > 22 && this._curScale > this._scaleFloor) {
      target = Math.max(this._scaleFloor, this._curScale - 0.1);
    } else if (avgMs < 14 && this._curScale < this._scaleCeil) {
      target = Math.min(this._scaleCeil, this._curScale + 0.05);
    }
    if (target === this._curScale) return false;
    this._curScale = target;
    this._scaleAdjustCooldown = 1.5;
    const ratio = Math.min(window.devicePixelRatio, this.pixelRatioCap) * target;
    composer?.setPixelRatio(ratio);
    renderer?.setPixelRatio(ratio);
    return true;
  }

  /** Returns the effective pixel ratio after preset + adaptive scale. */
  getEffectivePixelRatio() {
    return Math.min(window.devicePixelRatio, this.pixelRatioCap) * this._curScale;
  }
}

export const Graphics = new GraphicsSettings();
export { PRESETS };
