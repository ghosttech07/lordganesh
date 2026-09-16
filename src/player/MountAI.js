// Mooshika when Ganesha is on foot. He waits where he was left; when called
// he runs to Ganesha, pushing around props like the player does and stopping
// at any doorway (door blockers), then waits outside. Exposes the same
// motion fields the rig reads from the CharacterController so the mouse
// animates identically whether ridden or free.

import { moveTowards, dampAngle, shortestAngle } from '../core/MathUtils.js';
import { MOVE } from './CharacterController.js';
import { WATER_LEVEL } from '../world/WorldConfig.js';

const RUN = 12;
const ACCEL = 20;
const DECEL = 30;
const ARRIVE = 2.4;

export class MountAI {
  constructor(chunkManager) {
    this.world = chunkManager;
    this.field = chunkManager.field;
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0;
    this.px = 0; this.py = 0; this.pz = 0; this.pyaw = 0;
    this.speed = 0;
    this.angularVel = 0;
    this.vy = 0;
    this.grounded = true;
    this.justLanded = false;
    this.justLeapt = false;
    this.landImpact = 0;
    this.swimming = false;
    this.wading = false;
    this.surface = 0;
    this.slope = 0;
    this.following = false;
    this.blocked = false;
    this.avoidT = 0;
    this.avoidSign = 1;
    this.stuckT = 0;
    this.bestDist = Infinity;
    this._cx = 0; this._cz = 0;
    this._collideCb = this._collide.bind(this);
  }

  call() {
    this.following = true;
    this.blocked = false;
    this.stuckT = 0;
    this.bestDist = Infinity;
  }

  placeAt(pose) {
    this.x = this.px = pose.x;
    this.y = this.py = this.field.heightAt(pose.x, pose.z);
    this.z = this.pz = pose.z;
    this.yaw = this.pyaw = pose.yaw;
    this.speed = 0;
    this.following = false;
    this.blocked = false;
  }

  distanceTo(x, z) {
    return Math.hypot(this.x - x, this.z - z);
  }

  step(dt, tx, tz) {
    this.px = this.x; this.py = this.y; this.pz = this.z; this.pyaw = this.yaw;
    const dx = tx - this.x;
    const dz = tz - this.z;
    const dist = Math.hypot(dx, dz);
    let target = 0;
    const prevYaw = this.yaw;
    if (this.following && dist > ARRIVE) {
      let want = Math.atan2(dx, dz);
      // Steer around whatever just pushed us for a moment.
      if (this.avoidT > 0) {
        this.avoidT -= dt;
        want += this.avoidSign * 1.15;
      }
      this.yaw = dampAngle(this.yaw, want, 0.08, dt);
      const maxD = MOVE.turnRate * dt;
      const d = shortestAngle(prevYaw, this.yaw);
      if (Math.abs(d) > maxD) this.yaw = prevYaw + Math.sign(d) * maxD;
      target = dist < 8 ? RUN * 0.5 : RUN;
    } else if (this.following) {
      this.following = false; // arrived
    }
    this.angularVel = shortestAngle(prevYaw, this.yaw) / dt;
    this.speed = moveTowards(this.speed, target, (target > this.speed ? ACCEL : DECEL) * dt);

    const hx = Math.sin(this.yaw);
    const hz = Math.cos(this.yaw);
    this._cx = this.x + hx * this.speed * dt;
    this._cz = this.z + hz * this.speed * dt;
    const before = Math.hypot(this._cx - this.x, this._cz - this.z);
    this.world.queryColliders(this._cx, this._cz, MOVE.playerRadius + 0.5, this._collideCb);
    this.world.queryDoorBlockers(this._cx, this._cz, MOVE.playerRadius + 0.5, this._collideCb);
    const after = Math.hypot(this._cx - this.x, this._cz - this.z);
    // Pushed while running: pick a side to slip around the obstacle.
    if (this.following && before > 0.02 && after < before * 0.6 && this.avoidT <= 0) {
      const px = this._cx - (this.x + hx * this.speed * dt);
      const pz = this._cz - (this.z + hz * this.speed * dt);
      // Cross(heading, push) tells which side the obstacle is on.
      this.avoidSign = hx * pz - hz * px > 0 ? -1 : 1;
      this.avoidT = 0.7;
    }
    // Patience: if he hasn't gained ground in a while he gives up and waits.
    if (this.following) {
      if (dist < this.bestDist - 0.5) {
        this.bestDist = dist;
        this.stuckT = 0;
      } else {
        this.stuckT += dt;
      }
      this.blocked = this.stuckT > 4;
      if (this.blocked) {
        this.following = false;
        this.speed = 0;
      }
    } else {
      this.blocked = false;
    }
    this.x = this._cx;
    this.z = this._cz;
    const ground = this.field.heightAt(this.x, this.z);
    this.y = ground;
    const depth = WATER_LEVEL - ground;
    this.swimming = depth > 0.9;
    this.wading = depth > 0.05 && !this.swimming;
    if (this.swimming) this.y = WATER_LEVEL - 0.45;
  }

  _collide(px, pz, pr) {
    const dx = this._cx - px;
    const dz = this._cz - pz;
    const rr = pr + MOVE.playerRadius;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr || d2 < 1e-6) return false;
    const d = Math.sqrt(d2);
    const push = (rr - d) / d;
    this._cx += dx * push;
    this._cz += dz * push;
    return false;
  }

  getRenderPose(alpha, out) {
    out.x = this.px + (this.x - this.px) * alpha;
    out.y = this.py + (this.y - this.py) * alpha;
    out.z = this.pz + (this.z - this.pz) * alpha;
    out.yaw = this.pyaw + shortestAngle(this.pyaw, this.yaw) * alpha;
    return out;
  }
}
