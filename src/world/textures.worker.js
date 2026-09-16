// Bakes the terrain PBR layer textures off the main thread during loading.
import { buildTerrainTextures } from './TerrainTextures.js';

self.onmessage = (e) => {
  const { seed, size } = e.data;
  const r = buildTerrainTextures(seed, size);
  const transfer = [];
  for (const a of r.albedo) transfer.push(a.buffer);
  for (const n of r.normal) transfer.push(n.buffer);
  self.postMessage(r, transfer);
};
