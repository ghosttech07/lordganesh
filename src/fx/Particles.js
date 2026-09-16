// Pooled CPU particles rendered as THREE.Points. Every system owns fixed-size
// typed arrays; emit() recycles the oldest slot, update() integrates in place.
// No allocation after construction.

import * as THREE from 'three';
import { makeSoftParticle } from './ProceduralTextures.js';

let _sprite = null;

const VERT = /* glsl */ `
  attribute float aLife;
  attribute float aSize;
  attribute vec3 aColor;
  varying float vLife;
  varying vec3 vColor;
  uniform float uScale;
  void main() {
    vLife = aLife;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(4.0, -mv.z); // never balloon right at the lens
    gl_Position = projectionMatrix * mv;
  }
`;
const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uAlpha;
  varying float vLife;
  varying vec3 vColor;
  void main() {
    if (vLife <= 0.0) discard;
    vec4 t = texture2D(uMap, gl_PointCoord);
    float fade = smoothstep(0.0, 0.15, vLife) * smoothstep(0.0, 0.5, 1.0 - vLife);
    gl_FragColor = vec4(vColor, t.a * fade * uAlpha);
  }
`;

class ParticlePool {
  constructor(scene, capacity, { additive = false, alpha = 1, sizeScale = 300, simple = false } = {}) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);   // 1 → 0
    this.decay = new Float32Array(capacity);  // per-second
    this.size = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 3);
    this.drag = 1;
    this.gravity = 0;
    this.cursor = 0;
    this.alive = 0;

    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.lifeAttr = new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aLife', this.lifeAttr);
    g.setAttribute('aSize', this.sizeAttr);
    g.setAttribute('aColor', this.colAttr);
    g.setAttribute('color', this.colAttr); // for the PointsMaterial fallback
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    if (!_sprite) _sprite = makeSoftParticle(64);
    this.material = simple
      ? new THREE.PointsMaterial({
          map: _sprite, size: sizeScale * 0.004, transparent: true, opacity: alpha, depthWrite: false,
          vertexColors: true, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        })
      : new THREE.ShaderMaterial({
      uniforms: { uMap: { value: _sprite }, uAlpha: { value: alpha }, uScale: { value: sizeScale } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, lifeSec, size, r, g, b) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const o = i * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.vel[o] = vx;
    this.vel[o + 1] = vy;
    this.vel[o + 2] = vz;
    this.life[i] = 1;
    this.decay[i] = 1 / Math.max(0.05, lifeSec);
    this.size[i] = size;
    this.color[o] = r;
    this.color[o + 1] = g;
    this.color[o + 2] = b;
  }

  update(dt) {
    const n = this.capacity;
    const drag = Math.pow(this.drag, dt);
    let alive = 0;
    for (let i = 0; i < n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= this.decay[i] * dt;
      if (this.life[i] <= 0) {
        this.life[i] = 0;
        continue;
      }
      alive++;
      const o = i * 3;
      this.vel[o + 1] += this.gravity * dt;
      this.vel[o] *= drag;
      this.vel[o + 1] *= drag;
      this.vel[o + 2] *= drag;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
    }
    this.alive = alive;
    this.points.visible = alive > 0;
    if (alive > 0) {
      this.posAttr.needsUpdate = true;
      this.lifeAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
    }
  }
}

export class ParticleSystems {
  constructor(scene, chunkManager, quality, simple = false) {
    this.world = chunkManager;
    this.field = chunkManager.field;
    const q = quality.particles;
    const S = { simple };
    this.pollen = new ParticlePool(scene, Math.round(260 * q), { additive: true, alpha: 0.3, sizeScale: 40, ...S });
    this.pollen.drag = 0.9;
    this.dust = new ParticlePool(scene, Math.round(160 * q), { alpha: 0.3, sizeScale: 160, ...S });
    this.dust.drag = 0.15;
    this.dust.gravity = -0.8;
    this.smoke = new ParticlePool(scene, Math.round(160 * q), { alpha: 0.25, sizeScale: 220, ...S });
    this.smoke.drag = 0.6;
    this.burst = new ParticlePool(scene, 220, { additive: true, alpha: 0.8, sizeScale: 110, ...S });
    this.burst.drag = 0.08;
    this.burst.gravity = -6;

    this._pollenTimer = 0;
    this._smokeTimer = 0;
    this._shrineScan = 0;
    this._shrines = new Float32Array(12 * 3);
    this._shrineCount = 0;
    this._scanCb = this._onShrine.bind(this);
    this.enabled = quality.particles > 0;
  }

  _onShrine(x, y, z) {
    if (this._shrineCount >= 12) return true;
    const o = this._shrineCount * 3;
    this._shrines[o] = x;
    this._shrines[o + 1] = y;
    this._shrines[o + 2] = z;
    this._shrineCount++;
    return false;
  }

  /** Golden burst at a collected modak. */
  collectBurst(x, y, z) {
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = Math.random() * Math.PI * 0.5;
      const s = 4 + Math.random() * 7;
      this.burst.emit(
        x, y + 0.8, z,
        Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s + 3, Math.sin(a) * Math.cos(e) * s,
        0.9 + Math.random() * 0.9, 18 + Math.random() * 26,
        1.0, 0.75 + Math.random() * 0.2, 0.25
      );
    }
  }

  update(dt, ctrl, rig, camera, wind) {
    if (!this.enabled) return;
    // Pollen drifts in a volume around the camera.
    this._pollenTimer += dt;
    while (this._pollenTimer > 0.03) {
      this._pollenTimer -= 0.03;
      // Spawn in a ring 6–34 u from the camera so motes never sit on the lens.
      const ang = Math.random() * Math.PI * 2;
      const rad = 6 + Math.random() * 28;
      const cx = camera.position.x + Math.cos(ang) * rad;
      const cz = camera.position.z + Math.sin(ang) * rad;
      const gy = this.field.heightAt(cx, cz);
      this.pollen.emit(
        cx, gy + 0.5 + Math.random() * 6, cz,
        0.4 + Math.sin(wind) * 0.3, 0.25 + Math.random() * 0.3, 0.2 + Math.cos(wind * 0.7) * 0.3,
        6 + Math.random() * 6, 5 + Math.random() * 6,
        0.9, 0.82, 0.5
      );
    }

    // Dust kicked up by feet at run/sprint speeds.
    if (rig.footstepEvent >= 0 && ctrl.grounded && ctrl.speed > 8 && ctrl.surface !== 2) {
      const n = ctrl.speed > 18 ? 5 : 3;
      for (let i = 0; i < n; i++) {
        this.dust.emit(
          ctrl.x + (Math.random() - 0.5) * 0.8, ctrl.y + 0.15, ctrl.z + (Math.random() - 0.5) * 0.8,
          -Math.sin(ctrl.yaw) * 1.5 + (Math.random() - 0.5) * 1.2, 1.2 + Math.random(), -Math.cos(ctrl.yaw) * 1.5 + (Math.random() - 0.5) * 1.2,
          0.7 + Math.random() * 0.5, 14 + Math.random() * 12,
          0.76, 0.66, 0.5
        );
      }
    }

    // Incense smoke at nearby shrines (rescan every 2 s — shrines don't move).
    this._shrineScan -= dt;
    if (this._shrineScan <= 0) {
      this._shrineScan = 2;
      this._shrineCount = 0;
      this.world.queryShrines(ctrl.x, ctrl.z, 90, this._scanCb);
    }
    if (this._shrineCount > 0) {
      this._smokeTimer += dt;
      while (this._smokeTimer > 0.09) {
        this._smokeTimer -= 0.09;
        const k = (Math.random() * this._shrineCount) | 0;
        const o = k * 3;
        this.smoke.emit(
          this._shrines[o] + (Math.random() - 0.5) * 0.3, this._shrines[o + 1] + 1.0, this._shrines[o + 2] + 1.3,
          (Math.random() - 0.5) * 0.3 + Math.sin(wind) * 0.2, 0.9 + Math.random() * 0.4, (Math.random() - 0.5) * 0.3,
          3.5 + Math.random() * 2, 20 + Math.random() * 20,
          0.85, 0.82, 0.78
        );
      }
    }

    this.pollen.update(dt);
    this.dust.update(dt);
    this.smoke.update(dt);
    this.burst.update(dt);
  }
}
