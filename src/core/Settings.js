// Quality presets + persisted user settings.

export const QUALITY_PRESETS = {
  low: {
    msaa: 0,
    name: 'Low',
    pixelRatioCap: 1.0,
    shadows: false,
    cascades: 1,
    shadowMapSize: 1024,
    ao: false,
    bloom: true,
    godRays: false,
    smaa: false,
    grade: true,
    vegetationDensity: 0.35,
    cullScale: 2.2,
    terrainCastsShadow: false,
    propShadows: false,
    particles: 0.4,
    anisotropy: 2,
  },
  medium: {
    msaa: 2,
    name: 'Medium',
    pixelRatioCap: 1.5,
    shadows: true,
    cascades: 2,
    shadowMapSize: 1024,
    ao: false,
    bloom: true,
    godRays: false,
    smaa: true,
    grade: true,
    vegetationDensity: 0.6,
    cullScale: 1.5,
    terrainCastsShadow: false,
    propShadows: true,
    particles: 0.7,
    anisotropy: 4,
  },
  high: {
    msaa: 4,
    name: 'High',
    pixelRatioCap: 2.0,
    shadows: true,
    cascades: 4,
    shadowMapSize: 2048,
    ao: true,
    bloom: true,
    godRays: true,
    smaa: true,
    grade: true,
    vegetationDensity: 1.0,
    cullScale: 1.0,
    terrainCastsShadow: true,
    propShadows: true,
    particles: 1.0,
    anisotropy: 8,
  },
  ultra: {
    msaa: 4,
    name: 'Ultra',
    pixelRatioCap: 4.0,
    shadows: true,
    cascades: 4,
    shadowMapSize: 4096,
    ao: true,
    bloom: true,
    godRays: true,
    smaa: true,
    grade: true,
    vegetationDensity: 1.0,
    cullScale: 0.7,
    terrainCastsShadow: true,
    propShadows: true,
    particles: 1.3,
    anisotropy: 16,
  },
};

const STORAGE_KEY = 'endless-modak.settings.v1';

const DEFAULTS = {
  quality: 'auto',        // 'auto' | 'low' | 'medium' | 'high' | 'ultra'
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  ambientVolume: 0.7,
  mouseSensitivity: 1.0,
  gamepadSensitivity: 1.0,
  invertY: false,
  language: 'en',
  playerName: '',
  tutorialSeen: false,
  mooshikaScale: 0.68,    // size of the mount; Ganesha keeps his own size
  debug: false,
  renderer: 'webgl',      // 'webgl' | 'webgpu' (experimental)
};

export class Settings {
  constructor() {
    this.data = { ...DEFAULTS };
    this.listeners = new Set();
    this.load();
    const url = new URLSearchParams(location.search);
    if (url.has('debug')) this.data.debug = true;
    if (url.get('renderer') === 'webgpu') this.data.renderer = 'webgpu';
    if (url.has('quality')) this.data.quality = url.get('quality');
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch {
      /* private mode etc. — defaults are fine */
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      /* ignore */
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.save();
    for (const fn of this.listeners) fn(key, value);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
