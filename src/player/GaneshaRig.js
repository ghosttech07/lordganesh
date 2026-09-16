// Ganesha as a single textured mesh (image-to-3D GLB) brought to life without
// a hand-made skeleton.
//
// The mesh is auto-skinned by *spatial region*: vertices inside the head
// volume (crown, ears, trunk) bind to a head bone pivoting at the neck; the
// four hands bind to wrist bones; everything else stays on the root. Weights
// fade over a small band so nothing tears. Blinking uses two skin-toned
// eyelid shells placed on the face by raycasting for the eye surface, then
// scaled shut/open. The result: he turns his head, looks into turns, waves
// the abhaya hand, sways the upper arms and blinks — on a mesh that shipped
// with no rig at all.
//
// Region fractions below are expressed in the mesh's own bounding box
// (0..1 in height, ±0.5 in width/depth) so they survive any rescale.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, damp, smoothstep } from '../core/MathUtils.js';

// Region layout for a seated, four-armed, front-facing Ganesha (+Z = front).
export const REGIONS = {
  waistY: 0.31,         // below this the crossed legs / dhoti live (collapsed when standing)
  neckY: 0.58,          // head pivot height (fraction of height)
  headBand: 0.05,       // weight fade band around neckY
  headHalfWidth: 0.30,  // |x| limit for the head region at neck height (excludes hands)
  trunkMinY: 0.40,      // trunk hangs below the neck: front-centre vertices above this are head
  trunkHalfWidth: 0.14,
  hands: [
    // name, side (x sign), yMin, yMax, |x|Min, pivot fraction (x, y, z)
    { name: 'handLowerL', sx: -1, yMin: 0.42, yMax: 0.66, xMin: 0.26, pivot: [-0.33, 0.44, 0.02] },
    { name: 'handLowerR', sx: 1, yMin: 0.40, yMax: 0.60, xMin: 0.26, pivot: [0.33, 0.42, 0.02] },
    { name: 'handUpperL', sx: -1, yMin: 0.60, yMax: 1.05, xMin: 0.30, pivot: [-0.36, 0.60, 0.0] },
    { name: 'handUpperR', sx: 1, yMin: 0.60, yMax: 1.05, xMin: 0.30, pivot: [0.36, 0.60, 0.0] },
  ],
  eyes: { y: 0.735, x: 0.075, size: 0.024 }, // eye centres (fractions), lid radius (fraction of height)
};

const _v = new THREE.Vector3();
const _ray = new THREE.Raycaster();

export class GaneshaRig {
  /** @param source THREE.Object3D containing one or more meshes (GLB scene or a baked stand-in) */
  constructor(source, { height = 1.9 } = {}) {
    this.root = new THREE.Group();
    this.root.name = 'ganesha-glb';

    // Merge everything into one geometry so a single SkinnedMesh carries the model.
    const geos = [];
    let material = null;
    source.updateMatrixWorld(true);
    source.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      // Drop attributes that differ between parts so merging is possible.
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      if (!g.attributes.normal) g.computeVertexNormals();
      geos.push(g.index ? g.toNonIndexed() : g);
      if (!material) material = Array.isArray(o.material) ? o.material[0] : o.material;
    });
    const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const size = new THREE.Vector3();
    bb.getSize(size);
    // Normalise: feet at y=0, centred in x/z, scaled to `height`.
    const s = height / size.y;
    geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    geo.scale(s, s, s);
    geo.computeBoundingBox();
    this.height = height;
    this.width = size.x * s;
    this.depth = size.z * s;

    this._skin(geo);

    if (material && material.isMeshStandardMaterial) {
      material.envMapIntensity = 1.4;
      material.roughness = Math.min(material.roughness ?? 1, 0.75);
    }
    this.mesh = new THREE.SkinnedMesh(geo, material || new THREE.MeshStandardMaterial({ color: 0xd8a068 }));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.add(this.bones.root);
    this.mesh.bind(this.skeleton);
    this.root.add(this.mesh);

    this._eyelids(material);

    this.blinkT = 2 + Math.random() * 3;
    this.blink = 0; // 0 open → 1 closed
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.lookTargetYaw = 0;
    this.lookTargetPitch = 0;
    this.lookTimer = 1;
    this.wave = 0;
    this.idleT = 0;
  }

  // -------------------------------------------------------------- skinning

  _skin(geo) {
    const H = this.height;
    const W = this.width;
    const R = REGIONS;
    const bones = {};
    const mk = (name, x, y, z, parent) => {
      const b = new THREE.Bone();
      b.name = name;
      b.position.set(x, y, z);
      if (parent) parent.add(b);
      bones[name] = b;
      return b;
    };
    const root = mk('root', 0, 0, 0, null);
    const head = mk('head', 0, R.neckY * H, 0.02 * H, root);
    const handBones = R.hands.map((h) => mk(h.name, h.pivot[0] * W, h.pivot[1] * H, h.pivot[2] * W, root));
    const legs = mk('legs', 0, R.waistY * H, 0, root);
    this.bones = bones;
    this.legsBone = legs;
    const list = [root, head, ...handBones, legs];
    this.skeleton = new THREE.Skeleton(list);
    this.headBone = head;
    this.handBones = handBones;

    const pos = geo.attributes.position;
    const n = pos.count;
    const idx = new Uint16Array(n * 4);
    const wgt = new Float32Array(n * 4);
    const tmpW = new Float32Array(list.length);

    for (let i = 0; i < n; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const fy = y / H;
      const fx = x / W;
      const fz = z / W;
      tmpW.fill(0);

      // Head: above the neck (fading over headBand). The wide zone on either
      // side holds ears (behind, fz small) AND the raised hands/implements (in
      // front, fz larger; and above the ears). Ears stay with the head; hands
      // and implements are excluded by depth, or outright above the ear line.
      let wHead = smoothstep(R.neckY - R.headBand, R.neckY + R.headBand, fy);
      const wide = smoothstep(R.headHalfWidth, R.headHalfWidth + 0.06, Math.abs(fx));
      if (wide > 0) {
        const aboveEars = smoothstep(0.78, 0.84, fy);
        const inFront = smoothstep(0.08, 0.18, fz);
        wHead *= 1 - wide * Math.max(aboveEars, inFront);
      }
      // Trunk: front-centre column below the neck follows the head.
      if (fy < R.neckY + R.headBand && fy > R.trunkMinY && Math.abs(fx) < R.trunkHalfWidth && fz > 0.05) {
        wHead = Math.max(wHead, smoothstep(R.trunkMinY, R.trunkMinY + 0.06, fy) * (1 - smoothstep(R.trunkHalfWidth - 0.05, R.trunkHalfWidth, Math.abs(fx))));
      }
      tmpW[1] = clamp(wHead, 0, 1);

      // Hands.
      for (let h = 0; h < R.hands.length; h++) {
        const d = R.hands[h];
        if (Math.sign(fx) !== d.sx) continue;
        const ax = Math.abs(fx);
        const wy = smoothstep(d.yMin, d.yMin + 0.05, fy) * (1 - smoothstep(d.yMax - 0.04, d.yMax, fy));
        const wx = smoothstep(d.xMin, d.xMin + 0.06, ax);
        tmpW[2 + h] = wy * wx * (1 - tmpW[1]);
      }

      // Seated legs / dhoti: everything below the waist.
      tmpW[list.length - 1] = 1 - smoothstep(R.waistY - 0.04, R.waistY + 0.03, fy);

      let sum = 0;
      for (let b = 1; b < list.length; b++) sum += tmpW[b];
      if (sum > 1) {
        for (let b = 1; b < list.length; b++) tmpW[b] /= sum;
        sum = 1;
      }
      tmpW[0] = 1 - sum;

      // Top-4 influences.
      for (let k = 0; k < 4; k++) {
        let best = -1;
        let bw = 0;
        for (let b = 0; b < list.length; b++) if (tmpW[b] > bw) { bw = tmpW[b]; best = b; }
        idx[i * 4 + k] = best < 0 ? 0 : best;
        wgt[i * 4 + k] = best < 0 ? 0 : bw;
        if (best >= 0) tmpW[best] = 0;
      }
    }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(wgt, 4));
  }

  /**
   * Seated (on the mount) shows the model's own crossed legs. Standing
   * collapses that region into the waist so procedural walking legs can take
   * its place beneath the torso.
   */
  setSeated(seated) {
    const sc = seated ? 1 : 0.001;
    this.legsBone.scale.set(sc, sc, sc);
  }

  /** World-space height of the waist line (fraction of model height). */
  get waistHeight() {
    return REGIONS.waistY * this.height;
  }

  // --------------------------------------------------------------- eyelids

  _eyelids(material) {
    const H = this.height;
    const W = this.width;
    const E = REGIONS.eyes;
    // Upper eyelids: a hemisphere shell centred slightly inside the face at
    // each eye, rotating about the eye's horizontal axis — open it sits back
    // inside the head, closed it wraps the front of the eye.
    const lidMat = new THREE.MeshStandardMaterial({ color: 0xe6b897, roughness: 0.62 });
    this.lids = [];
    for (const sx of [-1, 1]) {
      _ray.set(new THREE.Vector3(sx * E.x * W, E.y * H, this.depth), new THREE.Vector3(0, 0, -1));
      const hit = _ray.intersectObject(this.mesh, false)[0];
      const p = hit ? hit.point.clone() : new THREE.Vector3(sx * E.x * W, E.y * H, this.depth * 0.35);
      const nrm = hit && hit.face ? hit.face.normal.clone().normalize() : new THREE.Vector3(0, 0, 1);
      const r = E.size * H;
      const pivot = new THREE.Object3D();
      pivot.position.copy(p).addScaledVector(nrm, -r * 0.6); // eye centre, just under the surface
      pivot.lookAt(pivot.position.clone().add(nrm));            // pivot +z = outward
      const lid = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), lidMat);
      lid.castShadow = false;
      lid.scale.set(1.25, 1.0, 1.0);
      pivot.add(lid);
      this.headBone.attach(pivot);
      this.lids.push(lid);
    }
    this._setLids(0);
  }

  /** t: 0 open → 1 closed. */
  _setLids(t) {
    // Open: pole points back into the head (-z). Closed: pole points outward (+z).
    const rx = -Math.PI * 0.7 + t * Math.PI * 1.18;
    for (const lid of this.lids) lid.rotation.x = rx;
  }

  // ---------------------------------------------------------------- update

  /**
   * @param ctx { dt, angularVel, speed, bounce, lean, airPose, phase }
   */
  update(ctx) {
    const dt = ctx.dt;
    this.idleT += dt;

    // Blink: quick close, brief hold, quick open; irregular interval.
    this.blinkT -= dt;
    if (this.blinkT <= 0) {
      this.blinkT = 2.5 + Math.random() * 4;
      this._blinkPhase = 0.28;
    }
    if (this._blinkPhase > 0) {
      this._blinkPhase -= dt;
      const t = 0.28 - this._blinkPhase;
      this.blink = t < 0.1 ? t / 0.1 : t < 0.16 ? 1 : Math.max(0, 1 - (t - 0.16) / 0.12);
    } else this.blink = 0;
    this._setLids(this.blink);

    // Head: look into turns, occasional idle glances, gait bob.
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = 2 + Math.random() * 4;
      this.lookTargetYaw = (Math.random() - 0.5) * 0.5;
      this.lookTargetPitch = (Math.random() - 0.5) * 0.16;
    }
    const turnYaw = clamp(ctx.angularVel * 0.12, -0.45, 0.45);
    this.lookYaw = damp(this.lookYaw, this.lookTargetYaw + turnYaw, 0.35, dt);
    this.lookPitch = damp(this.lookPitch, this.lookTargetPitch, 0.4, dt);
    const hb = this.headBone;
    hb.rotation.y = this.lookYaw;
    hb.rotation.x = this.lookPitch + Math.sin(ctx.phase * 2 + 0.4) * ctx.bounce * 0.5 - ctx.airPose * 0.15;
    hb.rotation.z = -ctx.lean * 0.4 + Math.sin(this.idleT * 0.7) * 0.02;

    // Hands: abhaya hand gently rocks; upper hands sway with the gait; modak hand steadies.
    const [lowL, lowR, upL, upR] = this.handBones;
    const gait = Math.sin(ctx.phase) * ctx.bounce * 2.5;
    lowL.rotation.z = Math.sin(this.idleT * 1.4) * 0.08 + gait * 0.2;
    lowL.rotation.x = Math.sin(this.idleT * 0.9) * 0.06;
    lowR.rotation.x = -0.02 + Math.sin(this.idleT * 1.1 + 1) * 0.04 + gait * 0.1;
    upL.rotation.z = Math.sin(this.idleT * 0.8 + 2) * 0.06 + gait * 0.25;
    upR.rotation.z = -Math.sin(this.idleT * 0.85 + 1) * 0.06 - gait * 0.25;
    upL.rotation.x = upR.rotation.x = -ctx.airPose * 0.2;
  }
}

/** Load `/models/ganesha.glb`; resolves null (not an error) if it's absent. */
export async function loadGaneshaGLB(url = 'models/ganesha.glb') {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok || !(head.headers.get('content-type') || '').includes('model')) {
      // Vite dev serves index.html for unknown paths — require a model MIME type.
      if (!head.ok) return null;
      const ct = head.headers.get('content-type') || '';
      if (ct.includes('text/html')) return null;
    }
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    loader.setDRACOLoader(draco);
    const gltf = await loader.loadAsync(url);
    return gltf.scene;
  } catch (e) {
    console.warn('Ganesha GLB not loaded, using procedural rig:', e.message || e);
    return null;
  }
}
