// A flock of birds wheeling over the world. One InstancedMesh; wings are two
// triangles whose flap is a cheap rotation about the body axis. The flock
// drifts on a wide slow circle around the player so it is always somewhere
// in the sky without ever being in the way.

import * as THREE from 'three';

const COUNT = 16;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();

export class Birds {
  constructor(scene, field) {
    this.field = field;
    // Chevron: body + two swept wings, ~1.2 u span.
    const g = new THREE.BufferGeometry();
    const v = new Float32Array([
      0, 0, 0.25,  -0.65, 0.05, -0.2,  -0.2, 0, -0.1,
      0, 0, 0.25,  0.2, 0, -0.1,  0.65, 0.05, -0.2,
      -0.08, 0, 0.3,  0.08, 0, 0.3,  0, 0.02, -0.25,
    ]);
    g.setAttribute('position', new THREE.BufferAttribute(v, 3));
    g.computeVertexNormals();
    this.mesh = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: 0x2a221c, roughness: 0.9, side: THREE.DoubleSide }), COUNT);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    scene.add(this.mesh);
    this.t = Math.random() * 100;
    this.offsets = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      this.offsets[i * 3] = (Math.random() - 0.5) * 30;
      this.offsets[i * 3 + 1] = (Math.random() - 0.5) * 8;
      this.offsets[i * 3 + 2] = Math.random() * Math.PI * 2;
    }
    this.cx = 0;
    this.cz = 0;
  }

  update(dt, px, pz) {
    this.t += dt;
    // Flock centre follows the player slowly; the flock circles it.
    this.cx += (px - this.cx) * Math.min(1, dt * 0.05);
    this.cz += (pz - this.cz) * Math.min(1, dt * 0.05);
    const R = 90;
    const ang = this.t * 0.045;
    for (let i = 0; i < COUNT; i++) {
      const o = i * 3;
      const a = ang + this.offsets[o + 2] * 0.12;
      const x = this.cx + Math.cos(a) * (R + this.offsets[o]);
      const z = this.cz + Math.sin(a) * (R + this.offsets[o]);
      const ground = this.field.heightAt(x, z);
      const y = Math.max(ground + 30, this.field.heightAt(this.cx, this.cz) + 40) + this.offsets[o + 1] + Math.sin(this.t * 0.7 + i) * 2;
      _p.set(x, y, z);
      const flap = Math.sin(this.t * 6 + this.offsets[o + 2]) * 0.55;
      // Heading tangent to the circle; bank into the turn; flap = roll wobble.
      _e.set(0, -a + Math.PI / 2, 0.35 + flap);
      _q.setFromEuler(_e);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
