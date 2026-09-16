// Exactly MODAK_COUNT modaks are alive at any time. All meshes, lights, beams
// and mote systems are created once and pooled; spawn/despawn only toggles
// visibility and rewrites positions. update() allocates nothing.

import * as THREE from 'three';
import { WATER_LEVEL } from '../world/WorldConfig.js';
import { mulberry32 } from '../core/MathUtils.js';
import { makeSoftParticle } from '../fx/ProceduralTextures.js';

export const MODAK_COUNT = 12;
export const COLLECT_RADIUS = 3;
const SPAWN_MIN = 60;
const SPAWN_MAX = 400;
const MIN_SEPARATION = 45;
const LIGHT_COUNT = 4;         // nearest N modaks get a real point light
const WRONG_COOLDOWN = 5.0;    // seconds

const _frustum = new THREE.Frustum();
const _projView = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _slope = [0, 0];

/** Modak profile: rounded base, pinched pleated top. */
function makeModakGeometry() {
  const pts = [];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // Bulbous body, then quick taper to a tip.
    const r = t < 0.7 ? Math.sin(t * Math.PI * 0.72) * 0.62 + 0.02 : (1 - t) * 1.1 * 0.62;
    pts.push(new THREE.Vector2(Math.max(0.001, r), t * 1.05));
  }
  const g = new THREE.LatheGeometry(pts, 20);
  // Pleats: displace radially by a periodic ripple around the axis.
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = pos.getY(i);
    const a = Math.atan2(z, x);
    const ripple = 1 + Math.sin(a * 9) * 0.045 * Math.min(1, y * 1.6);
    pos.setXYZ(i, x * ripple, y, z * ripple);
  }
  g.computeVertexNormals();
  return g;
}

const BeamShader = {
  uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(1.0, 0.8, 0.35) }, uStrength: { value: 1 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform float uTime, uStrength;
    uniform vec3 uColor;
    varying vec2 vUv;
    void main() {
      float v = vUv.y;
      // Soft fade at both ends, brighter near the ground.
      float a = smoothstep(0.0, 0.08, v) * (1.0 - smoothstep(0.35, 1.0, v));
      a *= 0.55 + 0.45 * sin(uTime * 1.7 + v * 12.0) * 0.25 + 0.4;
      gl_FragColor = vec4(uColor * 1.2, a * 0.22 * uStrength);
    }
  `,
};

const MoteShader = {
  uniforms: { uTime: { value: 0 }, uMap: { value: null }, uSize: { value: 22 } },
  vertexShader: /* glsl */ `
    attribute float aSeed;
    uniform float uTime, uSize;
    varying float vAlpha;
    void main() {
      float t = uTime * (0.35 + aSeed * 0.4) + aSeed * 30.0;
      float ang = aSeed * 6.2831 + t * 0.9;
      float r = 0.9 + sin(t * 1.3 + aSeed * 9.0) * 0.5;
      float y = fract(t * 0.25 + aSeed) * 3.2;
      vec3 p = vec3(cos(ang) * r, y, sin(ang) * r);
      vAlpha = (1.0 - abs(y / 3.2 - 0.5) * 2.0);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = uSize * (0.6 + aSeed * 0.6) / max(1.0, -mv.z * 0.15);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uMap;
    varying float vAlpha;
    void main() {
      vec4 t = texture2D(uMap, gl_PointCoord);
      gl_FragColor = vec4(vec3(1.0, 0.85, 0.45) * 1.5, t.a * vAlpha * 0.9);
    }
  `,
};

class Modak {
  constructor(index, geometry, material, beamMat, moteMat) {
    this.index = index;
    this.active = false;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.cooldownUntil = 0;
    this.needsExit = false; // re-arms only after the player leaves the radius
    this.hidden = false;    // inside a house/hut/cave: no beam, "?" indicator
    this.phase = Math.random() * Math.PI * 2;

    this.group = new THREE.Group();
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = true;
    this.mesh.scale.setScalar(1.15);
    this.group.add(this.mesh);

    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.9, 60, 12, 1, true), beamMat);
    this.beam.position.y = 30;
    this.beam.renderOrder = 8;
    this.group.add(this.beam);

    const N = 24;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const seeds = new Float32Array(N);
    for (let i = 0; i < N; i++) seeds[i] = i / N;
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.6, 0), 3);
    this.motes = new THREE.Points(g, moteMat);
    this.motes.renderOrder = 9;
    this.group.add(this.motes);

    this.light = null; // assigned dynamically from the light pool
    this.group.visible = false;
  }
}

export class ModakSystem {
  constructor(scene, chunkManager, seed, events, simple = false) {
    this.scene = scene;
    this.world = chunkManager;
    this.field = chunkManager.field;
    this.events = events;
    this.rand = mulberry32((seed ^ 0x51ab) >>> 0);
    this.time = 0;

    this.geometry = makeModakGeometry();
    this.material = new THREE.MeshStandardMaterial({
      color: 0xf2b53a,
      metalness: 0.62,
      roughness: 0.28,
      emissive: 0x6a3d05,
      emissiveIntensity: 0.55,
    });
    const sprite = makeSoftParticle(64);
    if (simple) {
      // WebGPU path: no GLSL. Plain additive materials stand in.
      this.beamMaterial = new THREE.MeshBasicMaterial({
        color: 0xffcc66, transparent: true, opacity: 0.12, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      this.moteMaterial = new THREE.PointsMaterial({
        map: sprite, color: 0xffd28a, size: 0.35, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    } else {
      this.beamMaterial = new THREE.ShaderMaterial({
        uniforms: BeamShader.uniforms,
        vertexShader: BeamShader.vertexShader,
        fragmentShader: BeamShader.fragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      MoteShader.uniforms.uMap.value = sprite;
      this.moteMaterial = new THREE.ShaderMaterial({
        uniforms: MoteShader.uniforms,
        vertexShader: MoteShader.vertexShader,
        fragmentShader: MoteShader.fragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    }

    this.group = new THREE.Group();
    this.group.name = 'modaks';
    scene.add(this.group);

    this.modaks = [];
    for (let i = 0; i < MODAK_COUNT; i++) {
      const m = new Modak(i, this.geometry, this.material, this.beamMaterial, this.moteMaterial);
      this.group.add(m.group);
      this.modaks.push(m);
    }

    this.lights = [];
    for (let i = 0; i < LIGHT_COUNT; i++) {
      const l = new THREE.PointLight(0xffb347, 0, 16, 2);
      l.position.y = 1.4;
      this.group.add(l);
      this.lights.push(l);
    }
    this._lightOrder = new Int32Array(MODAK_COUNT);
    this._lightDist = new Float32Array(MODAK_COUNT);

    this.frozenIndex = -1; // modak currently in question flow
    this.spawnedTotal = 0;
    // Share of modaks hidden inside shelters. Raised in Modak Hunt mode.
    this.hiddenFraction = 0.25;
    this._shelters = new Float32Array(96 * 4);
    this._shelterCount = 0;
    this._shelterCb = this._onShelter.bind(this);
    this._blockCb = this._onBlock.bind(this);
    this._blocked = false;
    this._probeX = 0;
    this._probeZ = 0;
  }

  _onShelter(x, y, z, rotY) {
    if (this._shelterCount >= 96) return true;
    const o = this._shelterCount * 4;
    this._shelters[o] = x;
    this._shelters[o + 1] = y;
    this._shelters[o + 2] = z;
    this._shelters[o + 3] = rotY;
    this._shelterCount++;
    return false;
  }

  _onBlock(cx, cz, cr) {
    const dx = cx - this._probeX;
    const dz = cz - this._probeZ;
    const rr = cr + 0.9; // player radius + margin
    if (dx * dx + dz * dz < rr * rr) {
      this._blocked = true;
      return true;
    }
    return false;
  }

  /** True if the path from the interior out through the door (+z local) is clear. */
  _approachClear(x, z, rotY) {
    const dx = Math.sin(rotY);
    const dz = Math.cos(rotY);
    // Probe from just outside the doorway to 9 u out; the building's own wall
    // circles flank the doorway and never sit on this line.
    for (let d = 3.5; d <= 9; d += 0.75) {
      this._probeX = x + dx * d;
      this._probeZ = z + dz * d;
      this._blocked = false;
      this.world.queryColliders(this._probeX, this._probeZ, 1.0, this._blockCb);
      if (this._blocked) return false;
    }
    return true;
  }

  /** Try to place `m` inside a house/hut/cave interior in the spawn ring. */
  _spawnHidden(m, px, pz) {
    this._shelterCount = 0;
    this.world.queryShelters(px, pz, SPAWN_MAX, this._shelterCb);
    // Random start, walk the list: first usable shelter wins.
    const n = this._shelterCount;
    if (n === 0) return false;
    const start = (this.rand() * n) | 0;
    for (let k = 0; k < n; k++) {
      const o = ((start + k) % n) * 4;
      const x = this._shelters[o];
      const y = this._shelters[o + 1];
      const z = this._shelters[o + 2];
      const rotY = this._shelters[o + 3];
      const d = Math.hypot(x - px, z - pz);
      if (d < 45) continue;
      if (!this._approachClear(x, z, rotY)) continue;
      let tooClose = false;
      for (let i = 0; i < MODAK_COUNT; i++) {
        const other = this.modaks[i];
        if (!other.active || other === m) continue;
        if (Math.hypot(other.x - x, other.z - z) < 18) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      this._place(m, x, y, z);
      m.hidden = true;
      m.beam.visible = false;
      return true;
    }
    return false;
  }

  /** Fill the world with the initial set. Call once chunks near the player exist. */
  populate(px, pz, camera) {
    for (const m of this.modaks) if (!m.active) this._spawn(m, px, pz, camera, false);
  }

  _spawn(m, px, pz, camera, avoidFrustum) {
    // Some modaks hide indoors; the rest glow in the open.
    const hiddenNow = this.modaks.reduce((n, o) => n + (o.active && o.hidden && o !== m ? 1 : 0), 0);
    if (hiddenNow < Math.round(MODAK_COUNT * this.hiddenFraction) && this._spawnHidden(m, px, pz)) return true;
    if (avoidFrustum) {
      _projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_projView);
    }
    let minD = SPAWN_MIN;
    let maxD = SPAWN_MAX;
    for (let attempt = 0; attempt < 90; attempt++) {
      // After many failures, relax the ring so we always converge.
      if (attempt === 45) {
        minD = 40;
        maxD = 220;
      }
      const ang = this.rand() * Math.PI * 2;
      const dist = minD + this.rand() * (maxD - minD);
      const x = px + Math.cos(ang) * dist;
      const z = pz + Math.sin(ang) * dist;

      if (!this.field.isWalkable(x, z, _slope)) continue;
      const y = this.field.heightAt(x, z);
      if (y < WATER_LEVEL + 0.6) continue;
      // Props are only known for streamed chunks; require the chunk so the
      // "never inside a prop" guarantee is real, not probabilistic.
      if (!this.world.isChunkReady(x, z)) continue;
      if (this.world.isInsideProp(x, z, 1.6)) continue;

      let tooClose = false;
      for (let i = 0; i < MODAK_COUNT; i++) {
        const o = this.modaks[i];
        if (!o.active || o === m) continue;
        const dx = o.x - x;
        const dz = o.z - z;
        if (dx * dx + dz * dz < MIN_SEPARATION * MIN_SEPARATION) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      if (avoidFrustum && attempt < 70) {
        _v.set(x, y + 1, z);
        if (_frustum.containsPoint(_v)) continue;
      }

      this._place(m, x, y, z);
      return true;
    }
    // Last resort: nearest walkable spot on a spiral; the modak still spawns.
    for (let r = 50; r < 400; r += 12) {
      for (let a = 0; a < Math.PI * 2; a += 0.6) {
        const x = px + Math.cos(a) * r;
        const z = pz + Math.sin(a) * r;
        if (this.field.isWalkable(x, z, _slope) && !this.world.isInsideProp(x, z, 1.6)) {
          this._place(m, x, this.field.heightAt(x, z), z);
          return true;
        }
      }
    }
    return false;
  }

  _place(m, x, y, z) {
    m.active = true;
    m.x = x;
    m.y = y;
    m.z = z;
    m.cooldownUntil = 0;
    m.needsExit = false;
    m.hidden = false;
    m.beam.visible = true;
    m.group.position.set(x, y, z);
    m.group.visible = true;
    this.spawnedTotal++;
  }

  /** Called by the game after a correct answer. */
  collect(index, px, pz, camera) {
    const m = this.modaks[index];
    m.active = false;
    m.group.visible = false;
    this.frozenIndex = -1;
    this._spawn(m, px, pz, camera, true);
  }

  /**
   * Called when the question card closes after a wrong answer: the modak
   * stays, can't re-trigger for 5 s, and not until the player has stepped
   * out of its radius and back in.
   */
  release(index) {
    const m = this.modaks[index];
    m.cooldownUntil = this.time + WRONG_COOLDOWN;
    m.needsExit = true;
    this.frozenIndex = -1;
  }

  update(dt, px, py, pz, camera, darkness) {
    this.time += dt;
    BeamShader.uniforms.uTime.value = this.time;
    MoteShader.uniforms.uTime.value = this.time;
    // Beams read stronger at night, calmer by day.
    BeamShader.uniforms.uStrength.value = 0.5 + darkness * 0.3;
    this.material.emissiveIntensity = 0.45 + darkness * 0.9;

    let nearestIdx = -1;
    let nearestD2 = Infinity;

    for (let i = 0; i < MODAK_COUNT; i++) {
      const m = this.modaks[i];
      if (!m.active) {
        this._lightDist[i] = Infinity;
        continue;
      }
      // Bob & rotate.
      const t = this.time + m.phase;
      m.mesh.position.y = 0.9 + Math.sin(t * 1.4) * 0.18;
      m.mesh.rotation.y = t * 0.7;

      const dx = m.x - px;
      const dz = m.z - pz;
      const d2 = dx * dx + dz * dz;
      this._lightDist[i] = d2;
      this._lightOrder[i] = i;
      if (d2 < nearestD2) {
        nearestD2 = d2;
        nearestIdx = i;
      }

      // Motes + beam only matter within a few hundred units; skip the rest.
      const far = d2 > 380 * 380;
      if (m.motes.visible === far) m.motes.visible = !far;
    }

    // Assign the point-light pool to the nearest N modaks (insertion sort on
    // 12 entries is cheaper than anything clever and allocates nothing).
    for (let i = 1; i < MODAK_COUNT; i++) {
      const key = this._lightOrder[i];
      let j = i - 1;
      while (j >= 0 && this._lightDist[this._lightOrder[j]] > this._lightDist[key]) {
        this._lightOrder[j + 1] = this._lightOrder[j];
        j--;
      }
      this._lightOrder[j + 1] = key;
    }
    for (let l = 0; l < LIGHT_COUNT; l++) {
      const idx = this._lightOrder[l];
      const light = this.lights[l];
      const m = this.modaks[idx];
      if (!m || !m.active || this._lightDist[idx] === Infinity) {
        light.intensity = 0;
        continue;
      }
      light.position.set(m.x, m.y + 1.6, m.z);
      light.intensity = 2.5 + darkness * 7;
    }

    // Re-arm modaks the player has walked away from.
    const exitR2 = (COLLECT_RADIUS + 1.5) * (COLLECT_RADIUS + 1.5);
    for (let i = 0; i < MODAK_COUNT; i++) {
      const m = this.modaks[i];
      if (m.needsExit && m.active && this._lightDist[i] > exitR2) m.needsExit = false;
    }

    // Collection trigger.
    if (this.frozenIndex === -1 && nearestIdx >= 0 && nearestD2 < COLLECT_RADIUS * COLLECT_RADIUS) {
      const m = this.modaks[nearestIdx];
      if (this.time >= m.cooldownUntil && !m.needsExit) {
        this.frozenIndex = nearestIdx;
        this.events.emit('modak:reached', nearestIdx);
      }
    }
  }

  /** Position of modak i into `out` (Vector3). */
  positionOf(i, out) {
    const m = this.modaks[i];
    return out.set(m.x, m.y + 1, m.z);
  }
}
