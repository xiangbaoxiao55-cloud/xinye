import { TILE, TILE_COLOR, TILE_SIZE, MAP_SIZE } from './tiles.js';

const TS = TILE_SIZE;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this._tileCache = null;
    this._cacheSize = 0;
  }

  // Pre-render tile colors into an offscreen ImageData for speed
  _buildTileCache(world) {
    const N = MAP_SIZE;
    const oc = document.createElement('canvas');
    oc.width = N * TS; oc.height = N * TS;
    const ctx = oc.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const t = world.tiles[y * N + x];
        ctx.fillStyle = TILE_COLOR[t];
        ctx.fillRect(x * TS, y * TS, TS, TS);

        // subtle grid lines for grass tiles
        if (t >= TILE.GRASS && t <= TILE.GRASS_DENSE) {
          ctx.fillStyle = 'rgba(0,0,0,0.04)';
          ctx.fillRect(x * TS, y * TS, 1, TS);
          ctx.fillRect(x * TS, y * TS, TS, 1);
        }

        // water shimmer dots
        if (t === TILE.WATER || t === TILE.SHALLOW_WATER) {
          ctx.fillStyle = 'rgba(255,255,255,0.15)';
          ctx.fillRect(x * TS + 4, y * TS + 4, 2, 2);
          ctx.fillRect(x * TS + 11, y * TS + 10, 2, 2);
        }
      }
    }
    this._tileCache = oc;
    this._cacheSize = N * TS;
  }

  render(world, camera, time) {
    if (!this._tileCache) this._buildTileCache(world);

    const { ctx, canvas } = this;
    const { w: cw, h: ch, zoom } = camera;

    ctx.save();
    ctx.fillStyle = '#1a3a4a';
    ctx.fillRect(0, 0, cw, ch);

    ctx.imageSmoothingEnabled = false;

    // Translate/scale for camera
    ctx.translate(cw / 2, ch / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-camera.x, -camera.y);

    // Visible tile range
    const wx0 = camera.x - cw / 2 / zoom;
    const wy0 = camera.y - ch / 2 / zoom;
    const wx1 = camera.x + cw / 2 / zoom;
    const wy1 = camera.y + ch / 2 / zoom;
    const tx0 = Math.max(0, Math.floor(wx0 / TS));
    const ty0 = Math.max(0, Math.floor(wy0 / TS));
    const tx1 = Math.min(MAP_SIZE, Math.ceil(wx1 / TS));
    const ty1 = Math.min(MAP_SIZE, Math.ceil(wy1 / TS));

    // Draw tile cache slice
    const srcX = tx0 * TS, srcY = ty0 * TS;
    const srcW = (tx1 - tx0) * TS, srcH = (ty1 - ty0) * TS;
    if (srcW > 0 && srcH > 0) {
      ctx.drawImage(this._tileCache, srcX, srcY, srcW, srcH, srcX, srcY, srcW, srcH);
    }

    // Draw trees
    this._drawTrees(ctx, world.trees, tx0, ty0, tx1, ty1, time);

    // Draw buildings (depth sorted by y)
    const sortedBuildings = [...world.buildings].sort((a, b) => (a.y + a.h) - (b.y + b.h));
    for (const b of sortedBuildings) {
      if (b.x + b.w < tx0 || b.x > tx1 || b.y + b.h < ty0 || b.y > ty1) continue;
      this._drawBuilding(ctx, b, time);
    }

    ctx.restore();

    // HUD (screen space)
    this._drawHUD(ctx, cw, ch, time);
  }

  _drawTrees(ctx, trees, tx0, ty0, tx1, ty1, time) {
    for (const tr of trees) {
      if (tr.x < tx0 - 1 || tr.x > tx1 + 1 || tr.y < ty0 - 1 || tr.y > ty1 + 1) continue;
      const px = tr.x * TS, py = tr.y * TS;
      if (tr.type === 'pine') {
        // triangle trunk
        ctx.fillStyle = '#6b4423';
        ctx.fillRect(px + 6, py + 10, 4, 6);
        // canopy layers
        ctx.fillStyle = '#1e5c18';
        _tri(ctx, px + 8, py + 2, 10, 8);
        ctx.fillStyle = '#277020';
        _tri(ctx, px + 8, py + 5, 8, 6);
        ctx.fillStyle = '#32882a';
        _tri(ctx, px + 8, py + 8, 6, 5);
      } else {
        ctx.fillStyle = '#6b4423';
        ctx.fillRect(px + 6, py + 8, 4, 8);
        ctx.fillStyle = '#2d7a20';
        ctx.beginPath();
        ctx.arc(px + 8, py + 6, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#3a9028';
        ctx.beginPath();
        ctx.arc(px + 6, py + 4, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  _drawBuilding(ctx, b, time) {
    const px = b.x * TS, py = b.y * TS;
    const pw = b.w * TS, ph = b.h * TS;

    if (b.id === 'well') {
      // stone circle
      ctx.fillStyle = '#888';
      ctx.beginPath(); ctx.arc(px + 8, py + 8, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#333';
      ctx.beginPath(); ctx.arc(px + 8, py + 8, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#6b4423';
      ctx.fillRect(px + 6, py + 1, 4, 2); // beam
      return;
    }

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(px + 3, py + ph - 2, pw, 5);

    // Wall
    ctx.fillStyle = b.wall;
    ctx.fillRect(px, py + ph * 0.35, pw, ph * 0.65);

    // Door
    ctx.fillStyle = '#6b4423';
    const dw = TS * 0.5, dh = TS * 0.65;
    ctx.fillRect(px + pw / 2 - dw / 2, py + ph - dh, dw, dh);

    // Windows
    ctx.fillStyle = '#a8d8ea';
    if (b.w >= 3) {
      ctx.fillRect(px + 3, py + ph * 0.45, 5, 5);
      ctx.fillRect(px + pw - 8, py + ph * 0.45, 5, 5);
    }

    // Roof (triangle-ish, pitched)
    ctx.fillStyle = b.roof;
    ctx.beginPath();
    ctx.moveTo(px - 2, py + ph * 0.38);
    ctx.lineTo(px + pw / 2, py + 2);
    ctx.lineTo(px + pw + 2, py + ph * 0.38);
    ctx.closePath(); ctx.fill();

    // Roof shadow line
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(px - 2, py + ph * 0.38 - 1, pw + 4, 2);

    // Special: 我们的家 — glowing window
    if (b.id === 'home') {
      const glow = 0.6 + 0.4 * Math.sin(time / 800);
      ctx.fillStyle = `rgba(200,180,255,${glow * 0.5})`;
      ctx.fillRect(px + pw / 2 - 3, py + ph * 0.42, 6, 6);
      ctx.shadowColor = '#a080ff';
      ctx.shadowBlur = 8 / (ctx._zoom ?? 1);
      ctx.fillStyle = `rgba(180,160,240,${glow})`;
      ctx.fillRect(px + pw / 2 - 2, py + ph * 0.43, 4, 4);
      ctx.shadowBlur = 0;

      // label
      ctx.save();
      ctx.scale(1 / 1, 1 / 1); // already in world space
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(px + pw / 2 - 18, py - 12, 36, 11);
      ctx.fillStyle = '#e8d8ff';
      ctx.font = '7px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('你和炘也的家', px + pw / 2, py - 3);
      ctx.restore();
    }
  }

  _drawHUD(ctx, cw, ch) {
    // Mini compass
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.arc(cw - 30, 30, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e8e0d0';
    ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('N', cw - 30, 16);
    ctx.fillText('S', cw - 30, 48);
    ctx.fillText('W', cw - 48, 33);
    ctx.fillText('E', cw - 12, 33);

    // Hint
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(8, ch - 28, 200, 20);
    ctx.fillStyle = '#ccc';
    ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('拖拽移动  滚轮缩放', 14, ch - 14);
  }
}

function _tri(ctx, cx, ty, hw, h) {
  ctx.beginPath();
  ctx.moveTo(cx - hw, ty + h);
  ctx.lineTo(cx + hw, ty + h);
  ctx.lineTo(cx, ty);
  ctx.closePath(); ctx.fill();
}
