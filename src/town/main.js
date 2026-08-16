import { generateWorld } from './world.js';
import { Camera } from './camera.js';
import { Renderer } from './renderer.js';
import { TILE_SIZE, MAP_SIZE } from './tiles.js';

const canvas = document.getElementById('world');
const world = generateWorld();
const camera = new Camera(window.innerWidth, window.innerHeight);
const renderer = new Renderer(canvas);

// Center camera on our home
const home = world.buildings.find(b => b.id === 'home');
if (home) {
  camera.centerOn(
    (home.x + home.w / 2) * TILE_SIZE,
    (home.y + home.h / 2) * TILE_SIZE
  );
} else {
  camera.centerOn(MAP_SIZE * TILE_SIZE / 2, MAP_SIZE * TILE_SIZE / 2);
}

// Resize
function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  camera.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

// Input
canvas.addEventListener('mousedown', e => { camera.onMouseDown(e); canvas.style.cursor = 'grabbing'; });
window.addEventListener('mousemove', e => camera.onMouseMove(e));
window.addEventListener('mouseup', () => { camera.onMouseUp(); canvas.style.cursor = 'default'; });
canvas.addEventListener('wheel', e => camera.onWheel(e, e.offsetX, e.offsetY), { passive: false });

// Touch support
let lastTouch = null;
canvas.addEventListener('touchstart', e => {
  if (e.touches.length === 1) {
    camera.onMouseDown({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
    lastTouch = null;
  } else if (e.touches.length === 2) {
    lastTouch = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  }
}, { passive: true });
canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  if (e.touches.length === 1) {
    camera.onMouseMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
  } else if (e.touches.length === 2 && lastTouch) {
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    camera.onWheel({ preventDefault() {}, deltaY: lastTouch > dist ? 20 : -20 }, cx, cy);
    lastTouch = dist;
  }
}, { passive: false });
canvas.addEventListener('touchend', () => { camera.onMouseUp(); lastTouch = null; }, { passive: true });

// Seed display
const seedEl = document.getElementById('seed-display');
if (seedEl) seedEl.textContent = `种子 ${world.seed}`;

// Render loop
function loop(t) {
  renderer.render(world, camera, t);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
