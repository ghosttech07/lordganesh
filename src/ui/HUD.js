// In-game HUD. DOM for text, canvases for compass/minimap. The per-frame
// update touches the DOM only when a displayed value actually changes.

import * as THREE from 'three';
import { CHUNK_SIZE, KAILASH } from '../world/WorldConfig.js';
import { chunkKeyToCoords } from '../world/ChunkManager.js';
import { MODAK_COUNT } from '../modak/ModakSystem.js';
import { damp } from '../core/MathUtils.js';

const _v = new THREE.Vector3();
const _cc = [0, 0];
const _dist = new Float32Array(MODAK_COUNT);
const _order = new Int32Array(MODAK_COUNT);
const MAX_INDICATORS = 4;

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export class HUD {
  constructor(root, i18n, input) {
    this.i18n = i18n;
    this.input = input;
    this.root = el('div', 'hud', root);

    // Score block.
    const sb = el('div', 'hud-score', this.root);
    this.scoreLabel = el('div', 'label', sb, i18n.t('score'));
    this.scoreValue = el('div', 'value', sb, '0');
    const stats = el('div', 'hud-stats', sb);
    this.modakStat = el('span', '', stats);
    this.modakStat.innerHTML = `${i18n.t('modaks')} <b>0</b>`;
    this.streakStat = el('span', 'streak', stats);
    this.streakStat.innerHTML = `${i18n.t('streak')} <b>0</b>`;
    this.modakB = this.modakStat.querySelector('b');
    this.streakB = this.streakStat.querySelector('b');
    this.bonus = el('div', 'hud-bonus', this.root, '');

    // Compass.
    const cw = el('div', 'hud-compass', this.root);
    this.compass = el('canvas', '', cw);
    this.compass.width = 840;
    this.compass.height = 68;
    this.cctx = this.compass.getContext('2d');

    // Hunt timer (competitive mode only).
    this.timer = el('div', 'hud-timer hidden', this.root);
    this.timerLabel = el('span', 'label', this.timer, i18n.t('timeLeft'));
    this.timerValue = el('span', '', this.timer, '5:00');
    this._timerText = '';

    // Minimap.
    const mm = el('div', 'hud-minimap', this.root);
    this.minimap = el('canvas', '', mm);
    this.minimap.width = 300;
    this.minimap.height = 300;
    this.mctx = this.minimap.getContext('2d');
    this.clock = el('div', 'hud-clock', this.root, '');

    // Edge indicators (pooled).
    this.indicators = [];
    for (let i = 0; i < MODAK_COUNT; i++) {
      const d = el('div', 'edge-indicator hidden', this.root);
      const arrow = el('div', 'arrow', d);
      const q = el('span', 'q', d, '?');
      const dist = el('span', 'dist', d, '');
      this.indicators.push({ el: d, arrow, q, dist, lastText: '', shown: false, wasHidden: false });
    }

    this.hint = el('div', 'hud-hint', this.root, i18n.t('controlsHelp'));

    // Touch controls.
    const touch = el('div', 'touch', this.root);
    this.stick = el('div', 'stick', touch);
    this.nub = el('div', 'nub', this.stick);
    const mkBtn = (name, label, cls) => {
      const b = el('button', `btn ${cls}`, touch, label);
      const down = (e) => {
        e.preventDefault();
        input.touchButton(name, true);
      };
      const up = (e) => {
        e.preventDefault();
        input.touchButton(name, false);
      };
      b.addEventListener('touchstart', down, { passive: false });
      b.addEventListener('touchend', up, { passive: false });
      b.addEventListener('touchcancel', up, { passive: false });
      return b;
    };
    mkBtn('sprint', 'RUN', 'sprint');
    mkBtn('leap', 'LEAP', 'leap');
    mkBtn('pause', 'II', 'pause');
    this.mountBtn = mkBtn('mount', i18n.t('btnOff'), 'mount');

    // Context prompt (mount / dismount / call).
    this.prompt = el('div', 'hud-prompt hidden', this.root, '');
    this._promptText = '';

    // Debug overlay.
    this.debug = el('div', 'debug hidden', this.root, '');

    this.displayScore = 0;
    this.shownScore = -1;
    this.shownModaks = -1;
    this.shownStreak = -1;
    this.bonusTimer = 0;
    this.mapTimer = 0;
    this.compassTimer = 0;
    this.lastClock = '';
    this._debugTimer = 0;

    this.applyLanguage();
  }

  applyLanguage() {
    const t = this.i18n;
    this.scoreLabel.textContent = t.t('score');
    this.modakStat.firstChild.textContent = `${t.t('modaks')} `;
    this.streakStat.firstChild.textContent = `${t.t('streak')} `;
    this.hint.textContent = t.t('controlsHelp');
    this.timerLabel.textContent = t.t('timeLeft');
  }

  setVisible(v) {
    this.root.classList.toggle('hidden', !v);
  }
  setDim(v) {
    this.root.classList.toggle('dim', v);
  }

  showBonus(text) {
    this.bonus.textContent = text;
    this.bonus.classList.add('show');
    this.bonusTimer = 2.2;
  }

  /**
   * @param score  ScoreSystem
   * @param pose   character pose
   * @param camera THREE camera
   * @param modaks ModakSystem
   * @param world  ChunkManager
   * @param sky    SkySystem
   */
  update(dt, score, pose, camera, modaks, world, sky, stats) {
    // Animated count-up: score eases toward the real value.
    this.displayScore = damp(this.displayScore, score.score, 0.12, dt);
    if (score.score - this.displayScore < 0.6) this.displayScore = score.score;
    const shown = Math.round(this.displayScore);
    if (shown !== this.shownScore) {
      this.shownScore = shown;
      this.scoreValue.textContent = String(shown);
    }
    if (score.modaks !== this.shownModaks) {
      this.shownModaks = score.modaks;
      this.modakB.textContent = String(score.modaks);
    }
    if (score.streak !== this.shownStreak) {
      this.shownStreak = score.streak;
      this.streakB.textContent = String(score.streak);
      this.streakStat.classList.toggle('hot', score.streak >= 3);
    }
    if (this.bonusTimer > 0) {
      this.bonusTimer -= dt;
      if (this.bonusTimer <= 0) this.bonus.classList.remove('show');
    }

    this._updateIndicators(pose, camera, modaks);

    this.compassTimer -= dt;
    if (this.compassTimer <= 0) {
      this.compassTimer = 0.05;
      this._drawCompass(pose, camera, modaks);
    }
    this.mapTimer -= dt;
    if (this.mapTimer <= 0) {
      this.mapTimer = 0.2;
      this._drawMinimap(pose, camera, modaks, world);
      const c = sky.timeOfDayLabel;
      if (c !== this.lastClock) {
        this.lastClock = c;
        this.clock.textContent = c;
      }
    }

    // Touch joystick visual.
    const j = this.input.joystick;
    if (j.active) {
      this.stick.style.display = 'block';
      this.stick.style.left = `${j.ox - 64}px`;
      this.stick.style.top = `${j.oy - 64}px`;
      const dx = Math.max(-40, Math.min(40, j.x - j.ox));
      const dy = Math.max(-40, Math.min(40, j.y - j.oy));
      this.nub.style.transform = `translate(${dx}px, ${dy}px)`;
    } else if (document.body.classList.contains('touch-device')) {
      this.stick.style.display = 'block';
      this.stick.style.left = '28px';
      this.stick.style.bottom = '40px';
      this.stick.style.top = 'auto';
      this.nub.style.transform = 'none';
    }

    if (stats) {
      this._debugTimer -= dt;
      if (this._debugTimer <= 0) {
        this._debugTimer = 0.25;
        this.debug.textContent =
          `fps ${stats.fps.toFixed(0)}  frame ${stats.frameMs.toFixed(2)}ms  (sim ${stats.simMs.toFixed(2)} render ${stats.renderMs.toFixed(2)})\n` +
          `draw calls ${stats.calls}  tris ${(stats.triangles / 1000).toFixed(0)}k  programs ${stats.programs}\n` +
          `chunks ${stats.chunks} (pending ${stats.pending})  instances ${stats.instances}\n` +
          `pos ${pose.x.toFixed(1)} ${pose.y.toFixed(1)} ${pose.z.toFixed(1)}  speed ${stats.speed.toFixed(1)}  ${stats.renderer}  ${stats.quality}\n` +
          `sun ${sky.elevation.toFixed(2)}  heap ${stats.heap}`;
      }
    }
  }

  setDebug(v) {
    this.debug.classList.toggle('hidden', !v);
  }

  /** Mount context: 'mounted' | 'near' | 'far' | 'indoors' | null. */
  setMountPrompt(state) {
    const t = this.i18n;
    const text = state === 'mounted' ? t.t('getOff') : state === 'near' ? t.t('ride') : state === 'far' ? t.t('callMount') : state === 'indoors' ? t.t('waitsOutside') : state === 'coming' ? t.t('coming') : '';
    if (text !== this._promptText) {
      this._promptText = text;
      this.prompt.textContent = text;
      this.prompt.classList.toggle('hidden', !text);
      this.mountBtn.textContent = state === 'mounted' ? t.t('btnOff') : t.t('btnRide');
    }
  }

  /** seconds left, or null to hide. */
  setTimer(sec) {
    if (sec === null) {
      this.timer.classList.add('hidden');
      return;
    }
    this.timer.classList.remove('hidden');
    const s = Math.max(0, Math.ceil(sec));
    const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (text !== this._timerText) {
      this._timerText = text;
      this.timerValue.textContent = text;
      this.timer.classList.toggle('low', s <= 30);
    }
  }

  _updateIndicators(pose, camera, modaks) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const margin = 44;
    // Rank modaks by distance; only the nearest MAX_INDICATORS get a screen
    // marker (all of them are still on the compass and minimap).
    for (let i = 0; i < MODAK_COUNT; i++) {
      const m = modaks.modaks[i];
      _dist[i] = m.active ? Math.hypot(m.x - pose.x, m.z - pose.z) : Infinity;
      _order[i] = i;
    }
    for (let i = 1; i < MODAK_COUNT; i++) {
      const k = _order[i];
      let j = i - 1;
      while (j >= 0 && _dist[_order[j]] > _dist[k]) {
        _order[j + 1] = _order[j];
        j--;
      }
      _order[j + 1] = k;
    }
    for (let r = 0; r < MODAK_COUNT; r++) {
      const i = _order[r];
      const ind = this.indicators[i];
      const m = modaks.modaks[i];
      if (!m.active || r >= MAX_INDICATORS) {
        if (ind.shown) {
          ind.el.classList.add('hidden');
          ind.shown = false;
        }
        continue;
      }
      _v.set(m.x, m.y + 1.2, m.z).project(camera);
      const behind = _v.z > 1;
      let sx = (_v.x * 0.5 + 0.5) * w;
      let sy = (1 - (_v.y * 0.5 + 0.5)) * h;
      const onScreen = !behind && sx > margin && sx < w - margin && sy > margin && sy < h - margin;
      if (onScreen) {
        if (ind.shown) {
          ind.el.classList.add('hidden');
          ind.shown = false;
        }
        continue;
      }
      // Off-screen: project the direction onto the screen edge.
      if (behind) {
        sx = w - sx;
        sy = h - sy;
      }
      const cx = w / 2;
      const cy = h / 2;
      let dx = sx - cx;
      let dy = sy - cy;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const tx = (cx - margin) / Math.abs(dx || 1e-6);
      const ty = (cy - margin) / Math.abs(dy || 1e-6);
      const t = Math.min(tx, ty);
      const ex = cx + dx * t;
      const ey = cy + dy * t;
      const ang = Math.atan2(dy, dx) + Math.PI / 2;
      const dist = Math.hypot(m.x - pose.x, m.z - pose.z);
      // Hidden modaks: only a rough distance (to the nearest 25 m) and a "?".
      const text = m.hidden ? `~${Math.round(dist / 25) * 25} m` : `${Math.round(dist)} m`;
      if (ind.wasHidden !== m.hidden) {
        ind.wasHidden = m.hidden;
        ind.el.classList.toggle('secret', m.hidden);
      }
      ind.el.style.transform = `translate(${ex.toFixed(0)}px, ${ey.toFixed(0)}px)`;
      ind.arrow.style.transform = `rotate(${ang.toFixed(3)}rad)`;
      if (text !== ind.lastText) {
        ind.lastText = text;
        ind.dist.textContent = text;
      }
      if (!ind.shown) {
        ind.el.classList.remove('hidden');
        ind.shown = true;
      }
    }
  }

  _drawCompass(pose, camera, modaks) {
    const ctx = this.cctx;
    const W = this.compass.width;
    const H = this.compass.height;
    ctx.clearRect(0, 0, W, H);
    // Camera heading (yaw), 0 = -Z = North.
    _v.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const heading = Math.atan2(_v.x, -_v.z);
    const span = Math.PI * 0.9; // visible arc
    const pxPerRad = W / span;

    ctx.fillStyle = 'rgba(20,12,6,0.45)';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 12);
    ctx.fill();

    const draw = (angle, label, color, size) => {
      let d = angle - heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) > span / 2) return;
      const x = W / 2 + d * pxPerRad;
      ctx.fillStyle = color;
      ctx.font = `600 ${size}px "Noto Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x, H / 2);
    };
    const cardinals = [
      [0, 'N'],
      [Math.PI / 2, 'E'],
      [Math.PI, 'S'],
      [-Math.PI / 2, 'W'],
    ];
    for (const [a, l] of cardinals) draw(a, l, 'rgba(251,243,228,0.9)', 26);
    for (let k = 0; k < 8; k++) draw((k * Math.PI) / 4 + Math.PI / 8, '·', 'rgba(251,243,228,0.35)', 22);

    // Modak bearings.
    for (let i = 0; i < MODAK_COUNT; i++) {
      const m = modaks.modaks[i];
      if (!m.active) continue;
      const a = Math.atan2(m.x - pose.x, -(m.z - pose.z));
      let d = a - heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) > span / 2) continue;
      const x = W / 2 + d * pxPerRad;
      ctx.beginPath();
      ctx.moveTo(x, H - 6);
      ctx.lineTo(x - 7, H - 20);
      ctx.lineTo(x + 7, H - 20);
      ctx.closePath();
      if (m.hidden) {
        ctx.strokeStyle = '#f2c14e';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = '#f2c14e';
        ctx.fill();
      }
    }
    // Kailash bearing (white peak) with distance.
    {
      const a = Math.atan2(KAILASH.x - pose.x, -(KAILASH.z - pose.z));
      let d = a - heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) <= span / 2) {
        const x = W / 2 + d * pxPerRad;
        ctx.fillStyle = '#f4f6ff';
        ctx.beginPath();
        ctx.moveTo(x, 6);
        ctx.lineTo(x - 9, 24);
        ctx.lineTo(x + 9, 24);
        ctx.closePath();
        ctx.fill();
        const km = Math.hypot(KAILASH.x - pose.x, KAILASH.z - pose.z) / 1000;
        ctx.font = '600 14px "Noto Sans", sans-serif';
        ctx.fillText(km >= 1 ? `${km.toFixed(1)}km` : `${Math.round(km * 1000)}m`, x, 46);
      }
    }
    // Centre tick.
    ctx.fillStyle = '#f4a21c';
    ctx.fillRect(W / 2 - 1.5, 4, 3, 12);
  }

  _drawMinimap(pose, camera, modaks, world) {
    const ctx = this.mctx;
    const S = this.minimap.width;
    ctx.clearRect(0, 0, S, S);
    const scale = S / (CHUNK_SIZE * 7); // ~7 chunks across
    const cx = S / 2;
    const cy = S / 2;
    // Heading-up: rotate the world so the player's forward points to the top.
    const theta = pose.yaw + Math.PI;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(theta);
    // Explored chunks.
    ctx.fillStyle = 'rgba(242,193,78,0.16)';
    for (const key of world.explored) {
      chunkKeyToCoords(key, _cc);
      const x = (_cc[0] * CHUNK_SIZE - pose.x) * scale;
      const y = (_cc[1] * CHUNK_SIZE - pose.z) * scale;
      ctx.fillRect(x, y, CHUNK_SIZE * scale - 1, CHUNK_SIZE * scale - 1);
    }
    // Loaded chunks outline.
    ctx.strokeStyle = 'rgba(251,243,228,0.12)';
    for (const c of world._chunkList) {
      const x = (c.originX - pose.x) * scale;
      const y = (c.originZ - pose.z) * scale;
      ctx.strokeRect(x, y, CHUNK_SIZE * scale, CHUNK_SIZE * scale);
    }
    // Modaks (open = filled, hidden = ring); off-map ones clamp to the rim.
    for (let i = 0; i < MODAK_COUNT; i++) {
      const m = modaks.modaks[i];
      if (!m.active) continue;
      let x = (m.x - pose.x) * scale;
      let y = (m.z - pose.z) * scale;
      const l = Math.hypot(x, y);
      const rim = S / 2 - 8;
      if (l > rim) {
        x = (x / l) * rim;
        y = (y / l) * rim;
      }
      ctx.beginPath();
      ctx.arc(x, y, l > rim ? 3 : 4, 0, Math.PI * 2);
      if (m.hidden) {
        ctx.strokeStyle = '#ffd76a';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = l > rim ? 'rgba(242,193,78,0.6)' : '#ffd76a';
        ctx.shadowColor = '#ffb347';
        ctx.shadowBlur = l > rim ? 0 : 8;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    // Kailash marker.
    {
      let x = (KAILASH.x - pose.x) * scale;
      let y = (KAILASH.z - pose.z) * scale;
      const l = Math.hypot(x, y);
      const rim = S / 2 - 10;
      if (l > rim) {
        x = (x / l) * rim;
        y = (y / l) * rim;
      }
      ctx.fillStyle = '#f4f6ff';
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x - 5, y + 4);
      ctx.lineTo(x + 5, y + 4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Player arrow: fixed at the centre, always pointing up (forward).
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#fbf3e4';
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 3);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // North marker travels around the rim as the map rotates.
    {
      const nx = cx + Math.sin(theta) * (S / 2 - 16);
      const ny = cy - Math.cos(theta) * (S / 2 - 16);
      ctx.fillStyle = 'rgba(251,243,228,0.85)';
      ctx.font = '600 20px "Noto Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', nx, ny);
    }
  }
}
