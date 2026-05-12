import * as THREE from 'three';

const BASE_FOV       = 70;
const SPRINT_FOV     = 80;
const ADS_FOV        = 42;
const SNIPER_ADS_FOV = 22;
const EYE_HEIGHT     = 1.65;

export class ThirdPersonCamera {
  constructor(camera, player) {
    this.camera = camera;
    this.player = player;

    this._fovTarget  = BASE_FOV;
    this._currentFov = BASE_FOV;

    this._recoilPitch    = 0;
    this._recoilRecovery = 6;

    this._bobPhase = 0;
    this._bobY     = 0;

    this._leanRoll = 0;

    // FPS — never show the local player's body
    this.player.body.visible = false;
  }

  setADS(active, isSniper = false) {
    this._fovTarget = active ? (isSniper ? SNIPER_ADS_FOV : ADS_FOV) : BASE_FOV;
  }

  setSprint(active) {
    if (this._fovTarget === BASE_FOV || this._fovTarget === SPRINT_FOV) {
      this._fovTarget = active ? SPRINT_FOV : BASE_FOV;
    }
  }

  addRecoil(amount) {
    this._recoilPitch += amount;
  }

  update(dt, shake = null) {
    // FOV lerp
    this._currentFov = THREE.MathUtils.lerp(this._currentFov, this._fovTarget, dt * 9);
    if (Math.abs(this._currentFov - this.camera.fov) > 0.05) {
      this.camera.fov = this._currentFov;
      this.camera.updateProjectionMatrix();
    }

    // Recoil recovery
    if (this._recoilPitch > 0) {
      this._recoilPitch = Math.max(0, this._recoilPitch - dt * this._recoilRecovery);
    }

    const playerPos = this.player.getPosition();
    const yaw   = this.player.getYaw();
    const pitch  = this.player.getPitch() + this._recoilPitch;
    const sinY  = Math.sin(yaw),  cosY = Math.cos(yaw);
    const sinP  = Math.sin(pitch), cosP = Math.cos(pitch);

    // Eye position
    const eyePos = new THREE.Vector3(playerPos.x, playerPos.y + EYE_HEIGHT, playerPos.z);

    // Head bob — smaller amplitude than TPS
    const vel   = this.player.velocity;
    const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    if (speed > 0.5 && this.player.grounded) {
      const bobRate = this.player._isSprinting ? 9.5 : 6.5;
      this._bobPhase += dt * bobRate;
      const bobAmt = (this.player._isSprinting ? 0.05 : 0.025) * Math.min(speed / 8, 1);
      this._bobY = THREE.MathUtils.lerp(this._bobY, Math.sin(this._bobPhase) * bobAmt, dt * 20);
    } else {
      this._bobY = THREE.MathUtils.lerp(this._bobY, 0, dt * 12);
    }
    eyePos.y += this._bobY;

    // Screen shake
    if (shake && shake.intensity > 0) {
      eyePos.add(shake.offset);
    }

    this.camera.position.copy(eyePos);

    // Look along yaw + pitch
    const lookTarget = new THREE.Vector3(
      eyePos.x - sinY * cosP * 100,
      eyePos.y + sinP * 100,
      eyePos.z - cosY * cosP * 100
    );
    this.camera.lookAt(lookTarget);

    // Subtle strafe lean
    const rightDot   = vel.x * cosY + vel.z * (-sinY);
    const targetLean = rightDot * -0.004;
    this._leanRoll = THREE.MathUtils.lerp(this._leanRoll, targetLean, dt * 7);
    if (Math.abs(this._leanRoll) > 0.0005) {
      this.camera.rotateZ(this._leanRoll);
    }
  }
}
