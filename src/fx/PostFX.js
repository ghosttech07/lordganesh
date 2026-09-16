// Post-processing chain (WebGL2 path).
//
//   Render → GTAO → Bloom → GodRays → Grade (chromatic aberration + vignette +
//   saffron/gold colour grade) → Output (ACES Filmic + sRGB) → SMAA
//
// Notes vs. the brief:
//  * TAA: three.js's WebGL pipeline has no motion-vector TAA; its
//    TAARenderPass is a static-scene accumulator and ghosts on movement, so
//    SMAA is used for anti-aliasing instead.
//  * SSR on water: SSRPass costs a full extra scene pass; the water material
//    uses environment reflections + fresnel instead (see Water.js).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAberration: { value: 0.00035 },
    uVignette: { value: 0.36 },
    uWarmth: { value: 0.09 },
    uSaturation: { value: 1.08 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAberration, uVignette, uWarmth, uSaturation;
    varying vec2 vUv;
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      // Subtle chromatic aberration that grows toward the edges.
      vec2 off = d * r2 * uAberration * 40.0;
      float r = texture2D(tDiffuse, vUv + off).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - off).b;
      vec3 c = vec3(r, g, b);
      // Warm saffron/gold grade: lift reds & greens a touch, pull blues.
      c *= vec3(1.0 + uWarmth, 1.0 + uWarmth * 0.45, 1.0 - uWarmth * 0.55);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      // Vignette.
      float v = 1.0 - smoothstep(0.35, 1.25, sqrt(r2) * 1.6) * uVignette;
      gl_FragColor = vec4(c * v, 1.0);
    }
  `,
};

/**
 * Sun-shaft pass. Extracts a bright mask around the sun's screen position,
 * radially blurs it, and adds it back. Tree canopies occlude the sky, which is
 * exactly what produces rays through foliage at low sun angles. Weight is
 * driven by sun elevation so it fades to nothing at midday.
 */
const GodRayShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uWeight: { value: 0.0 },
    uDecay: { value: 0.96 },
    uDensity: { value: 0.9 },
    uColor: { value: new THREE.Color(1.0, 0.82, 0.55) },
  },
  vertexShader: GradeShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSun;
    uniform float uWeight, uDecay, uDensity;
    uniform vec3 uColor;
    varying vec2 vUv;
    const int SAMPLES = 40;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uWeight <= 0.001) { gl_FragColor = base; return; }
      vec2 delta = (vUv - uSun) * (uDensity / float(SAMPLES));
      vec2 uv = vUv;
      float illum = 1.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < SAMPLES; i++) {
        uv -= delta;
        vec3 s = texture2D(tDiffuse, uv).rgb;
        // Bright-pass: only the sky/sun region contributes.
        float lum = dot(s, vec3(0.3, 0.59, 0.11));
        // Only the sun and its immediate halo seed the shafts.
        acc += s * smoothstep(1.7, 3.2, lum) * illum;
        illum *= uDecay;
      }
      float dist = distance(vUv, uSun);
      float falloff = 1.0 - smoothstep(0.2, 1.1, dist);
      gl_FragColor = vec4(base.rgb + acc / float(SAMPLES) * uColor * uWeight * falloff * 0.9, 1.0);
    }
  `,
};

export class PostFX {
  constructor(renderer, scene, camera, quality) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = quality;
    this.enabled = true;
    this._build();
  }

  _build() {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const q = this.quality;

    // MSAA on the scene target: with alphaToCoverage on leaf/grass materials
    // this turns hard alpha-test cut-outs into soft, real-looking edges.
    const size2 = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size2);
    const target = new THREE.WebGLRenderTarget(size2.x, size2.y, {
      type: THREE.HalfFloatType,
      samples: q.msaa || 0,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    if (q.ao) {
      this.gtao = new GTAOPass(this.scene, this.camera, size.x, size.y);
      this.gtao.output = GTAOPass.OUTPUT.Default;
      this.gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1, thickness: 1, scale: 1.2, samples: 12 });
      this.gtao.blendIntensity = 0.7;
      this.composer.addPass(this.gtao);
    }

    if (q.bloom) {
      this.bloom = new UnrealBloomPass(size, 0.2, 0.4, 1.9); // emissives only (lamps 2.6, modaks, sun)
      // Clamp what feeds the bloom: subtract the threshold and cap the excess,
      // so a very bright sky/sun can only ever contribute a bounded halo.
      const hp = this.bloom.materialHighPassFilter;
      hp.fragmentShader = hp.fragmentShader.replace(
        'gl_FragColor = mix( outputColor, texel, alpha );',
        `vec3 excess = max(texel.rgb - vec3(luminosityThreshold * 0.7), 0.0);
         excess = min(excess, vec3(0.9));
         gl_FragColor = mix( outputColor, vec4(excess, texel.a), alpha );`
      );
      hp.needsUpdate = true;
      this.composer.addPass(this.bloom);
    }

    if (q.godRays) {
      this.godRays = new ShaderPass(GodRayShader);
      this.composer.addPass(this.godRays);
    }

    if (q.grade) {
      this.grade = new ShaderPass(GradeShader);
      this.composer.addPass(this.grade);
    }

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    if (q.smaa) {
      this.smaa = new SMAAPass();
      this.composer.addPass(this.smaa);
    }
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
  }

  /** @param sunScreen {x,y} in 0..1, or null if the sun is off-screen. */
  updateSun(sunScreen, elevation) {
    if (!this.godRays) return;
    const u = this.godRays.uniforms;
    if (!sunScreen) {
      u.uWeight.value = 0;
      return;
    }
    u.uSun.value.set(sunScreen.x, sunScreen.y);
    // Strongest at low elevations (dawn/dusk), gone above ~35°.
    const e = Math.max(0, elevation);
    const low = 1 - Math.min(1, e / 0.6);
    u.uWeight.value = low * low * 0.5 * (elevation > -0.05 ? 1 : 0);
  }

  render(dt) {
    if (this.enabled) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.composer.dispose?.();
  }
}
