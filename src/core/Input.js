// Unified input. Keyboard+mouse, gamepad and touch all resolve to the same
// small state struct, so the character controller has exactly one code path
// and every device feels the same.
//
//   move   : (x, y) in -1..1, magnitude ≤ 1. y>0 = forward.
//   look   : (dx, dy) accumulated this frame in radians-ish, consumed on read.
//   sprint : bool
//   leap   : edge-triggered (true for one poll)
//   pause / confirm / back : edge-triggered

const DEAD_ZONE = 0.16;

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.moveX = 0;
    this.moveY = 0;
    this.lookDX = 0;
    this.lookDY = 0;
    this.sprint = false;
    this.walk = false;
    this.leap = false;
    this.mount = false; // edge: E key / gamepad Y / touch button
    this.pause = false;
    this.confirm = false;
    this.back = false;
    this.viewToggle = false;
    this.walkMode = false;
    this.enabled = true;
    this.pointerLocked = false;
    this.lastDevice = 'keyboard';
    this.mouseSensitivity = 0.0022;
    this.gamepadSensitivity = 2.4;
    this.invertY = false;

    this._keys = new Set();
    this._leapEdge = false;
    this._mountEdge = false;
    this._pauseEdge = false;
    this._confirmEdge = false;
    this._backEdge = false;
    this._viewToggleEdge = false;
    this._padPrev = { leap: false, pause: false, confirm: false, back: false, sprint: false, view: false };

    this._touch = {
      active: false,
      id: -1,
      ox: 0,
      oy: 0,
      x: 0,
      y: 0,
      lookId: -1,
      lookX: 0,
      lookY: 0,
      sprint: false,
    };

    this._bind();
  }

  // ---------------------------------------------------------------- binding

  _bind() {
    const c = this.canvas;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this._keys.add(e.code);
      this.lastDevice = 'keyboard';
      if (e.code === 'Space') this._leapEdge = true;
      if (e.code === 'KeyE') this._mountEdge = true;
      if (e.code === 'Escape') this._pauseEdge = true;
      if (e.code === 'Enter') this._confirmEdge = true;
      if (e.code === 'KeyV') this._viewToggleEdge = true;
      if (e.code === 'KeyZ') this.walkMode = !this.walkMode;
      if (e.code === 'Space' && !this.enabled) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
    window.addEventListener('blur', () => this._keys.clear());

    c.addEventListener('mousedown', () => {
      if (this.enabled && !this.pointerLocked && !this._isTouchDevice()) {
        c.requestPointerLock?.();
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === c;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.lastDevice = 'keyboard';
      this.lookDX += e.movementX * this.mouseSensitivity;
      this.lookDY += e.movementY * this.mouseSensitivity * (this.invertY ? -1 : 1);
    });

    // Touch: left half = virtual joystick, right half = look drag.
    const t = this._touch;
    c.addEventListener(
      'touchstart',
      (e) => {
        this.lastDevice = 'touch';
        for (const touch of e.changedTouches) {
          const half = window.innerWidth * 0.5;
          if (touch.clientX < half && t.id === -1) {
            t.id = touch.identifier;
            t.ox = touch.clientX;
            t.oy = touch.clientY;
            t.x = t.ox;
            t.y = t.oy;
            t.active = true;
          } else if (t.lookId === -1) {
            t.lookId = touch.identifier;
            t.lookX = touch.clientX;
            t.lookY = touch.clientY;
          }
        }
        e.preventDefault();
      },
      { passive: false }
    );
    c.addEventListener(
      'touchmove',
      (e) => {
        for (const touch of e.changedTouches) {
          if (touch.identifier === t.id) {
            t.x = touch.clientX;
            t.y = touch.clientY;
          } else if (touch.identifier === t.lookId) {
            this.lookDX += (touch.clientX - t.lookX) * 0.006;
            this.lookDY += (touch.clientY - t.lookY) * 0.006;
            t.lookX = touch.clientX;
            t.lookY = touch.clientY;
          }
        }
        e.preventDefault();
      },
      { passive: false }
    );
    const endTouch = (e) => {
      for (const touch of e.changedTouches) {
        if (touch.identifier === t.id) {
          t.id = -1;
          t.active = false;
        }
        if (touch.identifier === t.lookId) t.lookId = -1;
      }
    };
    c.addEventListener('touchend', endTouch);
    c.addEventListener('touchcancel', endTouch);

    window.addEventListener('gamepadconnected', () => {
      this.lastDevice = 'gamepad';
    });
  }

  _isTouchDevice() {
    return 'ontouchstart' in window && navigator.maxTouchPoints > 0;
  }

  /** Called by the touch HUD buttons. */
  touchButton(name, down) {
    if (name === 'sprint') this._touch.sprint = down;
    if (name === 'leap' && down) this._leapEdge = true;
    if (name === 'mount' && down) this._mountEdge = true;
    if (name === 'view' && down) this._viewToggleEdge = true;
    if (name === 'pause' && down) this._pauseEdge = true;
  }

  releasePointer() {
    if (this.pointerLocked) document.exitPointerLock?.();
  }

  // ---------------------------------------------------------------- polling

  /** Snapshot all devices into the public fields. Call once per frame. */
  poll(dt) {
    let mx = 0;
    let my = 0;
    let sprint = false;
    let walk = false;

    // Keyboard.
    const k = this._keys;
    if (k.has('KeyW') || k.has('ArrowUp')) my += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) my -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (k.has('ShiftLeft') || k.has('ShiftRight')) sprint = true;
    if (this.walkMode || k.has('ControlLeft') || k.has('KeyC') || k.has('AltLeft')) walk = true;
    if (mx !== 0 && my !== 0) {
      const inv = 1 / Math.sqrt(mx * mx + my * my);
      mx *= inv;
      my *= inv;
    }
    if (mx !== 0 || my !== 0) this.lastDevice = 'keyboard';

    // Gamepad (standard mapping).
    const pads = navigator.getGamepads ? navigator.getGamepads() : null;
    if (pads) {
      for (let i = 0; i < pads.length; i++) {
        const gp = pads[i];
        if (!gp || !gp.connected) continue;
        let lx = gp.axes[0] || 0;
        let ly = -(gp.axes[1] || 0);
        let mag = Math.hypot(lx, ly);
        if (mag > DEAD_ZONE) {
          // Rescale so the dead-zone edge maps to 0, full deflection to 1.
          const s = Math.min(1, (mag - DEAD_ZONE) / (1 - DEAD_ZONE)) / mag;
          lx *= s;
          ly *= s;
          mx = lx;
          my = ly;
          this.lastDevice = 'gamepad';
        }
        let rx = gp.axes[2] || 0;
        let ry = gp.axes[3] || 0;
        if (Math.abs(rx) < DEAD_ZONE) rx = 0;
        if (Math.abs(ry) < DEAD_ZONE) ry = 0;
        if (rx !== 0 || ry !== 0) {
          this.lookDX += rx * this.gamepadSensitivity * dt;
          this.lookDY += ry * this.gamepadSensitivity * dt * (this.invertY ? -1 : 1);
          this.lastDevice = 'gamepad';
        }
        const b = gp.buttons;
        const btn = (n) => !!(b[n] && b[n].pressed);
        if (btn(10) || btn(7) || btn(2)) sprint = true; // LS click / RT / X
        const leapNow = btn(0);
        const mountNow = btn(3);
        if (mountNow && !this._padPrev.mount) this._mountEdge = true;
        this._padPrev.mount = mountNow;
        const pauseNow = btn(9);
        const confirmNow = btn(0);
        const backNow = btn(1);
        if (leapNow && !this._padPrev.leap) this._leapEdge = true;
        if (pauseNow && !this._padPrev.pause) this._pauseEdge = true;
        if (confirmNow && !this._padPrev.confirm) this._confirmEdge = true;
        if (backNow && !this._padPrev.back) this._backEdge = true;
        this._padPrev.leap = leapNow;
        this._padPrev.pause = pauseNow;
        this._padPrev.confirm = confirmNow;
        this._padPrev.back = backNow;
        break;
      }
    }

    // Touch joystick.
    const t = this._touch;
    if (t.active) {
      const R = 64;
      let jx = (t.x - t.ox) / R;
      let jy = -(t.y - t.oy) / R;
      const mag = Math.hypot(jx, jy);
      if (mag > 1) {
        jx /= mag;
        jy /= mag;
      }
      if (mag > 0.08) {
        mx = jx;
        my = jy;
      }
      this.lastDevice = 'touch';
    }
    if (t.sprint) sprint = true;

    this.moveX = mx;
    this.moveY = my;
    this.sprint = sprint;
    this.walk = walk;

    // Edge-triggered buttons: true for exactly one poll.
    this.leap = this._leapEdge;
    this.mount = this._mountEdge;
    this._mountEdge = false;
    this.pause = this._pauseEdge;
    this.confirm = this._confirmEdge;
    this.back = this._backEdge;
    this.viewToggle = this._viewToggleEdge;
    this._leapEdge = this._pauseEdge = this._confirmEdge = this._backEdge = this._viewToggleEdge = false;
  }

  /** Read and clear the accumulated look delta. Writes into `out` = {x, y}. */
  consumeLook(out) {
    out.x = this.lookDX;
    out.y = this.lookDY;
    this.lookDX = 0;
    this.lookDY = 0;
    return out;
  }

  /** Joystick visual state for the touch HUD. */
  get joystick() {
    return this._touch;
  }
}
