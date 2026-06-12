import * as THREE from 'three';

// ── Screen Shake ─────────────────────────────────────────────────────────────
export class ScreenShake {
  constructor() {
    this.intensity = 0;
    this._offset = new THREE.Vector3();
  }

  shake(amount) {
    this.intensity = Math.max(this.intensity, amount);
  }

  update(dt) {
    if (this.intensity <= 0) return;
    this.intensity = Math.max(0, this.intensity - dt * 9);
    const i = this.intensity;
    this._offset.set(
      (Math.random() - 0.5) * i * 0.6,
      (Math.random() - 0.5) * i * 0.4,
      (Math.random() - 0.5) * i * 0.3
    );
  }

  get offset() { return this._offset; }
}

// ── Muzzle Flash (PointLight + sprite billboard) ────────────────────────────
// Keeps the persistent PointLight (intensity modulated; light count never
// changes → no shader recompile freeze) and adds a single billboard sprite
// with a procedural cross-flash texture for the visible muzzle pop.
// The sprite always faces the camera, so the flash reads from any angle.
export class MuzzleFlash {
  constructor(scene) {
    this._light = new THREE.PointLight(0xffcc55, 0, 12);
    this._light.castShadow = false;
    scene.add(this._light);
    this._timer = 0;

    // Procedural flash texture: bright center + four directional spike rays.
    const tex = this._makeFlashTexture();
    this._sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,    // additive so it pops over scene
      depthWrite: false,
      fog: false,
    }));
    this._sprite.scale.setScalar(0.6);
    this._sprite.visible = false;
    scene.add(this._sprite);
    this._spriteOpacity = 0;
  }

  flash(position, power = 4) {
    this._light.position.copy(position);
    this._light.intensity = power;

    // Scale sprite to weapon weight (power proxies for weapon size).
    this._sprite.position.copy(position);
    this._sprite.scale.setScalar(0.45 + Math.min(power, 8) * 0.08);
    this._sprite.material.opacity = 1.0;
    this._sprite.material.rotation = Math.random() * Math.PI * 2;
    this._sprite.visible = true;
    this._spriteOpacity = 1.0;

    this._timer = 0.09;   // slightly longer so the sprite fade reads
  }

  update(dt) {
    if (this._timer > 0) {
      this._timer -= dt;
      this._light.intensity = Math.max(0, this._light.intensity - dt * 80);
      this._spriteOpacity = Math.max(0, this._spriteOpacity - dt * 14);
      this._sprite.material.opacity = this._spriteOpacity;
      if (this._spriteOpacity <= 0.01) this._sprite.visible = false;
    }
  }

  _makeFlashTexture() {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');

    // Bright soft core
    const core = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size * 0.32);
    core.addColorStop(0.00, 'rgba(255, 250, 220, 1.00)');
    core.addColorStop(0.45, 'rgba(255, 200, 120, 0.65)');
    core.addColorStop(1.00, 'rgba(255, 140,  60, 0.00)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, size, size);

    // Cross-shaped rays (vertical + horizontal). Two long thin gradient
    // rectangles using `lighter` so they add to the core instead of
    // overwriting it.
    ctx.globalCompositeOperation = 'lighter';
    const ray = ctx.createLinearGradient(0, size/2, size, size/2);
    ray.addColorStop(0.00, 'rgba(255, 200, 110, 0.0)');
    ray.addColorStop(0.50, 'rgba(255, 240, 180, 0.55)');
    ray.addColorStop(1.00, 'rgba(255, 200, 110, 0.0)');
    ctx.fillStyle = ray;
    ctx.fillRect(0, size/2 - 4, size, 8);
    // Rotate 90° for the vertical spike
    ctx.save();
    ctx.translate(size/2, size/2);
    ctx.rotate(Math.PI / 2);
    ctx.translate(-size/2, -size/2);
    ctx.fillRect(0, size/2 - 4, size, 8);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
}

// ── Floating Damage Numbers ───────────────────────────────────────────────────
export class DamageNumbers {
  constructor() {
    this._el = document.createElement('div');
    this._el.id = 'dmg-numbers';
    this._el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:22;overflow:hidden;';
    document.body.appendChild(this._el);
  }

  show(worldPos, amount, camera, canvas, critical = false) {
    const proj = worldPos.clone().project(camera);
    if (proj.z > 1) return; // behind camera

    // Small random horizontal jitter so simultaneous multi-hits read as a
    // burst rather than a single stacked number. Vertical jitter keeps
    // separate hits from overlapping perfectly.
    const jx = (Math.random() - 0.5) * 36;
    const jy = (Math.random() - 0.5) * 18;
    const x = (proj.x *  0.5 + 0.5) * canvas.clientWidth + jx;
    const y = (proj.y * -0.5 + 0.5) * canvas.clientHeight + jy;

    const div = document.createElement('div');
    div.className = 'dmg-num' + (critical ? ' crit' : '');
    div.textContent = Math.round(amount);
    div.style.left = x + 'px';
    div.style.top  = y + 'px';
    this._el.appendChild(div);
    // Match longer CSS animation duration so divs aren't removed mid-anim.
    setTimeout(() => div.remove(), 1200);
  }

  showHeadshot(worldPos, camera, canvas) {
    const proj = worldPos.clone().project(camera);
    if (proj.z > 1) return;
    const x = (proj.x *  0.5 + 0.5) * canvas.clientWidth;
    const y = (proj.y * -0.5 + 0.5) * canvas.clientHeight;
    const div = document.createElement('div');
    div.className = 'dmg-num headshot-tag';
    div.textContent = 'HEADSHOT';
    div.style.left = x + 'px';
    div.style.top  = (y - 28) + 'px';
    this._el.appendChild(div);
    setTimeout(() => div.remove(), 1300);
  }

  showKill(worldPos, camera, canvas) {
    const proj = worldPos.clone().project(camera);
    if (proj.z > 1) return;
    const x = (proj.x *  0.5 + 0.5) * canvas.clientWidth;
    const y = (proj.y * -0.5 + 0.5) * canvas.clientHeight;
    const div = document.createElement('div');
    div.className = 'dmg-num kill-tag';
    div.textContent = 'ELIMINATED';
    div.style.left = x + 'px';
    div.style.top  = y + 'px';
    this._el.appendChild(div);
    setTimeout(() => div.remove(), 1700);
  }
}

// ── Directional Damage Indicator ──────────────────────────────────────────────
export class DirectionalDamage {
  constructor() {
    const hud = document.getElementById('hud');
    // 4 arcs: forward, right, back, left
    this._indicators = ['top', 'right', 'bottom', 'left'].map(side => {
      const el = document.createElement('div');
      el.className = `dir-dmg dir-${side}`;
      el.style.opacity = '0';
      hud.appendChild(el);
      return { el, timer: 0 };
    });
  }

  show(playerPos, playerYaw, sourcePos) {
    // Vector from player to source in world XZ
    const dx = sourcePos.x - playerPos.x;
    const dz = sourcePos.z - playerPos.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.01) return;
    const nx = dx / len, nz = dz / len;

    // Player facing direction: yaw rotation applied to local -Z = (-sin(yaw), 0, -cos(yaw))
    const fx = -Math.sin(playerYaw);
    const fz = -Math.cos(playerYaw);

    // Signed angle: positive = source to the right of player
    const dot   =  fx * nx + fz * nz;    // forward component
    const cross = fx * nz - fz * nx;     // right component (y of 2D cross)
    const angle = Math.atan2(cross, dot); // -PI to PI

    // Map angle to which indicator
    let idx;
    if (angle > -Math.PI / 4 && angle < Math.PI / 4)        idx = 0; // forward
    else if (angle >= Math.PI / 4 && angle < 3 * Math.PI / 4)  idx = 1; // right
    else if (angle < -Math.PI / 4 && angle > -3 * Math.PI / 4) idx = 3; // left
    else                                                           idx = 2; // back

    const ind = this._indicators[idx];
    ind.el.style.opacity = '1';
    ind.timer = 0.85;
  }

  update(dt) {
    for (const ind of this._indicators) {
      if (ind.timer > 0) {
        ind.timer -= dt;
        ind.el.style.opacity = Math.max(0, ind.timer / 0.85).toFixed(3);
      }
    }
  }
}

// ── Hit Marker (brief cross flash on hit) ─────────────────────────────────────
export class HitMarker {
  constructor() {
    this._el = document.getElementById('crosshair');
    this._timer = 0;
    this._kill  = false;
  }

  hit(isKill = false) {
    this._timer = 0.12;
    this._kill  = isKill;
    if (this._el) {
      this._el.classList.add(isKill ? 'hitmarker-kill' : 'hitmarker-hit');
    }
  }

  update(dt) {
    if (this._timer > 0) {
      this._timer -= dt;
      if (this._timer <= 0 && this._el) {
        this._el.classList.remove('hitmarker-hit', 'hitmarker-kill');
      }
    }
  }
}
