// Descent: a parachutist drifting down over the procedural atlas.
//
// The subject is the camera's anchor. Only the tiles around it are requested,
// so the work stays proportional to what is on screen; altitude maps to zoom,
// which means the world resolves more detail as the canopy comes down.

import { clamp, valueNoise2 } from './noise.js';

export const START_ALTITUDE = 640;
const FALL_RATE = 14;
const MAX_SPEED = 26;
const SCALE_PER_METRE = 0.028;

export function altitudeToScale(altitude) {
  return 1 + (START_ALTITUDE - clamp(altitude, 0, START_ALTITUDE)) * SCALE_PER_METRE;
}

export function scaleToAltitude(scale) {
  return clamp(START_ALTITUDE - (scale - 1) / SCALE_PER_METRE, 0, START_ALTITUDE);
}

export class Descent {
  constructor({ seed, x, y, altitude = START_ALTITUDE }) {
    this.seed = seed;
    this.reset(x, y, altitude);
  }

  reset(x, y, altitude = START_ALTITUDE) {
    this.x = x;
    this.y = y;
    this.altitude = clamp(altitude, 0, START_ALTITUDE);
    this.vx = 0;
    this.vy = 0;
    this.time = 0;
    this.landed = this.altitude <= 0;
    this.fallRate = 0;
    this.baseWindAngle = ((this.seed % 6283) / 1000) % (Math.PI * 2);
    this.windAngle = this.baseWindAngle;
    this.windStrength = 10;
  }

  update(dt, steer, dive) {
    if (this.landed || dt <= 0) {
      this.fallRate = 0;
      return;
    }

    this.time += dt;

    // Wind wanders slowly around a seed-dependent heading.
    const wander = valueNoise2(this.time * 0.035, 4.2, this.seed ^ 0x9e37);
    this.windAngle = this.baseWindAngle + (wander - 0.5) * 1.6;
    this.windStrength = 7 + 9 * valueNoise2(this.time * 0.045, 9.1, this.seed ^ 0x51a7);

    const windX = Math.cos(this.windAngle) * this.windStrength;
    const windY = Math.sin(this.windAngle) * this.windStrength;

    // Steering is an acceleration, not a position set: the canopy has mass and
    // the wind keeps pushing, so the player can influence the drift but not
    // teleport around the map.
    const accel = 24;
    this.vx += steer.x * accel * dt;
    this.vy += steer.y * accel * dt;

    // Drag pulls the canopy back toward the wind velocity.
    const drag = 1 - Math.exp(-dt * 0.85);
    this.vx += (windX - this.vx) * drag * 0.6;
    this.vy += (windY - this.vy) * drag * 0.6;

    const speed = Math.hypot(this.vx, this.vy);
    if (speed > MAX_SPEED) {
      this.vx *= MAX_SPEED / speed;
      this.vy *= MAX_SPEED / speed;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // A little extra sink while diving or moving fast.
    const fall = FALL_RATE * (dive ? 1.95 : 1) * (1 + Math.min(0.35, speed / 120));
    this.fallRate = fall;
    this.altitude = Math.max(0, this.altitude - fall * dt);
    if (this.altitude <= 0) {
      this.landed = true;
      this.vx = 0;
      this.vy = 0;
      this.fallRate = 0;
    }
  }
}

// --- Drawing ----------------------------------------------------------------

function hash01(n) {
  const x = Math.sin(n * 12.9898 + 4.1414) * 43758.5453;
  return x - Math.floor(x);
}

const wrap = (v, max) => ((v % max) + max) % max;

function drawStreaks(ctx, { width, height, time, windAngle, strength, alpha }) {
  const dx = Math.cos(windAngle);
  const dy = Math.sin(windAngle);
  const travel = 55 + strength * 7;
  const length = 16 + strength * 2.2;

  ctx.save();
  ctx.strokeStyle = `rgba(232, 238, 235, ${alpha})`;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  for (let i = 0; i < 18; i++) {
    const x = wrap(hash01(i * 3.17) * width + dx * time * travel, width);
    const y = wrap(hash01(i * 7.31 + 9) * height + dy * time * travel, height);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx * length, y + dy * length);
    ctx.stroke();
  }
  ctx.restore();
}

function drawShadow(ctx, size) {
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#04121a';
  ctx.beginPath();
  ctx.ellipse(11 * size, 26 * size, 19 * size, 7 * size, 0.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFigure(ctx, size, landed) {
  const figY = landed ? 4 * size : 7 * size;
  ctx.save();
  ctx.fillStyle = '#17262f';
  ctx.strokeStyle = '#17262f';
  ctx.lineCap = 'round';

  // Head
  ctx.beginPath();
  ctx.arc(0, figY - 7 * size, 3.1 * size, 0, Math.PI * 2);
  ctx.fill();

  // Torso
  ctx.beginPath();
  ctx.roundRect(-2.4 * size, figY - 4 * size, 4.8 * size, 9 * size, 1.6 * size);
  ctx.fill();

  // Legs
  ctx.lineWidth = 2.1 * size;
  ctx.beginPath();
  ctx.moveTo(-1.1 * size, figY + 4 * size);
  ctx.lineTo(-3.6 * size, figY + (landed ? 8 : 11) * size);
  ctx.moveTo(1.1 * size, figY + 4 * size);
  ctx.lineTo(3.6 * size, figY + (landed ? 8 : 11) * size);
  ctx.stroke();

  // Arms reaching up to the lines (only while flying)
  if (!landed) {
    ctx.lineWidth = 1.7 * size;
    ctx.beginPath();
    ctx.moveTo(-2 * size, figY - 2 * size);
    ctx.lineTo(-7 * size, figY - 11 * size);
    ctx.moveTo(2 * size, figY - 2 * size);
    ctx.lineTo(7 * size, figY - 11 * size);
    ctx.stroke();
  }

  ctx.restore();
}

function drawCanopy(ctx, size, sway, landed) {
  const w = 58 * size;
  const h = 25 * size;
  const baseY = landed ? 2 * size : -34 * size;
  const rise = landed ? h * 0.45 : h * 1.3;

  ctx.save();
  ctx.translate(0, baseY);
  ctx.rotate(sway);

  // Lines from the canopy to the figure.
  if (!landed) {
    ctx.strokeStyle = 'rgba(48, 58, 60, 0.7)';
    ctx.lineWidth = 0.9;
    for (const k of [-0.38, -0.13, 0.13, 0.38]) {
      ctx.beginPath();
      ctx.moveTo(k * w, 0);
      ctx.lineTo(k * w * 0.28, 36 * size);
      ctx.stroke();
    }
  }

  const grad = ctx.createLinearGradient(0, -rise, 0, 0);
  grad.addColorStop(0, landed ? '#cdb787' : '#f1e1bc');
  grad.addColorStop(1, landed ? '#9a8158' : '#c99a58');
  ctx.fillStyle = grad;

  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  ctx.quadraticCurveTo(-w / 2, -rise, 0, -rise);
  ctx.quadraticCurveTo(w / 2, -rise, w / 2, 0);
  // Scalloped lower edge.
  const cells = 6;
  for (let i = cells; i >= 0; i--) {
    const x0 = -w / 2 + (i / cells) * w;
    const x1 = -w / 2 + ((i + 1) / cells) * w;
    const mid = (x0 + x1) / 2;
    if (i === cells) ctx.lineTo(x0, 0);
    ctx.quadraticCurveTo(mid, 5 * size, x1, 0);
  }
  ctx.closePath();
  ctx.fill();

  // Seams
  ctx.strokeStyle = landed ? 'rgba(96, 76, 48, 0.5)' : 'rgba(120, 86, 40, 0.45)';
  ctx.lineWidth = 0.8;
  for (let i = 1; i < cells; i++) {
    const x = -w / 2 + (i / cells) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.quadraticCurveTo(x * 1.04, -rise * 0.72, x * 0.7, -rise);
    ctx.stroke();
  }

  // Rim
  ctx.strokeStyle = 'rgba(86, 62, 32, 0.55)';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  ctx.quadraticCurveTo(0, -rise * 1.04, w / 2, 0);
  ctx.stroke();

  ctx.restore();
}

function drawParachutist(ctx, { sx, sy, altitude, time, landed }) {
  const progress = 1 - clamp(altitude / START_ALTITUDE, 0, 1);
  const size = 1 + progress * 0.55;
  const sway = Math.sin(time * 1.5) * (landed ? 0.02 : 0.055);

  ctx.save();
  ctx.translate(sx, sy);
  drawShadow(ctx, size);
  ctx.rotate(sway * 0.6);
  drawCanopy(ctx, size, sway, landed);
  drawFigure(ctx, size, landed);
  ctx.restore();
}

function drawCanopyRimStatic(ctx, width, height, cx, cy) {
  // The opening the jumper looks through. The fabric is the ring between this
  // ellipse and a much larger one, so only its inner edge reaches the screen.
  const innerX = Math.min(width * 0.46, height * 0.68);
  const innerY = innerX * 0.94;
  const outerX = Math.max(width, height) * 1.2;
  const outerY = outerX;

  ctx.save();

  // Fabric ring.
  ctx.beginPath();
  ctx.ellipse(cx, cy, outerX, outerY, 0, 0, Math.PI * 2);
  ctx.ellipse(cx, cy, innerX, innerY, 0, 0, Math.PI * 2, true);
  ctx.fillStyle = 'rgba(230, 214, 178, 0.12)';
  ctx.fill();

  // Alternating fabric panels just inside the rim.
  const panels = 28;
  ctx.fillStyle = 'rgba(120, 92, 48, 0.055)';
  for (let i = 0; i < panels; i += 2) {
    const a0 = (i / panels) * Math.PI * 2;
    const a1 = ((i + 1) / panels) * Math.PI * 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, innerX * 1.2, innerY * 1.2, 0, a0, a1);
    ctx.ellipse(cx, cy, innerX, innerY, 0, a1, a0, true);
    ctx.closePath();
    ctx.fill();
  }

  // Seams radiating out from the opening.
  ctx.strokeStyle = 'rgba(232, 220, 190, 0.16)';
  ctx.lineWidth = 1;
  for (let i = 0; i < panels; i++) {
    const a = (i / panels) * Math.PI * 2 + 0.08;
    const x0 = cx + Math.cos(a) * innerX;
    const y0 = cy + Math.sin(a) * innerY;
    const x1 = cx + Math.cos(a) * innerX * 1.2;
    const y1 = cy + Math.sin(a) * innerY * 1.2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  // Rim.
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(240, 228, 198, 0.3)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, innerX, innerY, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Soft fabric shadow toward the corners.
  const shade = ctx.createRadialGradient(
    cx,
    cy,
    Math.min(innerX, innerY) * 0.92,
    cx,
    cy,
    outerX,
  );
  shade.addColorStop(0, 'rgba(4, 10, 14, 0)');
  shade.addColorStop(0.5, 'rgba(4, 10, 14, 0.12)');
  shade.addColorStop(1, 'rgba(4, 10, 14, 0.6)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, width, height);

  ctx.restore();
}

// The rim never changes between frames, so bake it at device resolution and
// blit it. Repainting a full-screen gradient every frame is the one thing that
// noticeably costs frames in canopy cam.
const rimCache = { canvas: null, width: 0, height: 0, cx: 0, cy: 0, dpr: 0 };

function drawCanopyRim(ctx, { width, height, cx, cy }, dpr) {
  if (
    !rimCache.canvas ||
    rimCache.width !== width ||
    rimCache.height !== height ||
    rimCache.cx !== cx ||
    rimCache.cy !== cy ||
    rimCache.dpr !== dpr
  ) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const rim = canvas.getContext('2d');
    rim.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCanopyRimStatic(rim, width, height, cx, cy);
    rimCache.canvas = canvas;
    rimCache.width = width;
    rimCache.height = height;
    rimCache.cx = cx;
    rimCache.cy = cy;
    rimCache.dpr = dpr;
  }
  ctx.drawImage(rimCache.canvas, 0, 0, width, height);
}

export function drawDescentScene(ctx, options) {
  const { sx, sy, width, height, time, view, altitude, landed, windAngle, windStrength, dpr = 1 } = options;

  if (view === 'first') {
    // The canopy fabric fades out as the jumper nears the ground, leaving the
    // terrain visible at touchdown instead of an empty rim.
    const fade = clamp(altitude / 60, 0, 1);
    if (fade <= 0.01) return;
    drawStreaks(ctx, { width, height, time, windAngle, strength: windStrength, alpha: 0.1 * fade });
    ctx.save();
    ctx.globalAlpha = fade;
    drawCanopyRim(ctx, { width, height, cx: sx, cy: sy }, dpr);
    ctx.restore();
    return;
  }

  drawStreaks(ctx, { width, height, time, windAngle, strength: windStrength, alpha: 0.05 });
  drawParachutist(ctx, { sx, sy, altitude, time, landed });
}
