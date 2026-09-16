// Procedural rig for Mooshika with Ganesha seated on the saddle.
//
// Hierarchy:
//   root (position/yaw from the controller)
//   └─ body (bounce, pitch, roll)
//       ├─ head → ears, snout, eyes, whiskers
//       ├─ legFL/FR/BL/BR (upper → lower → paw)
//       ├─ tail (4 segments)
//       └─ saddle ─ ganesha (torso → head/trunk/arms)   ← bone-attached
//
// Surfaces are physically based: fur (sheen + strand normals), skin (soft
// sheen + wrinkle normals on head and trunk), brushed gold with clearcoat,
// silk with gold sheen, wet clearcoated eyes and nose, ivory tusk. Each node
// merges its parts per material, so the whole rig is ~14 draw calls.
//
// Animation is procedural and distance-driven: gait phase advances by ground
// distance / stride, so feet never slide. Parameters are damped with a 0.15 s
// crossfade so state changes never snap.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, damp, lerp, smoothstep } from '../core/MathUtils.js';
import { MOVE } from './CharacterController.js';
import { makeFurNormal, makeSkinNormal, makeMouseSkinNormal, makeGoldRoughness } from './CharacterTextures.js';
import { GaneshaRig } from './GaneshaRig.js';

// Mooshika's size relative to the rig's authored proportions. Ganesha rides the
// saddle, which is counter-scaled, so he keeps his own size on a smaller mount.
export const MOUSE_SCALE = 0.68; // default; see setMouseScale()

function at(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  geo.rotateX(rx);
  geo.rotateY(ry);
  geo.rotateZ(rz);
  geo.translate(x, y, z);
  return geo;
}
function sc(geo, x, y, z) {
  geo.scale(x, y, z);
  return geo;
}

/** Collects parts per material under one node; build() emits one mesh per material. */
class Node {
  constructor(parent, x = 0, y = 0, z = 0) {
    this.group = new THREE.Group();
    this.group.position.set(x, y, z);
    parent.add(this.group);
    this.buckets = new Map();
  }
  add(mat, geo) {
    if (!this.buckets.has(mat)) this.buckets.set(mat, []);
    this.buckets.get(mat).push(geo);
    return this;
  }
  build() {
    for (const [mat, parts] of this.buckets) {
      const g = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      const m = new THREE.Mesh(g, mat);
      // Gems, whiskers and trim are too small to shadow; skip them in the 4 cascades.
      m.castShadow = g.attributes.position.count > 400;
      m.receiveShadow = true;
      this.group.add(m);
    }
    this.buckets.clear();
    return this.group;
  }
}

// Speed keys for the gait blendspace: idle, walk, run, sprint.
const KEYS = [0, MOVE.walk, MOVE.run, MOVE.sprint];
// Per key: [strideLength, bounceAmp, legLift, spinePitch, headBob, cadenceMult]
const GAIT = [
  [0.80, 0.0, 0.0, 0.0, 0.0, 1.0],
  [1.05, 0.024, 0.16, 0.02, 0.015, 1.2],
  [1.55, 0.075, 0.28, 0.10, 0.040, 1.55],
  [1.95, 0.110, 0.36, 0.16, 0.060, 1.75],
];
const CROSSFADE = 0.12;

export class MooshikaRig {
  constructor(scene) {
    this.root = new THREE.Group();
    this.root.name = 'mooshika';
    scene.add(this.root);

    this._materials();
    this._build();
    this._buildWalker(scene);

    this.phase = 0;
    this.blend = { stride: 0.80, bounce: 0, lift: 0, spinePitch: 0, headBob: 0, cadence: 1 };
    this.lean = 0;
    this.headYaw = 0;
    this.squash = 0;
    this.airPose = 0;
    this.turnShuffle = 0;
    this.idleT = 0;
    this.footDown = [false, false, false, false];
    this.footstepEvent = -1;
    this.ganeshaRig = null; // set by useGaneshaModel(); null → procedural Ganesha
  }

  /** Live-adjust Mooshika's size (0.4–1.2). Ganesha is unaffected. */
  setMouseScale(v) {
    this.mouseScale = Math.max(0.4, Math.min(1.2, v));
    this.saddle.scale.setScalar(1 / this.mouseScale);
  }

  /**
   * Replace the procedural Ganesha with a textured mesh (image-to-3D GLB) that
   * is auto-rigged for head turns, hand motion and blinking. Pass `null` to
   * return to the procedural figure.
   */
  useGaneshaModel(source, height = 1.75) {
    if (this.ganeshaRig) {
      this.saddle.remove(this.ganeshaRig.root);
      this.ganeshaRig = null;
      this.ganesha.visible = true;
    }
    if (!source) return;
    this.ganeshaRig = new GaneshaRig(source, { height });
    this.ganeshaRig.root.position.set(0, -0.02, 0.02);
    this.saddle.add(this.ganeshaRig.root);
    this.ganesha.visible = false;
  }

  /** Bake the procedural Ganesha into a single mesh group — a stand-in to test the auto-rig. */
  bakeStandIn() {
    const g = new THREE.Group();
    this.ganesha.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.ganesha.matrixWorld).invert();
    this.ganesha.traverse((o) => {
      if (!o.isMesh) return;
      const m = new THREE.Mesh(o.geometry.clone(), o.material);
      m.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      g.add(m);
    });
    return g;
  }

  // ------------------------------------------------------------ materials

  _materials() {
    const furN = makeFurNormal(256, 11);
    furN.repeat.set(4, 4);
    const mouseSkinN = makeMouseSkinNormal(128, 42);
    mouseSkinN.repeat.set(2, 4);
    const skinN = makeSkinNormal(256, 23);
    skinN.repeat.set(2, 2);
    const goldR = makeGoldRoughness(128, 5);

    this.M = {
      // Upper pelt: soft warm taupe/grey-brown with rich silvery-cream sheen (matches reference photo)
      fur: new THREE.MeshPhysicalMaterial({
        color: 0x7c6d61,
        roughness: 0.82,
        metalness: 0,
        sheen: 1.0,
        sheenRoughness: 0.42,
        sheenColor: new THREE.Color(0xdad2c7),
        normalMap: furN,
        normalScale: new THREE.Vector2(0.85, 0.85),
      }),
      // Flank / transition fur: soft fawn warm grey
      furMid: new THREE.MeshPhysicalMaterial({
        color: 0x928275,
        roughness: 0.84,
        sheen: 1.0,
        sheenRoughness: 0.4,
        sheenColor: new THREE.Color(0xe0d6cb),
        normalMap: furN,
        normalScale: new THREE.Vector2(0.75, 0.75),
      }),
      // Underbelly, throat, and cheeks: soft warm creamy ivory
      furLight: new THREE.MeshPhysicalMaterial({
        color: 0xdcd3c6,
        roughness: 0.86,
        sheen: 1.0,
        sheenRoughness: 0.35,
        sheenColor: new THREE.Color(0xf6f0e7),
        normalMap: furN,
        normalScale: new THREE.Vector2(0.65, 0.65),
      }),
      // Inner ear: natural warm peach-pink with delicate translucency
      innerEar: new THREE.MeshPhysicalMaterial({
        color: 0xe89f99,
        roughness: 0.44,
        metalness: 0,
        sheen: 0.8,
        sheenColor: new THREE.Color(0xffccd0),
        clearcoat: 0.2,
        clearcoatRoughness: 0.35,
        normalMap: mouseSkinN,
        normalScale: new THREE.Vector2(0.35, 0.35),
      }),
      // Ear outer rim: soft warm taupe rim
      earRim: new THREE.MeshPhysicalMaterial({
        color: 0x827265,
        roughness: 0.76,
        sheen: 0.65,
        sheenColor: new THREE.Color(0xd4c8bb),
        normalMap: furN,
        normalScale: new THREE.Vector2(0.6, 0.6),
      }),
      // Paws & tail skin: delicate warm pink with skin rings
      pinkSkin: new THREE.MeshPhysicalMaterial({
        color: 0xe59b95,
        roughness: 0.45,
        sheen: 0.45,
        sheenColor: new THREE.Color(0xffdeda),
        clearcoat: 0.25,
        clearcoatRoughness: 0.35,
        normalMap: mouseSkinN,
        normalScale: new THREE.Vector2(0.6, 0.6),
      }),
      // Eye: deep obsidian black with glassy clearcoat
      wet: new THREE.MeshPhysicalMaterial({
        color: 0x070707,
        roughness: 0.02,
        metalness: 0.05,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        envMapIntensity: 4.0,
      }),
      // Specular catchlight: bright white sparkle giving living soulful expression
      eyeSparkle: new THREE.MeshBasicMaterial({
        color: 0xffffff,
      }),
      // Eyelid margin: soft fleshy pinkish-brown rim
      eyeLid: new THREE.MeshPhysicalMaterial({
        color: 0xa66e67,
        roughness: 0.52,
      }),
      // Nose: soft strawberry-pink with moist highlight
      nose: new THREE.MeshPhysicalMaterial({
        color: 0xe8828b,
        roughness: 0.18,
        sheen: 0.5,
        sheenColor: new THREE.Color(0xffc2c7),
        clearcoat: 1.0,
        clearcoatRoughness: 0.08,
      }),
      // Whiskers: ultra-fine semi-translucent glossy white
      whisker: new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: 0.2,
        clearcoat: 0.6,
        clearcoatRoughness: 0.1,
      }),
      // Claws: tiny translucent ivory-pink tips
      claw: new THREE.MeshStandardMaterial({
        color: 0xfff2f4,
        roughness: 0.3,
      }),
      // Ganesha
      skin: new THREE.MeshPhysicalMaterial({
        color: 0xc98b52,
        roughness: 0.6,
        metalness: 0,
        sheen: 0.12,
        sheenRoughness: 0.6,
        sheenColor: new THREE.Color(0xffe0c0),
        clearcoat: 0.06,
        clearcoatRoughness: 0.6,
      }),
      skinHead: new THREE.MeshPhysicalMaterial({
        color: 0xc4864c,
        roughness: 0.64,
        sheen: 0.12,
        sheenRoughness: 0.6,
        sheenColor: new THREE.Color(0xffe0c0),
        normalMap: skinN,
        normalScale: new THREE.Vector2(0.55, 0.55),
        clearcoat: 0.06,
        clearcoatRoughness: 0.6,
      }),
      gold: new THREE.MeshPhysicalMaterial({
        color: 0xffc44d,
        metalness: 0.92,
        roughness: 0.3,
        roughnessMap: goldR,
        clearcoat: 0.5,
        clearcoatRoughness: 0.15,
        envMapIntensity: 3.2,
        emissive: 0x3a2405,
        emissiveIntensity: 0.5,
      }),
      silk: new THREE.MeshPhysicalMaterial({
        color: 0xa8231f,
        roughness: 0.62,
        sheen: 1.0,
        sheenRoughness: 0.45,
        sheenColor: new THREE.Color(0xf2c14e),
      }),
      silkBlue: new THREE.MeshPhysicalMaterial({
        color: 0x1f4e86,
        roughness: 0.6,
        sheen: 1.0,
        sheenRoughness: 0.4,
        sheenColor: new THREE.Color(0xc7d8ff),
      }),
      ivory: new THREE.MeshPhysicalMaterial({
        color: 0xf3ecdc,
        envMapIntensity: 1.8,
        roughness: 0.35,
        sheen: 0.4,
        sheenColor: new THREE.Color(0xfff6e8),
        clearcoat: 0.3,
        clearcoatRoughness: 0.3,
      }),
      ruby: new THREE.MeshPhysicalMaterial({
        color: 0xb1121a,
        envMapIntensity: 2.5,
        roughness: 0.1,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
        emissive: 0x3a0000,
        emissiveIntensity: 0.6,
      }),
      modak: new THREE.MeshStandardMaterial({ color: 0xf2b53a, metalness: 0.5, roughness: 0.3, emissive: 0x6a3d05, emissiveIntensity: 0.5 }),
      tilak: new THREE.MeshStandardMaterial({ color: 0xc41e1a, roughness: 0.8 }),
    };
  }

  // ---------------------------------------------------------------- build

  _build() {
    const M = this.M;

    this.body = new THREE.Group();
    this.mouseScale = MOUSE_SCALE;
    this.body.position.y = 0.72 * this.mouseScale;
    this.body.scale.setScalar(this.mouseScale);
    this.root.add(this.body);

    // Mooshika torso: plump, cuddly, rounded teardrop form matching the reference photo
    const torso = new Node(this.body);
    // Main rounded torso core
    torso.add(M.fur, sc(new THREE.SphereGeometry(0.66, 32, 26), 1.06, 0.88, 1.48));
    // Plump rounded rump at the back
    torso.add(M.fur, at(sc(new THREE.SphereGeometry(0.62, 28, 22), 1.10, 0.98, 1.08), 0, 0.03, -0.42));
    // Cute rounded shoulders
    torso.add(M.fur, at(sc(new THREE.SphereGeometry(0.52, 26, 20), 1.02, 0.90, 1.05), 0, 0.03, 0.44));
    // Fluffy rounded flanks (sides)
    for (const s of [1, -1]) {
      torso.add(M.furMid, at(sc(new THREE.SphereGeometry(0.46, 22, 18), 0.65, 0.82, 1.15), 0.42 * s, -0.05, -0.06));
    }
    // Soft creamy ivory underbelly and chest
    torso.add(M.furLight, at(sc(new THREE.SphereGeometry(0.58, 28, 22), 0.96, 0.60, 1.38), 0, -0.22, 0.06));
    torso.add(M.furLight, at(sc(new THREE.SphereGeometry(0.44, 24, 18), 0.92, 0.70, 0.98), 0, -0.12, 0.52));

    // Saddle cloth contoured over the back with gold trim and tassels
    torso.add(M.silk, at(sc(new THREE.SphereGeometry(0.64, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.40), 1.02, 0.56, 1.02), 0, 0.16, -0.04));
    torso.add(M.gold, at(new THREE.TorusGeometry(0.64, 0.026, 8, 40), 0, 0.44, -0.04, Math.PI / 2));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      torso.add(M.gold, at(new THREE.SphereGeometry(0.034, 6, 5), Math.cos(a) * 0.65, 0.38, -0.04 + Math.sin(a) * 0.65));
    }
    this.bodyMesh = torso.build();

    // Head: rounded skull with soft cheek contour, large cupped ears, glossy black eyes with catchlights, cute nose, and curved whiskers
    this.head = new THREE.Group();
    this.head.position.set(0, 0.28, 0.96);
    this.body.add(this.head);
    const head = new Node(this.head);
    // Skull
    head.add(M.fur, at(sc(new THREE.SphereGeometry(0.44, 30, 24), 1.04, 0.92, 1.15), 0, 0, 0));
    head.add(M.fur, at(sc(new THREE.SphereGeometry(0.36, 24, 20), 0.96, 0.78, 0.95), 0, 0.12, 0.18));
    // Bridge of muzzle in warm fur
    head.add(M.furMid, at(sc(new THREE.SphereGeometry(0.26, 22, 18), 0.92, 0.76, 1.25), 0, 0.04, 0.42));
    // Soft cream chin & throat
    head.add(M.furLight, at(sc(new THREE.SphereGeometry(0.32, 22, 18), 0.84, 0.62, 1.12), 0, -0.16, 0.35));
    // Whisker pads in soft cream
    head.add(M.furLight, at(sc(new THREE.SphereGeometry(0.24, 22, 18), 0.90, 0.70, 1.28), 0, -0.05, 0.52));

    // Nose: sculpted cute pink heart bulb with nostrils and philtrum cleft
    head.add(M.nose, at(sc(new THREE.SphereGeometry(0.065, 16, 14), 1.1, 0.88, 1.0), 0, -0.052, 0.82));
    for (const s of [1, -1]) {
      head.add(M.nose, at(new THREE.SphereGeometry(0.036, 12, 10), 0.032 * s, -0.056, 0.80));
    }
    head.add(M.nose, at(new THREE.CylinderGeometry(0.008, 0.008, 0.06, 4), 0, -0.09, 0.78, 0, 0, Math.PI / 2));

    // Bilateral features: cheeks, eyes, ears, whiskers
    for (const s of [1, -1]) {
      // Soft rounded cream cheek contour (seamlessly nestled into head)
      head.add(M.furLight, at(sc(new THREE.SphereGeometry(0.28, 22, 18), 1.0, 0.82, 0.95), 0.22 * s, -0.08, 0.24, 0.04, 0.25 * s, 0));

      // Eyes: large, deep obsidian bead eyes with glassy corneal reflection + specular catchlight sparkle
      head.add(M.eyeLid, at(sc(new THREE.TorusGeometry(0.096, 0.016, 8, 24), 1.0, 1.08, 1.0), 0.28 * s, 0.16, 0.35, 0.12, 0.55 * s, 0.1 * s));
      head.add(M.wet, at(sc(new THREE.SphereGeometry(0.096, 24, 20), 1.0, 1.05, 1.0), 0.29 * s, 0.16, 0.35, 0.12, 0.55 * s, 0.1 * s));
      // Primary specular catchlight highlight
      head.add(M.eyeSparkle, at(new THREE.SphereGeometry(0.024, 10, 8), 0.355 * s, 0.21, 0.40));
      // Secondary fill sparkle
      head.add(M.eyeSparkle, at(new THREE.SphereGeometry(0.013, 8, 6), 0.365 * s, 0.13, 0.38));

      // Ears: large, rounded, cup-shaped with warm translucent pink inner and delicate rim (naturally angled outward and curved)
      // Back outer shell
      head.add(M.earRim, at(sc(new THREE.SphereGeometry(0.37, 28, 24), 1.0, 1.12, 0.15), 0.38 * s, 0.46, -0.02, 0.24, 0.58 * s, -0.22 * s));
      // Outer rim
      head.add(M.earRim, at(sc(new THREE.TorusGeometry(0.35, 0.018, 8, 28), 1.0, 1.12, 1.0), 0.385 * s, 0.46, -0.01, 0.24, 0.58 * s, -0.22 * s));
      // Translucent warm peach-pink inner shell
      head.add(M.innerEar, at(sc(new THREE.SphereGeometry(0.31, 26, 22), 0.94, 1.06, 0.11), 0.395 * s, 0.46, 0.01, 0.24, 0.58 * s, -0.22 * s));
      // Fur tuft at ear base
      head.add(M.fur, at(sc(new THREE.SphereGeometry(0.15, 14, 10), 1.0, 0.85, 1.15), 0.34 * s, 0.32, 0.00));

      // Whiskers: realistic fan of 12 radiating curved white whiskers per side
      const whiskerSpecs = [
        [0.68, -0.06, 0.42, -0.16, 0.02],
        [0.74, -0.01, 0.28, -0.06, 0.01],
        [0.72, 0.06, 0.18, 0.08, 0.00],
        [0.64, 0.14, 0.12, 0.20, -0.01],
        [0.56, 0.22, 0.08, 0.32, -0.02],
        [0.70, -0.10, 0.52, -0.22, 0.01],
        [0.76, -0.03, 0.36, -0.12, 0.00],
        [0.78, 0.04, 0.26, 0.02, -0.01],
        [0.68, 0.12, 0.18, 0.16, -0.02],
        [0.60, -0.14, 0.62, -0.26, 0.02],
        [0.66, -0.06, 0.46, -0.16, 0.01],
        [0.62, 0.03, 0.32, -0.02, -0.01],
      ];
      for (const [len, rx, ry, rz, rowY] of whiskerSpecs) {
        const wg = new THREE.CylinderGeometry(0.0012, 0.0035, len, 4);
        wg.translate(0, len / 2, 0);
        wg.rotateZ(s * (Math.PI / 2 + rz));
        wg.rotateY(s * ry);
        wg.rotateX(rx);
        wg.translate(s * 0.18, -0.04 + rowY, 0.60);
        head.add(M.whisker, wg);
      }
    }
    head.build();

    // Legs & Paws: cute pink mouse paws with distinct toes, pads, and tiny claws
    this.legs = [];
    const legDefs = [
      [0.34, 0.52, 1],
      [-0.34, 0.52, 1],
      [0.38, -0.50, 0],
      [-0.38, -0.50, 0],
    ];
    for (const [x, z, front] of legDefs) {
      const upper = new Node(this.body, x, -0.24, z);
      if (front) {
        // Front upper arm
        upper.add(M.fur, at(new THREE.CapsuleGeometry(0.095, 0.26, 6, 14), 0, -0.14, 0));
        const lower = new Node(upper.group, 0, -0.28, 0);
        lower.add(M.furMid, at(new THREE.CapsuleGeometry(0.075, 0.22, 6, 14), 0, -0.13, 0));
        // Front paw palm
        lower.add(M.pinkSkin, at(sc(new THREE.SphereGeometry(0.075, 14, 10), 1.0, 0.48, 1.3), 0, -0.28, 0.06));
        // 4 cute articulated front toes with soft pads & tiny claws
        for (const t of [-1.5, -0.5, 0.5, 1.5]) {
          const toeZ = 0.16 + (1 - Math.abs(t) * 0.18) * 0.06;
          lower.add(M.pinkSkin, at(sc(new THREE.SphereGeometry(0.026, 8, 6), 0.85, 0.75, 1.25), t * 0.038, -0.28, toeZ));
          lower.add(M.claw, at(new THREE.ConeGeometry(0.008, 0.035, 5), t * 0.038, -0.285, toeZ + 0.04, -Math.PI / 2, 0, 0));
        }
        upper.build();
        lower.build();
        this.legs.push({ upper: upper.group, lower: lower.group, front: true, phaseOffset: 0 });
      } else {
        // Rear leg: plump muscular mouse haunch/thigh
        upper.add(M.fur, at(sc(new THREE.SphereGeometry(0.24, 20, 16), 0.9, 1.18, 1.35), 0, -0.10, 0));
        upper.add(M.fur, at(new THREE.CapsuleGeometry(0.105, 0.28, 6, 14), 0, -0.18, 0));
        const lower = new Node(upper.group, 0, -0.32, 0);
        lower.add(M.furMid, at(new THREE.CapsuleGeometry(0.082, 0.26, 6, 14), 0, -0.14, 0));
        // Elongated rear mouse foot with heel and 5 toes
        lower.add(M.pinkSkin, at(sc(new THREE.SphereGeometry(0.09, 14, 10), 0.88, 0.44, 1.5), 0, -0.29, 0.08));
        for (const t of [-2, -1, 0, 1, 2]) {
          const toeZ = 0.18 + (1 - Math.abs(t) * 0.16) * 0.07;
          lower.add(M.pinkSkin, at(sc(new THREE.SphereGeometry(0.026, 8, 6), 0.82, 0.72, 1.25), t * 0.034, -0.29, toeZ));
          lower.add(M.claw, at(new THREE.ConeGeometry(0.008, 0.035, 5), t * 0.034, -0.295, toeZ + 0.04, -Math.PI / 2, 0, 0));
        }
        upper.build();
        lower.build();
        this.legs.push({ upper: upper.group, lower: lower.group, front: false, phaseOffset: 0 });
      }
    }
    this.legs[1].phaseOffset = Math.PI;
    this.legs[2].phaseOffset = Math.PI;

    // Tail: 6 articulated segments with delicate tapering and micro-ringed skin texture
    this.tail = [];
    let parent = this.body;
    let tz = -0.92;
    const tailRadii = [0.046, 0.040, 0.034, 0.028, 0.020, 0.012];
    for (let i = 0; i < 6; i++) {
      const seg = new Node(parent, 0, i === 0 ? -0.06 : 0, tz);
      const r0 = tailRadii[i];
      const r1 = i < 5 ? tailRadii[i + 1] : 0.006;
      seg.add(M.pinkSkin, at(new THREE.CylinderGeometry(r1, r0, 0.28, 10), 0, 0, -0.14, Math.PI / 2));
      seg.build();
      this.tail.push(seg.group);
      parent = seg.group;
      tz = -0.27;
    }

    this.saddle = new THREE.Group();
    this.saddle.position.set(0, 0.52, -0.04);
    this.saddle.scale.setScalar(1 / this.mouseScale); // Ganesha stays full size
    this.body.add(this.saddle);

    this._buildGanesha();
  }

  _buildGanesha() {
    const M = this.M;
    this.ganesha = new THREE.Group();
    this.ganesha.scale.setScalar(0.95);
    this.saddle.add(this.ganesha);

    const g = new Node(this.ganesha);
    // Crossed legs in a red silk dhoti with gold border; feet peeking out.
    g.add(M.silk, at(sc(new THREE.SphereGeometry(0.5, 24, 16), 1.3, 0.42, 1.0), 0, 0.12, 0.05));
    g.add(M.gold, at(new THREE.TorusGeometry(0.6, 0.022, 8, 40), 0, 0.2, 0.05, Math.PI / 2));
    g.add(M.skin, at(sc(new THREE.SphereGeometry(0.11, 12, 8), 1.4, 0.6, 1.0), 0.32, 0.22, 0.42));
    g.add(M.skin, at(sc(new THREE.SphereGeometry(0.11, 12, 8), 1.4, 0.6, 1.0), -0.32, 0.22, 0.42));
    // Belly (lambodara) and chest.
    g.add(M.skin, at(sc(new THREE.SphereGeometry(0.44, 32, 24), 1.0, 1.05, 0.95), 0, 0.5, 0.02));
    g.add(M.skin, at(sc(new THREE.SphereGeometry(0.34, 24, 18), 1.3, 0.7, 0.9), 0, 0.9, 0));
    // Sacred thread, snake belt, necklace, armlets.
    g.add(M.ivory, at(new THREE.TorusGeometry(0.42, 0.014, 6, 40), 0, 0.62, 0.02, 0.35, 0, 0.7));
    g.add(M.gold, at(new THREE.TorusGeometry(0.45, 0.03, 8, 40), 0, 0.36, 0.02, Math.PI / 2));
    g.add(M.gold, at(new THREE.TorusGeometry(0.3, 0.035, 8, 36), 0, 1.02, 0.06, Math.PI / 2 + 0.3));
    for (let i = 0; i < 9; i++) {
      const a = -0.9 + (i / 8) * 1.8;
      g.add(M.ruby, at(new THREE.SphereGeometry(0.03, 8, 6), Math.sin(a) * 0.32, 0.98 - Math.cos(a) * 0.06, 0.06 + Math.cos(a) * 0.3));
    }
    // Four arms: upper pair (pasha / ankusha), lower pair (abhaya / modak).
    const arm = (x, y, z, rz, rx, len) => at(new THREE.CapsuleGeometry(0.085, len, 6, 14), x, y, z, rx, 0, rz);
    // Upper right (viewer's left): raised, holding the goad.
    g.add(M.skin, arm(0.44, 0.98, -0.02, 1.25, 0, 0.3));
    g.add(M.skin, at(new THREE.CapsuleGeometry(0.075, 0.32, 6, 14), 0.66, 1.2, -0.02, 0, 0, 0.35));
    g.add(M.gold, at(new THREE.CylinderGeometry(0.018, 0.018, 0.55, 8), 0.7, 1.55, 0));
    g.add(M.gold, at(new THREE.TorusGeometry(0.06, 0.016, 6, 16, Math.PI * 1.3), 0.7, 1.82, 0, 0, 0, -0.6));
    // Upper left: raised, holding the noose.
    g.add(M.skin, arm(-0.44, 0.98, -0.02, -1.25, 0, 0.3));
    g.add(M.skin, at(new THREE.CapsuleGeometry(0.075, 0.32, 6, 14), -0.66, 1.2, -0.02, 0, 0, -0.35));
    g.add(M.gold, at(new THREE.TorusGeometry(0.12, 0.014, 6, 24), -0.72, 1.6, 0, 0.3));
    // Lower left: forearm forward holding a modak in the palm.
    g.add(M.skin, arm(0.42, 0.72, 0.02, 0.9, 0, 0.3));
    g.add(M.skin, at(new THREE.CapsuleGeometry(0.075, 0.28, 6, 14), 0.5, 0.5, 0.25, 1.1, 0, 0.2));
    g.add(M.skin, at(sc(new THREE.SphereGeometry(0.1, 12, 10), 1.1, 0.5, 1.2), 0.5, 0.42, 0.44));
    g.add(M.modak, at(new THREE.ConeGeometry(0.1, 0.16, 12), 0.5, 0.5, 0.44));
    // Lower right upper arm (the raised abhaya hand is a separate animated node).
    g.add(M.skin, arm(-0.42, 0.72, 0.02, -0.5, 0, 0.3));
    g.build();

    this.hand = new THREE.Group();
    this.hand.position.set(-0.58, 0.86, 0.04);
    this.ganesha.add(this.hand);
    const hand = new Node(this.hand);
    hand.add(M.skin, at(new THREE.CapsuleGeometry(0.07, 0.3, 6, 14), 0, 0.18, 0));
    hand.add(M.skin, at(sc(new THREE.SphereGeometry(0.1, 14, 10), 1, 1.2, 0.45), 0, 0.42, 0));
    for (let f = 0; f < 4; f++) hand.add(M.skin, at(new THREE.CapsuleGeometry(0.02, 0.09, 4, 8), -0.06 + f * 0.04, 0.56, 0));
    hand.add(M.gold, at(new THREE.TorusGeometry(0.085, 0.018, 8, 24), 0, 0.3, 0, Math.PI / 2));
    hand.build();

    // Head: elephant skin with wrinkle normals, lobed ears, one tusk, crown.
    this.ganeshaHead = new THREE.Group();
    this.ganeshaHead.position.set(0, 1.14, 0.02);
    this.ganesha.add(this.ganeshaHead);
    const h = new Node(this.ganeshaHead);
    h.add(M.skinHead, at(sc(new THREE.SphereGeometry(0.36, 32, 24), 1.05, 1, 1.0), 0, 0.18, 0));
    h.add(M.skinHead, at(sc(new THREE.SphereGeometry(0.28, 24, 18), 1.15, 0.7, 0.9), 0, 0.38, 0.08)); // brow
    h.add(M.skinHead, at(sc(new THREE.SphereGeometry(0.18, 18, 14), 1, 0.8, 1), 0, 0.02, 0.3)); // cheeks/upper trunk base
    for (const s of [1, -1]) {
      // Lobed ear: two overlapping thin ellipsoids.
      h.add(M.skinHead, at(sc(new THREE.SphereGeometry(0.3, 22, 16), 0.85, 1.15, 0.12), 0.46 * s, 0.24, -0.02, 0.05, 0.4 * s, 0.1 * s));
      h.add(M.skinHead, at(sc(new THREE.SphereGeometry(0.2, 18, 12), 0.9, 1.0, 0.1), 0.5 * s, -0.02, 0.0, 0.05, 0.4 * s, 0.1 * s));
      h.add(M.pinkSkin, at(sc(new THREE.SphereGeometry(0.2, 18, 12), 0.8, 1.0, 0.06), 0.47 * s, 0.22, 0.02, 0.05, 0.4 * s, 0.1 * s));
      h.add(M.gold, at(new THREE.TorusGeometry(0.05, 0.012, 6, 16), 0.5 * s, -0.16, 0.02));
      h.add(M.wet, at(new THREE.SphereGeometry(0.045, 14, 10), 0.13 * s, 0.24, 0.31));
    }
    h.add(M.tilak, at(new THREE.BoxGeometry(0.035, 0.13, 0.02), 0, 0.44, 0.33));
    h.add(M.ivory, at(new THREE.ConeGeometry(0.045, 0.32, 12), 0.17, -0.02, 0.36, -1.3, 0, 0.15)); // single tusk
    h.add(M.gold, at(new THREE.CylinderGeometry(0.2, 0.32, 0.24, 24), 0, 0.6, 0));
    h.add(M.gold, at(new THREE.ConeGeometry(0.17, 0.36, 16), 0, 0.88, 0));
    h.add(M.gold, at(new THREE.TorusGeometry(0.31, 0.022, 8, 32), 0, 0.51, 0, Math.PI / 2));
    h.add(M.ruby, at(new THREE.SphereGeometry(0.055, 12, 8), 0, 1.09, 0));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      h.add(M.ruby, at(new THREE.SphereGeometry(0.028, 8, 6), Math.cos(a) * 0.3, 0.62, Math.sin(a) * 0.3));
    }
    h.build();

    // Trunk: five tapered segments curling to the viewer's left.
    this.trunk = [];
    let parent = this.ganeshaHead;
    let pos = [0, 0.02, 0.36];
    for (let i = 0; i < 5; i++) {
      const seg = new Node(parent, pos[0], pos[1], pos[2]);
      const r = 0.1 - i * 0.015;
      seg.add(M.skinHead, at(new THREE.CylinderGeometry(r - 0.014, r, 0.2, 14), 0, -0.1, 0));
      seg.add(M.skinHead, at(new THREE.SphereGeometry(r, 14, 10), 0, -0.2, 0));
      seg.build();
      seg.group.rotation.x = 0.25 + i * 0.22;
      seg.group.rotation.z = 0.12 * i;
      this.trunk.push(seg.group);
      parent = seg.group;
      pos = [0, -0.2, 0];
    }
  }

  // ------------------------------------------------------------- animation

  /**
   * @param pose   interpolated {x,y,z,yaw} from the controller
   * @param ctrl   the CharacterController (for speed, grounded, etc.)
   * @param dt     render delta time (seconds)
   */
  // ------------------------------------------------------- mount / dismount

  /** The node that holds Ganesha (textured rig or procedural figure). */
  get ganeshaNode() {
    return this.ganeshaRig ? this.ganeshaRig.root : this.ganesha;
  }

  /** Build the standing body Ganesha walks with when dismounted: dhoti + legs. */
  _buildWalker(scene) {
    this.walker = new THREE.Group();
    this.walker.name = 'ganesha-walker';
    this.walker.visible = false;
    scene.add(this.walker);
    const M = this.M;
    M.legSkin = new THREE.MeshPhysicalMaterial({ color: 0xe0b394, roughness: 0.6, sheen: 0.15, sheenColor: new THREE.Color(0xffe4cc) });
    M.dhoti = new THREE.MeshPhysicalMaterial({
      color: 0x5f6e2c, roughness: 0.62, sheen: 1.0, sheenRoughness: 0.45, sheenColor: new THREE.Color(0xd8c26a),
    });

    // Everything below is in model units and scaled together by `body`, so the
    // standing figure keeps one coherent scale (a little under riding size so
    // he fits through doorways).
    this.walkerScale = 1.2;
    this.body2 = new THREE.Group();
    this.body2.scale.setScalar(this.walkerScale);
    this.walker.add(this.body2);
    this.legLen = { thigh: 0.46, shin: 0.44 };
    this.hipY = this.legLen.thigh + this.legLen.shin + 0.06;

    // Torso holder: the GLB (or procedural figure) is attached here so its
    // waist line lands at hip height.
    this.torso = new THREE.Group();
    this.body2.add(this.torso);

    // Dhoti: hugs the belly at the waist, flares to just above the knees, gold hem.
    const skirt = new Node(this.torso);
    skirt.add(M.dhoti, at(new THREE.CylinderGeometry(0.3, 0.36, 0.48, 20, 1, true), 0, -0.24, 0));
    skirt.add(M.dhoti, at(new THREE.CircleGeometry(0.3, 20), 0, 0.0, 0, -Math.PI / 2)); // closes the top under the belly
    skirt.add(M.gold, at(new THREE.TorusGeometry(0.36, 0.02, 8, 32), 0, -0.47, 0, Math.PI / 2));
    skirt.add(M.gold, at(new THREE.TorusGeometry(0.305, 0.035, 8, 32), 0, -0.02, 0, Math.PI / 2)); // waistband
    // Pleated front fold.
    skirt.add(M.dhoti, at(new THREE.BoxGeometry(0.14, 0.42, 0.05), 0, -0.25, 0.3));
    skirt.build();

    // Legs: hip → thigh → knee → shin → foot, per side.
    this.walkLegs = [];
    for (const sx of [-1, 1]) {
      const hip = new Node(this.body2, sx * 0.16, this.hipY, 0);
      hip.add(M.legSkin, at(new THREE.CapsuleGeometry(0.135, this.legLen.thigh - 0.2, 8, 14), 0, -this.legLen.thigh / 2, 0));
      hip.add(M.gold, at(new THREE.TorusGeometry(0.17, 0.02, 6, 20), 0, -this.legLen.thigh * 0.85, 0, Math.PI / 2)); // anklet-like knee band
      const knee = new Node(hip.group, 0, -this.legLen.thigh, 0);
      knee.add(M.legSkin, at(new THREE.CapsuleGeometry(0.105, this.legLen.shin - 0.2, 8, 14), 0, -this.legLen.shin / 2, 0));
      knee.add(M.gold, at(new THREE.TorusGeometry(0.14, 0.02, 6, 20), 0, -this.legLen.shin + 0.1, 0, Math.PI / 2)); // anklet
      const foot = new Node(knee.group, 0, -this.legLen.shin, 0);
      foot.add(M.legSkin, sc(at(new THREE.SphereGeometry(0.13, 12, 8), 0, 0.02, 0.09), 1.0, 0.45, 1.7));
      for (let t = 0; t < 4; t++) foot.add(M.legSkin, at(new THREE.SphereGeometry(0.035, 6, 5), -0.08 + t * 0.053, 0.03, 0.3));
      hip.build();
      knee.build();
      foot.build();
      this.walkLegs.push({ hip: hip.group, knee: knee.group, foot: foot.group, side: sx });
    }
    this.walkPhase = 0;
    this.walkerT = 0;
    this.footDownWalk = [false, false];
    this.mounted = true;
  }

  /**
   * Put Ganesha on the mount (true) or standing at `pose` (false).
   * Reparents the Ganesha node; Mooshika's rig keeps animating either way.
   */
  setMounted(mounted, pose = null) {
    if (mounted === this.mounted) return;
    this.mounted = mounted;
    const node = this.ganeshaNode;
    if (mounted) {
      this.torso.remove(node);
      this.saddle.add(node);
      node.position.set(0, this.ganeshaRig ? -0.02 : 0, this.ganeshaRig ? 0.02 : 0);
      node.rotation.set(0, 0, 0);
      if (this.ganeshaRig) this.ganeshaRig.setSeated(true);
      this.walker.visible = false;
    } else {
      this.saddle.remove(node);
      this.torso.add(node);
      // Waist line of the model sits at the hip; the seated legs are collapsed.
      const waist = this.ganeshaRig ? this.ganeshaRig.waistHeight : 0.45;
      node.position.set(0, -waist, 0);
      node.rotation.set(0, 0, 0);
      node.scale.setScalar(1);
      if (this.ganeshaRig) this.ganeshaRig.setSeated(false);
      this.torso.position.set(0, this.hipY, 0);
      if (pose) {
        this.walker.position.set(pose.x, pose.y, pose.z);
        this.walker.rotation.y = pose.yaw;
      }
      this.walker.visible = true;
    }
  }

  /** Animate Ganesha on foot: distance-driven leg cycle, torso bob and lean. */
  updateWalker(pose, ctrl, dt) {
    this.walkerT += dt;
    const w = this.walker;
    const speed = ctrl.speed;
    const moving = speed > 0.25;
    const stride = 1.35; // metres per full cycle at this leg length
    if (moving) this.walkPhase += (speed * dt) / stride * Math.PI * 2;
    const amp = clamp(speed / 6.5, 0.25, 1.15); // swing amplitude grows with pace
    const ph = this.walkPhase;

    w.position.set(pose.x, pose.y + (ctrl.grounded ? 0 : 0.15), pose.z);
    w.rotation.y = pose.yaw;
    w.rotation.x = clamp(speed * 0.01, 0, 0.1);
    w.rotation.z = clamp(-ctrl.angularVel * 0.025, -0.12, 0.12);

    // Torso: bob twice per cycle, slight sway, idle breathing.
    const bob = moving ? Math.abs(Math.sin(ph)) * 0.045 * amp : Math.sin(this.walkerT * 1.5) * 0.012;
    this.torso.position.y = this.hipY + bob;
    this.torso.rotation.y = moving ? Math.sin(ph) * 0.05 * amp : 0;
    this.torso.rotation.z = moving ? Math.cos(ph) * 0.03 * amp : 0;

    // Legs: opposite phases; knee bends during the swing, foot stays level.
    this.footstepEvent = -1;
    for (let i = 0; i < 2; i++) {
      const L = this.walkLegs[i];
      const lp = ph + (i === 0 ? 0 : Math.PI);
      const s = Math.sin(lp);
      const swing = moving ? s * 0.55 * amp : 0;
      const lift = moving ? Math.max(0, Math.cos(lp)) * 0.9 * amp : 0; // knee flex on the forward swing
      L.hip.rotation.x = -swing;                    // forward = negative x rotation
      L.knee.rotation.x = lift * 0.9 + (moving ? 0.08 : 0.02);
      L.foot.rotation.x = -(L.hip.rotation.x + L.knee.rotation.x) * 0.9; // keep the sole level
      const down = s <= 0;
      if (down && !this.footDownWalk[i] && moving && ctrl.grounded) this.footstepEvent = i;
      this.footDownWalk[i] = down;
    }

    if (this.ganeshaRig) {
      this.ganeshaRig.update({ dt, angularVel: ctrl.angularVel, speed, bounce: moving ? 0.04 * amp : 0, lean: w.rotation.z, airPose: ctrl.grounded ? 0 : 1, phase: ph });
    }
  }

  update(pose, ctrl, dt) {
    this.root.position.set(pose.x, pose.y, pose.z);
    this.root.rotation.y = pose.yaw;

    const speed = ctrl.speed;
    this.idleT += dt;

    // --- blendspace on (speed) ------------------------------------------
    let k = 0;
    while (k < KEYS.length - 2 && speed > KEYS[k + 1]) k++;
    const t = clamp((speed - KEYS[k]) / (KEYS[k + 1] - KEYS[k]), 0, 1);
    const a = GAIT[k];
    const b = GAIT[k + 1];
    const tStride = lerp(a[0], b[0], t);
    const tBounce = lerp(a[1], b[1], t);
    const tLift = lerp(a[2], b[2], t);
    const tSpine = lerp(a[3], b[3], t);
    const tHead = lerp(a[4], b[4], t);
    const tCadence = lerp(a[5], b[5], t);

    // Crossfade: every parameter approaches its target with silky half-life
    const bl = this.blend;
    bl.stride = damp(bl.stride, tStride, CROSSFADE * 0.5, dt);
    bl.bounce = damp(bl.bounce, tBounce, CROSSFADE * 0.5, dt);
    bl.lift = damp(bl.lift, tLift, CROSSFADE * 0.5, dt);
    bl.spinePitch = damp(bl.spinePitch, tSpine, CROSSFADE * 0.5, dt);
    bl.headBob = damp(bl.headBob, tHead, CROSSFADE * 0.5, dt);
    bl.cadence = damp(bl.cadence, tCadence, CROSSFADE * 0.5, dt);

    // --- distance-driven gait phase with nimble rodent cadence -----------
    const moving = speed > 0.25;
    if (moving) this.phase += ((speed * dt) / bl.stride) * Math.PI * 2 * bl.cadence;

    // Turn-in-place shuffle
    const turning = !moving && Math.abs(ctrl.angularVel) > 0.5;
    this.turnShuffle = damp(this.turnShuffle, turning ? 1 : 0, CROSSFADE * 0.5, dt);
    if (this.turnShuffle > 0.01) this.phase += dt * 8.5 * this.turnShuffle;

    // --- turn lean & head look -------------------------------------------
    const leanTarget = clamp(-ctrl.angularVel * 0.07 * (speed / MOVE.run), -0.32, 0.32);
    this.lean = damp(this.lean, leanTarget, 0.09, dt);
    this.headYaw = damp(this.headYaw, clamp(ctrl.angularVel * 0.08, -0.45, 0.45), 0.1, dt);

    // --- leap / land ------------------------------------------------------
    if (ctrl.justLanded) this.squash = clamp(ctrl.landImpact, 0.3, 1.2);
    this.squash = damp(this.squash, 0, 0.10, dt);
    const airTarget = ctrl.grounded ? 0 : 1;
    this.airPose = damp(this.airPose, airTarget, 0.07, dt);

    // --- apply to body (silky smooth harmonic motion) -----------
    const ph = this.phase;
    // Gait blend weights
    const runT = clamp((speed - MOVE.walk) / (MOVE.sprint - MOVE.walk), 0, 1);
    const walkT = clamp(speed / MOVE.walk, 0, 1);
    const speedFactor = smoothstep(0.1, MOVE.walk, speed);
    const walkWeight = walkT * (1 - runT);

    // Harmonic vertical bounce:
    const bounce = 0.5 * (1 - Math.cos(ph * 2)) * bl.bounce;
    const idleBreath = Math.sin(this.idleT * 1.5) * 0.010 * (1 - walkT);
    const swimDip = ctrl.swimming ? -0.45 : ctrl.wading ? -0.12 : 0;

    // Organic lateral weight shift & hip/shoulder sway during walking
    const lateralSway = Math.sin(ph) * 0.028 * walkWeight;
    const lateralYaw = Math.cos(ph) * 0.018 * walkWeight;
    const walkPitch = Math.sin(ph * 2) * 0.014 * walkWeight;

    // Spine flexion wave (authentic rodent bounding gallop at run/sprint)
    const spineWave = Math.sin(ph);
    const spineFlex = spineWave * bl.spinePitch;

    const MS = this.mouseScale;
    this.body.position.y = (0.70 + bounce + idleBreath - this.squash * 0.15 + this.airPose * 0.1) * MS + swimDip;
    this.body.position.x = Math.sin(ph) * 0.012 * walkWeight * MS;
    this.body.rotation.x = -bl.spinePitch * 0.4 + spineWave * bl.bounce * 0.8 + walkPitch + this.airPose * -0.32 + (ctrl.vy < 0 ? -this.airPose * 0.28 : 0);
    this.body.rotation.z = this.lean + lateralSway;
    this.body.rotation.y = lateralYaw;

    // Rodent spine compression and extension along body axis
    this.body.scale.set(
      (1 - spineFlex * 0.10 + this.squash * 0.12) * MS,
      (1 + spineFlex * 0.08 - this.squash * 0.16) * MS,
      (1 + spineFlex * 0.14 + this.squash * 0.08) * MS
    );

    // Head stabilization: counter-balances body sway to keep eyes alert and level
    this.head.rotation.x = bl.headBob * 0.5 - spineWave * bl.bounce * 0.5 - walkPitch * 0.6 - this.airPose * 0.18;
    this.head.rotation.y = this.headYaw - lateralYaw * 0.5;
    const sniff = (1 - walkT) * Math.sin(this.idleT * 7.5) * 0.018;
    this.head.rotation.z = (this.lean * 0.25) - (lateralSway * 0.4) + sniff;

    // Legs: 4-beat lateral sequence walk smoothly morphing to bounding gallop at sprint
    // Lateral walk sequence: Back Left (0) -> Front Left (0.5 PI) -> Back Right (1.0 PI) -> Front Right (1.5 PI)
    const walkOffsets = [
      Math.PI * 0.50,  // Front Left
      Math.PI * 1.50,  // Front Right
      Math.PI * 0.00,  // Back Left
      Math.PI * 1.00,  // Back Right
    ];
    const sprintOffsets = [
      0,               // Front Left
      Math.PI * 0.35,  // Front Right
      Math.PI * 0.95,  // Back Left
      Math.PI * 1.25,  // Back Right
    ];
    const dynamicOffsets = [
      lerp(walkOffsets[0], sprintOffsets[0], runT),
      lerp(walkOffsets[1], sprintOffsets[1], runT),
      lerp(walkOffsets[2], sprintOffsets[2], runT),
      lerp(walkOffsets[3], sprintOffsets[3], runT),
    ];

    this.footstepEvent = -1;
    for (let i = 0; i < 4; i++) {
      const L = this.legs[i];
      const lp = ph + dynamicOffsets[i];
      const s = Math.sin(lp);
      const c = Math.cos(lp);

      // Sinusoidal bell curve lift: soft takeoff and gentle, zero-impact landing
      const liftNorm = s > 0 ? Math.sin(s * Math.PI) : 0;
      const gaitAmp = moving ? lerp(0.30, 0.48, runT) * speedFactor : 0.22 * this.turnShuffle;
      const swingAngle = c * gaitAmp * (L.front ? 1 : 0.9);
      const airAngle = L.front ? -0.85 : 0.75;

      L.upper.rotation.x = lerp(swingAngle, airAngle, this.airPose) - this.squash * 0.22;
      L.lower.rotation.x = lerp(liftNorm * bl.lift * 2.2, L.front ? 1.15 : -0.38, this.airPose) + this.squash * 0.45;

      const down = s <= 0;
      if (down && !this.footDown[i] && moving && ctrl.grounded) this.footstepEvent = i;
      this.footDown[i] = down;
    }

    // Tail: 6 articulated segments trailing with traveling sinusoidal wave & secondary drag
    const tailWave = this.idleT * 2.6 + (moving ? ph * 0.70 : 0);
    for (let i = 0; i < this.tail.length; i++) {
      const seg = this.tail[i];
      const lag = (i + 1) * 0.40;
      const tailSway = Math.sin(tailWave - lag) * (0.15 + i * 0.07) - this.lean * 0.95 - (Math.sin(ph - lag) * 0.04 * walkWeight);
      seg.rotation.y = tailSway;
      seg.rotation.x = 0.16 + i * 0.10 + Math.sin(tailWave * 0.75 - lag) * 0.06 - this.airPose * 0.4 + Math.cos(ph - lag) * bl.bounce * 0.35;
    }

    // Ganesha rides the saddle with balanced counter-sway (skipped on foot).
    if (!this.mounted) return;
    if (this.ganeshaRig) {
      const gr = this.ganeshaRig.root;
      gr.rotation.z = -this.lean * 0.32 - lateralSway * 0.35;
      gr.rotation.x = -this.body.rotation.x * 0.35 - this.airPose * 0.12;
      this.ganeshaRig.update({ dt, angularVel: ctrl.angularVel, speed, bounce: bl.bounce, lean: this.lean, airPose: this.airPose, phase: ph });
    } else {
      this.ganesha.rotation.z = -this.lean * 0.32 - lateralSway * 0.35;
      this.ganesha.rotation.x = -this.body.rotation.x * 0.35 - this.airPose * 0.12;
      this.hand.rotation.z = -0.25 + Math.sin(this.idleT * 1.3) * 0.05;
      this.hand.rotation.x = Math.sin(this.idleT * 0.9) * 0.05;
      const trunkSway = Math.sin(this.idleT * 1.1) * 0.08 + Math.sin(ph) * bl.bounce * 0.8;
      for (let i = 0; i < this.trunk.length; i++) {
        const seg = this.trunk[i];
        seg.rotation.x = 0.25 + i * 0.22 + trunkSway * (i + 1) * 0.18;
        seg.rotation.z = 0.12 * i + trunkSway * 0.18;
      }
    }
  }
}
