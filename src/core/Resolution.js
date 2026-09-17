// Adaptive render resolution.
//
// The game renders at the device's native pixel ratio (that is what makes a
// phone screen look sharp), and this controller is the safety net: if the
// frame rate stays low it steps the pixel ratio down a notch at a time, and
// once things are comfortably smooth again it steps back up toward the target.
// Steps are deliberately slow and hysteretic so the picture never "breathes".

const STEP = 0.25;
const LOW_FPS = 44; // sustained below this → step down
const HIGH_FPS = 57; // sustained above this → step up (if below target)
const LOW_HOLD = 2.5; // seconds
const HIGH_HOLD = 12;
const COOLDOWN = 4; // seconds between changes
const WARMUP = 6; // ignore the first seconds (shaders compiling, chunks streaming)

export class ResolutionController {
  constructor(engine, target, min = 1) {
    this.engine = engine;
    this.target = target;
    this.min = Math.min(min, target);
    this.current = target;
    this._low = 0;
    this._high = 0;
    this._cool = WARMUP;
    this.enabled = true;
  }

  setTarget(target) {
    this.target = target;
    this.min = Math.min(this.min, target);
    this.current = target;
    this._low = this._high = 0;
    this._cool = COOLDOWN;
    this.engine.setPixelRatio(target);
  }

  update(dt, fps) {
    if (!this.enabled) return;
    if (this._cool > 0) {
      this._cool -= dt;
      return;
    }
    if (fps < LOW_FPS) {
      this._low += dt;
      this._high = 0;
      if (this._low >= LOW_HOLD && this.current > this.min + 1e-3) {
        this.current = Math.max(this.min, this.current - STEP);
        this._apply();
      }
    } else if (fps > HIGH_FPS) {
      this._high += dt;
      this._low = 0;
      if (this._high >= HIGH_HOLD && this.current < this.target - 1e-3) {
        this.current = Math.min(this.target, this.current + STEP);
        this._apply();
      }
    } else {
      this._low = this._high = 0;
    }
  }

  _apply() {
    this._low = this._high = 0;
    this._cool = COOLDOWN;
    this.engine.setPixelRatio(this.current);
  }
}
