import { TILE, MAP_SIZE } from './tiles.js';

function hash(x, y, seed) {
  let h = (seed ^ 0xdeadbeef) + x * 374761393 + y * 668265263;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

function smooth(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fractal(x, y, oct, persist, lac, seed) {
  let v = 0, a = 1, f = 1, m = 0;
  for (let i = 0; i < oct; i++) {
    v += smooth(x * f, y * f, seed + i * 1000) * a;
    m += a; a *= persist; f *= lac;
  }
  return v / m;
}

function makeRng(seed) {
  let s = seed | 0;
  return () => {
    s = Math.imul(s, 1664525) + 1013904223;
    return (s >>> 0) / 0xffffffff;
  };
}

const BUILDING_DEFS = [
  { id: 'home',  w: 4, h: 3, roof: '#5040b0', wall: '#c8c0e0', label: '你和炘也的家' },
  { id: 'house', w: 3, h: 2, roof: '#c04040', wall: '#d4c4a0', label: '小屋' },
  { id: 'shop',  w: 4, h: 2, roof: '#8b6914', wall: '#e0d0a0', label: '商铺' },
  { id: 'barn',  w: 4, h: 3, roof: '#a04020', wall: '#c09060', label: '谷仓' },
  { id: 'well',  w: 1, h: 1, roof: '#666666', wall: '#888888', label: '水井' },
];

export function generateWorld(seed) {
  seed = (seed ?? (Math.random() * 99999 | 0));
  const rng = makeRng(seed);
  const N = MAP_SIZE;
  const tiles = new Uint8Array(N * N);
  const heights = new Float32Array(N * N);
  const cx = N / 2, cy = N / 2, radius = N * 0.44;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const nx = x / N * 5, ny = y / N * 5;
      let h = fractal(nx, ny, 6, 0.5, 2.0, seed);
      const dx = (x - cx) / radius, dy = (y - cy) / radius;
      const dist = Math.sqrt(dx * dx + dy * dy);
      h = h * 0.3 + Math.pow(Math.min(dist, 1.3), 1.6) * 0.7;
      heights[y * N + x] = Math.max(0, Math.min(1, h));
    }
  }

  for (let i = 0; i < N * N; i++) {
    const h = heights[i];
    if      (h < 0.20) tiles[i] = TILE.DEEP_WATER;
    else if (h < 0.25) tiles[i] = TILE.WATER;
    else if (h < 0.30) tiles[i] = TILE.SHALLOW_WATER;
    else if (h < 0.36) tiles[i] = TILE.SAND;
    else if (h < 0.54) tiles[i] = TILE.GRASS;
    else if (h < 0.64) tiles[i] = TILE.GRASS_DENSE;
    else if (h < 0.71) tiles[i] = TILE.FOREST_FLOOR;
    else if (h < 0.79) tiles[i] = TILE.FOREST;
    else if (h < 0.89) tiles[i] = TILE.MOUNTAIN;
    else               tiles[i] = TILE.PEAK;
  }

  const buildings = _placeBuildings(tiles, rng);
  const trees = _placeTrees(tiles, rng);

  return { tiles, heights, buildings, trees, seed, size: N };
}

function _placeBuildings(tiles, rng) {
  const N = MAP_SIZE;
  const buildings = [];
  const occupied = new Set();

  const canPlace = (x, y, w, h) => {
    for (let dy = -1; dy <= h; dy++) {
      for (let dx = -1; dx <= w; dx++) {
        const tx = x + dx, ty = y + dy;
        if (tx < 2 || tx >= N - 2 || ty < 2 || ty >= N - 2) return false;
        if (occupied.has(ty * N + tx)) return false;
        const t = tiles[ty * N + tx];
        if (dy >= 0 && dy < h && dx >= 0 && dx < w) {
          if (t !== TILE.SAND && t !== TILE.GRASS && t !== TILE.GRASS_DENSE) return false;
        }
      }
    }
    return true;
  };

  const place = (x, y, def) => {
    buildings.push({ x, y, ...def });
    for (let dy = -1; dy <= def.h; dy++)
      for (let dx = -1; dx <= def.w; dx++)
        occupied.add((y + dy) * N + (x + dx));
  };

  // 我们的家 — 优先放在中心草地
  const cx = N / 2 | 0, cy = N / 2 | 0;
  const home = BUILDING_DEFS[0];
  let placed = false;
  for (let r = 4; r < 25 && !placed; r++) {
    for (let a = 0; a < 40 && !placed; a++) {
      const angle = rng() * Math.PI * 2;
      const x = (cx + Math.cos(angle) * r) | 0;
      const y = (cy + Math.sin(angle) * r) | 0;
      if (canPlace(x, y, home.w, home.h)) { place(x, y, home); placed = true; }
    }
  }

  const counts = { house: 8, shop: 3, barn: 2, well: 3 };
  for (const def of BUILDING_DEFS.slice(1)) {
    let n = counts[def.id] ?? 1, tries = 0;
    while (n > 0 && tries++ < 600) {
      const x = (rng() * (N - 10) + 5) | 0;
      const y = (rng() * (N - 10) + 5) | 0;
      if (canPlace(x, y, def.w, def.h)) { place(x, y, def); n--; }
    }
  }

  return buildings;
}

function _placeTrees(tiles, rng) {
  const N = MAP_SIZE, trees = [];
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const t = tiles[y * N + x];
      const chance = t === TILE.FOREST ? 0.4 : t === TILE.FOREST_FLOOR ? 0.18 : t === TILE.GRASS_DENSE ? 0.04 : 0;
      if (chance > 0 && rng() < chance) {
        trees.push({ x: x + rng() * 0.7 + 0.15, y: y + rng() * 0.7 + 0.15, type: rng() < 0.65 ? 'pine' : 'oak' });
      }
    }
  }
  return trees;
}
