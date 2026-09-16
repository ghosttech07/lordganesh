// Biome definitions. Each biome declares its climate centre (moisture,
// temperature, elevation preference) plus its palette and scatter budget.
// Membership is computed as a smooth falloff from the centre and then
// normalised, so borders always blend — there is no hard cut anywhere.

export const BIOME_IDS = {
  RIVERBANK: 0,
  FOREST_GROVE: 1,
  TEMPLE_RUINS: 2,
  FLOWER_FIELDS: 3,
  ROCKY_HILLS: 4,
  KAILASH: 5,
};

export const BIOME_COUNT = 6;

/**
 * `ground` / `groundAlt` are sRGB triples (0..1) as an artist would pick them;
 * TerrainField converts them to linear once at construction.
 * `scatter` maps prop type → density (expected props per 100x100 units) and
 * the Poisson radius that enforces minimum spacing.
 */
export const BIOMES = [
  {
    id: BIOME_IDS.RIVERBANK,
    name: 'Riverbank',
    moisture: 0.86,
    temperature: 0.55,
    elevation: 0.12,
    spread: 0.30,
    ground: [0.55, 0.50, 0.36],
    groundAlt: [0.42, 0.50, 0.30],
    ambient: 'river',
    footstep: 'water',
    scatter: [
      { prop: 'lotus', density: 22.0, radius: 3.2 },
      { prop: 'banyan', density: 2.2, radius: 15 },
      { prop: 'reeds', density: 70.0, radius: 2.2 },
      { prop: 'grass', density: 220.0, radius: 1.8 },
      { prop: 'lamp', density: 2.0, radius: 12 },
      { prop: 'hut', density: 5.0, radius: 13, cluster: { scale: 260, threshold: 0.6 }, align: true, maxSlope: 0.3, scaleMin: 0.9, scaleVar: 0.25 },
      { prop: 'well', density: 0.6, radius: 30, cluster: { scale: 260, threshold: 0.62 }, maxSlope: 0.25 },
    ],
  },
  {
    id: BIOME_IDS.FOREST_GROVE,
    name: 'Forest Grove',
    moisture: 0.66,
    temperature: 0.62,
    elevation: 0.34,
    spread: 0.30,
    ground: [0.30, 0.44, 0.22],
    groundAlt: [0.38, 0.50, 0.26],
    ambient: 'forest',
    footstep: 'grass',
    scatter: [
      { prop: 'banyan', density: 5.0, radius: 9.5 },
      { prop: 'shrub', density: 28.0, radius: 3.6 },
      { prop: 'grass', density: 420.0, radius: 1.7 },
      { prop: 'shrine', density: 0.35, radius: 30 },
      { prop: 'burrow', density: 3.0, radius: 9, maxSlope: 0.45 },
      { prop: 'house', density: 4.0, radius: 17, cluster: { scale: 300, threshold: 0.64 }, align: true, maxSlope: 0.3, scaleMin: 0.9, scaleVar: 0.25 },
    ],
  },
  {
    id: BIOME_IDS.TEMPLE_RUINS,
    name: 'Temple Ruins',
    moisture: 0.34,
    temperature: 0.60,
    elevation: 0.46,
    spread: 0.28,
    ground: [0.55, 0.51, 0.45],
    groundAlt: [0.62, 0.56, 0.48],
    ambient: 'temple',
    footstep: 'stone',
    scatter: [
      { prop: 'archway', density: 2.2, radius: 14 },
      { prop: 'pillar', density: 6.0, radius: 7.5 },
      { prop: 'lamp', density: 5.0, radius: 6.5 },
      { prop: 'shrine', density: 1.0, radius: 24 },
      { prop: 'grass', density: 120.0, radius: 2.4 },
      { prop: 'rock', density: 3.0, radius: 8 },
      { prop: 'house', density: 3.2, radius: 17, cluster: { scale: 280, threshold: 0.6 }, align: true, maxSlope: 0.3, scaleMin: 0.9, scaleVar: 0.25 },
      { prop: 'lamppost', density: 2.5, radius: 14, cluster: { scale: 280, threshold: 0.58 }, maxSlope: 0.35 },
    ],
  },
  {
    id: BIOME_IDS.FLOWER_FIELDS,
    name: 'Flower Fields',
    moisture: 0.56,
    temperature: 0.82,
    elevation: 0.28,
    spread: 0.27,
    ground: [0.50, 0.55, 0.27],
    groundAlt: [0.60, 0.52, 0.24],
    ambient: 'meadow',
    footstep: 'grass',
    scatter: [
      { prop: 'marigold', density: 300.0, radius: 1.9 },
      { prop: 'grass', density: 220.0, radius: 2.0 },
      { prop: 'banyan', density: 1.0, radius: 20 },
      { prop: 'shrub', density: 5.0, radius: 6 },
      { prop: 'lamp', density: 1.0, radius: 16 },
      { prop: 'house', density: 5.0, radius: 16, cluster: { scale: 320, threshold: 0.6 }, align: true, maxSlope: 0.3, scaleMin: 0.9, scaleVar: 0.25 },
      { prop: 'hut', density: 3.5, radius: 13, cluster: { scale: 320, threshold: 0.62 }, align: true, maxSlope: 0.3, scaleMin: 0.9, scaleVar: 0.25 },
      { prop: 'well', density: 0.7, radius: 28, cluster: { scale: 320, threshold: 0.64 }, maxSlope: 0.25 },
      { prop: 'lamppost', density: 2.0, radius: 15, cluster: { scale: 320, threshold: 0.6 }, maxSlope: 0.35 },
      { prop: 'burrow', density: 1.5, radius: 10, maxSlope: 0.4 },
    ],
  },
  {
    id: BIOME_IDS.ROCKY_HILLS,
    name: 'Rocky Hills',
    moisture: 0.22,
    temperature: 0.32,
    elevation: 0.86,
    spread: 0.32,
    ground: [0.48, 0.46, 0.44],
    groundAlt: [0.40, 0.38, 0.37],
    ambient: 'highland',
    footstep: 'stone',
    scatter: [
      { prop: 'rock', density: 16.0, radius: 5.0 },
      { prop: 'pillar', density: 0.8, radius: 18 },
      { prop: 'shrub', density: 9.0, radius: 5.5 },
      { prop: 'grass', density: 90.0, radius: 2.6 },
      { prop: 'cave', density: 1.2, radius: 22 },
      { prop: 'burrow', density: 2.0, radius: 10, maxSlope: 0.5 },
      { prop: 'deodar', density: 2.5, radius: 8 },
    ],
  },
  {
    id: BIOME_IDS.KAILASH,
    name: 'Kailash Snowfields',
    moisture: 0.42,
    temperature: 0.08,
    elevation: 1.35,
    spread: 0.34,
    ground: [0.62, 0.64, 0.68],
    groundAlt: [0.5, 0.5, 0.52],
    ambient: 'highland',
    footstep: 'grass',
    scatter: [
      { prop: 'deodar', density: 9.0, radius: 6.5, maxSlope: 0.7 },
      { prop: 'rock', density: 10.0, radius: 6.0 },
      { prop: 'flags', density: 1.6, radius: 18, maxSlope: 0.5 },
      { prop: 'cave', density: 0.8, radius: 26 },
      { prop: 'shrine', density: 0.4, radius: 40, maxSlope: 0.35 },
      { prop: 'lamp', density: 1.2, radius: 14, maxSlope: 0.5 },
    ],
  },
];

/** Every prop type that any biome can scatter, in a stable order. */
export const PROP_TYPES = [
  'banyan',
  'lotus',
  'reeds',
  'shrub',
  'grass',
  'marigold',
  'archway',
  'pillar',
  'lamp',
  'shrine',
  'rock',
  'house',
  'hut',
  'well',
  'lamppost',
  'burrow',
  'cave',
  'deodar',
  'flags',
];

export const PROP_INDEX = Object.freeze(
  PROP_TYPES.reduce((acc, name, i) => {
    acc[name] = i;
    return acc;
  }, {})
);

/**
 * Props a capsule-shaped player should collide with. A number is a circle
 * radius at the prop origin. An object with `walls` is a list of local-space
 * segments [x1, z1, x2, z2] rasterised into small circles of radius `r` at
 * chunk build time — this is how houses, huts and caves get walls you can
 * walk along and doorways you can walk through.
 */
const HOUSE_W = 9.2 / 2, HOUSE_D = 7.6 / 2, DOOR = 1.2;
export const PROP_COLLIDERS = {
  banyan: 1.15,
  pillar: 0.85,
  shrine: 1.6,
  rock: 1.5,
  archway: 0.0, // walkable through the opening; handled as two legs below
  well: 1.3,
  lamppost: 0.3,
  deodar: 0.7,
  flags: 0.0,
  house: {
    r: 0.42,
    walls: [
      [-HOUSE_W, -HOUSE_D, HOUSE_W, -HOUSE_D],          // back
      [-HOUSE_W, -HOUSE_D, -HOUSE_W, HOUSE_D],          // left
      [HOUSE_W, -HOUSE_D, HOUSE_W, HOUSE_D],            // right
      // Front wall stops one circle-radius short of the doorway so the clear
      // opening is the full door width.
      [-HOUSE_W, HOUSE_D, -DOOR - 0.42, HOUSE_D],       // front, left of door
      [DOOR + 0.42, HOUSE_D, HOUSE_W, HOUSE_D],         // front, right of door
    ],
  },
  hut: { r: 0.42, ring: { radius: 3.1, gapCenter: 0, gapHalfAngle: 0.5 } }, // door faces +z
  cave: { r: 0.6, ring: { radius: 4.0, gapCenter: 0, gapHalfAngle: 0.62 } },
};

/** Props with an interior a hidden modak can be placed in: local interior point. */
export const SHELTERS = {
  house: [0, 0.45, -0.6],
  hut: [0, 0.35, -0.5],
  cave: [0, 0.3, -0.8],
};
