// Game orchestrator: boots every system, owns the state machine, and wires
// events between world, player, modaks, questions, UI and audio.

import * as THREE from 'three';
import { Settings, QUALITY_PRESETS } from './core/Settings.js';
import { detectDeviceTier } from './core/DeviceTier.js';
import { createRenderer, Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { EventBus } from './core/EventBus.js';
import { ScoreSystem } from './core/ScoreSystem.js';
import { hashString } from './core/MathUtils.js';
import { BIOME_COUNT } from './world/Biomes.js';
import { PropLibrary, windUniform } from './world/PropLibrary.js';
import { ChunkManager } from './world/ChunkManager.js';
import { createKailashLandmark } from './world/Landmark.js';
import { SkySystem } from './world/Sky.js';
import { updateWater } from './world/Water.js';
import { CharacterController } from './player/CharacterController.js';
import { MountAI } from './player/MountAI.js';
import { MooshikaRig } from './player/MooshikaRig.js';
import { loadGaneshaGLB } from './player/GaneshaRig.js';
import { CameraRig } from './player/CameraRig.js';
import { ModakSystem } from './modak/ModakSystem.js';
import { QuestionSystem } from './questions/QuestionSystem.js';
import { Leaderboard } from './leaderboard/Leaderboard.js';
import { Identity } from './leaderboard/Identity.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { ParticleSystems } from './fx/Particles.js';
import { Birds } from './fx/Birds.js';
import { PostFX } from './fx/PostFX.js';
import { I18n } from './ui/i18n.js';
import { HUD } from './ui/HUD.js';
import { QuestionCard } from './ui/QuestionCard.js';
import { PuzzleCard } from './ui/PuzzleCard.js';
import { MatchCard } from './ui/MatchCard.js';
import { Menus } from './ui/Menus.js';

const STATE = { LOADING: 0, MENU: 1, PLAYING: 2, QUESTION: 3, PAUSED: 4, SUMMARY: 5 };
const HUNT_SECONDS = 0; // 0 = untimed: the hunt runs until the player ends it

function bakeTerrainTextures(seed, size) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./world/textures.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      resolve(e.data);
      w.terminate();
    };
    w.onerror = (e) => {
      console.warn('terrain texture bake failed, using flat shading', e);
      resolve(null);
      w.terminate();
    };
    w.postMessage({ seed, size });
  });
}

const _pose = { x: 0, y: 0, z: 0, yaw: 0 };
const _mountPose = { x: 0, y: 0, z: 0, yaw: 0 };
const _door = { x: 0, z: 0 };
const MOUNT_RANGE = 4.5;
const _v = new THREE.Vector3();
const _biomeW = new Float32Array(BIOME_COUNT);

export class Game {
  constructor(canvas, uiRoot) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.state = STATE.LOADING;
    this.events = new EventBus();
    this.THREE = THREE; // handy for console/debug tooling
  }

  async boot() {
    this.settings = new Settings();
    this.i18n = new I18n(this.settings);
    document.documentElement.lang = this.i18n.lang;
    this.device = detectDeviceTier();
    if (this.device.isMobile) document.body.classList.add('touch-device');

    const qKey = this.settings.get('quality') === 'auto' ? this.device.tier : this.settings.get('quality');
    this.quality = QUALITY_PRESETS[qKey] || QUALITY_PRESETS.medium;
    this.qualityKey = qKey;

    // Seed: shared daily seed by default; ?seed=anything overrides.
    const url = new URLSearchParams(location.search);
    this.seed = url.has('seed') ? hashString(url.get('seed')) : Leaderboard.dailySeed();

    this._showLoading(0, this.i18n.t('loading'));

    // Renderer, scene, camera.
    this.renderer = await createRenderer(this.canvas, this.settings, this.quality);
    const simple = this.renderer.__kind === 'webgpu'; // experimental path: no GLSL features
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.3, 900);
    this.engine = new Engine(this.renderer, this.camera);
    this.engine.onResize = (w, h) => this.postfx?.setSize(w, h);

    // Terrain PBR layers bake in a worker while the sky bakes on the GPU.
    const texSize = this.quality.anisotropy >= 8 ? 1024 : 512;
    const texturesPromise = simple ? Promise.resolve(null) : bakeTerrainTextures(this.seed, texSize);
    const ganeshaPromise = loadGaneshaGLB(); // 16 MB textured model; streams while the world bakes

    // Lighting/sky with baked IBL keyframes.
    this.sky = new SkySystem(this.scene, this.camera, this.renderer, this.quality, 0.985); // golden morning
    await this.sky.bakeEnvironment((p) => this._showLoading(p * 0.4));
    const terrainTextures = await texturesPromise;
    this._showLoading(0.5);

    // World.
    this.props = new PropLibrary().build(this.sky.csm);
    this.world = new ChunkManager({ scene: this.scene, seed: this.seed, props: this.props, csm: this.sky.csm, quality: this.quality, simple, terrainTextures });
    this.scene.add(createKailashLandmark(this.world.field, this.sky.csm));
    this._showLoading(0.6);

    // Player.
    this.controller = new CharacterController(this.world);
    this.mountAI = new MountAI(this.world);
    this.rig = new MooshikaRig(this.scene);
    this.rig.setMouseScale(this.settings.get('mooshikaScale'));
    // Textured Ganesha (public/models/ganesha.glb) if present; procedural otherwise.
    const ganeshaModel = await ganeshaPromise;
    if (ganeshaModel) this.rig.useGaneshaModel(ganeshaModel);
    this.cameraRig = new CameraRig(this.camera, this.world);
    this.input = new Input(this.canvas);
    this._applyInputSettings();

    // Modaks, questions, score.
    this.modaks = new ModakSystem(this.scene, this.world, this.seed, this.events, simple);
    this.questions = new QuestionSystem(this.seed ^ (Date.now() & 0xffff));
    this.score = new ScoreSystem();
    this.leaderboard = new Leaderboard();
    this.identity = new Identity(this.leaderboard);

    // Effects, audio.
    this.particles = new ParticleSystems(this.scene, this.world, this.quality, simple);
    this.birds = new Birds(this.scene, this.world.field);
    this.audio = new AudioEngine(this.settings);
    if (this.renderer.__kind === 'webgl2') {
      this.postfx = new PostFX(this.renderer, this.scene, this.camera, this.quality);
      this.engine.resize();
    }

    // UI.
    this.hud = new HUD(this.uiRoot, this.i18n, this.input);
    this.hud.setVisible(false);
    this.hud.setDebug(this.settings.get('debug'));
    this.card = new QuestionCard(this.uiRoot, this.i18n, this.audio);
    this.puzzle = new PuzzleCard(this.uiRoot, this.i18n, this.audio);
    this.match = new MatchCard(this.uiRoot, this.i18n, this.audio);
    this.mode = 'free';
    this.huntLeft = 0;
    this.menus = new Menus(this.uiRoot, this.i18n, this.settings, this.leaderboard, this.audio);
    this.menus.deviceInfo = this.device;
    this.menus.questionSystem = this.questions;
    this.menus.identity = this.identity;
    this.menus.seed = this.seed;
    this._wireUI();

    this.events.on('modak:reached', (i) => this._onModakReached(i));

    // Spawn the player and pre-stream the starting area.
    this._findSpawn();
    this.cameraRig.reset(this.controller.x, this.controller.y, this.controller.z, this.controller.yaw);
    this.world.update(this.controller.x, this.controller.z, this.camera);
    await this._waitForChunks(1, (p) => this._showLoading(0.6 + p * 0.4));
    this.modaks.populate(this.controller.x, this.controller.z, this.camera);

    this._hideLoading();
    this.engine.onFixed = (dt) => this._fixed(dt);
    this.engine.onFrame = (dt, alpha) => this._frame(dt, alpha);
    this.engine.onRender = (dt) => this._render(dt);
    this.engine.start();
    this._enterMenu();
  }

  // ------------------------------------------------------------ loading

  _showLoading(p, msg) {
    if (!this._loading) {
      const d = document.createElement('div');
      d.className = 'loading';
      d.innerHTML = `<div class="om">ॐ</div><div class="bar"><i></i></div><div class="msg"></div>`;
      this.uiRoot.appendChild(d);
      this._loading = d;
    }
    this._loading.querySelector('.bar i').style.width = `${Math.round(p * 100)}%`;
    if (msg) this._loading.querySelector('.msg').textContent = msg;
  }
  _hideLoading() {
    this._loading?.remove();
    this._loading = null;
  }

  _waitForChunks(radius, onProgress) {
    return new Promise((resolve) => {
      const need = (radius * 2 + 1) ** 2;
      const check = () => {
        this.world.update(this.controller.x, this.controller.z, this.camera);
        let ready = 0;
        const cx = this.world.playerCX;
        const cz = this.world.playerCZ;
        for (let dz = -radius; dz <= radius; dz++)
          for (let dx = -radius; dx <= radius; dx++)
            if (this.world.isChunkLoaded(cx + dx, cz + dz)) ready++;
        onProgress?.(ready / need);
        if (ready >= need) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
  }

  _findSpawn() {
    const f = this.world.field;
    const scratch = [0, 0];
    for (let r = 0; r < 600; r += 9) {
      for (let a = 0; a < Math.PI * 2; a += 0.5) {
        const x = 64 + Math.cos(a) * r;
        const z = 64 + Math.sin(a) * r;
        if (f.isWalkable(x, z, scratch) && f.heightAt(x, z) > 1.5) {
          this.controller.teleport(x, z);
          return;
        }
      }
    }
    this.controller.teleport(64, 64);
  }

  // ---------------------------------------------------------------- UI

  _wireUI() {
    const m = this.menus;
    m.on('play', (mode) => this._startRun(mode || 'free'));
    m.on('resume', () => this._resume());
    m.on('endRun', () => this._endRun());
    m.on('settingsChanged', (key) => {
      if (key === 'quality' || key === 'renderer') {
        m.toast('Reloading to apply…');
        setTimeout(() => location.reload(), 500);
      } else if (key === 'debug') {
        this.hud.setDebug(this.settings.get('debug'));
      } else if (key.endsWith('Volume')) {
        this.audio.applyVolumes();
      } else if (key === 'mooshikaScale') {
        this.rig.setMouseScale(this.settings.get('mooshikaScale'));
      } else {
        this._applyInputSettings();
      }
    });
    this.i18n.onChange(() => {
      this.hud.applyLanguage();
      document.documentElement.lang = this.i18n.lang;
    });
    this.card.onAnswer = (correct, idx) => this._onAnswer(correct, idx);
    this.card.onClose = (correct) => this._afterQuestion(correct);
    this.puzzle.onAnswer = (correct, answer) => this._onPuzzleAnswer(correct, answer);
    this.puzzle.onClose = (correct) => this._afterQuestion(correct);
    this.match.onAnswer = (correct, answer) => { this.questions.answerMatch(this.presentation, correct, answer); this._applyAnswer(correct); };
    this.match.onClose = (correct) => this._afterQuestion(correct);

    // Audio must start on a user gesture; the first click/key anywhere does it.
    const gesture = () => {
      this.audio.start();
      this.audio.resume();
      window.removeEventListener('pointerdown', gesture);
      window.removeEventListener('keydown', gesture);
    };
    window.addEventListener('pointerdown', gesture);
    window.addEventListener('keydown', gesture);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM' && this.state === STATE.PLAYING) this.audio.toggleMusic();
      if (e.code === 'F3') {
        e.preventDefault();
        this.settings.set('debug', !this.settings.get('debug'));
        this.hud.setDebug(this.settings.get('debug'));
      }
    });
  }

  _applyInputSettings() {
    this.input.mouseSensitivity = 0.0022 * this.settings.get('mouseSensitivity');
    this.input.gamepadSensitivity = 2.4 * this.settings.get('gamepadSensitivity');
    this.input.invertY = this.settings.get('invertY');
  }

  // ------------------------------------------------------------- states

  _enterMenu() {
    this.state = STATE.MENU;
    this.controller.inputEnabled = false;
    this.cameraRig.enabled = false;
    this.input.enabled = false;
    this.input.releasePointer();
    this.hud.setVisible(false);
    this.menus.showMain();
    // Retry any score that couldn't be sent earlier (never from the frame loop).
    this.leaderboard.flushQueue().catch(() => {});
  }

  _startRun(mode = 'free') {
    this.menus.close();
    this.mode = mode;
    if (!this.controller.mounted) this._mount();
    // Hunt: more modaks hide indoors and the clock runs; re-seat every modak.
    this.modaks.hiddenFraction = mode === 'hunt' ? 0.5 : 0.4;
    for (const m of this.modaks.modaks) {
      m.active = false;
      m.group.visible = false;
    }
    this.modaks.frozenIndex = -1;
    this.modaks.populate(this.controller.x, this.controller.z, this.camera);
    this.huntLeft = mode === 'hunt' && HUNT_SECONDS > 0 ? HUNT_SECONDS : 0;
    this.hud.setTimer(this.huntLeft > 0 ? this.huntLeft : null);
    this.score.reset();
    this.hud.displayScore = 0;
    this.questions.missed.length = 0;
    this.state = STATE.PLAYING;
    this.controller.inputEnabled = true;
    this.cameraRig.enabled = true;
    this.input.enabled = true;
    this.hud.setVisible(true);
    this.hud.setDim(false);
    this.audio.start();
    this.audio.resume();
    if (!this.device.isMobile) this.canvas.requestPointerLock?.();
  }

  _pause() {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.PAUSED;
    this.controller.inputEnabled = false;
    this.cameraRig.enabled = false;
    this.input.enabled = false;
    this.input.releasePointer();
    this.hud.setDim(true);
    this.menus.showPause();
  }

  _resume() {
    this.menus.close();
    this.state = STATE.PLAYING;
    this.controller.inputEnabled = true;
    this.cameraRig.enabled = true;
    this.input.enabled = true;
    this.hud.setDim(false);
    if (!this.device.isMobile) this.canvas.requestPointerLock?.();
  }

  async _endRun() {
    this.menus.close();
    this.state = STATE.SUMMARY;
    this.controller.inputEnabled = false;
    this.input.enabled = false;
    this.input.releasePointer();
    this.hud.setVisible(false);
    this.hud.setTimer(null);
    const payload = this.score.toSubmission(this.identity.claimed ? this.identity.name : this.settings.get('playerName') || 'Bhakta', this.seed, this.mode);
    let result;
    try {
      result = await this.leaderboard.submit(payload, this.identity.secret);
    } catch (err) {
      result = { ok: false, reason: String(err.message || err) };
    }
    this.menus.showSummary(this.score, result, this.mode);
  }

  // -------------------------------------------------------------- modaks

  _onModakReached(index) {
    if (this.state !== STATE.PLAYING) {
      this.modaks.frozenIndex = -1;
      return;
    }
    this.state = STATE.QUESTION;
    this.activeModak = index;
    this.controller.inputEnabled = false;
    this.input.releasePointer();
    this.hud.setDim(true);
    this.audio.uiTick();
    // Indoor modaks pose a puzzle (arrange-in-order or match-the-pairs);
    // open ones a question (multiple choice or fill-the-blank shloka).
    if (this.modaks.modaks[index].hidden) {
      if (Math.random() < 0.5) {
        this.presentation = this.questions.nextMatch(this.score.score);
        this.match.show(this.presentation);
      } else {
        this.presentation = this.questions.nextPuzzle(this.score.score);
        this.puzzle.show(this.presentation);
      }
    } else {
      this.presentation = this.questions.next(this.score.score);
      this.card.show(this.presentation);
    }
  }

  _onPuzzleAnswer(correct, answer) {
    this.questions.answerPuzzle(this.presentation, correct, answer);
    this._applyAnswer(correct);
  }

  _onAnswer(correct, chosenIndex) {
    this.questions.answer(this.presentation, chosenIndex);
    this._applyAnswer(correct);
  }

  _applyAnswer(correct) {
    if (correct) {
      const bonus = this.score.onCorrect();
      this.modaks.positionOf(this.activeModak, _v);
      this.particles.collectBurst(_v.x, _v.y - 1, _v.z);
      this.audio.bell(0.9 + Math.min(0.4, this.score.streak * 0.04));
      this.modaks.collect(this.activeModak, this.controller.x, this.controller.z, this.camera);
      if (bonus) {
        this.audio.tabla();
        this.hud.showBonus(`${this.i18n.t('streakBonus')} +${bonus}`);
      }
    } else {
      this.score.onWrong();
      this.audio.softNo();
    }
  }

  _afterQuestion(correct) {
    if (this.state !== STATE.QUESTION) return;
    if (!correct) this.modaks.release(this.activeModak);
    this.state = STATE.PLAYING;
    this.controller.inputEnabled = true;
    this.hud.setDim(false);
    if (!this.device.isMobile) this.canvas.requestPointerLock?.();
  }

  // -------------------------------------------------------------- loop

  _fixed(dt) {
    if (this.state === STATE.PAUSED || this.state === STATE.MENU || this.state === STATE.SUMMARY) return;
    this.controller.step(dt);
    if (!this.controller.mounted) {
      // He runs to Ganesha — or, if Ganesha is indoors, to the doorway outside.
      let tx = this.controller.x;
      let tz = this.controller.z;
      const indoors = this.world.isIndoors(tx, tz);
      if (indoors && this.world.nearestDoorOutside(tx, tz, _door)) {
        tx = _door.x;
        tz = _door.z;
      }
      this.mountAI.step(dt, tx, tz);
      // Safety recall: if he gave up far away, bring him to a spot just behind Ganesha.
      if (this.mountAI.blocked && this._calling && !indoors && this.mountAI.distanceTo(this.controller.x, this.controller.z) > 12) {
        const c = this.controller;
        _door.x = c.x - Math.sin(c.yaw) * 5;
        _door.z = c.z - Math.cos(c.yaw) * 5;
        if (!this.world.isIndoors(_door.x, _door.z)) {
          this.mountAI.placeAt({ x: _door.x, z: _door.z, yaw: c.yaw });
          this.mountAI.call();
        }
      }
      // Called and arrived beside Ganesha (outdoors): hop on.
      if (this._calling && this.mountAI.distanceTo(this.controller.x, this.controller.z) < MOUNT_RANGE) {
        this._calling = false;
        if (!indoors) this._mount();
      }
    }
  }

  // ------------------------------------------------------------ mounting

  _toggleMount() {
    const c = this.controller;
    if (c.mounted) {
      c.getRenderPose(1, _pose);
      this.mountAI.placeAt(_pose);
      c.mounted = false;
      this.rig.setMounted(false, _pose);
      this.audio.uiTick();
      return;
    }
    const near = this.mountAI.distanceTo(c.x, c.z) < MOUNT_RANGE;
    const indoors = this.world.isIndoors(c.x, c.z);
    if (near && !indoors) {
      this._mount();
    } else {
      // Whistle from anywhere — indoors too; he'll wait by the door.
      this._calling = true;
      this.mountAI.call();
      this.audio.whistle();
    }
  }

  _mount() {
    const c = this.controller;
    c.mounted = true;
    this._calling = false;
    this.mountAI.following = false;
    this.rig.setMounted(true);
    this.audio.uiTick();
  }

  _mountPromptState() {
    const c = this.controller;
    if (c.tooDeep) return 'deep';
    if (c.mounted) return 'mounted';
    if (this.world.isIndoors(c.x, c.z)) return 'indoors';
    if (this.mountAI.distanceTo(c.x, c.z) < MOUNT_RANGE) return 'near';
    return this._calling && this.mountAI.following ? 'coming' : 'far';
  }

  _frame(dt, alpha) {
    this.input.poll(dt);

    if (this.input.pause) {
      if (this.state === STATE.PLAYING) this._pause();
      else if (this.state === STATE.PAUSED) this._resume();
    }
    if (this.input.confirm && this.state === STATE.QUESTION) {
      this.card.gamepadConfirm();
      this.puzzle.gamepadConfirm();
      this.match.gamepadConfirm();
    }

    // Modak Hunt clock (only when a time limit is configured): ends the run at zero.
    if (this.mode === 'hunt' && HUNT_SECONDS > 0 && (this.state === STATE.PLAYING || this.state === STATE.QUESTION)) {
      this.huntLeft -= dt;
      this.hud.setTimer(this.huntLeft);
      if (this.huntLeft <= 0) {
        if (this.state === STATE.QUESTION) {
          this.card.hide();
          this.puzzle.hide();
          this.match.hide();
          this.modaks.frozenIndex = -1;
        }
        this._endRun();
        return;
      }
    }

    if (this.input.mount && this.state === STATE.PLAYING) this._toggleMount();

    const simulating = this.state === STATE.PLAYING || this.state === STATE.QUESTION;
    if (simulating) {
      if (this.input.viewToggle) this.cameraRig.cycleViewMode();
      this.controller.cameraYaw = this.cameraRig.moveYaw;
      this.controller.setInput(this.input);
    } else {
      // Keep look deltas from accumulating while a menu is open.
      this.input.lookDX = this.input.lookDY = 0;
    }

    const paused = this.state === STATE.PAUSED || this.state === STATE.MENU || this.state === STATE.SUMMARY;
    const worldDt = paused ? 0 : dt;

    this.controller.getRenderPose(paused ? 1 : alpha, _pose);
    if (this.controller.mounted) {
      this.rig.update(_pose, this.controller, worldDt);
    } else {
      this.mountAI.getRenderPose(paused ? 1 : alpha, _mountPose);
      this.rig.update(_mountPose, this.mountAI, worldDt);   // Mooshika on his own
      this.rig.updateWalker(_pose, this.controller, worldDt); // Ganesha on the lotus
    }
    this.cameraRig.update(_pose, this.controller, this.input, dt);
    this.camera.updateMatrixWorld();

    this.world.update(_pose.x, _pose.z, this.camera);
    this.sky.update(worldDt);
    windUniform.value += worldDt;
    updateWater(this.sky, this.camera, worldDt);
    this.modaks.update(worldDt, _pose.x, _pose.y, _pose.z, this.camera, this.sky.darkness);
    const mouseMotion = this.controller.mounted ? this.controller : this.mountAI;
    this.particles.update(worldDt, mouseMotion, this.rig, this.camera, windUniform.value);
    this.birds.update(worldDt, _pose.x, _pose.z);

    this.world.field.biomeWeightsAt(_pose.x, _pose.z, _biomeW);
    this.audio.update(worldDt, mouseMotion, this.rig, _biomeW);

    this.card.update(dt);
    this.puzzle.update(dt);
    this.match.update(dt);
    if (this.state !== STATE.MENU && this.state !== STATE.SUMMARY) {
      const st = this.settings.get('debug') ? this._debugStats() : null;
      this.hud.update(dt, this.score, _pose, this.camera, this.modaks, this.world, this.sky, st);
      this.hud.setMountPrompt(this.state === STATE.PLAYING ? this._mountPromptState() : null);
    }
    this.postfx?.updateSun(this.sky.sunOnScreen ? this.sky.sunScreen : null, this.sky.elevation);
  }

  _debugStats() {
    const s = this.engine.stats;
    s.chunks = this.world.stats.loaded;
    s.pending = this.world.stats.pending;
    s.instances = this.world.stats.instances;
    s.speed = this.controller.speed;
    s.renderer = this.renderer.__kind;
    s.quality = this.qualityKey;
    return s;
  }

  _render(dt) {
    if (this.postfx) this.postfx.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}
