// Mount Kailash as a far landmark.
//
// Streamed chunks only reach ~320 u and fog hides them beyond that, so a
// mountain 1 km away would be invisible. This builds one coarse mesh of the
// *actual* height field around the peak (so it matches the terrain exactly),
// colours it by elevation (rock / snow line), and renders it with a much
// weaker fog term. It sits 1.5 u below the real surface, so where chunks are
// loaded they cover it; beyond them it carries the silhouette to the horizon.

import * as THREE from 'three';
import { KAILASH, SNOW_LINE } from './WorldConfig.js';

export function createKailashLandmark(field, csm) {
  const R = KAILASH.plateauRadius * 1.15;
  const N = 84;
  const step = (R * 2) / N;
  const verts = (N + 1) * (N + 1);
  const pos = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  const grad = [0, 0];
  let i = 0;
  for (let j = 0; j <= N; j++) {
    for (let k = 0; k <= N; k++) {
      const x = KAILASH.x - R + k * step;
      const z = KAILASH.z - R + j * step;
      const y = field.heightAt(x, z) - 1.5;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      field.gradientAt(x, z, grad, 3);
      const slope = Math.hypot(grad[0], grad[1]);
      const n = field.nDetail.noise01(x / 60, z / 60) - 0.5;
      const snow = smooth(SNOW_LINE - 10, SNOW_LINE + 10, y + n * 16) * (1 - smooth(0.5, 1.1, slope) * 0.85);
      // Rock (grey-brown) → highland green low down → snow.
      const green = 1 - smooth(20, 45, y);
      let r = 0.36 + green * 0.02, g = 0.34 + green * 0.08, b = 0.32 - green * 0.05;
      r += (0.9 - r) * snow;
      g += (0.92 - g) * snow;
      b += (0.96 - b) * snow;
      col[i * 3] = r;
      col[i * 3 + 1] = g;
      col[i * 3 + 2] = b;
      i++;
    }
  }
  const idx = new Uint32Array(N * N * 6);
  let q = 0;
  for (let j = 0; j < N; j++) {
    for (let k = 0; k < N; k++) {
      const a = j * (N + 1) + k;
      const b = a + 1;
      const c = a + N + 1;
      const d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  if (csm) csm.setupMaterial(mat);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    // Aerial perspective, but ~4x thinner than the scene fog so the peak reads from afar.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
         float landmarkFog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth * 0.07);
         gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(landmarkFog, 0.0, 0.92));
       #endif`
    );
  };
  mat.customProgramCacheKey = () => 'landmark';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.frustumCulled = true;
  mesh.name = 'kailash-landmark';
  return mesh;
}

function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
