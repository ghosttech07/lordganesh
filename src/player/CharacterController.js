// Kinematic character controller for Ganesha-on-Mooshika. One controller, one
// rig: Ganesha is parented to Mooshika's saddle bone in MooshikaRig, so the
// pair can never drift apart.
//
// Design notes (these decide whether movement feels good):
//  * Fixed 60 Hz step. The renderer interpolates between the previous and
//    current state with an alpha, so a 120 Hz display sees smooth motion and
//    a 45 fps stutter never changes the simulated path.
//  * The terrain is an analytic height function, so "raycast ground snap" is an
//    exact vertical query — no rigid body ever touches the terrain, which is
//    what removes slope stutter.
//  * Speed is integrated with separate accel/decel toward a target; heading
//    is damped toward the desired direction with a hard rate cap. Velocity is
//    always along the heading, giving natural turning arcs.

import { clamp, damp, dampAngle, moveTowards, shortestAngle, smoothstep } from '../core/MathUtils.js';
import { WATER_LEVEL, MAX_SLOPE_WALKABLE } from '../world/WorldConfig.js';

export const MOVE = {
  walk: 5.2,
  run: 14,
  sprint: 22,
  accel: 22,
  decel: 30,
  turnRate: 8, // rad/s cap
  turnHalfLife: 0.065, // seconds; the damped part of the turn
  gravity: 34,
  leapVelocity: 9.5,
  playerRadius: 0.62,
  // On foot (Ganesha dismounted, gliding on his lotus): calmer, narrower.
  foot: { walk: 3.2, run: 6.5, sprint: 9.5, leapVelocity: 6.5, radius: 0.5 },
  swimSpeedScale: 0.45,
  wadeSpeedScale: 0.7,
};

export const SURFACE = { GRASS: 0, STONE: 1, WATER: 2 };

const _grad = [0, 0];

export class CharacterController {
  constructor(chunkManager) {
    this.world = chunkManager;
    this.field = chunkManager.field;

    // Simulation state (current) and the previous step (for interpolation).
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.yaw = 0;
    this.px = 0;
    this.py = 0;
    this.pz = 0;
    this.pyaw = 0;

    this.speed = 0;         // scalar ground speed along heading
    this.vy = 0;
    this.grounded = true;
    this.swimming = false;
    this.wading = false;
    this.angularVel = 0;    // rad/s, for the animation blendspace
    this.surface = SURFACE.GRASS;
    this.slope = 0;
    this.groundY = 0;

    // Animation-facing flags (edge events consumed by the rig).
    this.justLeapt = false;
    this.justLanded = false;
    this.landImpact = 0;
    this.airTime = 0;

    this.inputEnabled = true;
    this.cameraYaw = 0; // set each step by the camera rig

    // Desired movement this step.
    this._wantX = 0;
    this._wantZ = 0;
    this._wantMag = 0;
    this._wantSprint = false;
    this._wantWalk = false;
    this._wantLeap = false;

    this._collideCb = this._collide.bind(this);
    // Riding Mooshika. On foot, speeds drop and doorways open up: door
    // blockers (the mount can't go indoors) are only consulted while mounted.
    this.mounted = true;
  }

  /** Place the character on the ground at (x, z). */
  teleport(x, z) {
    this.x = this.px = x;
    this.z = this.pz = z;
    this.y = this.py = this.groundY = this.field.heightAt(x, z);
    this.speed = 0;
    this.vy = 0;
  }

  /** Called once per frame with the polled input; stored for the fixed steps. */
  setInput(input) {
    if (!this.inputEnabled) {
      this._wantMag = 0;
      this._wantSprint = false;
      this._wantLeap = false;
      return;
    }
    // Camera-relative: rotate (moveX, moveY) by the camera yaw.
    const s = Math.sin(this.cameraYaw);
    const c = Math.cos(this.cameraYaw);
    // Forward is -Z in three.js; camera yaw 0 looks down -Z.
    const fx = -s;
    const fz = -c;
    const rx = c;
    const rz = -s;
    let wx = fx * input.moveY + rx * input.moveX;
    let wz = fz * input.moveY + rz * input.moveX;
    const mag = Math.hypot(wx, wz);
    if (mag > 1e-4) {
      wx /= mag;
      wz /= mag;
    }
    this._wantX = wx;
    this._wantZ = wz;
    this._wantMag = Math.min(1, mag);
    this._wantSprint = input.sprint;
    this._wantWalk = input.walk;
    if (input.leap) this._wantLeap = true;
  }

  /** One fixed physics step. */
  step(dt) {
    // Roll current → previous for interpolation.
    this.px = this.x;
    this.py = this.y;
    this.pz = this.z;
    this.pyaw = this.yaw;
    this.justLeapt = false;
    this.justLanded = false;

    const mag = this._wantMag;
    const hasInput = mag > 0.05;

    // --- target speed tier -------------------------------------------------
    let targetSpeed = 0;
    const tiers = this.mounted ? MOVE : MOVE.foot;
    if (hasInput) {
      if (this._wantSprint) targetSpeed = tiers.sprint;
      else if (this._wantWalk || mag < 0.45) targetSpeed = tiers.walk;
      else targetSpeed = tiers.run;
      // Analog sticks ease from walk up to the tier speed.
      if (mag < 1) targetSpeed *= 0.55 + 0.45 * smoothstep(0.05, 1, mag);
    }

    // Terrain modifiers.
    if (this.swimming) targetSpeed *= MOVE.swimSpeedScale;
    else if (this.wading) targetSpeed *= MOVE.wadeSpeedScale;

    // --- heading -----------------------------------------------------------
    const prevYaw = this.yaw;
    if (hasInput) {
      const targetYaw = Math.atan2(this._wantX, this._wantZ);
      // Damped approach, then cap the angular rate so sharp reversals still
      // read as a deliberate turn rather than a snap.
      let next = dampAngle(this.yaw, targetYaw, MOVE.turnHalfLife, dt);
      const delta = shortestAngle(this.yaw, next);
      const maxDelta = MOVE.turnRate * dt;
      if (Math.abs(delta) > maxDelta) next = this.yaw + Math.sign(delta) * maxDelta;
      // While reversing hard at speed, bleed speed so the arc stays tight.
      const misalign = Math.abs(shortestAngle(this.yaw, targetYaw));
      if (misalign > 1.9 && this.speed > MOVE.walk) targetSpeed = Math.min(targetSpeed, MOVE.walk);
      this.yaw = next;
    }
    this.angularVel = shortestAngle(prevYaw, this.yaw) / dt;

    // --- slope -------------------------------------------------------------
    this.field.gradientAt(this.x, this.z, _grad);
    const gx = _grad[0];
    const gz = _grad[1];
    this.slope = Math.hypot(gx, gz);
    const hx = Math.sin(this.yaw);
    const hz = Math.cos(this.yaw);
    const uphill = hx * gx + hz * gz; // >0 means climbing
    if (uphill > 0) targetSpeed *= 1 - clamp(uphill * 0.55, 0, 0.5);
    else targetSpeed *= 1 + clamp(-uphill * 0.18, 0, 0.12);
    // Impassable slope directly ahead: stop.
    if (this.slope > MAX_SLOPE_WALKABLE && uphill > 0.25) targetSpeed = 0;

    // --- speed integration (velvety exponential damping) ------------------
    const halfLife = targetSpeed > this.speed ? 0.09 : 0.12;
    this.speed = damp(this.speed, targetSpeed, halfLife, dt);
    if (Math.abs(this.speed - targetSpeed) < 0.02) this.speed = targetSpeed;

    // --- leap --------------------------------------------------------------
    if (this._wantLeap && this.grounded && !this.swimming) {
      this.vy = this.mounted ? MOVE.leapVelocity : MOVE.foot.leapVelocity;
      this.grounded = false;
      this.justLeapt = true;
      this.airTime = 0;
    }
    this._wantLeap = false;

    // --- integrate ---------------------------------------------------------
    let nx = this.x + hx * this.speed * dt;
    let nz = this.z + hz * this.speed * dt;

    // Prop collision: push out of circles.
    this._cx = nx;
    this._cz = nz;
    this.world.queryColliders(nx, nz, this.radius + 0.5, this._collideCb);
    if (this.mounted) this.world.queryDoorBlockers(nx, nz, this.radius + 0.5, this._collideCb);
    nx = this._cx;
    nz = this._cz;

    const ground = this.field.heightAt(nx, nz);
    this.groundY = ground;

    if (!this.grounded) {
      this.vy -= MOVE.gravity * dt;
      this.airTime += dt;
      let ny = this.y + this.vy * dt;
      if (ny <= ground) {
        ny = ground;
        this.grounded = true;
        this.justLanded = true;
        this.landImpact = clamp(-this.vy / MOVE.leapVelocity, 0, 1.5);
        this.vy = 0;
      }
      this.y = ny;
    } else {
      // Ground snap. Small step-down tolerance keeps feet planted on ridges;
      // beyond it the character is airborne (walked off a ledge).
      const drop = this.y - ground;
      if (drop > 1.1 && this.speed > 1) {
        this.grounded = false;
        this.vy = 0;
        this.airTime = 0;
      } else {
        this.y = ground;
      }
    }

    // Water: float in deep channels, wade in shallows.
    const depth = WATER_LEVEL - ground;
    this.swimming = depth > 0.9;
    this.wading = depth > 0.05 && !this.swimming;
    if (this.swimming) {
      const floatY = WATER_LEVEL - 0.45;
      if (this.y < floatY) this.y = floatY;
      this.grounded = true;
      this.vy = 0;
    }

    this.surface = this.swimming || this.wading ? SURFACE.WATER : this._surfaceFor(nx, nz);

    this.x = nx;
    this.z = nz;
  }

  get radius() {
    return this.mounted ? MOVE.playerRadius : MOVE.foot.radius;
  }

  _collide(px, pz, pr) {
    const dx = this._cx - px;
    const dz = this._cz - pz;
    const rr = pr + this.radius;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr || d2 < 1e-6) return false;
    const d = Math.sqrt(d2);
    const push = (rr - d) / d;
    this._cx += dx * push;
    this._cz += dz * push;
    return false;
  }

  _surfaceFor(x, z) {
    // Stone in temple ruins / rocky hills, grass elsewhere. Uses the dominant
    // biome; cheap enough at 60 Hz.
    const b = this.field.dominantBiomeAt(x, z);
    return b === 2 || b === 4 ? SURFACE.STONE : SURFACE.GRASS; // 5 (Kailash snow) is muffled like grass
  }

  // ------------------------------------------------------------ rendering

  /** Interpolated pose for the current render frame. `out` = {x,y,z,yaw}. */
  getRenderPose(alpha, out) {
    out.x = this.px + (this.x - this.px) * alpha;
    out.y = this.py + (this.y - this.py) * alpha;
    out.z = this.pz + (this.z - this.pz) * alpha;
    out.yaw = this.pyaw + shortestAngle(this.pyaw, this.yaw) * alpha;
    return out;
  }
}
