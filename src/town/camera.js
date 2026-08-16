export class Camera {
  constructor(w, h) {
    this.x = 0; this.y = 0;
    this.zoom = 2.5;
    this.minZoom = 0.8; this.maxZoom = 8;
    this.w = w; this.h = h;
    this._drag = null;
  }

  resize(w, h) { this.w = w; this.h = h; }

  centerOn(wx, wy) { this.x = wx; this.y = wy; }

  toScreen(wx, wy) {
    return [(wx - this.x) * this.zoom + this.w / 2,
            (wy - this.y) * this.zoom + this.h / 2];
  }

  toWorld(sx, sy) {
    return [(sx - this.w / 2) / this.zoom + this.x,
            (sy - this.h / 2) / this.zoom + this.y];
  }

  onMouseDown(e) {
    this._drag = { sx: e.clientX, sy: e.clientY, cx: this.x, cy: this.y };
  }

  onMouseMove(e) {
    if (!this._drag) return;
    const dx = (e.clientX - this._drag.sx) / this.zoom;
    const dy = (e.clientY - this._drag.sy) / this.zoom;
    this.x = this._drag.cx - dx;
    this.y = this._drag.cy - dy;
  }

  onMouseUp() { this._drag = null; }

  onWheel(e, sx, sy) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const [wx, wy] = this.toWorld(sx, sy);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    // zoom toward cursor
    const [nsx, nsy] = this.toScreen(wx, wy);
    this.x += (nsx - sx) / this.zoom;
    this.y += (nsy - sy) / this.zoom;
  }
}
