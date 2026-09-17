// Third-person spring-arm camera.
//
//  * Pivot follows the character with 0.12 s half-life position damping.
//  * Yaw/pitch follow the input with 0.08 s half-life rotation damping — the
//    damping *is* the "trailing lag on fast turns": a quick 180° of input
//    reaches the camera over a few frames rather than instantly.
//  * When the player is moving and hasn't touched look for a moment, the yaw
//    gently drifts behind the heading so the camera settles on its own.
//  * Spring arm: the arm is shortened if any sample along it dips below the
//    terrain (+ clearance) or intersects a prop collider, then eased back out.
//  * FOV widens 65° → 78° with speed. No shake on flat ground — none at all.

import * as THREE from 'three';
import { clamp, damp, dampAngle, lerp, shortestAngle, smoothstep } from '../core/MathUtils.js';
import { MOVE } from './CharacterController.js';
import { WATER_LEVEL } from '../world/WorldConfig.js';

const _look = { x: 0, y: 0 };
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _target = new THREE.Vector3();

export const CAMERA = {
  armLength: 7.2,
  minArm: 1.6,
  pivotHeight: 1.55,
  posHalfLife: 0.12,
  rotHalfLife: 0.08,
  fovMin: 65,
  fovMax: 78,
  pitchMin: -0.35,
  pitchMax: 1.15,
  defaultPitch: 0.26,
  autoFollowDelay: 1.4,
  autoFollowRate: 1.6,
  groundClearance: 0.55,
};

export const VIEW_MODES = [
  { name: 'chase', yawOffset: Math.PI, pitch: 0.26, arm: 7.2, pivotHeight: 1.55 },
  { name: 'action', yawOffset: Math.PI * 0.72, pitch: 0.16, arm: 5.2, pivotHeight: 1.25 },
  { name: 'front', yawOffset: 0.20, pitch: 0.12, arm: 4.4, pivotHeight: 1.05 },
];

export class CameraRig {
  constructor(camera, chunkManager) {
    this.camera = camera;
    this.world = chunkManager;
    this.field = chunkManager.field;

    this.viewModeIndex = 0;
    this._lastPoseYaw = 0;

    this.yaw = 0;
    this.pitch = CAMERA.defaultPitch;
    this.targetYaw = 0;
    this.targetPitch = CAMERA.defaultPitch;

    this.pivot = new THREE.Vector3();
    this.arm = CAMERA.armLength;
    this.fov = CAMERA.fovMin;
    this.sinceLook = 10;
    this.enabled = true;
    this._collideCb = this._collide.bind(this);
    this._armHit = 0;
  }

  reset(x, y, z, yaw) {
    this._lastPoseYaw = yaw;
    const vm = VIEW_MODES[this.viewModeIndex];
    this.pivot.set(x, y + vm.pivotHeight, z);
    this.yaw = this.targetYaw = yaw + vm.yawOffset;
    this.pitch = this.targetPitch = vm.pitch;
    this.arm = vm.arm;
    this._apply();
  }

  cycleViewMode() {
    this.viewModeIndex = (this.viewModeIndex + 1) % VIEW_MODES.length;
    const vm = VIEW_MODES[this.viewModeIndex];
    this.targetPitch = vm.pitch;
    this.targetYaw = this._lastPoseYaw + vm.yawOffset;
    this.sinceLook = 10;
    return vm;
  }

  /**
   * @param pose   interpolated character pose {x,y,z,yaw}
   * @param ctrl   CharacterController
   * @param input  Input (look deltas consumed here)
   * @param dt     render delta
   */
  update(pose, ctrl, input, dt) {
    this._lastPoseYaw = pose.yaw;
    const vm = VIEW_MODES[this.viewModeIndex];

    input.consumeLook(_look);
    if (this.enabled && (_look.x !== 0 || _look.y !== 0)) {
      this.targetYaw -= _look.x;
      this.targetPitch = clamp(this.targetPitch + _look.y, CAMERA.pitchMin, CAMERA.pitchMax);
      this.sinceLook = 0;
    } else {
      this.sinceLook += dt;
    }

    // Auto-follow: drift the yaw behind the mode offset while moving
    if (ctrl.speed > 1 && this.sinceLook > CAMERA.autoFollowDelay) {
      const behind = pose.yaw + vm.yawOffset;
      const strength = CAMERA.autoFollowRate * smoothstep(1, MOVE.run, ctrl.speed) * dt;
      this.targetYaw += shortestAngle(this.targetYaw, behind) * clamp(strength, 0, 1);
      // Ease the pitch back toward mode pitch
      this.targetPitch = damp(this.targetPitch, vm.pitch, 1.2, dt);
    }

    // Rotation damping (0.08 s).
    this.yaw = dampAngle(this.yaw, this.targetYaw, CAMERA.rotHalfLife, dt);
    this.pitch = damp(this.pitch, this.targetPitch, CAMERA.rotHalfLife, dt);

    // Position damping (0.12 s) of the pivot toward the character.
    _target.set(pose.x, pose.y + vm.pivotHeight, pose.z);
    this.pivot.x = damp(this.pivot.x, _target.x, CAMERA.posHalfLife, dt);
    this.pivot.y = damp(this.pivot.y, _target.y, CAMERA.posHalfLife, dt);
    this.pivot.z = damp(this.pivot.z, _target.z, CAMERA.posHalfLife, dt);

    // FOV with speed.
    const fovTarget = lerp(CAMERA.fovMin, CAMERA.fovMax, smoothstep(MOVE.walk, MOVE.sprint, ctrl.speed));
    this.fov = damp(this.fov, fovTarget, 0.25, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    // Spring arm collision: sample along the arm for terrain + props.
    const cp = Math.cos(this.pitch);
    _dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    let desired = vm.arm;
    const samples = 8;
    for (let i = 1; i <= samples; i++) {
      const d = (i / samples) * vm.arm;
      const sx = this.pivot.x + _dir.x * d;
      const sy = this.pivot.y + _dir.y * d;
      const sz = this.pivot.z + _dir.z * d;
      const ground = this.field.heightAt(sx, sz) + CAMERA.groundClearance;
      if (sy < ground) {
        desired = Math.max(CAMERA.minArm, d - vm.arm / samples);
        break;
      }
      this._armHit = 0;
      this.world.queryColliders(sx, sz, 0.4, this._collideCb);
      if (this._armHit) {
        desired = Math.max(CAMERA.minArm, d - vm.arm / samples);
        break;
      }
    }
    // Snap in quickly (never clip), ease out slowly.
    this.arm = desired < this.arm ? desired : damp(this.arm, desired, 0.2, dt);

    this._apply();
  }

  _collide(px, pz, pr) {
    // Trees, pillars and building walls block the camera (so it follows you
    // indoors); tiny colliders like lampposts don't.
    if (pr >= 0.4) {
      this._armHit = 1;
      return true;
    }
    return false;
  }

  _apply() {
    const cp = Math.cos(this.pitch);
    _dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    _pos.copy(this.pivot).addScaledVector(_dir, this.arm);
    // Never let the eye itself dip under the terrain.
    const floor = Math.max(this.field.heightAt(_pos.x, _pos.z) + 0.35, WATER_LEVEL + 0.45);
    if (_pos.y < floor) _pos.y = floor;
    this.camera.position.copy(_pos);
    this.camera.lookAt(this.pivot);
  }

  /**
   * Yaw used by the controller for camera-relative input. The camera sits at
   * pivot + (sin yaw, cos yaw)·arm and looks back at the pivot, so its view
   * direction is (-sin yaw, -cos yaw) — the same convention the controller
   * uses for "forward".
   */
  get moveYaw() {
    const vm = VIEW_MODES[this.viewModeIndex];
    return this.yaw + (Math.PI - vm.yawOffset);
  }
}
