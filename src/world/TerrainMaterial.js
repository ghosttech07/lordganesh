// Layered PBR terrain material.
//
// Four ground layers (grass, soil, rock, sand) live in two 2D texture arrays
// (albedo sRGB; normal RGB + roughness A). Per-vertex layer weights come from
// the terrain worker (biome, slope, shoreline, patch noise). In the fragment:
//   * grass/soil/sand are sampled planar in world XZ at two scales, blended to
//     kill visible tiling;
//   * rock is sampled triplanar so cliffs don't smear;
//   * the four tangent normals are blended and combined with the geometric
//     world normal, then converted to view space for three's lighting;
//   * vertex colour (biome palette) tints the result.
// Everything else — CSM shadows, IBL, fog, tonemapping — is stock
// MeshStandardMaterial, so the patch is small and survives three upgrades.

import * as THREE from 'three';
import { LAYERS } from './TerrainTextures.js';
import { SNOW_LINE } from './WorldConfig.js';

// World-space tile size per layer (units).
const TILE = { grass: 3.6, soil: 4.2, rock: 7.0, sand: 2.8, snow: 5.0 };

export function createTerrainMaterial(textures, csm, anisotropy) {
  const { size, albedo, normal } = textures;
  const L = LAYERS.length;

  const albedoArr = new THREE.DataArrayTexture(concat(albedo), size, size, L);
  albedoArr.colorSpace = THREE.SRGBColorSpace;
  const normalArr = new THREE.DataArrayTexture(concat(normal), size, size, L);
  normalArr.colorSpace = THREE.NoColorSpace;
  for (const t of [albedoArr, normalArr]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
  }

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 1.0,
    metalness: 0.0,
  });
  if (csm) csm.setupMaterial(mat);
  const prev = mat.onBeforeCompile;

  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uAlbedo = { value: albedoArr };
    shader.uniforms.uNormal = { value: normalArr };
    shader.uniforms.uInvTile = {
      value: new THREE.Vector4(1 / TILE.grass, 1 / TILE.soil, 1 / TILE.rock, 1 / TILE.sand),
    };
    shader.uniforms.uSnow = { value: new THREE.Vector3(1 / TILE.snow, SNOW_LINE, 9.0) }; // invTile, line, band

    shader.vertexShader =
      `attribute vec4 aLayers;\nvarying vec4 vLayers;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\n` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vLayers = aLayers;
         vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vWNormal = normalize(mat3(modelMatrix) * objectNormal);`
      );

    shader.fragmentShader =
      `precision highp sampler2DArray;
       uniform sampler2DArray uAlbedo;
       uniform sampler2DArray uNormal;
       uniform vec4 uInvTile;
       uniform vec3 uSnow;
       varying vec4 vLayers;
       varying vec3 vWPos;
       varying vec3 vWNormal;

       // Dual-scale planar sample: breaks repetition without a second texture.
       vec4 planar(sampler2DArray s, vec2 uv, float layer) {
         return 0.5 * (texture(s, vec3(uv, layer)) + texture(s, vec3(uv * 0.231 + 0.37, layer)));
       }
       vec4 planar1(sampler2DArray s, vec2 uv, float layer) {
         return texture(s, vec3(uv, layer));
       }
       // Triplanar with |N|^4 projection weights.
       vec4 triplanar(sampler2DArray s, vec3 p, vec3 n, float layer) {
         vec3 w = pow(abs(n), vec3(4.0));
         w /= (w.x + w.y + w.z);
         return texture(s, vec3(p.yz, layer)) * w.x + texture(s, vec3(p.xz, layer)) * w.y + texture(s, vec3(p.xy, layer)) * w.z;
       }
       vec3 tsToWorldXZ(vec3 t) { return vec3(t.x, t.z, -t.y); } // planar XZ tangent frame → world
      ` +
      shader.fragmentShader
        .replace(
          '#include <map_fragment>',
          `
          vec4 lw = vLayers / max(vLayers.x + vLayers.y + vLayers.z + vLayers.w, 1e-4);
          vec2 pxz = vWPos.xz;
          vec3 nG = normalize(vWNormal);

          vec3 alb = vec3(0.0);
          vec3 tn = vec3(0.0);      // accumulated tangent-space normal (xz frame)
          float rough = 0.0;

          if (lw.x > 0.003) { vec4 a = planar(uAlbedo, pxz * uInvTile.x, 0.0); vec4 n = planar1(uNormal, pxz * uInvTile.x, 0.0);
            alb += a.rgb * lw.x; tn += (n.xyz * 2.0 - 1.0) * lw.x; rough += n.a * lw.x; }
          if (lw.y > 0.003) { vec4 a = planar(uAlbedo, pxz * uInvTile.y, 1.0); vec4 n = planar1(uNormal, pxz * uInvTile.y, 1.0);
            alb += a.rgb * lw.y; tn += (n.xyz * 2.0 - 1.0) * lw.y; rough += n.a * lw.y; }
          if (lw.w > 0.003) { vec4 a = planar(uAlbedo, pxz * uInvTile.w, 3.0); vec4 n = planar1(uNormal, pxz * uInvTile.w, 3.0);
            alb += a.rgb * lw.w; tn += (n.xyz * 2.0 - 1.0) * lw.w; rough += n.a * lw.w; }

          vec3 rockN = vec3(0.0);
          if (lw.z > 0.003) { vec4 a = triplanar(uAlbedo, vWPos * uInvTile.z, nG, 2.0); vec4 n = triplanar(uNormal, vWPos * uInvTile.z, nG, 2.0);
            alb += a.rgb * lw.z; rough += n.a * lw.z;
            // Rock normal is applied in world space along the dominant axis (whiteout blend).
            vec3 t = n.xyz * 2.0 - 1.0;
            vec3 w = pow(abs(nG), vec3(4.0)); w /= (w.x + w.y + w.z);
            rockN = (vec3(0.0, t.x, t.y) * w.x + vec3(t.x, 0.0, t.y) * w.y + vec3(t.x, t.y, 0.0) * w.z) * lw.z;
          }

          // Biome tint from the vertex palette, applied around the texture's own luminance.
          vec3 tint = vColor.rgb / max(dot(vColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
          alb *= mix(vec3(1.0), tint * 0.7, 0.32);

          // Snow by elevation: a noisy snow line, thinner on steep faces.
          float snowNoise = texture(uAlbedo, vec3(pxz * 0.0045, 1.0)).r - 0.5;
          float steep = smoothstep(0.35, 0.75, 1.0 - nG.y);
          float snowW = smoothstep(uSnow.y - uSnow.z, uSnow.y + uSnow.z, vWPos.y + snowNoise * 14.0) * (1.0 - steep * 0.85);
          if (snowW > 0.003) {
            vec4 a = planar(uAlbedo, pxz * uSnow.x, 4.0); vec4 n = planar1(uNormal, pxz * uSnow.x, 4.0);
            alb = mix(alb, a.rgb, snowW); rough = mix(rough, n.a, snowW);
            tn = mix(tn, n.xyz * 2.0 - 1.0, snowW); rockN *= (1.0 - snowW);
          }
          diffuseColor.rgb *= alb;
          `
        )
        .replace('#include <color_fragment>', '')
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = roughness * clamp(rough, 0.35, 1.0);`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `{
            vec3 pert = tsToWorldXZ(tn) * 0.9 + rockN * 1.1;
            vec3 Nw = normalize(nG + pert * 0.8);
            normal = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
          }`
        );
  };
  mat.customProgramCacheKey = () => 'terrain-layered';
  mat.userData.arrays = [albedoArr, normalArr];
  return mat;
}

function concat(arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
