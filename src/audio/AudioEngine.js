// Procedural audio. Everything is synthesised with Web Audio so the game ships
// with zero audio files; swap any voice for a sample by loading a buffer into
// the matching `play*` method.
//
// Busses: master → { music, sfx, ambient }. Each biome ambience is a layer
// whose gain is crossfaded toward its biome weight; footsteps pick a synth
// voice by surface; the raga is a tanpura drone in Bhupali (a pentatonic
// evening raga) with a slow, sparse melodic line.

import { BIOME_COUNT } from '../world/Biomes.js';
import { SURFACE } from '../player/CharacterController.js';

const SA = 146.83; // D3 tonic
// Bhupali: Sa Re Ga Pa Dha (1, 9/8, 5/4, 3/2, 5/3)
const RAGA = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4, 5 / 2];

function noiseBuffer(ctx, seconds = 2) {
  const len = ctx.sampleRate * seconds;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    // Pink-ish noise via simple filter cascade.
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
  }
  return buf;
}

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.started = false;
    this.ambientWeights = new Float32Array(BIOME_COUNT);
    this._stepTimer = 0;
    this._melodyTimer = 0;
    this._melodyNote = 0;
    this.musicMuted = false;
  }

  /** Must be called from a user gesture. */
  start() {
    if (this.started) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = (this.ctx = new Ctx());
    this.started = true;

    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.music = ctx.createGain();
    this.sfx = ctx.createGain();
    this.ambient = ctx.createGain();
    this.music.connect(this.master);
    this.sfx.connect(this.master);
    this.ambient.connect(this.master);
    this.applyVolumes();

    this.noise = noiseBuffer(ctx, 3);
    this._buildAmbient();
    this._buildRaga();
  }

  applyVolumes() {
    if (!this.started) return;
    const s = this.settings;
    this.master.gain.value = s.get('masterVolume');
    this.music.gain.value = this.musicMuted ? 0 : s.get('musicVolume') * 0.35;
    this.sfx.gain.value = s.get('sfxVolume');
    this.ambient.gain.value = s.get('ambientVolume');
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  // --------------------------------------------------------------- ambient

  _buildAmbient() {
    const ctx = this.ctx;
    this.layers = [];
    // Per-biome: [filterType, frequency, Q, extra]
    const specs = [
      { type: 'lowpass', freq: 900, q: 0.7, water: true },   // riverbank: water hush
      { type: 'bandpass', freq: 2400, q: 1.5, birds: true }, // forest: rustle + birds
      { type: 'bandpass', freq: 500, q: 0.9, drone: true },  // temple: low drone + wind
      { type: 'highpass', freq: 1800, q: 0.6, bees: true },  // meadow: bright, insects
      { type: 'lowpass', freq: 400, q: 0.5, wind: true },    // rocky: wind
      { type: 'highpass', freq: 900, q: 0.4, wind: true },   // kailash: thin high wind
    ];
    for (let i = 0; i < BIOME_COUNT; i++) {
      const s = specs[i];
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = s.type;
      f.frequency.value = s.freq;
      f.Q.value = s.q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.ambient);
      src.start();
      // Slow LFO on filter frequency for life.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.05 + i * 0.03;
      const lg = ctx.createGain();
      lg.gain.value = s.freq * 0.25;
      lfo.connect(lg).connect(f.frequency);
      lfo.start();
      const layer = { gain: g, extra: null };
      if (s.drone) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = SA / 2;
        const og = ctx.createGain();
        og.gain.value = 0.08;
        o.connect(og).connect(g);
        o.start();
      }
      this.layers.push(layer);
    }
  }

  /** @param weights Float32Array(BIOME_COUNT) — biome membership at the player. */
  setAmbient(weights, dt) {
    if (!this.started) return;
    const k = Math.min(1, dt * 1.2);
    for (let i = 0; i < BIOME_COUNT; i++) {
      const g = this.layers[i].gain.gain;
      const target = weights[i] * 0.55;
      g.value += (target - g.value) * k;
    }
  }

  // ------------------------------------------------------------------ raga

  _buildRaga() {
    const ctx = this.ctx;
    this.ragaBus = ctx.createGain();
    this.ragaBus.gain.value = 1;
    this.ragaBus.connect(this.music);

    // Tanpura: Sa, Pa, Sa' with a slow plucking envelope emulated by LFO'd gain.
    const drones = [SA / 2, SA * 0.75, SA];
    drones.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = 900 + i * 200;
      const g = ctx.createGain();
      g.gain.value = 0.045;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.9 + i * 0.37;
      const lg = ctx.createGain();
      lg.gain.value = 0.02;
      lfo.connect(lg).connect(g.gain);
      o.connect(flt).connect(g).connect(this.ragaBus);
      o.start();
      lfo.start();
    });
  }

  _playMelodyNote() {
    const ctx = this.ctx;
    // Walk the scale with small, mostly stepwise moves — sparse and calm.
    const step = Math.random() < 0.6 ? (Math.random() < 0.5 ? 1 : -1) : (Math.random() < 0.5 ? 2 : -2);
    this._melodyNote = Math.max(0, Math.min(RAGA.length - 1, this._melodyNote + step));
    const f = SA * 2 * RAGA[this._melodyNote];
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f * 0.985, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(f, ctx.currentTime + 0.25); // meend (glide)
    const g = ctx.createGain();
    const t = ctx.currentTime;
    const dur = 1.4 + Math.random() * 1.6;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.08, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g).connect(this.ragaBus);
    o.start(t);
    o.stop(t + dur + 0.1);
  }

  toggleMusic() {
    this.musicMuted = !this.musicMuted;
    this.applyVolumes();
    return this.musicMuted;
  }

  // ----------------------------------------------------------------- sfx

  footstep(surface, intensity = 1) {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    let dur = 0.08;
    let vol = 0.25 * intensity;
    if (surface === SURFACE.STONE) {
      f.type = 'bandpass';
      f.frequency.value = 1800 + Math.random() * 600;
      f.Q.value = 2.5;
      dur = 0.06;
      vol *= 0.9;
    } else if (surface === SURFACE.WATER) {
      f.type = 'lowpass';
      f.frequency.value = 1200;
      dur = 0.22;
      vol *= 1.1;
    } else {
      f.type = 'lowpass';
      f.frequency.value = 700 + Math.random() * 300;
      dur = 0.09;
    }
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.02);
  }

  /** Temple bell: inharmonic partials with long decay. */
  bell(pitch = 1) {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const base = 660 * pitch;
    const partials = [1, 2.0, 2.41, 3.0, 4.2, 5.4];
    const amps = [1, 0.6, 0.45, 0.3, 0.2, 0.12];
    const out = ctx.createGain();
    out.gain.value = 0.35;
    out.connect(this.sfx);
    partials.forEach((p, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = base * p;
      const g = ctx.createGain();
      const decay = 2.2 / (1 + i * 0.5);
      g.gain.setValueAtTime(amps[i] * 0.3, t);
      g.gain.exponentialRampToValueAtTime(0.0005, t + decay);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + decay + 0.1);
    });
    // Strike transient.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    src.connect(g).connect(out);
    src.start(t);
    src.stop(t + 0.05);
  }

  /** Tabla sting: a 'dha' (bass + treble) followed by a quick 'tin'. */
  tabla() {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const hit = (time, f0, f1, dur, vol) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, time);
      o.frequency.exponentialRampToValueAtTime(f1, time + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + dur);
      o.connect(g).connect(this.sfx);
      o.start(time);
      o.stop(time + dur + 0.02);
    };
    hit(t, 180, 70, 0.35, 0.5);         // bayan (bass)
    hit(t, 520, 480, 0.12, 0.25);       // dayan
    hit(t + 0.16, 760, 700, 0.1, 0.22); // tin
    hit(t + 0.3, 180, 60, 0.4, 0.45);   // dha
  }

  /** Soft wrong-answer tone: a gentle descending third, no harshness. */
  softNo() {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    [440, 370].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.18);
      g.gain.linearRampToValueAtTime(0.12, t + i * 0.18 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.18 + 0.4);
      o.connect(g).connect(this.sfx);
      o.start(t + i * 0.18);
      o.stop(t + i * 0.18 + 0.45);
    });
  }

  /** Two-note whistle to call Mooshika. */
  whistle() {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(1400, t);
    o.frequency.exponentialRampToValueAtTime(2100, t + 0.12);
    o.frequency.setValueAtTime(2100, t + 0.2);
    o.frequency.exponentialRampToValueAtTime(1500, t + 0.42);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.03);
    g.gain.setValueAtTime(0.18, t + 0.16);
    g.gain.linearRampToValueAtTime(0.0001, t + 0.2);
    g.gain.linearRampToValueAtTime(0.16, t + 0.24);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.55);
  }

  uiTick() {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 880;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.1);
  }

  // --------------------------------------------------------------- update

  update(dt, ctrl, rig, biomeWeights) {
    if (!this.started) return;
    this.setAmbient(biomeWeights, dt);
    // Footsteps are driven by the rig's foot-contact events → perfectly synced.
    if (rig.footstepEvent >= 0 && ctrl.grounded) {
      const intensity = 0.4 + Math.min(1, ctrl.speed / 22) * 0.8;
      this.footstep(ctrl.surface, intensity);
    }
    if (ctrl.justLanded) this.footstep(ctrl.surface, 1.4);

    this._melodyTimer -= dt;
    if (this._melodyTimer <= 0) {
      this._melodyTimer = 2.5 + Math.random() * 4;
      if (!this.musicMuted) this._playMelodyNote();
    }
  }
}
