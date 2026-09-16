// Water surface material. Chunks that dip below the waterline get a water
// mesh whose per-vertex `aDepth` (water level − terrain height) was computed
// in the terrain worker, so the shader can do depth-based colour, edge fade
// and shoreline foam with no depth-buffer readback at all.

import * as THREE from 'three';
import { makeWaterNormal } from '../fx/ProceduralTextures.js';

export const waterUniforms = {
  uTime: { value: 0 },
  uNormalMap: { value: null },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
  uSkyColor: { value: new THREE.Color(0.55, 0.7, 0.95) },
  uShallow: { value: new THREE.Color(0.18, 0.5, 0.48) },
  uDeep: { value: new THREE.Color(0.03, 0.16, 0.22) },
  uDaylight: { value: 1 },
  uCameraPos: { value: new THREE.Vector3() },
  fogColor: { value: new THREE.Color() },
  fogDensity: { value: 0.004 },
};

export function createWaterMaterial(seed, simple = false) {
  if (simple) {
    // WebGPU path: no GLSL. A translucent standard material stands in.
    return new THREE.MeshStandardMaterial({
      color: 0x1f5f6a,
      transparent: true,
      opacity: 0.82,
      roughness: 0.12,
      metalness: 0.05,
      depthWrite: false,
    });
  }
  waterUniforms.uNormalMap.value = makeWaterNormal(256, seed ^ 0xa11);
  const mat = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    transparent: true,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      attribute float aDepth;
      varying float vDepth;
      varying vec3 vWorld;
      varying float vFogDepth;
      void main() {
        vDepth = aDepth;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mv = viewMatrix * wp;
        vFogDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform sampler2D uNormalMap;
      uniform vec3 uSunDir, uSunColor, uSkyColor, uShallow, uDeep, uCameraPos;
      uniform float uDaylight;
      uniform vec3 fogColor;
      uniform float fogDensity;
      varying float vDepth;
      varying vec3 vWorld;
      varying float vFogDepth;

      void main() {
        // Two scrolling normal samples at different scales → animated surface.
        vec2 uv1 = vWorld.xz * 0.055 + vec2(uTime * 0.021, uTime * 0.017);
        vec2 uv2 = vWorld.xz * 0.11 - vec2(uTime * 0.013, -uTime * 0.026);
        vec3 n1 = texture2D(uNormalMap, uv1).xyz * 2.0 - 1.0;
        vec3 n2 = texture2D(uNormalMap, uv2).xyz * 2.0 - 1.0;
        vec3 n = normalize(vec3(n1.x + n2.x, 2.6, n1.y + n2.y));

        vec3 V = normalize(uCameraPos - vWorld);
        float fresnel = pow(1.0 - max(dot(n, V), 0.0), 3.0);
        fresnel = mix(0.06, 1.0, fresnel);

        // Depth colour: shallow turquoise → deep teal.
        float d = clamp(vDepth / 3.0, 0.0, 1.0);
        vec3 body = mix(uShallow, uDeep, sqrt(d));

        // Sun specular.
        vec3 H = normalize(uSunDir + V);
        float spec = pow(max(dot(n, H), 0.0), 240.0) * 2.2 * uDaylight;

        // Reflection: sky colour by fresnel, dimmed at night.
        vec3 refl = uSkyColor * (0.35 + 0.65 * uDaylight);
        vec3 col = mix(body, refl, fresnel * 0.75) + uSunColor * spec;

        // Shoreline foam: band near zero depth with a moving break-up pattern.
        float foamMask = 1.0 - smoothstep(0.0, 0.55, vDepth);
        float foamNoise = texture2D(uNormalMap, vWorld.xz * 0.2 + vec2(uTime * 0.05, 0.0)).z;
        float foam = foamMask * smoothstep(0.45, 0.75, foamNoise + sin(uTime * 1.3 + vWorld.x * 0.4) * 0.12);
        col = mix(col, vec3(0.92, 0.95, 0.9) * (0.5 + 0.5 * uDaylight), foam * 0.8);

        // Edge fade so the surface never hard-cuts the bank.
        float alpha = smoothstep(-0.15, 0.45, vDepth) * 0.92 + foam * 0.08;

        float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
        col = mix(col, fogColor, fogF);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
  return mat;
}

/** Sync per-frame uniforms from sky/camera. */
export function updateWater(sky, camera, dt) {
  const u = waterUniforms;
  u.uTime.value += dt;
  u.uSunDir.value.copy(sky.sunDir);
  u.uDaylight.value = 1 - sky.darkness;
  u.uCameraPos.value.copy(camera.position);
  u.fogColor.value.copy(sky.scene.fog.color);
  u.fogDensity.value = sky.scene.fog.density;
  u.uSkyColor.value.copy(sky.hemi.color);
}
