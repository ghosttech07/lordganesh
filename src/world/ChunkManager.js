// Chunk streaming. Owns the terrain field, the worker pool, and every loaded
// chunk's GPU resources. The per-frame update() allocates nothing: it walks
// the active grid with integer loops and reuses scratch objects.

import * as THREE from 'three';
import { TerrainField } from './TerrainField.js';
import { CHUNK_SIZE, CHUNK_RES, VIEW_RADIUS, WATER_LEVEL } from './WorldConfig.js';
import { createWaterMaterial } from './Water.js';
import { PROP_TYPES, PROP_COLLIDERS, SHELTERS } from './Biomes.js';
import { PROP_META } from './PropLibrary.js';
import { floorDiv, hash2 } from '../core/MathUtils.js';
import { makeDetailNormalMap, makeRoughnessAOMap } from '../fx/ProceduralTextures.js';
import { createTerrainMaterial } from './TerrainMaterial.js';

const UNLOAD_RADIUS = VIEW_RADIUS + 1; // hysteresis so border chunks don't thrash
const MAX_IN_FLIGHT = 6;
const UPLOADS_PER_FRAME = 1;
const LOD_CHUNKS_PER_FRAME = 4;

// LOD switch thresholds in *screen pixels* of the prop's height.
const LOD1_PX = 70;
const LOD2_PX = 22;
// Below this many pixels the prop is not drawn at all (small-object culling).
const CULL_PX = 5;

const _obj = new THREE.Object3D();
const _col = new THREE.Color();
const _camPos = new THREE.Vector3();

// Per-instance tint ranges [hue shift, saturation scale, lightness scale] so
// no two trees, roofs or tufts are the same colour.
const INSTANCE_TINT = {
  banyan: [0.03, 0.2, 0.18],
  deodar: [0.02, 0.15, 0.2],
  shrub: [0.03, 0.2, 0.2],
  grass: [0.03, 0.25, 0.25],
  marigold: [0.02, 0.1, 0.15],
  reeds: [0.02, 0.2, 0.2],
  house: [0.01, 0.15, 0.1],
  hut: [0.01, 0.15, 0.12],
  rock: [0.0, 0.1, 0.22],
  cave: [0.0, 0.1, 0.15],
};
const _tmp = new THREE.Vector3();

// Numeric chunk key: no string allocation in the per-tick collider queries.
const KEY_OFF = 1 << 20;
const chunkKey = (cx, cz) => (cx + KEY_OFF) * (KEY_OFF * 2) + (cz + KEY_OFF);
export const chunkKeyToCoords = (key, out) => {
  out[0] = Math.floor(key / (KEY_OFF * 2)) - KEY_OFF;
  out[1] = (key % (KEY_OFF * 2)) - KEY_OFF;
  return out;
};

class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);
    this.originX = cx * CHUNK_SIZE;
    this.originZ = cz * CHUNK_SIZE;
    this.centerX = this.originX + CHUNK_SIZE / 2;
    this.centerZ = this.originZ + CHUNK_SIZE / 2;
    this.terrain = null;        // THREE.Mesh
    this.water = null;          // THREE.Mesh or null
    this.props = [];            // { name, mesh, lod, height, count }
    this.colliders = null;      // Float32Array [x, z, r, ...] world-space
    this.colliderCount = 0;
    this.shrines = null;        // Float32Array [x, y, z, ...] world-space
    this.shrineCount = 0;
    this.shelters = null;       // Float32Array [x, y, z, rotY, type, ...] interior points
    this.shelterCount = 0;
    this.doors = null;          // Float32Array [x, z, r, ...] doorway blockers (mount can't pass)
    this.doorCount = 0;
    this.ready = false;
    this.minY = 0;
    this.maxY = 0;
  }
}

// Local +z of each building's doorway; the mount is blocked here.
const DOOR_LOCAL_Z = { house: 7.6 / 2, hut: 3.1 };

function colliderCirclesPerInstance(c) {
  let n = 0;
  if (c.walls) for (const [x1, z1, x2, z2] of c.walls) n += Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1) / (c.r * 1.6))) + 1;
  if (c.ring) n += Math.ceil((Math.PI * 2 * c.ring.radius) / (c.r * 1.6));
  return n;
}

export class ChunkManager {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {number} o.seed
   * @param {import('./PropLibrary.js').PropLibrary} o.props
   * @param {object|null} o.csm
   * @param {object} o.quality  quality preset (shadow flags, prop density)
   */
  constructor({ scene, seed, props, csm, quality, simple = false, terrainTextures = null }) {
    this.scene = scene;
    this.seed = seed >>> 0;
    this.field = new TerrainField(this.seed);
    this.props = props;
    this.csm = csm;
    this.quality = quality;
    this.simple = simple;
    this.terrainTextures = terrainTextures;

    this.chunks = new Map();
    this.pending = new Map(); // requestId → key
    this.pendingKeys = new Set();
    this.resultQueue = [];
    this.explored = new Set();
    this.nextRequestId = 1;

    this.playerCX = 0;
    this.playerCZ = 0;
    this._lodCursor = 0;
    this._needsRefresh = true;
    this._chunkList = []; // flat array mirror of the map, for allocation-free iteration

    this.group = new THREE.Group();
    this.group.name = 'chunks';
    scene.add(this.group);

    this._buildSharedGeometry();
    this._buildTerrainMaterial();
    this._spawnWorkers();

    this.stats = { loaded: 0, pending: 0, instances: 0 };
  }

  // ---------------------------------------------------------------- setup

  _buildSharedGeometry() {
    const n = CHUNK_RES + 1;
    const idx = new Uint32Array(CHUNK_RES * CHUNK_RES * 6);
    let k = 0;
    for (let j = 0; j < CHUNK_RES; j++) {
      for (let i = 0; i < CHUNK_RES; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        idx[k++] = a;
        idx[k++] = c;
        idx[k++] = b;
        idx[k++] = b;
        idx[k++] = c;
        idx[k++] = d;
      }
    }
    this.sharedIndex = new THREE.BufferAttribute(idx, 1);

    // UVs tile the detail maps every 16 world units. 128/16 = 8, so seams align.
    const uv = new Float32Array(n * n * 2);
    let u = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        uv[u++] = (i / CHUNK_RES) * 8;
        uv[u++] = (j / CHUNK_RES) * 8;
      }
    }
    this.sharedUV = new THREE.BufferAttribute(uv, 2);

    // Flat water plane positions — identical for every chunk, so shared.
    const wp = new Float32Array(n * n * 3);
    let w = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        wp[w++] = (i / CHUNK_RES) * CHUNK_SIZE;
        wp[w++] = WATER_LEVEL;
        wp[w++] = (j / CHUNK_RES) * CHUNK_SIZE;
      }
    }
    this.sharedWaterPos = new THREE.BufferAttribute(wp, 3);
    this.waterMaterial = createWaterMaterial(this.seed, this.simple);
  }

  _buildTerrainMaterial() {
    if (this.terrainTextures && !this.simple) {
      this.terrainMaterial = createTerrainMaterial(this.terrainTextures, this.csm, this.quality.anisotropy);
      return;
    }
    const normalMap = makeDetailNormalMap(256, this.seed ^ 0x51);
    const raoMap = makeRoughnessAOMap(128, this.seed ^ 0x77);
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1.0,
      metalness: 0.0,
      normalMap,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughnessMap: raoMap,
      aoMap: raoMap,
      aoMapIntensity: 0.6,
    });
    if (this.csm) this.csm.setupMaterial(mat);
    this.terrainMaterial = mat;
  }

  _spawnWorkers() {
    const count = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
    this.workers = [];
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./terrain.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this._onWorkerMessage(e.data);
      w.postMessage({ type: 'init', seed: this.seed });
      this.workers.push(w);
    }
    this._workerRR = 0;
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    for (const c of this.chunks.values()) this._destroyChunk(c);
    this.chunks.clear();
    this.scene.remove(this.group);
  }

  // ------------------------------------------------------------- streaming

  _onWorkerMessage(msg) {
    if (msg.type !== 'chunk') return;
    const key = this.pending.get(msg.requestId);
    this.pending.delete(msg.requestId);
    if (!key) return;
    // Player may have moved on; drop stale results without uploading.
    const dx = Math.abs(msg.chunkX - this.playerCX);
    const dz = Math.abs(msg.chunkZ - this.playerCZ);
    if (Math.max(dx, dz) > UNLOAD_RADIUS) {
      this.pendingKeys.delete(key);
      this._needsRefresh = true;
      return;
    }
    // The key stays in pendingKeys until the chunk is actually built, so it
    // can't be re-requested while it waits in the upload queue.
    this.resultQueue.push(msg);
  }

  _request(cx, cz) {
    const key = chunkKey(cx, cz);
    if (this.chunks.has(key) || this.pendingKeys.has(key)) return;
    const id = this.nextRequestId++;
    this.pending.set(id, key);
    this.pendingKeys.add(key);
    const w = this.workers[this._workerRR];
    this._workerRR = (this._workerRR + 1) % this.workers.length;
    w.postMessage({ type: 'build', chunkX: cx, chunkZ: cz, requestId: id });
  }

  /** Main per-frame entry. Streams around (px, pz); updates LOD from `camera`. */
  update(px, pz, camera) {
    const cx = floorDiv(px, CHUNK_SIZE);
    const cz = floorDiv(pz, CHUNK_SIZE);
    const moved = cx !== this.playerCX || cz !== this.playerCZ || this.chunks.size === 0;
    this.playerCX = cx;
    this.playerCZ = cz;

    if (moved) {
      this.explored.add(chunkKey(cx, cz));
      this._updateShadowCasters();
    }
    if (moved || this._needsRefresh) {
      this._needsRefresh = false;
      this._refreshDesired();
    }

    // Throttled GPU upload: at most N chunk builds per frame.
    for (let i = 0; i < UPLOADS_PER_FRAME && this.resultQueue.length > 0; i++) {
      // Take the closest queued result first.
      let best = 0;
      let bestD = Infinity;
      for (let q = 0; q < this.resultQueue.length; q++) {
        const r = this.resultQueue[q];
        const d = Math.abs(r.chunkX - cx) + Math.abs(r.chunkZ - cz);
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
      const msg = this.resultQueue[best];
      this.resultQueue[best] = this.resultQueue[this.resultQueue.length - 1];
      this.resultQueue.pop();
      this._buildChunk(msg);
    }

    this._updateLOD(camera);

    this.stats.loaded = this.chunks.size;
    this.stats.pending = this.pendingKeys.size;
  }

  /** Only the 3x3 chunks around the player self-shadow; distant terrain
   *  shadowing is invisible under fog and would cost 4 cascades × 16 draws. */
  _updateShadowCasters() {
    if (!this.quality.terrainCastsShadow) return;
    for (let i = 0; i < this._chunkList.length; i++) {
      const c = this._chunkList[i];
      const near = Math.max(Math.abs(c.cx - this.playerCX), Math.abs(c.cz - this.playerCZ)) <= 1;
      if (c.terrain) c.terrain.castShadow = near;
    }
  }

  _refreshDesired() {
    const cx = this.playerCX;
    const cz = this.playerCZ;

    // Unload chunks beyond the hysteresis radius.
    for (let i = this._chunkList.length - 1; i >= 0; i--) {
      const c = this._chunkList[i];
      if (Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz)) > UNLOAD_RADIUS) {
        this._destroyChunk(c);
        this.chunks.delete(c.key);
        this._chunkList[i] = this._chunkList[this._chunkList.length - 1];
        this._chunkList.pop();
      }
    }

    // Request missing chunks in rings, nearest first.
    for (let r = 0; r <= VIEW_RADIUS; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (this.pendingKeys.size >= MAX_IN_FLIGHT) return;
          this._request(cx + dx, cz + dz);
        }
      }
    }
  }

  // --------------------------------------------------------------- build

  _buildChunk(msg) {
    const key = chunkKey(msg.chunkX, msg.chunkZ);
    this.pendingKeys.delete(key);
    this._needsRefresh = true; // a request slot freed up
    if (this.chunks.has(key)) return; // already built (defensive)
    if (Math.max(Math.abs(msg.chunkX - this.playerCX), Math.abs(msg.chunkZ - this.playerCZ)) > UNLOAD_RADIUS) return;
    const chunk = new Chunk(msg.chunkX, msg.chunkZ);
    chunk.minY = msg.minY;
    chunk.maxY = msg.maxY;

    // Terrain mesh. Index + UV attributes are shared across every chunk.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(msg.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(msg.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(msg.colors, 3));
    geo.setAttribute('aLayers', new THREE.BufferAttribute(msg.layers, 4));
    geo.setAttribute('uv', this.sharedUV);
    geo.setIndex(this.sharedIndex);
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(0, msg.minY, 0),
      new THREE.Vector3(CHUNK_SIZE, msg.maxY, CHUNK_SIZE)
    );
    geo.boundingSphere = new THREE.Sphere();
    geo.boundingBox.getBoundingSphere(geo.boundingSphere);

    const mesh = new THREE.Mesh(geo, this.terrainMaterial);
    mesh.position.set(chunk.originX, 0, chunk.originZ);
    mesh.receiveShadow = true;
    mesh.castShadow =
      this.quality.terrainCastsShadow &&
      Math.max(Math.abs(chunk.cx - this.playerCX), Math.abs(chunk.cz - this.playerCZ)) <= 1;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    chunk.terrain = mesh;

    // Water surface for chunks touching the waterline.
    if (msg.waterDepth) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', this.sharedWaterPos);
      wg.setAttribute('aDepth', new THREE.BufferAttribute(msg.waterDepth, 1));
      wg.setAttribute('uv', this.sharedUV);
      wg.setIndex(this.sharedIndex);
      wg.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(CHUNK_SIZE / 2, WATER_LEVEL, CHUNK_SIZE / 2),
        CHUNK_SIZE * 0.71
      );
      const wm = new THREE.Mesh(wg, this.waterMaterial);
      wm.position.set(chunk.originX, 0, chunk.originZ);
      wm.matrixAutoUpdate = false;
      wm.updateMatrix();
      wm.renderOrder = 5;
      this.group.add(wm);
      chunk.water = wm;
    }

    // Instanced props.
    let colliderCap = 0;
    let shelterCap = 0;
    for (const p of msg.props) {
      const name = PROP_TYPES[p.type];
      const n = p.data.length / 5;
      const c = PROP_COLLIDERS[name];
      if (c !== undefined) colliderCap += n * (name === 'archway' ? 2 : typeof c === 'number' ? 1 : colliderCirclesPerInstance(c));
      if (SHELTERS[name]) shelterCap += n;
    }
    chunk.colliders = new Float32Array(colliderCap * 3);
    let cc = 0;
    let shrineCap = 0;
    for (const p of msg.props) if (PROP_TYPES[p.type] === 'shrine') shrineCap += p.data.length / 5;
    chunk.shrines = new Float32Array(shrineCap * 3);
    let sc = 0;
    chunk.shelters = new Float32Array(shelterCap * 5); // x, y, z, rotY, type
    let sh = 0;
    chunk.doors = new Float32Array(shelterCap * 3);
    let dc = 0;

    for (const p of msg.props) {
      const name = PROP_TYPES[p.type];
      const meta = PROP_META[name];
      const data = p.data;
      let count = data.length / 5;

      // Quality presets thin out the cheap, dense vegetation.
      const keep = meta.height < 1.2 ? this.quality.vegetationDensity : 1;
      const stride = keep >= 1 ? 1 : Math.round(1 / keep);

      const lods = this.props.geometries[name];
      const mat = this.props.materials[name];
      const drawn = stride === 1 ? count : Math.ceil(count / stride);
      const im = new THREE.InstancedMesh(lods[0], mat, drawn);
      im.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      let k = 0;
      const collideR = PROP_COLLIDERS[name];
      for (let i = 0; i < count; i++) {
        const o = i * 5;
        const lx = data[o];
        const ly = data[o + 1];
        const lz = data[o + 2];
        const ry = data[o + 3];
        const s = data[o + 4];

        if (name === 'shrine') {
          chunk.shrines[sc++] = chunk.originX + lx;
          chunk.shrines[sc++] = ly;
          chunk.shrines[sc++] = chunk.originZ + lz;
        }
        if (SHELTERS[name]) {
          const ip = SHELTERS[name];
          const c = Math.cos(ry), sn = Math.sin(ry);
          chunk.shelters[sh++] = chunk.originX + lx + (ip[0] * c + ip[2] * sn) * s;
          chunk.shelters[sh++] = ly + ip[1] * s;
          chunk.shelters[sh++] = chunk.originZ + lz + (-ip[0] * sn + ip[2] * c) * s;
          chunk.shelters[sh++] = ry;
          chunk.shelters[sh++] = p.type;
          // Doorway blocker for the mount (houses and huts only; dens are fair game).
          const dz = DOOR_LOCAL_Z[name];
          if (dz !== undefined) {
            chunk.doors[dc++] = chunk.originX + lx + dz * sn * s;
            chunk.doors[dc++] = chunk.originZ + lz + dz * c * s;
            chunk.doors[dc++] = 1.5 * s;
          }
        }
        if (collideR !== undefined && typeof collideR === 'object') {
          // Walls / rings → circles in world space (rotY around Y: x' = x cos + z sin, z' = -x sin + z cos).
          const wx = chunk.originX + lx;
          const wz = chunk.originZ + lz;
          const c = Math.cos(ry), sn = Math.sin(ry);
          const r = collideR.r * s;
          const put = (px, pz) => {
            chunk.colliders[cc++] = wx + (px * c + pz * sn) * s;
            chunk.colliders[cc++] = wz + (-px * sn + pz * c) * s;
            chunk.colliders[cc++] = r;
          };
          if (collideR.walls) {
            for (const [x1, z1, x2, z2] of collideR.walls) {
              const len = Math.hypot(x2 - x1, z2 - z1);
              const n = Math.max(1, Math.ceil(len / (collideR.r * 1.6)));
              for (let q = 0; q <= n; q++) put(x1 + ((x2 - x1) * q) / n, z1 + ((z2 - z1) * q) / n);
            }
          }
          if (collideR.ring) {
            const { radius, gapCenter, gapHalfAngle } = collideR.ring;
            const n = Math.ceil((Math.PI * 2 * radius) / (collideR.r * 1.6));
            for (let q = 0; q < n; q++) {
              const a = (q / n) * Math.PI * 2;
              // Angle measured from +z toward +x; skip the doorway.
              let d = a - gapCenter;
              while (d > Math.PI) d -= Math.PI * 2;
              while (d < -Math.PI) d += Math.PI * 2;
              if (Math.abs(d) < gapHalfAngle) continue;
              put(Math.sin(a) * radius, Math.cos(a) * radius);
            }
          }
        } else if (collideR !== undefined) {
          const wx = chunk.originX + lx;
          const wz = chunk.originZ + lz;
          if (name === 'archway') {
            const ox = Math.cos(ry) * 2.4 * s;
            const oz = -Math.sin(ry) * 2.4 * s;
            chunk.colliders[cc++] = wx + ox;
            chunk.colliders[cc++] = wz + oz;
            chunk.colliders[cc++] = 0.75 * s;
            chunk.colliders[cc++] = wx - ox;
            chunk.colliders[cc++] = wz - oz;
            chunk.colliders[cc++] = 0.75 * s;
          } else {
            chunk.colliders[cc++] = wx;
            chunk.colliders[cc++] = wz;
            chunk.colliders[cc++] = collideR * s;
          }
        }

        if (i % stride !== 0) continue;
        _obj.position.set(lx, ly - 0.08, lz); // sink slightly so bases never float on slopes
        _obj.rotation.set(0, ry, 0);
        _obj.scale.setScalar(s);
        _obj.updateMatrix();
        im.setMatrixAt(k, _obj.matrix);
        const tintRange = INSTANCE_TINT[name];
        if (tintRange) {
          const h1 = hash2(Math.round(lx * 10), Math.round(lz * 10), this.seed ^ 0x77);
          const h2 = hash2(Math.round(lz * 10), Math.round(lx * 10), this.seed ^ 0x99);
          // Near-white multiplier: lightness ± range[2], warm/cool shift ± range[1],
          // a slight hue lean (more red or more green) ± range[0].
          const l = 1 + (h1 - 0.5) * 2 * tintRange[2];
          const warm = (h2 - 0.5) * 2 * tintRange[1];
          const lean = (h1 * h2 - 0.25) * 2 * tintRange[0];
          _col.setRGB(l * (1 + warm * 0.5 + lean), l * (1 + lean * 0.5), l * (1 - warm * 0.5 - lean));
          im.setColorAt(k, _col);
        }
        k++;
      }
      im.count = k;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.instanceMatrix.needsUpdate = true;
      im.position.set(chunk.originX, 0, chunk.originZ);
      im.matrixAutoUpdate = false;
      im.updateMatrix();
      im.castShadow = meta.castShadow && this.quality.propShadows;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      this.group.add(im);

      chunk.props.push({ name, mesh: im, lod: 0, height: meta.height, count: k });
      this.stats.instances += k;
    }
    chunk.colliderCount = cc / 3;
    chunk.shrineCount = sc / 3;
    chunk.shelterCount = sh / 5;
    chunk.doorCount = dc / 3;
    chunk.ready = true;

    this.chunks.set(chunk.key, chunk);
    this._chunkList.push(chunk);
  }

  _destroyChunk(chunk) {
    if (chunk.terrain) {
      this.group.remove(chunk.terrain);
      chunk.terrain.geometry.dispose();
    }
    if (chunk.water) {
      this.group.remove(chunk.water);
      chunk.water.geometry.dispose();
      chunk.water = null;
    }
    for (const p of chunk.props) {
      this.group.remove(p.mesh);
      p.mesh.dispose();
      this.stats.instances -= p.count;
    }
    chunk.props.length = 0;
  }

  // ----------------------------------------------------------------- LOD

  /**
   * Screen-space-size LOD. Because a chunk is 128u across, every instance of
   * a prop type in a chunk sits in a similar distance band, so LOD is chosen
   * per (chunk, propType) and applied by swapping the InstancedMesh geometry
   * — instance matrices are untouched and the draw-call count is unchanged.
   */
  _updateLOD(camera) {
    const n = this._chunkList.length;
    if (n === 0) return;
    camera.getWorldPosition(_camPos);
    // pixels per world unit at distance 1
    const pxPerUnit = camera.__viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));

    for (let s = 0; s < LOD_CHUNKS_PER_FRAME; s++) {
      this._lodCursor = (this._lodCursor + 1) % n;
      const chunk = this._chunkList[this._lodCursor];
      if (!chunk.ready) continue;
      // Nearest point of the chunk's footprint to the camera, so LOD never
      // pops late when the camera is right at a chunk edge.
      const nx = Math.max(chunk.originX, Math.min(_camPos.x, chunk.originX + CHUNK_SIZE));
      const nz = Math.max(chunk.originZ, Math.min(_camPos.z, chunk.originZ + CHUNK_SIZE));
      const dx = nx - _camPos.x;
      const dz = nz - _camPos.z;
      const dy = (chunk.minY + chunk.maxY) * 0.5 - _camPos.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));

      for (let i = 0; i < chunk.props.length; i++) {
        const p = chunk.props[i];
        const px = (p.height / dist) * pxPerUnit;
        let lod = px > LOD1_PX ? 0 : px > LOD2_PX ? 1 : 2;
        const visible = px > CULL_PX * this.quality.cullScale;
        if (p.mesh.visible !== visible) p.mesh.visible = visible;
        if (lod !== p.lod) {
          p.lod = lod;
          p.mesh.geometry = this.props.geometries[p.name][lod];
        }
      }
    }
  }

  // --------------------------------------------------------------- queries

  heightAt(x, z) {
    return this.field.heightAt(x, z);
  }

  /**
   * Visit every prop collider within `radius` of (x, z).
   * cb(cx, cz, r) — return true to stop early.
   */
  queryColliders(x, z, radius, cb) {
    const cx = floorDiv(x, CHUNK_SIZE);
    const cz = floorDiv(z, CHUNK_SIZE);
    const r2 = radius * radius;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (!chunk || !chunk.ready) continue;
        const arr = chunk.colliders;
        const n = chunk.colliderCount;
        for (let i = 0; i < n; i++) {
          const o = i * 3;
          const px = arr[o];
          const pz = arr[o + 1];
          const pr = arr[o + 2];
          const ddx = px - x;
          const ddz = pz - z;
          const reach = radius + pr;
          if (ddx * ddx + ddz * ddz > reach * reach + r2) continue;
          if (cb(px, pz, pr)) return;
        }
      }
    }
  }

  /** True if (x,z) lies inside any prop collider (with `pad` extra clearance). */
  isInsideProp(x, z, pad = 0) {
    let hit = false;
    this.queryColliders(x, z, pad, (px, pz, pr) => {
      const dx = px - x;
      const dz = pz - z;
      const rr = pr + pad;
      if (dx * dx + dz * dz < rr * rr) {
        hit = true;
        return true;
      }
      return false;
    });
    return hit;
  }

  /** True if (x, z) is inside a house or hut's walls (the mount can't come here). */
  isIndoors(x, z) {
    let inside = false;
    this.queryShelters(x, z, 8, (sx, sy, sz, ry, type) => {
      const name = PROP_TYPES[type];
      if (name !== 'house' && name !== 'hut') return false;
      // Into the building's local frame (interior point is at local (0, -0.6) for
      // a house, (0, -0.5) for a hut).
      const c = Math.cos(ry), sn = Math.sin(ry);
      const dx = x - sx, dz = z - sz;
      const lx = dx * c - dz * sn;
      const lz = dx * sn + dz * c + (name === 'house' ? -0.6 : -0.5);
      const hit = name === 'house' ? Math.abs(lx) < 4.9 && Math.abs(lz) < 4.1 : Math.hypot(lx, lz) < 3.4;
      if (hit) inside = true;
      return hit;
    });
    return inside;
  }

  /** Outside point in front of the nearest doorway to (x, z); writes {x, z}; false if none. */
  nearestDoorOutside(x, z, out) {
    let best = Infinity;
    let found = false;
    this.queryShelters(x, z, 12, (sx, sy, sz, ry, type) => {
      const name = PROP_TYPES[type];
      if (name !== 'house' && name !== 'hut') return false;
      const d = Math.hypot(sx - x, sz - z);
      if (d < best) {
        best = d;
        const reach = name === 'house' ? 8.5 : 6.5;
        out.x = sx + Math.sin(ry) * reach;
        out.z = sz + Math.cos(ry) * reach;
        found = true;
      }
      return false;
    });
    return found;
  }

  /** Doorway blockers (only consulted while riding). cb(x, z, r) → true to stop. */
  queryDoorBlockers(x, z, radius, cb) {
    const cx = floorDiv(x, CHUNK_SIZE);
    const cz = floorDiv(z, CHUNK_SIZE);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (!chunk || !chunk.ready) continue;
        for (let i = 0; i < chunk.doorCount; i++) {
          const o = i * 3;
          const ddx = chunk.doors[o] - x;
          const ddz = chunk.doors[o + 1] - z;
          const reach = radius + chunk.doors[o + 2];
          if (ddx * ddx + ddz * ddz > reach * reach) continue;
          if (cb(chunk.doors[o], chunk.doors[o + 1], chunk.doors[o + 2])) return;
        }
      }
    }
  }

  /** Visit shelter interiors (house/hut/cave) within `radius`. cb(x, y, z, rotY, type) → true to stop. */
  queryShelters(x, z, radius, cb) {
    const cx = floorDiv(x, CHUNK_SIZE);
    const cz = floorDiv(z, CHUNK_SIZE);
    const r2 = radius * radius;
    const reach = Math.ceil(radius / CHUNK_SIZE);
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const chunk = this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (!chunk || !chunk.ready) continue;
        for (let i = 0; i < chunk.shelterCount; i++) {
          const o = i * 5;
          const ddx = chunk.shelters[o] - x;
          const ddz = chunk.shelters[o + 2] - z;
          if (ddx * ddx + ddz * ddz > r2) continue;
          if (cb(chunk.shelters[o], chunk.shelters[o + 1], chunk.shelters[o + 2], chunk.shelters[o + 3], chunk.shelters[o + 4])) return;
        }
      }
    }
  }

  /** Visit shrine positions within `radius` of (x, z). cb(x, y, z) → true to stop. */
  queryShrines(x, z, radius, cb) {
    const cx = floorDiv(x, CHUNK_SIZE);
    const cz = floorDiv(z, CHUNK_SIZE);
    const r2 = radius * radius;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (!chunk || !chunk.ready) continue;
        for (let i = 0; i < chunk.shrineCount; i++) {
          const o = i * 3;
          const ddx = chunk.shrines[o] - x;
          const ddz = chunk.shrines[o + 2] - z;
          if (ddx * ddx + ddz * ddz > r2) continue;
          if (cb(chunk.shrines[o], chunk.shrines[o + 1], chunk.shrines[o + 2])) return;
        }
      }
    }
  }

  isChunkLoaded(cx, cz) {
    return this.chunks.has(chunkKey(cx, cz));
  }

  isChunkReady(x, z) {
    const c = this.chunks.get(chunkKey(floorDiv(x, CHUNK_SIZE), floorDiv(z, CHUNK_SIZE)));
    return !!(c && c.ready);
  }
}
