export const TILE = {
  DEEP_WATER: 0,
  WATER: 1,
  SHALLOW_WATER: 2,
  SAND: 3,
  GRASS: 4,
  GRASS_DENSE: 5,
  FOREST_FLOOR: 6,
  FOREST: 7,
  MOUNTAIN: 8,
  PEAK: 9,
};

export const TILE_COLOR = [
  '#1a4d6e', // DEEP_WATER
  '#2676a0', // WATER
  '#4094b8', // SHALLOW_WATER
  '#c4a870', // SAND
  '#7ab83e', // GRASS
  '#5a9a2a', // GRASS_DENSE
  '#4a8020', // FOREST_FLOOR
  '#2d6118', // FOREST
  '#8a7868', // MOUNTAIN
  '#b0a090', // PEAK
];

export const TILE_PASSABLE = [
  false, false, false, true, true, true, true, false, false, false,
];

export const TILE_SIZE = 16;
export const MAP_SIZE = 96;
