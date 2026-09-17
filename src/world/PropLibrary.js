// Procedural prop meshes with three LOD levels each.
//
// Every prop type uses ONE material, with colour and emission carried as
// vertex attributes. This is what lets a whole chunk's worth of a prop type be
// a single InstancedMesh draw call regardless of how many coloured parts the
// prop is made from. Emissive parts (lamp flames, shrine lamps) read a per-
// vertex `aEmissive` weight in a small shader patch, so bloom picks them up
// without a second material.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PROP_TYPES } from './Biomes.js';
import { mulberry32, hash2 } from '../core/MathUtils.js';
import { makeBarkNormal, makePlasterNormal } from '../fx/ProceduralTextures.js';

const _c = new THREE.Color();

/** Stamp colour + emissive weight onto a geometry so it can be merged. */
function tint(geo, hex, emissive = 0, gradientTop = null) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const emi = new Float32Array(n);
  _c.set(hex);
  let top = null;
  if (gradientTop) top = new THREE.Color(gradientTop);
  // Compute y-range for optional vertical gradient.
  let minY = Infinity,
    maxY = -Infinity;
  if (top) {
    for (let i = 0; i < n; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  for (let i = 0; i < n; i++) {
    let r = _c.r,
      g = _c.g,
      b = _c.b;
    if (top) {
      const t = (pos.getY(i) - minY) / (maxY - minY || 1);
      r += (top.r - r) * t;
      g += (top.g - g) * t;
      b += (top.b - b) * t;
    }
    col[i * 3] = r;
    col[i * 3 + 1] = g;
    col[i * 3 + 2] = b;
    emi[i] = emissive;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aEmissive', new THREE.BufferAttribute(emi, 1));
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return geo;
}

/** Pin every UV to the alpha textures' reserved white corner: part renders opaque. */
function opaque(geo) {
  const n = geo.attributes.position.count;
  const uv = new Float32Array(n * 2).fill(0.03);
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

function move(geo, x, y, z) {
  geo.translate(x, y, z);
  return geo;
}
function rot(geo, x, y, z) {
  geo.rotateX(x);
  geo.rotateY(y);
  geo.rotateZ(z);
  return geo;
}

function merge(parts) {
  // Polyhedron geometries are non-indexed; mixing them with indexed primitives
  // is not mergeable, so drop indices everywhere when any part lacks one.
  if (parts.some((p) => !p.index)) {
    parts = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

/**
 * Roughen an icosphere deterministically for rocks. Polyhedra are non-indexed,
 * so the displacement is a function of vertex *position* (hashed), which keeps
 * coincident corners together — random per-vertex offsets would tear faces.
 */
function jitter(geo, amount, seed) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const qx = Math.round(x * 500), qy = Math.round(y * 500), qz = Math.round(z * 500);
    const h = hash2(qx * 3 + qz * 7, qy * 5 - qz * 11, seed);
    const h2 = hash2(qy * 13 + qx, qz * 17 - qx * 3, seed + 99);
    const s = 1 + (h - 0.5) * amount + (h2 - 0.5) * amount * 0.35;
    pos.setXYZ(i, x * s, y * s * 0.7, z * s);
  }
  geo.computeVertexNormals();
  return geo;
}

// ------------------------------------------------------------------ builders
// Each returns [lod0, lod1, lod2].

const BARK = 0x4a3524;
const LEAF = 0x2b5c27;
const LEAF_LIGHT = 0x4e8a34;
const STONE = 0x8a8478;
const STONE_DARK = 0x655f55;
const FLAME = 0xffb347;

function buildBanyan() {
  const crown = [
    [0, 7.2, 0, 3.4],
    [2.4, 6.4, 1.2, 2.5],
    [-2.2, 6.6, -1.0, 2.6],
    [0.6, 6.2, -2.4, 2.3],
    [-0.8, 6.0, 2.2, 2.2],
  ];
  const lod = (cardsPerBlob, rootCount, trunkSeg) => {
    const parts = [];
    const coreScale = cardsPerBlob > 0 ? 0.55 : 0.95; // far LOD: the core IS the canopy
    parts.push(tint(opaque(move(new THREE.CylinderGeometry(0.5, 1.15, 5.4, trunkSeg), 0, 2.7, 0)), BARK));
    // Buttress flare and a few big limbs.
    parts.push(tint(opaque(move(new THREE.CylinderGeometry(1.1, 1.6, 0.8, trunkSeg), 0, 0.4, 0)), BARK));
    if (trunkSeg >= 8) {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.7;
        const g = new THREE.CylinderGeometry(0.16, 0.32, 3.2, 6);
        g.translate(0, 1.6, 0);
        g.rotateZ(0.9);
        g.rotateY(a);
        g.translate(0, 4.6, 0);
        parts.push(tint(opaque(g), BARK));
      }
    }
    // Dark inner cores keep the canopy opaque; leaf cards give the silhouette.
    for (const [x, y, z, r] of crown) {
      parts.push(tint(opaque(move(new THREE.SphereGeometry(r * coreScale, 10, 8), x, y, z)), cardsPerBlob > 0 ? 0x23481f : LEAF, 0, cardsPerBlob > 0 ? 0x2e5c28 : LEAF_LIGHT));
      if (cardsPerBlob > 0) parts.push(...leafCards(cardsPerBlob, x, y, z, r, r * 1.15, (x * 7 + z * 13) | 0, LEAF, LEAF_LIGHT));
    }
    for (let i = 0; i < rootCount; i++) {
      const a = (i / rootCount) * Math.PI * 2 + 0.4;
      parts.push(tint(opaque(move(new THREE.CylinderGeometry(0.09, 0.14, 5.4, 5), Math.cos(a) * 2.1, 2.7, Math.sin(a) * 2.1)), BARK));
    }
    return merge(parts);
  };
  return [lod(56, 5, 12), lod(20, 2, 8), lod(0, 0, 6)];
}

function buildLotus() {
  const lod = (seg) => {
    const parts = [];
    parts.push(tint(move(new THREE.CircleGeometry(0.9, seg), 0, 0.02, 0).rotateX(-Math.PI / 2), 0x2b6b3a));
    parts.push(tint(move(new THREE.CircleGeometry(0.7, seg), 0.9, 0.015, 0.6).rotateX(-Math.PI / 2), 0x2e7440));
    if (seg >= 8) {
      parts.push(tint(move(new THREE.ConeGeometry(0.28, 0.42, seg, 1, true), 0, 0.26, 0), 0xf3a6c6, 0, 0xffe4ee));
      parts.push(tint(move(new THREE.SphereGeometry(0.1, 6, 4), 0, 0.42, 0), 0xffd34d, 0.4));
    }
    return merge(parts);
  };
  return [lod(14), lod(8), lod(5)];
}

function buildReeds() {
  const lod = (count) => {
    const parts = [];
    const rand = mulberry32(42);
    for (let i = 0; i < count; i++) {
      const x = (rand() - 0.5) * 0.9;
      const z = (rand() - 0.5) * 0.9;
      const h = 1.6 + rand() * 1.3;
      const g = new THREE.CylinderGeometry(0.02, 0.045, h, 4);
      g.translate(x, h / 2, z);
      g.rotateZ((rand() - 0.5) * 0.2);
      parts.push(tint(g, 0x6c8f3a, 0, 0xbfd07a));
    }
    return merge(parts);
  };
  return [lod(7), lod(4), lod(2)];
}

function buildShrub() {
  const lod = (cards) => {
    const parts = [];
    parts.push(tint(opaque(move(new THREE.SphereGeometry(cards > 0 ? 0.4 : 0.9, 10, 8), 0, 0.62, 0)), cards > 0 ? 0x27521f : 0x36702e, 0, cards > 0 ? 0x33682a : 0x6ca648));
    if (cards > 0) {
      parts.push(...leafCards(cards, 0, 0.7, 0, 1.0, 0.95, 91, 0x36702e, 0x7fb552));
      parts.push(...leafCards(Math.ceil(cards * 0.5), 0.6, 0.5, 0.3, 0.65, 0.8, 92, 0x3a7a30, 0x86bd58));
    } else {
      parts.push(tint(opaque(move(new THREE.SphereGeometry(0.9, 6, 5), 0, 0.7, 0)), 0x36702e, 0, 0x6ca648));
    }
    return merge(parts);
  };
  return [lod(30), lod(12), lod(0)];
}

/** Crossed alpha-tested quads — the classic cheap grass tuft. */
function buildGrass() {
  const lod = (quads) => {
    const parts = [];
    for (let i = 0; i < quads; i++) {
      const g = new THREE.PlaneGeometry(0.7, 0.55, 1, 2);
      g.translate(0, 0.27, 0);
      g.rotateY((i / quads) * Math.PI);
      parts.push(tint(g, 0x4a7a2c, 0, 0x9ac858));
    }
    return merge(parts);
  };
  return [lod(3), lod(2), lod(1)];
}

function buildMarigold() {
  const lod = (seg, flowers) => {
    const parts = [];
    const rand = mulberry32(7);
    for (let i = 0; i < flowers; i++) {
      const x = (rand() - 0.5) * 0.9;
      const z = (rand() - 0.5) * 0.9;
      const h = 0.22 + rand() * 0.18;
      parts.push(tint(move(new THREE.CylinderGeometry(0.015, 0.025, h, 3), x, h / 2, z), 0x4f7a2f));
      parts.push(tint(move(new THREE.SphereGeometry(0.09, seg, seg - 1), x, h + 0.06, z), rand() > 0.5 ? 0xff9a1f : 0xffc21f, 0.06));
    }
    return merge(parts);
  };
  return [lod(7, 4), lod(5, 2), lod(4, 1)];
}

function buildArchway() {
  const lod = (seg) => {
    const parts = [];
    const H = 5.6;
    parts.push(tint(move(new THREE.BoxGeometry(1.0, H, 1.0), -2.4, H / 2, 0), STONE, 0, 0xa39c8e));
    parts.push(tint(move(new THREE.BoxGeometry(1.0, H, 1.0), 2.4, H / 2, 0), STONE, 0, 0xa39c8e));
    // Arch: half-torus.
    const arch = new THREE.TorusGeometry(2.4, 0.5, seg >= 8 ? 8 : 5, seg, Math.PI);
    arch.translate(0, H, 0);
    parts.push(tint(arch, STONE_DARK));
    if (seg >= 12) {
      // Capitals and a small finial.
      parts.push(tint(move(new THREE.BoxGeometry(1.4, 0.4, 1.4), -2.4, H + 0.2, 0), STONE_DARK));
      parts.push(tint(move(new THREE.BoxGeometry(1.4, 0.4, 1.4), 2.4, H + 0.2, 0), STONE_DARK));
      parts.push(tint(move(new THREE.ConeGeometry(0.5, 0.9, 6), 0, H + 2.9 + 0.45, 0), 0xc9a04a, 0.15));
    }
    return merge(parts);
  };
  return [lod(16), lod(10), lod(6)];
}

function buildPillar() {
  const lod = (seg) => {
    const parts = [];
    parts.push(tint(move(new THREE.CylinderGeometry(0.55, 0.62, 4.2, seg), 0, 2.1, 0), STONE, 0, 0xa8a193));
    parts.push(tint(move(new THREE.BoxGeometry(1.6, 0.35, 1.6), 0, 0.175, 0), STONE_DARK));
    if (seg >= 8) parts.push(tint(move(new THREE.BoxGeometry(1.5, 0.35, 1.5), 0, 4.35, 0), STONE_DARK));
    return merge(parts);
  };
  return [lod(12), lod(8), lod(5)];
}

function buildLamp() {
  const lod = (seg) => {
    const parts = [];
    parts.push(tint(move(new THREE.CylinderGeometry(0.2, 0.28, 1.5, seg), 0, 0.75, 0), STONE_DARK));
    parts.push(tint(move(new THREE.CylinderGeometry(0.36, 0.22, 0.22, seg), 0, 1.6, 0), 0xb8742d));
    // Flame: strongly emissive.
    parts.push(tint(move(new THREE.ConeGeometry(0.11, 0.34, seg >= 8 ? 6 : 4), 0, 1.86, 0), FLAME, 2.6, 0xfff1c4));
    return merge(parts);
  };
  return [lod(10), lod(7), lod(5)];
}

function buildShrine() {
  const lod = (seg) => {
    const parts = [];
    parts.push(tint(move(new THREE.BoxGeometry(3.2, 0.5, 3.2), 0, 0.25, 0), STONE_DARK));
    parts.push(tint(move(new THREE.BoxGeometry(2.2, 2.2, 2.2), 0, 1.6, 0), 0xa25a3a, 0, 0xc27452));
    parts.push(tint(move(new THREE.SphereGeometry(1.35, seg, Math.max(4, seg - 3), 0, Math.PI * 2, 0, Math.PI / 2), 0, 2.7, 0), 0xd8a54a, 0.08, 0xf2cb6e));
    parts.push(tint(move(new THREE.ConeGeometry(0.28, 0.9, 6), 0, 4.45, 0), 0xe6b84e, 0.2));
    if (seg >= 10) {
      // Opening + two lamps flanking it.
      parts.push(tint(move(new THREE.BoxGeometry(0.9, 1.3, 0.2), 0, 1.3, 1.15), 0x2a1d16));
      for (const sx of [-1.1, 1.1]) {
        parts.push(tint(move(new THREE.CylinderGeometry(0.16, 0.12, 0.14, 8), sx, 0.57, 1.3), 0xb8742d));
        parts.push(tint(move(new THREE.ConeGeometry(0.08, 0.26, 5), sx, 0.77, 1.3), FLAME, 2.4, 0xfff1c4));
      }
    }
    return merge(parts);
  };
  return [lod(14), lod(9), lod(6)];
}

function buildRock() {
  const lod = (detail) => {
    const g = jitter(new THREE.IcosahedronGeometry(1.4, detail + 1), 0.5, 1234);
    g.translate(0, 0.55, 0);
    return merge([tint(g, 0x6e6a63, 0, 0x8f8a80)]);
  };
  return [lod(2), lod(1), lod(0)];
}


// ----------------------------------------------------------- villages & dens

const PLASTER = 0xc9a373;
const PLASTER_DARK = 0xa8865a;
const MUD_BAND = 0x8a4a2a;
const WOOD = 0x3a2416;
const TERRACOTTA = 0x9a4a2c;
const THATCH = 0x9b8455;
const GLASS_WARM = 0xffb653;
const MARIGOLD = 0xff9a1f;
const MANGO_LEAF = 0x3f7a2a;

/** Marigold toran (garland) with mango leaves, hung across width `w` at height `y`. */
function toran(parts, w, y, z, beads = 11) {
  for (let i = 0; i < beads; i++) {
    const t = i / (beads - 1);
    const x = -w / 2 + t * w;
    const sag = Math.sin(t * Math.PI) * 0.22;
    parts.push(tint(move(new THREE.SphereGeometry(0.09, 6, 5), x, y - sag, z), i % 2 ? MARIGOLD : 0xffc21f, 0.12));
    if (i % 2 === 0) parts.push(tint(move(new THREE.PlaneGeometry(0.12, 0.26), x, y - sag - 0.2, z + 0.02), MANGO_LEAF));
  }
}

/** Triangular prism along X (gable): base at y=0 spanning ±depth/2 in z, ridge at y=height. */
function prism(width, height, depth) {
  const hw = width / 2, hd = depth / 2;
  // Two gable triangles + 3 quads (two roof planes and the base), non-indexed.
  const A = [-hw, 0, -hd], B = [-hw, 0, hd], C = [-hw, height, 0];
  const D = [hw, 0, -hd], E = [hw, 0, hd], F = [hw, height, 0];
  const tris = [
    [A, C, B], [D, E, F],                  // gable ends
    [A, D, F], [A, F, C],                  // back roof plane (-z side)
    [B, C, F], [B, F, E],                  // front roof plane (+z side)
    [A, B, E], [A, E, D],                  // base
  ];
  const pos = new Float32Array(tris.length * 9);
  let i = 0;
  for (const t of tris) for (const v of t) { pos[i++] = v[0]; pos[i++] = v[1]; pos[i++] = v[2]; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function buildHouse() {
  const lod = (detail) => {
    const parts = [];
    const W = 9.2, D = 7.6, H = 4.1;
    const T = 0.24; // wall thickness
    // Floor at ground level (the controller stands on it) over a deep stone
    // foundation, so on a slope the house sits on masonry instead of floating.
    parts.push(tint(move(new THREE.BoxGeometry(W + 0.6, 0.12, D + 0.6), 0, 0.0, 0), 0x7a5a40, 0, 0x8d6a4a)); // mud floor
    parts.push(tint(move(new THREE.BoxGeometry(W + 0.7, 3.0, D + 0.7), 0, -1.55, 0), STONE_DARK, 0, 0x7d766b)); // foundation
    // Hollow walls: back, two sides, and a front split around the doorway.
    parts.push(tint(move(new THREE.BoxGeometry(W, H, T), 0, 0.4 + H / 2, -D / 2 + T / 2), PLASTER, 0, 0xd8b98a));
    parts.push(tint(move(new THREE.BoxGeometry(T, H, D), -W / 2 + T / 2, 0.4 + H / 2, 0), PLASTER, 0, 0xd8b98a));
    parts.push(tint(move(new THREE.BoxGeometry(T, H, D), W / 2 - T / 2, 0.4 + H / 2, 0), PLASTER, 0, 0xd8b98a));
    const doorW = 2.4;
    const sideW = (W - doorW) / 2;
    parts.push(tint(move(new THREE.BoxGeometry(sideW, H, T), -W / 2 + sideW / 2, 0.4 + H / 2, D / 2 - T / 2), PLASTER, 0, 0xd8b98a));
    parts.push(tint(move(new THREE.BoxGeometry(sideW, H, T), W / 2 - sideW / 2, 0.4 + H / 2, D / 2 - T / 2), PLASTER, 0, 0xd8b98a));
    parts.push(tint(move(new THREE.BoxGeometry(doorW, H - 3.0, T), 0, 0.4 + H - (H - 3.0) / 2, D / 2 - T / 2), PLASTER, 0, 0xd8b98a)); // above the door
    parts.push(tint(move(new THREE.BoxGeometry(W + 0.02, 0.7, T + 0.02), 0, 0.75, -D / 2 + T / 2), MUD_BAND)); // ochre skirt (back)
    parts.push(tint(move(new THREE.BoxGeometry(T + 0.02, 0.7, D + 0.02), -W / 2 + T / 2, 0.75, 0), MUD_BAND));
    parts.push(tint(move(new THREE.BoxGeometry(T + 0.02, 0.7, D + 0.02), W / 2 - T / 2, 0.75, 0), MUD_BAND));
    parts.push(tint(move(new THREE.BoxGeometry(sideW + 0.02, 0.7, T + 0.02), -W / 2 + sideW / 2, 0.75, D / 2 - T / 2), MUD_BAND));
    parts.push(tint(move(new THREE.BoxGeometry(sideW + 0.02, 0.7, T + 0.02), W / 2 - sideW / 2, 0.75, D / 2 - T / 2), MUD_BAND));
    // Gable + roof slabs with overhang.
    parts.push(tint(move(prism(W, 2.7, D), 0, 0.4 + H, 0), PLASTER_DARK));
    for (const sgn of [1, -1]) {
      // Slab centred on the mid-point of each roof plane, tilted to its pitch.
      const slab = new THREE.BoxGeometry(W + 1.4, 0.18, Math.hypot(D / 2, 2.7) + 0.6);
      slab.rotateX(sgn * Math.atan2(2.7, D / 2));
      slab.translate(0, 0.4 + H + 1.35 + 0.1, sgn * (D / 4 + 0.15));
      // Tile courses: thin ridges across the slab read as rows of terracotta tiles.
      for (let c = 1; c < 6; c++) {
        const ridge = new THREE.BoxGeometry(W + 1.4, 0.06, 0.12);
        const along = (c / 6) * Math.hypot(D / 2, 2.7) - Math.hypot(D / 2, 2.7) / 2;
        ridge.translate(0, 0.12, along);
        ridge.rotateX(sgn * Math.atan2(2.7, D / 2));
        ridge.translate(0, 0.4 + H + 1.35 + 0.1, sgn * (D / 4 + 0.15));
        parts.push(tint(ridge, 0x7e3a20));
      }
      parts.push(tint(slab, TERRACOTTA, 0, 0xb8623c));
    }
    parts.push(tint(move(new THREE.CylinderGeometry(0.14, 0.14, W + 1.4, 6), 0, 0.4 + H + 2.7, 0, 0, 0, Math.PI / 2), 0x6e3520));
    // Door leaf swung open inward (hinged at the left jamb), step, windows, toran, diya.
    const leaf = new THREE.BoxGeometry(2.1, 2.9, 0.09);
    leaf.translate(1.05, 0, 0);
    leaf.rotateY(-1.9);
    leaf.translate(-doorW / 2, 0.4 + 1.45, D / 2 - T / 2);
    parts.push(tint(leaf, WOOD));
    parts.push(tint(move(new THREE.BoxGeometry(3.2, 0.5, 1.2), 0, 0.42, D / 2 + 0.6), STONE_DARK)); // threshold slab (lands at y≈0.02 after the drop)
    // Interior: an oil lamp on a wall shelf and a small framed image niche.
    parts.push(tint(move(new THREE.BoxGeometry(1.2, 0.08, 0.4), 0, 0.4 + 1.6, -D / 2 + T + 0.22), WOOD));
    parts.push(tint(move(new THREE.CylinderGeometry(0.12, 0.09, 0.1, 8), 0, 0.4 + 1.69, -D / 2 + T + 0.22), 0xb8742d));
    parts.push(tint(move(new THREE.ConeGeometry(0.06, 0.2, 5), 0, 0.4 + 1.84, -D / 2 + T + 0.22), FLAME, 2.6, 0xfff1c4));
    parts.push(tint(move(new THREE.BoxGeometry(0.8, 1.0, 0.04), 0, 0.4 + 2.5, -D / 2 + T + 0.03), 0xc9a04a, 0.1));
    // A cot and a water pot make the room lived-in.
    parts.push(tint(move(new THREE.BoxGeometry(2.4, 0.12, 1.1), -W / 2 + 1.6, 0.4 + 0.5, -1.2), WOOD));
    for (const [lx, lz] of [[-1.05, -0.45], [1.05, -0.45], [-1.05, 0.45], [1.05, 0.45]]) parts.push(tint(move(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 5), -W / 2 + 1.6 + lx, 0.4 + 0.25, -1.2 + lz), WOOD));
    parts.push(tint(move(new THREE.SphereGeometry(0.32, 10, 8), W / 2 - 1.2, 0.4 + 0.32, -1.5), 0x8a4a2a));
    if (detail >= 1) {
      for (const x of [-3.0, 3.0]) {
        parts.push(tint(move(new THREE.BoxGeometry(1.6, 1.6, 0.14), x, 0.4 + 2.3, D / 2 + 0.03), 0x2a4d7a));
        parts.push(tint(move(new THREE.BoxGeometry(1.2, 1.2, 0.1), x, 0.4 + 2.3, D / 2 + 0.06), GLASS_WARM, 1.1));
        parts.push(tint(move(new THREE.BoxGeometry(0.06, 1.2, 0.12), x, 0.4 + 2.3, D / 2 + 0.1), 0x2a4d7a)); // mullion
        parts.push(tint(move(new THREE.BoxGeometry(1.9, 0.14, 0.4), x, 0.4 + 1.45, D / 2 + 0.15), STONE_DARK)); // sill
      }
      // Side windows.
      for (const sx of [1, -1]) parts.push(tint(move(new THREE.BoxGeometry(0.1, 1.2, 1.2), sx * (W / 2 + 0.03), 0.4 + 2.3, -0.8), GLASS_WARM, 1.1));
    }
    if (detail >= 2) {
      parts.push(tint(move(new THREE.BoxGeometry(2.9, 0.14, 0.35), 0, 0.4 + 3.05, D / 2 + 0.12), WOOD)); // lintel
      toran(parts, 3.6, 0.4 + 3.55, D / 2 + 0.14, 15);
      for (const sx of [-1.5, 1.5]) {
        parts.push(tint(move(new THREE.CylinderGeometry(0.16, 0.12, 0.12, 8), sx, 0.6, D / 2 + 0.7), 0xb8742d));
        parts.push(tint(move(new THREE.ConeGeometry(0.07, 0.24, 5), sx, 0.78, D / 2 + 0.7), FLAME, 2.4, 0xfff1c4));
      }
      // Rangoli at the doorstep and a tulsi planter by the wall.
      parts.push(tint(move(new THREE.CircleGeometry(0.8, 16), 0, 0.41, D / 2 + 1.9).rotateX(-Math.PI / 2), 0xe0453a, 0.05, 0xffd23f));
      parts.push(tint(move(new THREE.CylinderGeometry(0.35, 0.28, 0.7, 8), W / 2 - 0.8, 0.75, D / 2 + 0.9), 0xa25a3a));
      parts.push(tint(move(new THREE.SphereGeometry(0.4, 8, 6), W / 2 - 0.8, 1.35, D / 2 + 0.9), 0x3f7a2a, 0, 0x7fb552));
    }
    // Everything above was authored on a 0.4 plinth; drop it so the floor is at y=0.
    const g = merge(parts);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0.3) pos.setY(i, pos.getY(i) - 0.4);
    g.computeBoundingSphere();
    return g;
  };
  return [lod(2), lod(1), lod(0)];
}

function buildHut() {
  const lod = (detail) => {
    const parts = [];
    const R = 3.1, H = 2.9;
    const seg = detail ? 22 : 12;
    const gap = 0.42; // doorway half-angle, centred on +z
    parts.push(tint(move(new THREE.CylinderGeometry(R + 0.25, R + 0.35, 0.3, seg), 0, -0.14, 0), STONE_DARK)); // floor slab, flush
    parts.push(tint(move(new THREE.CylinderGeometry(R + 0.3, R + 0.45, 2.6, seg), 0, -1.5, 0), STONE_DARK, 0, 0x7d766b)); // foundation
    parts.push(tint(move(new THREE.CylinderGeometry(R, R + 0.05, H, seg, 1, true, gap, Math.PI * 2 - gap * 2), 0, 0.3 + H / 2, 0), PLASTER, 0, 0xd8b98a));
    parts.push(tint(move(new THREE.CylinderGeometry(R + 0.02, R + 0.07, 0.5, seg, 1, true, gap, Math.PI * 2 - gap * 2), 0, 0.55, 0), MUD_BAND));
    // Lintel over the doorway.
    parts.push(tint(move(new THREE.BoxGeometry(2.8, 0.5, 0.3), 0, 0.3 + H - 0.25, R - 0.05), PLASTER_DARK));
    parts.push(tint(move(new THREE.ConeGeometry(R + 1.1, 2.6, detail ? 18 : 8), 0, 0.3 + H + 1.25, 0), THATCH, 0, 0xc4ab73));
    parts.push(tint(move(new THREE.SphereGeometry(0.24, 8, 6), 0, 0.3 + H + 2.55, 0), 0x6e5a3a));
    // Door leaf swung open, interior lamp.
    const leaf = new THREE.BoxGeometry(1.3, 2.3, 0.07);
    leaf.translate(0.65, 0, 0);
    leaf.rotateY(-1.8);
    leaf.translate(-Math.sin(gap) * R, 0.3 + 1.15, Math.cos(gap) * R - 0.05);
    parts.push(tint(leaf, WOOD));
    parts.push(tint(move(new THREE.ConeGeometry(0.05, 0.18, 5), 0, 0.3 + 1.2, -R + 0.5), FLAME, 2.4, 0xfff1c4));
    if (detail >= 1) {
      parts.push(tint(move(new THREE.BoxGeometry(0.8, 0.8, 0.12), 2.1, 0.3 + 1.7, R - 0.65, 0, -0.75, 0), GLASS_WARM, 1.0));
      toran(parts, 2.4, 0.3 + 2.6, R + 0.06, 9);
      parts.push(tint(move(new THREE.ConeGeometry(0.06, 0.2, 5), 1.1, 0.45, R + 0.4), FLAME, 2.2, 0xfff1c4));
    }
    // Authored on a 0.3 slab; drop so the floor is at y=0 (foundation/slab untouched).
    const g = merge(parts);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0.2) pos.setY(i, pos.getY(i) - 0.3);
    g.computeBoundingSphere();
    return g;
  };
  return [lod(2), lod(1), lod(0)];
}

function buildWell() {
  const lod = (seg) => {
    const parts = [];
    parts.push(tint(move(new THREE.CylinderGeometry(1.3, 1.4, 0.95, seg, 1, true), 0, 0.48, 0), STONE, 0, 0xa8a193));
    parts.push(tint(move(new THREE.TorusGeometry(1.3, 0.14, 6, seg), 0, 0.95, 0, Math.PI / 2), STONE_DARK));
    parts.push(tint(move(new THREE.CircleGeometry(1.15, seg), 0, 0.3, 0).rotateX(-Math.PI / 2), 0x1b3a3c));
    for (const sx of [-1, 1]) parts.push(tint(move(new THREE.CylinderGeometry(0.08, 0.1, 2.4, 6), sx * 1.15, 1.9, 0), WOOD));
    parts.push(tint(move(new THREE.CylinderGeometry(0.08, 0.08, 2.5, 6), 0, 3.05, 0, 0, 0, Math.PI / 2), WOOD));
    if (seg >= 12) {
      parts.push(tint(move(prism(2.9, 0.7, 1.6), 0, 3.15, 0), TERRACOTTA));
      parts.push(tint(move(new THREE.CylinderGeometry(0.18, 0.14, 0.3, 8), 0, 2.2, 0), 0x6e5a3a)); // bucket
      parts.push(tint(move(new THREE.CylinderGeometry(0.015, 0.015, 0.7, 3), 0, 2.7, 0), 0xd6c8a8));
    }
    return merge(parts);
  };
  return [lod(16), lod(10), lod(6)];
}

function buildLamppost() {
  const lod = (seg) => {
    const parts = [];
    parts.push(tint(move(new THREE.CylinderGeometry(0.22, 0.3, 0.4, seg), 0, 0.2, 0), STONE_DARK));
    parts.push(tint(move(new THREE.CylinderGeometry(0.09, 0.12, 3.4, seg), 0, 2.1, 0), 0x4a3b2a));
    parts.push(tint(move(new THREE.BoxGeometry(0.5, 0.6, 0.5), 0, 3.95, 0), 0x2b2118));
    parts.push(tint(move(new THREE.BoxGeometry(0.36, 0.44, 0.36), 0, 3.95, 0), GLASS_WARM, 2.2, 0xfff0c0));
    parts.push(tint(move(new THREE.ConeGeometry(0.42, 0.3, 4), 0, 4.4, 0, 0, Math.PI / 4, 0), 0x6e3520));
    if (seg >= 8) {
      for (let i = 0; i < 6; i++) parts.push(tint(move(new THREE.SphereGeometry(0.07, 6, 5), Math.cos(i * 1.1) * 0.16, 3.4 - i * 0.28, Math.sin(i * 1.1) * 0.16), MARIGOLD, 0.1));
    }
    return merge(parts);
  };
  return [lod(10), lod(7), lod(5)];
}

function buildBurrow() {
  const lod = (seg) => {
    const parts = [];
    const mound = new THREE.SphereGeometry(1.5, seg, Math.max(5, seg - 4), 0, Math.PI * 2, 0, Math.PI / 2);
    mound.scale(1.3, 0.55, 1.15);
    parts.push(tint(mound, 0x6b4a2e, 0, 0x8a6a3c));
    // Entrance: a dark socket on the front face and a worn dirt apron.
    parts.push(tint(move(new THREE.SphereGeometry(0.42, seg, 6), 0, 0.32, 1.15), 0x120c08));
    parts.push(tint(move(new THREE.CircleGeometry(0.9, seg), 0, 0.02, 1.7).rotateX(-Math.PI / 2), 0x7a5a37));
    if (seg >= 10) {
      for (let i = 0; i < 5; i++) parts.push(tint(move(new THREE.SphereGeometry(0.1, 5, 4), -0.9 + i * 0.45, 0.06, 1.55 + (i % 2) * 0.3), 0x8f8a80));
      parts.push(tint(move(new THREE.SphereGeometry(0.2, 8, 6), 0, 0.42, 1.28), 0x8c7b6b)); // a mouse peeking out
      parts.push(tint(move(new THREE.SphereGeometry(0.05, 6, 4), 0, 0.42, 1.48), 0xe8a0a8));
    }
    return merge(parts);
  };
  return [lod(14), lod(9), lod(6)];
}

function buildCave() {
  const lod = (detail) => {
    const parts = [];
    const R = 4.0;
    const gap = 0.62; // opening half-angle around +z
    const seg = detail >= 2 ? 26 : detail === 1 ? 16 : 10;
    // Dome shell (upper hemisphere) with a wedge missing for the mouth.
    // three's sphere puts +z at phi = π/2, so the opening is centred there.
    const dome = new THREE.SphereGeometry(R, seg, Math.max(6, seg / 2), Math.PI / 2 + gap, Math.PI * 2 - gap * 2, 0, Math.PI / 2);
    jitter(dome, 0.26, 4321);
    dome.scale(1.25, 0.95, 1.1);
    parts.push(tint(dome, 0x4f4a45, 0, 0x726c64));
    // Floor and a low lip around the mouth.
    parts.push(tint(move(new THREE.CircleGeometry(R * 1.05, seg), 0, 0.04, 0).rotateX(-Math.PI / 2), 0x3b3632, 0, 0x5a544d));
    if (detail >= 1) {
      for (let i = 0; i < 5; i++) {
        const r = jitter(new THREE.IcosahedronGeometry(0.5 + (i % 2) * 0.35, 1), 0.4, 77 + i);
        const a = -0.9 + i * 0.45;
        r.translate(Math.sin(a) * (R + 0.6) * (a < 0 ? 1.1 : 1.0), 0.3, Math.cos(a) * (R + 0.9));
        parts.push(tint(r, 0x5a544d, 0, 0x7a746b));
      }
      parts.push(tint(move(new THREE.CylinderGeometry(0.14, 0.1, 0.1, 8), 0, 0.09, -1.6), 0xb8742d));
      parts.push(tint(move(new THREE.ConeGeometry(0.07, 0.24, 5), 0, 0.25, -1.6), FLAME, 2.6, 0xfff1c4)); // lamp deep inside
    }
    return merge(parts);
  };
  return [lod(2), lod(1), lod(0)];
}

function buildDeodar() {
  const lod = (tiers, seg) => {
    const parts = [];
    parts.push(tint(move(new THREE.CylinderGeometry(0.16, 0.32, 3.0, seg), 0, 1.5, 0), 0x4a3524));
    for (let i = 0; i < tiers; i++) {
      const t = i / tiers;
      const r = 2.4 * (1 - t * 0.75);
      const h = 2.3 - t * 0.6;
      const y = 1.6 + i * (7.5 / tiers);
      const cone = new THREE.ConeGeometry(r, h, seg, 1, true);
      cone.translate(0, y + h / 2, 0);
      parts.push(tint(cone, 0x1c3f26, 0, 0x4e7a44));
    }
    return merge(parts);
  };
  return [lod(6, 10), lod(4, 7), lod(2, 5)];
}

function buildFlags() {
  const lod = (count) => {
    const parts = [];
    for (const sx of [-1, 1]) parts.push(tint(move(new THREE.CylinderGeometry(0.05, 0.07, 3.2, 5), sx * 3.4, 1.6, 0), 0x4a3b2a));
    parts.push(tint(move(new THREE.CylinderGeometry(0.012, 0.012, 6.8, 3), 0, 3.1, 0, 0, 0, Math.PI / 2), 0xd6c8a8));
    const colors = [0x2a5ad7, 0xf2f2f2, 0xd9342b, 0x2e9c48, 0xf2c14e];
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const x = -3.2 + t * 6.4;
      const sag = Math.sin(t * Math.PI) * 0.45;
      const f = new THREE.PlaneGeometry(0.52, 0.42);
      f.translate(0, -0.22, 0);
      f.rotateY((i % 2 ? 1 : -1) * 0.25);
      f.translate(x, 3.1 - sag, 0);
      parts.push(tint(f, colors[i % 5], 0.02));
    }
    return merge(parts);
  };
  return [lod(11), lod(7), lod(5)];
}

const BUILDERS = {
  banyan: buildBanyan,
  lotus: buildLotus,
  reeds: buildReeds,
  shrub: buildShrub,
  grass: buildGrass,
  marigold: buildMarigold,
  archway: buildArchway,
  pillar: buildPillar,
  lamp: buildLamp,
  shrine: buildShrine,
  rock: buildRock,
  house: buildHouse,
  hut: buildHut,
  well: buildWell,
  lamppost: buildLamppost,
  burrow: buildBurrow,
  cave: buildCave,
  deodar: buildDeodar,
  flags: buildFlags,
};

/** Per-type presentation data used by the chunk manager. */
export const PROP_META = {
  banyan: { height: 11, windy: false, alpha: true, castShadow: true },
  lotus: { height: 0.5, windy: false, alpha: false, castShadow: false },
  reeds: { height: 2.6, windy: true, alpha: false, castShadow: false },
  shrub: { height: 1.7, windy: true, alpha: true, castShadow: true },
  grass: { height: 0.55, windy: true, alpha: true, castShadow: false },
  marigold: { height: 0.45, windy: true, alpha: false, castShadow: false },
  archway: { height: 8.5, windy: false, alpha: false, castShadow: true },
  pillar: { height: 4.6, windy: false, alpha: false, castShadow: true },
  lamp: { height: 2.0, windy: false, alpha: false, castShadow: false },
  shrine: { height: 5, windy: false, alpha: false, castShadow: true },
  rock: { height: 2.4, windy: false, alpha: false, castShadow: true },
  house: { height: 9.2, windy: false, alpha: false, castShadow: true },
  hut: { height: 7.0, windy: false, alpha: false, castShadow: true },
  well: { height: 3.6, windy: false, alpha: false, castShadow: true },
  lamppost: { height: 4.6, windy: false, alpha: false, castShadow: false },
  burrow: { height: 1.0, windy: false, alpha: false, castShadow: false },
  cave: { height: 5.5, windy: false, alpha: false, castShadow: true },
  deodar: { height: 10.5, windy: false, alpha: false, castShadow: true },
  flags: { height: 3.4, windy: true, alpha: false, castShadow: false },
};

// ---------------------------------------------------------------- textures

/** Procedural grass-blade alpha mask: many thin, curved blades of varied height. */
function makeGrassAlpha() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = s;
  cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#fff';
  const rand = mulberry32(77);
  const blades = 22;
  for (let i = 0; i < blades; i++) {
    const x = (i + 0.5) * (s / blades) + (rand() - 0.5) * 6;
    const w = 2.5 + rand() * 3;
    const h = s * (0.45 + rand() * 0.55);
    const bend = (rand() - 0.5) * 34;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, s);
    ctx.quadraticCurveTo(x + bend * 0.4, s - h * 0.55, x + bend, s - h);
    ctx.quadraticCurveTo(x + bend * 0.45 + 1, s - h * 0.5, x + w / 2, s);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillRect(0, s - 8, 8, 8); // reserved opaque corner (uv ≈ 0.03, 0.03)
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Leaf-cluster alpha mask for tree/shrub canopy cards: soft-edged leaves on twigs. */
function makeLeafAlpha() {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = s;
  cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, s, s);
  const rand = mulberry32(31);
  // Twigs radiating from the centre, leaves along them.
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2.2;
  const twigs = 7;
  for (let t = 0; t < twigs; t++) {
    const a = (t / twigs) * Math.PI * 2 + rand() * 0.5;
    const len = s * (0.28 + rand() * 0.14);
    ctx.beginPath();
    ctx.moveTo(s / 2, s / 2);
    ctx.quadraticCurveTo(s / 2 + Math.cos(a + 0.3) * len * 0.5, s / 2 + Math.sin(a + 0.3) * len * 0.5, s / 2 + Math.cos(a) * len, s / 2 + Math.sin(a) * len);
    ctx.stroke();
    const leaves = 6 + (rand() * 4) | 0;
    for (let i = 0; i < leaves; i++) {
      const u = 0.25 + (i / leaves) * 0.75;
      const cx = s / 2 + Math.cos(a) * len * u + (rand() - 0.5) * 8;
      const cy = s / 2 + Math.sin(a) * len * u + (rand() - 0.5) * 8;
      const L = 18 + rand() * 16;
      const W = 7 + rand() * 6;
      const rot = a + (i % 2 ? 0.9 : -0.9) + (rand() - 0.5) * 0.5;
      // Soft alpha: radial gradient inside the leaf so the edge fades ~2 px.
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, L / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.78, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0.15)');
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-L / 2, 0);
      ctx.quadraticCurveTo(0, -W, L / 2, 0);
      ctx.quadraticCurveTo(0, W, -L / 2, 0);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, s - 8, 8, 8); // reserved opaque corner (uv ≈ 0.03, 0.03)
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Random leaf cards filling a sphere; `count` quads of `size`. */
function leafCards(count, cx, cy, cz, radius, size, seed, colorA, colorB) {
  const rand = mulberry32(seed);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    // Shell distribution: cards live in the outer half of the canopy where
    // they are seen; the dark core fills the inside.
    const rr = radius * (0.5 + 0.5 * Math.sqrt(rand()));
    const sx = Math.sqrt(1 - u * u);
    const x = cx + sx * Math.cos(t) * rr;
    const y = cy + u * rr * 0.8;
    const z = cz + sx * Math.sin(t) * rr;
    const g = new THREE.PlaneGeometry(size, size);
    g.rotateX((rand() - 0.5) * 2.2);
    g.rotateY(rand() * Math.PI * 2);
    g.rotateZ((rand() - 0.5) * 1.5);
    g.translate(x, y, z);
    // Outer cards lighter (sunlit), inner darker.
    const depth = rr / radius;
    parts.push(tint(g, colorA, 0, colorB).scale(1, 1, 1));
    const col = parts[parts.length - 1].attributes.color;
    for (let k = 0; k < col.count; k++) col.setXYZ(k, col.getX(k) * (0.7 + depth * 0.3), col.getY(k) * (0.7 + depth * 0.3), col.getZ(k) * (0.7 + depth * 0.3));
  }
  return parts;
}

// --------------------------------------------------------------- materials

export const windUniform = { value: 0 };

/**
 * Patches MeshStandardMaterial so that:
 *  - vertex `aEmissive` adds `vColor * aEmissive` to emissive radiance;
 *  - windy props sway on a shared time uniform (weight rises with height).
 */
function patchMaterial(mat, windy) {
  // CSM (if enabled) has already installed its own onBeforeCompile — chain it.
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uWind = windUniform;
    shader.vertexShader =
      `attribute float aEmissive;\nvarying float vEmissive;\nuniform float uWind;\n` +
      shader.vertexShader
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\n vEmissive = aEmissive;\n` +
            (windy
              ? ` {
                 vec4 wp = instanceMatrix * vec4(transformed, 1.0);
                 float sway = sin(uWind * 1.7 + wp.x * 0.35 + wp.z * 0.27) * 0.5
                            + sin(uWind * 2.9 + wp.z * 0.6) * 0.25;
                 float w = clamp(transformed.y, 0.0, 3.0) * 0.06;
                 transformed.x += sway * w;
                 transformed.z += sway * w * 0.6;
               }\n`
              : '')
        );
    shader.fragmentShader =
      `varying float vEmissive;\n` +
      shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\n totalEmissiveRadiance += vColor.rgb * vEmissive;`
      );
  };
  // Force a unique program per windy/non-windy variant.
  mat.customProgramCacheKey = () => (windy ? 'prop-windy' : 'prop-static');
  return mat;
}

export class PropLibrary {
  constructor() {
    this.geometries = {}; // name → [lod0, lod1, lod2]
    this.materials = {};  // name → material
    this.grassAlpha = null;
  }

  /** @param csm optional CSM instance; materials are registered with it first. */
  build(csm = null) {
    this.grassAlpha = makeGrassAlpha();
    this.leafAlpha = makeLeafAlpha();
    const bark = makeBarkNormal(256, 41);
    bark.repeat.set(2, 2);
    const plaster = makePlasterNormal(256, 43);
    plaster.repeat.set(3, 3);
    const SURFACE_NORMAL = { deodar: [bark, 0.8], house: [plaster, 0.45], hut: [plaster, 0.5], well: [plaster, 0.4], pillar: [plaster, 0.35], archway: [plaster, 0.35], cave: [bark, 0.5], rock: [bark, 0.45] };
    for (const name of PROP_TYPES) {
      this.geometries[name] = BUILDERS[name]();
      const meta = PROP_META[name];
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: name === 'lotus' ? 0.45 : 0.86,
        metalness: 0.0,
        side: meta.alpha || ['flags', 'house', 'hut', 'cave'].includes(name) ? THREE.DoubleSide : THREE.FrontSide,
      });
      if (meta.alpha) {
        mat.alphaMap = name === 'grass' ? this.grassAlpha : this.leafAlpha;
        mat.alphaTest = 0.4;
        mat.transparent = false;
        mat.alphaToCoverage = true; // soft edges under MSAA; harmless without it
      }
      if (SURFACE_NORMAL[name]) {
        mat.normalMap = SURFACE_NORMAL[name][0];
        mat.normalScale = new THREE.Vector2(SURFACE_NORMAL[name][1], SURFACE_NORMAL[name][1]);
      }
      if (csm) csm.setupMaterial(mat);
      this.materials[name] = patchMaterial(mat, meta.windy);
    }
    return this;
  }

  /** Radius of the LOD0 bounding sphere; used for culling & screen-size LOD. */
  boundingRadius(name) {
    return this.geometries[name][0].boundingSphere.radius;
  }
}
