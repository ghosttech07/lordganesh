// Sun, sky, environment lighting and the 20-minute day–night cycle.
//
// IBL: the Sky shader is baked to PMREM at several sun angles during loading,
// and the nearest bake is used as scene.environment. Baking at runtime would
// cost a visible hitch every time the sun moved, which the frame budget can't
// afford.

import * as THREE from 'three';
import { Sky as SkyShader } from 'three/addons/objects/Sky.js';
import { CSM } from 'three/addons/csm/CSM.js';
import { clamp, lerp, smoothstep } from '../core/MathUtils.js';
import { makeSoftParticle } from '../fx/ProceduralTextures.js';

export const DAY_LENGTH = 20 * 60; // seconds of real time per full cycle
const ENV_KEYFRAMES = 7;

const _sunDir = new THREE.Vector3();
const _v = new THREE.Vector3();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _skyBlue = new THREE.Color(0x5f9ce0);

export class SkySystem {
  constructor(scene, camera, renderer, quality, startPhase = 0.22) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.quality = quality;
    this.phase = startPhase; // 0..1 over the day; 0.25 = noon-ish
    this.timeScale = 1;
    this.elevation = 0;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.sunScreen = { x: 0.5, y: 0.5 };
    this.sunOnScreen = false;
    // WebGPU can't run the GLSL Sky shader or the CSM material patch; that
    // path gets a plain sky colour, a single shadowed sun and no IBL bake.
    this.simple = renderer.__kind === 'webgpu';

    this.sky = new SkyShader();
    this.sky.scale.setScalar(4000);
    this.sky.material.depthWrite = false;
    scene.add(this.sky);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 3.2;
    u.rayleigh.value = 1.15;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.8;
    if (u.cloudCoverage) {
      u.cloudCoverage.value = 0.22;
      u.cloudDensity.value = 0.55;
      u.cloudSpeed.value = 0.00002;
    }
    // The shader's sun disc is ~50+ in HDR and would flood the bloom pass
    // with a screen-wide halo. Draw a sprite sun with a controlled radiance.
    if (u.showSunDisc) u.showSunDisc.value = 0;
    this.sunSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeSoftParticle(128),
        color: 0xfff1d0,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    this.sunSprite.scale.set(70, 70, 1);
    this.sunSprite.renderOrder = -2;
    scene.add(this.sunSprite);
    if (this.simple) {
      scene.remove(this.sky);
      scene.background = new THREE.Color(0x87b6e6);
    }
    // The Sky shader's HDR output is bright enough to flood a bloom pass from
    // half the screen. Scale it so only the sun's halo crosses the threshold;
    // exposure/tonemapping is handled by the OutputPass, not here.
    this.skyScale = { value: 0.36 };
    this.sky.material.onBeforeCompile = (shader) => {
      shader.uniforms.uSkyScale = this.skyScale;
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform float uSkyScale;\nvoid main() {')
        .replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( texColor * uSkyScale, 1.0 );');
    };

    // Hemisphere fills the shadows with sky colour; directional is the sun.
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x5a4a30, 0.5);
    scene.add(this.hemi);

    if (quality.shadows && !this.simple) {
      this.csm = new CSM({
        camera,
        parent: scene,
        cascades: quality.cascades,
        shadowMapSize: quality.shadowMapSize,
        maxFar: quality.cascades >= 4 ? 260 : 140,
        mode: 'practical',
        lightIntensity: 2.3,
        lightMargin: 120,
        lightDirection: new THREE.Vector3(-0.4, -0.8, -0.3).normalize(),
      });
      this.csm.fade = true;
      for (const l of this.csm.lights) {
        l.shadow.bias = -0.00025;
        l.shadow.normalBias = 0.35;
      }
      this.sun = null;
    } else {
      this.csm = null;
      this.sun = new THREE.DirectionalLight(0xffffff, 2.6);
      if (this.simple && quality.shadows) {
        this.sun.castShadow = true;
        this.sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
        const c = this.sun.shadow.camera;
        c.left = c.bottom = -90;
        c.right = c.top = 90;
        c.near = 1;
        c.far = 500;
        this.sun.shadow.bias = -0.0005;
        this.sun.shadow.normalBias = 0.4;
      }
      scene.add(this.sun);
      scene.add(this.sun.target);
    }

    scene.fog = new THREE.FogExp2(0xd9c9a8, 0.0048);

    // Horizon skirt: a huge ground-coloured disc just below the average
    // terrain height, fully fogged at the distance it becomes visible, so the
    // sky never shows through beneath the streamed chunks' far edge.
    this.skirt = new THREE.Mesh(
      new THREE.RingGeometry(280, 4000, 48, 1),
      new THREE.MeshStandardMaterial({ color: 0x1d3436, roughness: 0.6, metalness: 0 })
    );
    this.skirt.rotation.x = -Math.PI / 2;
    this.skirt.position.y = -0.6; // reads as distant water under the fog
    this.skirt.renderOrder = -1;
    scene.add(this.skirt);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envMaps = [];
    this.envIndex = -1;
  }

  /** Bake the environment keyframes. Call during loading (async-friendly). */
  async bakeEnvironment(onProgress) {
    if (this.simple) {
      onProgress?.(1);
      return;
    }
    const skyScene = new THREE.Scene();
    const sky = new SkyShader();
    sky.scale.setScalar(4000);
    skyScene.add(sky);
    // Ambient sky light only: the sun disc is excluded from the bake (it would
    // swamp the IBL); the directional light provides the sun instead.
    const su = sky.material.uniforms;
    su.turbidity.value = 4;
    su.rayleigh.value = 1.4;
    su.mieCoefficient.value = 0.0005;
    su.mieDirectionalG.value = 0.7;
    if (su.showSunDisc) su.showSunDisc.value = 0;
    if (su.cloudCoverage) su.cloudCoverage.value = 0.0;

    for (let i = 0; i < ENV_KEYFRAMES; i++) {
      // Elevation keyframes from just below the horizon to overhead.
      const elev = lerp(-0.1, 1.35, i / (ENV_KEYFRAMES - 1));
      _sunDir.set(Math.cos(elev) * 0.6, Math.sin(elev), Math.cos(elev) * 0.8).normalize();
      su.sunPosition.value.copy(_sunDir);
      const rt = this.pmrem.fromScene(skyScene, 0.04);
      this.envMaps.push({ elev, texture: rt.texture });
      onProgress?.((i + 1) / ENV_KEYFRAMES);
      // Yield so the loading screen repaints.
      await new Promise((r) => setTimeout(r, 0));
    }
    sky.material.dispose();
    sky.geometry.dispose();
    this._applyEnv(true);
  }

  _applyEnv(force = false) {
    if (this.envMaps.length === 0) return;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.envMaps.length; i++) {
      const d = Math.abs(this.envMaps[i].elev - this.elevation);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best !== this.envIndex || force) {
      this.envIndex = best;
      this.scene.environment = this.envMaps[best].texture;
      // Night: environment contribution fades so lamps and modaks read.
    }
    this.scene.environmentIntensity = lerp(0.06, 0.32, smoothstep(-0.08, 0.35, this.elevation));
  }

  update(dt) {
    this.phase = (this.phase + (dt * this.timeScale) / DAY_LENGTH) % 1;
    if (this.sky.material.uniforms.time) this.sky.material.uniforms.time.value += dt;
    const theta = this.phase * Math.PI * 2;
    // Bias so ~70% of the cycle is daylight; night is short but real.
    this.elevation = (Math.sin(theta) * 0.75 + 0.35) * 1.3;
    const az = theta * 0.55 + 0.8;
    const ce = Math.cos(this.elevation);
    this.sunDir.set(Math.cos(az) * ce, Math.sin(this.elevation), Math.sin(az) * ce).normalize();

    // Sky.
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    this.sky.position.copy(this.camera.position);
    if (this.simple && this.scene.background) this.scene.background.copy(this.scene.fog.color).lerp(_skyBlue, 0.55);
    this.sunSprite.position.copy(this.camera.position).addScaledVector(this.sunDir, 800);
    // Radiance ~2.6 at most: enough to seed bloom/god rays, never a flood.
    const sunVis = smoothstep(-0.12, 0.05, this.elevation);
    this.sunSprite.material.color.setRGB(2.6 * sunVis, 2.3 * sunVis, 1.8 * sunVis);
    this.sunSprite.visible = sunVis > 0.001;

    const day = smoothstep(-0.05, 0.25, this.elevation);
    const golden = 1 - smoothstep(0.05, 0.45, Math.abs(this.elevation)); // near horizon
    const night = 1 - smoothstep(-0.25, 0.0, this.elevation);
    // The Sky shader keeps a bright horizon band after sunset; dim it.
    this.skyScale.value = 0.36 * lerp(0.18, 1, smoothstep(-0.2, 0.1, this.elevation));

    // Sun colour goes deep saffron at the horizon, neutral warm at noon.
    _c1.setRGB(1.0, 0.96, 0.9);
    _c2.setRGB(1.0, 0.58, 0.28);
    _c1.lerp(_c2, golden * 0.85);
    const sunIntensity = day * 2.3 * (1 - golden * 0.3);

    if (this.csm) {
      if (this.elevation > 0.02) {
        this.csm.lightDirection.copy(this.sunDir).negate();
      } else {
        // Moon: opposite side, cool and dim.
        this.csm.lightDirection.copy(this.sunDir);
        this.csm.lightDirection.y = -Math.abs(this.csm.lightDirection.y) - 0.5;
        this.csm.lightDirection.normalize();
      }
      const moon = night * 0.5;
      for (const l of this.csm.lights) {
        l.intensity = sunIntensity + moon;
        if (this.elevation > 0.02) l.color.copy(_c1);
        else l.color.setRGB(0.55, 0.65, 0.95);
      }
      this.csm.update();
    } else if (this.sun) {
      this.sun.position.copy(this.camera.position).addScaledVector(this.sunDir, 200);
      this.sun.target.position.copy(this.camera.position);
      this.sun.intensity = sunIntensity + night * 0.5;
      this.sun.color.copy(this.elevation > 0.02 ? _c1 : _c2.setRGB(0.55, 0.65, 0.95));
    }

    // Hemisphere: sky blue by day, deep indigo at night, warm ground bounce.
    this.hemi.color.setRGB(lerp(0.15, 0.72, day), lerp(0.18, 0.8, day), lerp(0.35, 1.0, day));
    this.hemi.groundColor.setRGB(lerp(0.06, 0.4, day), lerp(0.05, 0.32, day), lerp(0.08, 0.2, day));
    this.hemi.intensity = lerp(0.3, 0.38, day);

    // Fog picks up the horizon colour.
    const fog = this.scene.fog;
    // Fog matches the sky's horizon so distant terrain dissolves into it.
    fog.color.setRGB(
      lerp(0.03, lerp(0.78, 0.90, golden), day),
      lerp(0.035, lerp(0.84, 0.76, golden), day),
      lerp(0.07, lerp(0.93, 0.60, golden), day)
    );
    fog.density = lerp(0.006, 0.0044, day);
    this.skirt.position.set(this.camera.position.x, this.skirt.position.y, this.camera.position.z);

    this._applyEnv();

    // Sun screen position for god rays.
    _v.copy(this.sunDir).multiplyScalar(1000).add(this.camera.position).project(this.camera);
    this.sunOnScreen = _v.z < 1 && _v.x > -1.4 && _v.x < 1.4 && _v.y > -1.4 && _v.y < 1.4;
    this.sunScreen.x = _v.x * 0.5 + 0.5;
    this.sunScreen.y = _v.y * 0.5 + 0.5;
  }

  /** 0..1 how dark it is, for lamp/modak emissive boost. */
  get darkness() {
    return 1 - smoothstep(-0.1, 0.2, this.elevation);
  }

  get timeOfDayLabel() {
    const h = ((this.phase * 24 + 6) % 24) | 0;
    return `${String(h).padStart(2, '0')}:00`;
  }
}
