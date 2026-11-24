/** Drawing the simulated motorway at night.
 *
 * Everything is drawn in frame pixels (960 x 540) through the same camera the
 * stand-in detector uses, so a box the tracker draws sits on the vehicle it
 * belongs to. What does not move -- the sky, the city on the horizon, the
 * trees, the walls, the road and its markings, the pools of lamplight and their
 * reflections on the wet surface -- is drawn once into a layer at the screen's
 * own resolution and reused. Each frame then adds what moves, nearest last:
 * vehicles, their lights, the lamp posts, and the gantry whose sign shows the
 * count.
 *
 * Lights are additive sprites, not gradients built per frame: one small
 * pre-rendered glow per colour, scaled into place. */

import { CHARACTER_GAP, GLYPHS, GLYPH_COLUMNS, GLYPH_ROWS, signText } from "../ui/vms";
import type { Camera, Projected } from "./camera";
import { Random } from "./random";
import { BEAM, GANTRY_Y, SIGN, SIGNALS } from "./structures";
import type { Panel } from "./structures";
import { LANES, LANE_WIDTH_M, MEDIAN_HALF_M, ROAD_HALF_M } from "./traffic";
import type { Vehicle } from "./traffic";

type Ctx = CanvasRenderingContext2D;
type Rgb = readonly [number, number, number];

const LAMP_SPACING_M = 50;
const LAMP_HEIGHT_M = 12;
const LAMP_POLE_X = ROAD_HALF_M + 0.9;
const LAMP_HEAD_X = ROAD_HALF_M - 2.6;
const LAMP_LAST_Y = 700;
const WALL_X = ROAD_HALF_M + 1.7;
const WALL_H = 3.6;
const TREE_X = WALL_X + 4;
/** Painted edge of the running lanes, either side of the hard shoulder. */
const OUTER_EDGE_X = MEDIAN_HALF_M + 3 * LANE_WIDTH_M;
const ROAD_END_Y = 2400;

/** Car paints as they look under street lights. */
const PAINTS: readonly Rgb[] = [
  [206, 211, 216],
  [150, 158, 167],
  [78, 84, 92],
  [30, 33, 38],
  [38, 58, 96],
  [124, 34, 40],
  [40, 70, 60],
  [168, 152, 126],
  [52, 88, 148],
];

const TRAILERS: readonly Rgb[] = [
  [204, 209, 214],
  [124, 132, 142],
  [48, 80, 128],
  [130, 48, 46],
  [216, 208, 192],
  [60, 104, 84],
];

const NIGHT: Rgb = [10, 16, 28];

function rgb(colour: Rgb, light: number, alpha = 1): string {
  // Mix toward the night's own blue as the light falls, rather than toward
  // black: shadows outdoors at night are blue, not grey.
  const k = Math.max(0, light);
  const r = Math.round(colour[0] * k + NIGHT[0] * (1 - Math.min(1, k)));
  const g = Math.round(colour[1] * k + NIGHT[1] * (1 - Math.min(1, k)));
  const b = Math.round(colour[2] * k + NIGHT[2] * (1 - Math.min(1, k)));
  return alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

// -- sprites ---------------------------------------------------------------------

type Sprite = HTMLCanvasElement;

interface Sprites {
  readonly head: Sprite;
  readonly tail: Sprite;
  readonly amber: Sprite;
  readonly lamp: Sprite;
  readonly green: Sprite;
  readonly white: Sprite;
}

function makeSprite(colour: Rgb, hot: number): Sprite {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d") as Ctx;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const [r, g, b] = colour;
  gradient.addColorStop(0, `rgb(255 255 255 / ${hot})`);
  gradient.addColorStop(0.12, `rgb(${r} ${g} ${b} / 0.95)`);
  gradient.addColorStop(0.35, `rgb(${r} ${g} ${b} / 0.32)`);
  gradient.addColorStop(0.7, `rgb(${r} ${g} ${b} / 0.07)`);
  gradient.addColorStop(1, `rgb(${r} ${g} ${b} / 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

function makeSprites(): Sprites {
  return {
    head: makeSprite([255, 236, 204], 1),
    tail: makeSprite([255, 38, 28], 0.85),
    amber: makeSprite([255, 168, 40], 0.9),
    lamp: makeSprite([255, 214, 160], 1),
    green: makeSprite([60, 255, 150], 0.9),
    white: makeSprite([226, 236, 255], 1),
  };
}

function glow(ctx: Ctx, sprite: Sprite, u: number, v: number, w: number, h: number, alpha: number): void {
  if (alpha <= 0.002 || w <= 0 || h <= 0) {
    return;
  }
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(sprite, u - w / 2, v - h / 2, w, h);
}

// -- geometry helpers ------------------------------------------------------------

/** A panel's four corners on the frame, or null if any is behind the lens. */
function panelCorners(camera: Camera, panel: Panel): Projected[] | null {
  const corners = [
    camera.project(panel.x0, panel.y, panel.z0),
    camera.project(panel.x1, panel.y, panel.z0),
    camera.project(panel.x1, panel.y, panel.z1),
    camera.project(panel.x0, panel.y, panel.z1),
  ];
  return corners.every((corner) => corner !== null) ? (corners as Projected[]) : null;
}

function quad(ctx: Ctx, points: readonly Projected[], fill: string | CanvasGradient): void {
  ctx.beginPath();
  ctx.moveTo((points[0] as Projected).u, (points[0] as Projected).v);
  for (let index = 1; index < points.length; index += 1) {
    ctx.lineTo((points[index] as Projected).u, (points[index] as Projected).v);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** A strip on the road surface from y0 to y1, between x0 and x1, as one
 * polygon: both edges sampled along the way so it stays straight in
 * perspective even when it starts close to the camera. */
function groundStrip(camera: Camera, x0: number, x1: number, y0: number, y1: number): Projected[] | null {
  const a = camera.project(x0, y0, 0);
  const b = camera.project(x1, y0, 0);
  const c = camera.project(x1, y1, 0);
  const d = camera.project(x0, y1, 0);
  if (a === null || b === null || c === null || d === null) {
    return null;
  }
  return [a, b, c, d];
}

/** Lamplight falling on a point of the road, 0 to 1. */
function lampLight(y: number, x: number): number {
  let light = 0;
  const side = FIRST_LAMP_Y + (x < 0 ? 0 : LAMP_SPACING_M / 2);
  const nearest = Math.round((y - side) / LAMP_SPACING_M) * LAMP_SPACING_M + side;
  for (const lampY of [nearest - LAMP_SPACING_M, nearest, nearest + LAMP_SPACING_M]) {
    const along = (y - lampY) / 15;
    const across = (Math.abs(x) - LAMP_HEAD_X) / 10;
    light = Math.max(light, Math.exp(-(along * along) - across * across));
  }
  return light;
}

/** The first lamp on the left: close enough to the camera that its pool of
 * light falls in the bottom of the picture. The right-hand row is staggered
 * by half a spacing. */
const FIRST_LAMP_Y = 22;

function lampYs(side: -1 | 1): number[] {
  const out: number[] = [];
  for (let y = side < 0 ? FIRST_LAMP_Y : FIRST_LAMP_Y + LAMP_SPACING_M / 2; y <= LAMP_LAST_Y; y += LAMP_SPACING_M) {
    out.push(y);
  }
  return out;
}

// -- the painter -------------------------------------------------------------------

/** One thing to draw in the depth pass. */
interface Drawable {
  readonly depth: number;
  readonly draw: () => void;
}

export class ScenePainter {
  private readonly camera: Camera;
  private sprites: Sprites | null = null;
  private layer: HTMLCanvasElement | null = null;
  private layerResolution = 0;
  private readonly stars: { u: number; v: number; r: number; a: number; twinkle: number }[] = [];

  constructor(camera: Camera) {
    this.camera = camera;
    const rng = new Random(91);
    const horizon = camera.horizonV;
    for (let index = 0; index < 150; index += 1) {
      const v = rng.range(0, horizon - 18) ** 1.15 / (horizon - 18) ** 0.15;
      this.stars.push({
        u: rng.range(0, camera.spec.width),
        v,
        r: rng.range(0.35, 1.05),
        a: rng.range(0.25, 0.9),
        twinkle: rng.next() < 0.25 ? rng.range(0.6, 2.2) : 0,
      });
    }
  }

  /** Draw the scene. The context's transform must map frame pixels to the
   * canvas; `resolution` is device pixels per frame pixel, which is what the
   * still layer is drawn at. `time` is the simulation's clock, so a paused
   * road is a still picture. */
  paint(ctx: Ctx, resolution: number, vehicles: readonly Vehicle[], time: number, count: number): void {
    const sprites = (this.sprites ??= makeSprites());
    ctx.save();
    ctx.drawImage(this.still(resolution), 0, 0, this.camera.spec.width, this.camera.spec.height);
    this.twinkle(ctx, time);

    ctx.globalCompositeOperation = "lighter";
    for (const vehicle of vehicles) {
      this.groundLight(ctx, sprites, vehicle);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    const drawables: Drawable[] = [];
    for (const vehicle of vehicles) {
      const centre = this.camera.project(vehicle.x, vehicle.y, vehicle.height / 2);
      if (centre !== null) {
        drawables.push({ depth: centre.depth, draw: () => this.vehicle(ctx, sprites, vehicle) });
      }
    }
    for (const side of [-1, 1] as const) {
      for (const y of lampYs(side)) {
        const head = this.camera.project(side * LAMP_POLE_X, y, LAMP_HEIGHT_M / 2);
        if (head !== null) {
          drawables.push({ depth: head.depth, draw: () => this.lamp(ctx, sprites, side, y) });
        }
      }
    }
    const gantry = this.camera.project(0, GANTRY_Y, 6);
    if (gantry !== null) {
      drawables.push({ depth: gantry.depth, draw: () => this.gantry(ctx, sprites, count, time) });
    }
    drawables.sort((a, b) => b.depth - a.depth);
    for (const drawable of drawables) {
      drawable.draw();
    }

    this.haze(ctx);
    ctx.restore();
  }

  // -- the still layer -------------------------------------------------------------

  private still(resolution: number): HTMLCanvasElement {
    const rounded = Math.max(0.5, Math.round(resolution * 4) / 4);
    if (this.layer !== null && this.layerResolution === rounded) {
      return this.layer;
    }
    const { width, height } = this.camera.spec;
    const canvas = this.layer ?? document.createElement("canvas");
    canvas.width = Math.round(width * rounded);
    canvas.height = Math.round(height * rounded);
    const ctx = canvas.getContext("2d") as Ctx;
    ctx.setTransform(rounded, 0, 0, rounded, 0, 0);
    this.drawStill(ctx);
    this.layer = canvas;
    this.layerResolution = rounded;
    return canvas;
  }

  private drawStill(ctx: Ctx): void {
    const sprites = (this.sprites ??= makeSprites());
    const camera = this.camera;
    const { width, height } = camera.spec;
    const horizon = camera.horizonV;

    // Sky: deep blue overhead, warming toward the city on the horizon.
    const sky = ctx.createLinearGradient(0, 0, 0, horizon + 8);
    sky.addColorStop(0, "#02040a");
    sky.addColorStop(0.45, "#081129");
    sky.addColorStop(0.8, "#17204a");
    sky.addColorStop(0.94, "#3a2c4c");
    sky.addColorStop(1, "#5a3a3e");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, horizon + 8);
    for (const star of this.stars) {
      if (star.twinkle > 0) {
        continue;
      }
      ctx.globalAlpha = star.a;
      ctx.fillStyle = "#e9f0ff";
      ctx.beginPath();
      ctx.arc(star.u, star.v, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // The city's glow, then the city.
    ctx.globalCompositeOperation = "lighter";
    glow(ctx, sprites.lamp, width * 0.52, horizon + 4, width * 1.3, 150, 0.26);
    glow(ctx, sprites.amber, width * 0.6, horizon + 2, width * 0.62, 70, 0.22);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    this.skyline(ctx);

    // Ground beyond the road, then the trees and walls that line it.
    ctx.fillStyle = "#05080d";
    ctx.fillRect(0, horizon, width, height - horizon);
    this.trees(ctx);
    this.walls(ctx);

    // The road.
    const road = groundStrip(camera, -ROAD_HALF_M, ROAD_HALF_M, 4, ROAD_END_Y);
    if (road !== null) {
      const surface = ctx.createLinearGradient(0, horizon, 0, height);
      surface.addColorStop(0, "#2a2a3a");
      surface.addColorStop(0.07, "#141923");
      surface.addColorStop(0.4, "#0e1219");
      surface.addColorStop(1, "#0a0d12");
      quad(ctx, road, surface);
    }
    this.texture(ctx);
    this.markings(ctx);
    this.median(ctx);

    // Lamplight on the road, and its reflection in the wet surface.
    ctx.globalCompositeOperation = "lighter";
    for (const side of [-1, 1] as const) {
      for (const y of lampYs(side)) {
        this.pool(ctx, sprites, side, y);
      }
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  private skyline(ctx: Ctx): void {
    const rng = new Random(5);
    const { width } = this.camera.spec;
    const horizon = this.camera.horizonV;
    const buildings: { x: number; w: number; h: number }[] = [];
    let x = -10;
    while (x < width + 10) {
      const w = rng.range(7, 22);
      // Taller toward the middle, where the road points: a city centre.
      const centre = 1 - Math.min(1, Math.abs(x - width * 0.56) / (width * 0.5));
      const h = rng.range(3, 9) + centre * centre * rng.range(6, 30);
      buildings.push({ x, w, h });
      x += w + rng.range(-2, 3);
    }
    ctx.fillStyle = "#0a101d";
    for (const building of buildings) {
      ctx.fillRect(building.x, horizon - building.h, building.w, building.h + 2);
    }
    // A tower with a lit top, and a mast beside it.
    const tower = width * 0.63;
    ctx.fillRect(tower - 1.2, horizon - 58, 2.4, 58);
    ctx.fillRect(tower - 4, horizon - 47, 8, 6);
    ctx.fillRect(tower - 0.4, horizon - 68, 0.8, 12);
    // Windows: a few lit, mostly warm, some cold.
    for (const building of buildings) {
      for (let wy = horizon - building.h + 2; wy < horizon - 1; wy += 2.6) {
        for (let wx = building.x + 1.5; wx < building.x + building.w - 1; wx += 2.4) {
          if (rng.next() < 0.24) {
            ctx.fillStyle = rng.next() < 0.78 ? "rgb(255 205 140 / 0.9)" : "rgb(190 215 255 / 0.75)";
            ctx.fillRect(wx, wy, 1, 1);
          }
        }
      }
    }
    ctx.fillStyle = "rgb(255 210 150 / 0.85)";
    ctx.fillRect(tower - 3, horizon - 45.5, 6, 1);
  }

  /** The two tree lines: dark crowns along each side, behind the walls. */
  private trees(ctx: Ctx): void {
    const camera = this.camera;
    for (const side of [-1, 1] as const) {
      const rng = new Random(side < 0 ? 31 : 37);
      const tops: Projected[] = [];
      const bottoms: Projected[] = [];
      let crown = 11;
      for (let y = 6; y < 1600; y += y < 120 ? 1.6 : y < 400 ? 4 : 12) {
        crown += rng.range(-1.1, 1.1);
        crown = Math.min(15, Math.max(8, crown));
        const bump = Math.sin(y * 0.9 + side) * 0.7 + rng.range(-0.4, 0.4);
        const top = camera.project(side * (TREE_X + rng.range(0, 2)), y, crown + bump);
        const bottom = camera.project(side * TREE_X, y, 0);
        if (top !== null && bottom !== null) {
          tops.push(top);
          bottoms.push(bottom);
        }
      }
      if (tops.length < 2) {
        continue;
      }
      const shape = [...tops, ...bottoms.reverse()];
      const shade = ctx.createLinearGradient(0, 0, 0, camera.horizonV + 10);
      shade.addColorStop(0, "#020408");
      shade.addColorStop(1, "#0a1220");
      quad(ctx, shape, shade);
    }
  }

  private walls(ctx: Ctx): void {
    const camera = this.camera;
    for (const side of [-1, 1] as const) {
      const near = 5;
      const a = camera.project(side * WALL_X, near, 0);
      const b = camera.project(side * WALL_X, ROAD_END_Y, 0);
      const c = camera.project(side * WALL_X, ROAD_END_Y, WALL_H);
      const d = camera.project(side * WALL_X, near, WALL_H);
      if (a === null || b === null || c === null || d === null) {
        continue;
      }
      quad(ctx, [a, b, c, d], "#121821");
      // Panel joints, every 5 m, close enough to read as a wall.
      ctx.strokeStyle = "rgb(0 0 0 / 0.35)";
      ctx.lineWidth = 0.8;
      for (let y = 6; y < 180; y += 5) {
        const foot = camera.project(side * WALL_X, y, 0);
        const head = camera.project(side * WALL_X, y, WALL_H);
        if (foot === null || head === null) {
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(foot.u, foot.v);
        ctx.lineTo(head.u, head.v);
        ctx.stroke();
      }
      // The cap catches the light.
      ctx.strokeStyle = "rgb(150 165 185 / 0.18)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(d.u, d.v);
      ctx.lineTo(c.u, c.v);
      ctx.stroke();
    }
  }

  /** Asphalt grain near the camera, where it would be visible. */
  private texture(ctx: Ctx): void {
    const rng = new Random(77);
    const camera = this.camera;
    for (let index = 0; index < 2600; index += 1) {
      const y = 6 + rng.next() ** 2 * 90;
      const x = rng.range(-ROAD_HALF_M, ROAD_HALF_M);
      const point = camera.project(x, y, 0);
      if (point === null) {
        continue;
      }
      const size = Math.min(1.4, 18 / point.depth);
      ctx.fillStyle = rng.next() < 0.5 ? "rgb(255 255 255 / 0.035)" : "rgb(0 0 0 / 0.22)";
      ctx.fillRect(point.u, point.v, size, size);
    }
  }

  private markings(ctx: Ctx): void {
    const camera = this.camera;
    // Road paint is retroreflective: dim in the dark, bright where a lamp
    // falls on it. Each piece takes the light at its own distance.
    const paint = (x0: number, x1: number, y0: number, y1: number): void => {
      const strip = groundStrip(camera, x0, x1, y0, y1);
      if (strip !== null) {
        const lit = lampLight((y0 + y1) / 2, (x0 + x1) / 2);
        quad(ctx, strip, `rgb(226 230 236 / ${(0.15 + 0.33 * lit).toFixed(3)})`);
      }
    };
    for (const side of [-1, 1]) {
      // Solid lines: the edge of the running lanes and the edge by the median.
      for (const x of [OUTER_EDGE_X, MEDIAN_HALF_M]) {
        const centre = side * x;
        for (let y = 4; y < 700; y += 6) {
          paint(centre - 0.15, centre + 0.15, y, y + 6.05);
        }
        paint(centre - 0.15, centre + 0.15, 700, ROAD_END_Y);
      }
      // Dashed lane lines: 6 m painted, 12 m gap.
      for (const lane of [1, 2]) {
        const centre = side * (MEDIAN_HALF_M + lane * LANE_WIDTH_M);
        for (let y = 2; y < 900; y += 18) {
          paint(centre - 0.08, centre + 0.08, y, y + 6);
        }
      }
    }
  }

  private median(ctx: Ctx): void {
    const camera = this.camera;
    // A concrete step barrier: its two faces and its lit top.
    for (const side of [-1, 1] as const) {
      const a = camera.project(side * 0.35, 4, 0);
      const b = camera.project(side * 0.35, ROAD_END_Y, 0);
      const c = camera.project(side * 0.2, ROAD_END_Y, 0.85);
      const d = camera.project(side * 0.2, 4, 0.85);
      if (a !== null && b !== null && c !== null && d !== null) {
        quad(ctx, [a, b, c, d], "#2a3039");
      }
    }
    const top = [
      camera.project(-0.2, 4, 0.85),
      camera.project(0.2, 4, 0.85),
      camera.project(0.2, ROAD_END_Y, 0.85),
      camera.project(-0.2, ROAD_END_Y, 0.85),
    ];
    if (top.every((point) => point !== null)) {
      quad(ctx, top as Projected[], "#454c57");
    }
    // Reflectors every 12 m: white facing one way, amber the other.
    const sprites = (this.sprites ??= makeSprites());
    ctx.globalCompositeOperation = "lighter";
    for (let y = 8; y < 400; y += 12) {
      for (const side of [-1, 1] as const) {
        const point = camera.project(side * 0.32, y, 0.6);
        if (point === null) {
          continue;
        }
        const size = Math.max(1.2, 5 * camera.scaleAt(point.depth) * 0.12);
        glow(ctx, side < 0 ? sprites.white : sprites.amber, point.u, point.v, size * 2, size * 2, 0.5);
      }
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  /** A lamp's pool of light on the road, and its long reflection. */
  private pool(ctx: Ctx, sprites: Sprites, side: -1 | 1, y: number): void {
    const camera = this.camera;
    const centre = camera.project(side * (LAMP_HEAD_X - 1.5), y, 0);
    const near = camera.project(side * (LAMP_HEAD_X - 1.5), y - 14, 0);
    const far = camera.project(side * (LAMP_HEAD_X - 1.5), y + 14, 0);
    if (centre === null || near === null || far === null) {
      return;
    }
    const scale = camera.scaleAt(centre.depth);
    const across = 26 * scale;
    const along = Math.max(2, near.v - far.v) * 1.25;
    glow(ctx, sprites.lamp, centre.u, centre.v, across, along, 0.3);
    glow(ctx, sprites.lamp, centre.u, centre.v, across * 1.8, along * 1.6, 0.08);
    // The reflection runs from the road toward the lamp's mirror image.
    const head = camera.project(side * LAMP_HEAD_X, y, LAMP_HEIGHT_M);
    const mirror = camera.project(side * LAMP_HEAD_X, y, -LAMP_HEIGHT_M * 0.35);
    const foot = camera.project(side * LAMP_HEAD_X, y, 0);
    if (head === null || mirror === null || foot === null) {
      return;
    }
    const length = Math.max(4, mirror.v - foot.v) * 1.7;
    glow(ctx, sprites.lamp, foot.u, foot.v + length * 0.32, Math.max(2.5, 1.1 * scale), length, 0.34);
  }

  // -- what moves ---------------------------------------------------------------------

  private twinkle(ctx: Ctx, time: number): void {
    ctx.fillStyle = "#e9f0ff";
    for (const star of this.stars) {
      if (star.twinkle === 0) {
        continue;
      }
      ctx.globalAlpha = star.a * (0.55 + 0.45 * Math.sin(time * star.twinkle + star.u));
      ctx.beginPath();
      ctx.arc(star.u, star.v, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    // The tower's red warning light, on for a moment every second and a half.
    const horizon = this.camera.horizonV;
    const on = time % 1.5 < 0.5;
    const sprites = (this.sprites ??= makeSprites());
    ctx.globalCompositeOperation = "lighter";
    glow(ctx, sprites.tail, this.camera.spec.width * 0.63, horizon - 68, on ? 9 : 5, on ? 9 : 5, on ? 0.95 : 0.25);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  /** Headlight beams on the road ahead of each vehicle, and every light's
   * reflection in the wet surface under it. */
  private groundLight(ctx: Ctx, sprites: Sprites, vehicle: Vehicle): void {
    const camera = this.camera;
    const direction = vehicle.lane.direction;
    const front = vehicle.y + (direction * vehicle.length) / 2;
    const beamCentre = camera.project(vehicle.x, front + direction * 11, 0);
    const beamNear = camera.project(vehicle.x, front + direction * 1, 0);
    const beamFar = camera.project(vehicle.x, front + direction * 22, 0);
    if (beamCentre !== null && beamNear !== null && beamFar !== null && beamCentre.depth < 260) {
      const scale = camera.scaleAt(beamCentre.depth);
      const along = Math.abs(beamNear.v - beamFar.v);
      const strength = vehicle.kind === "motorcycle" ? 0.16 : 0.3;
      glow(ctx, sprites.head, beamCentre.u, beamCentre.v, 6.5 * scale, Math.max(3, along * 1.2), strength);
    }
    // Reflections of the lights the camera can see: headlights on traffic
    // coming toward it, tail-lights on traffic going away.
    for (const light of this.lights(vehicle)) {
      if (light.kind === "marker") {
        continue;
      }
      const foot = camera.project(light.x, light.y, 0);
      const mirror = camera.project(light.x, light.y, -light.z * 1.4);
      if (foot === null || mirror === null || foot.depth > 220) {
        continue;
      }
      const scale = camera.scaleAt(foot.depth);
      const length = Math.max(3, (mirror.v - foot.v) * 3.2);
      const sprite = light.kind === "head" ? sprites.head : sprites.tail;
      const brightness = light.kind === "head" ? 0.5 : light.brake ? 0.6 : 0.42;
      glow(ctx, sprite, foot.u, foot.v + length * 0.38, Math.max(1.6, 0.42 * scale), length, brightness);
    }
  }

  /** Where a vehicle's lights are, in world metres. */
  private lights(vehicle: Vehicle): {
    x: number;
    y: number;
    z: number;
    kind: "head" | "tail" | "marker";
    brake: boolean;
  }[] {
    const direction = vehicle.lane.direction;
    const toward = direction < 0;
    // The face the camera sees: the front of oncoming traffic, the back of
    // traffic going away.
    const nearY = vehicle.y - vehicle.length / 2;
    const out: { x: number; y: number; z: number; kind: "head" | "tail" | "marker"; brake: boolean }[] = [];
    const pair = (spread: number, z: number, kind: "head" | "tail" | "marker"): void => {
      for (const sign of [-1, 1]) {
        out.push({ x: vehicle.x + sign * spread, y: nearY, z, kind, brake: vehicle.braking });
      }
    };
    switch (vehicle.kind) {
      case "car":
        pair(vehicle.width / 2 - 0.3, toward ? 0.66 : 0.86, toward ? "head" : "tail");
        break;
      case "truck":
        pair(0.98, toward ? 0.86 : 1.02, toward ? "head" : "tail");
        pair(1.12, toward ? 3.1 : 3.92, "marker");
        break;
      case "bus":
        pair(1.0, toward ? 0.66 : 0.98, toward ? "head" : "tail");
        break;
      case "motorcycle":
        out.push({ x: vehicle.x, y: nearY, z: toward ? 0.96 : 0.82, kind: toward ? "head" : "tail", brake: vehicle.braking });
        break;
    }
    return out;
  }

  private vehicle(ctx: Ctx, sprites: Sprites, vehicle: Vehicle): void {
    const camera = this.camera;
    const near = camera.project(vehicle.x, vehicle.y - vehicle.length / 2, 0);
    if (near === null) {
      return;
    }
    const light = 0.34 + 0.62 * lampLight(vehicle.y, vehicle.x);
    if (near.depth < 320) {
      this.body(ctx, vehicle, light);
    }
    // Lights over the body, additive.
    ctx.globalCompositeOperation = "lighter";
    for (const lamp of this.lights(vehicle)) {
      const point = camera.project(lamp.x, lamp.y - 0.02, lamp.z);
      if (point === null) {
        continue;
      }
      const scale = camera.scaleAt(point.depth);
      if (lamp.kind === "head") {
        // Oncoming headlights are the brightest things in a night picture:
        // a hot core, a bloom, a wide glare, and a faint anamorphic streak --
        // the lens, not the lamp.
        const core = Math.min(9, Math.max(1.2, 0.36 * scale));
        glow(ctx, sprites.head, point.u, point.v, core * 2.8, core * 2.8, 1);
        glow(ctx, sprites.head, point.u, point.v, core * 9, core * 7.5, 0.55);
        glow(ctx, sprites.head, point.u, point.v, core * 22, core * 16, 0.14);
        glow(ctx, sprites.white, point.u, point.v, core * 30, core * 1.2, 0.26);
      } else if (lamp.kind === "tail") {
        const core = Math.min(7, Math.max(1, (lamp.brake ? 0.34 : 0.26) * scale));
        glow(ctx, sprites.tail, point.u, point.v, core * 2.8, core * 2.3, lamp.brake ? 1 : 0.85);
        glow(ctx, sprites.tail, point.u, point.v, core * 9, core * 7, lamp.brake ? 0.6 : 0.36);
        glow(ctx, sprites.tail, point.u, point.v, core * 18, core * 12, lamp.brake ? 0.16 : 0.08);
      } else {
        const core = Math.min(3.5, Math.max(0.7, 0.12 * scale));
        glow(ctx, vehicle.lane.direction < 0 ? sprites.amber : sprites.tail, point.u, point.v, core * 3, core * 3, 0.85);
      }
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  /** The body: boxes, far part first, each showing the faces the camera sees. */
  private body(ctx: Ctx, vehicle: Vehicle, light: number): void {
    const direction = vehicle.lane.direction;
    const front = vehicle.y + (direction * vehicle.length) / 2;
    /** World y of a point `s` metres back from the front bumper. */
    const at = (s: number): number => front - direction * s;
    const paint = PAINTS[vehicle.paint % PAINTS.length] as Rgb;
    const glass: Rgb = [16, 24, 36];
    const dark: Rgb = [14, 16, 20];
    const half = vehicle.width / 2;
    const L = vehicle.length;

    this.shadow(ctx, vehicle);

    type Part = { s0: number; s1: number; w: number; z0: number; z1: number; colour: Rgb; nearColour?: Rgb; gloss?: number };
    let parts: Part[];
    switch (vehicle.kind) {
      case "car":
        parts = [
          { s0: 0, s1: L, w: half, z0: 0.3, z1: 0.9, colour: paint },
          { s0: L * 0.27, s1: L * 0.8, w: half * 0.86, z0: 0.9, z1: vehicle.height, colour: paint, nearColour: glass, gloss: 1 },
        ];
        break;
      case "truck": {
        const trailer = TRAILERS[vehicle.paint % TRAILERS.length] as Rgb;
        parts = [
          { s0: 0, s1: 2.3, w: 1.24, z0: 0.45, z1: 3.1, colour: paint, nearColour: direction < 0 ? [24, 30, 40] : paint },
          { s0: 2.9, s1: L, w: 1.15, z0: 0.3, z1: 1.15, colour: dark },
          { s0: 2.9, s1: L, w: half, z0: 1.15, z1: 4, colour: trailer },
        ];
        break;
      }
      case "bus":
        parts = [{ s0: 0, s1: L, w: half, z0: 0.32, z1: vehicle.height, colour: [196, 202, 210], nearColour: direction < 0 ? [26, 34, 46] : [150, 156, 166] }];
        break;
      case "motorcycle":
        parts = [
          { s0: 0, s1: L, w: 0.28, z0: 0.3, z1: 1.0, colour: dark },
          { s0: L * 0.34, s1: L * 0.66, w: 0.26, z0: 1.0, z1: vehicle.height + 0.2, colour: [34, 38, 46] },
        ];
        break;
    }
    // Far parts first: the one whose near face is furthest from the camera.
    const nearFace = (part: Part): number => Math.min(at(part.s0), at(part.s1));
    parts.sort((a, b) => nearFace(b) - nearFace(a));
    for (const part of parts) {
      this.box(ctx, vehicle.x, part, at, light);
    }

    if (vehicle.kind === "bus") {
      this.busWindows(ctx, vehicle, at, light);
    }
  }

  private box(
    ctx: Ctx,
    x: number,
    part: { s0: number; s1: number; w: number; z0: number; z1: number; colour: Rgb; nearColour?: Rgb; gloss?: number },
    at: (s: number) => number,
    light: number,
  ): void {
    const camera = this.camera;
    const y0 = Math.min(at(part.s0), at(part.s1));
    const y1 = Math.max(at(part.s0), at(part.s1));
    const x0 = x - part.w;
    const x1 = x + part.w;
    const p = (px: number, py: number, pz: number): Projected | null => camera.project(px, py, pz);
    const n00 = p(x0, y0, part.z0);
    const n10 = p(x1, y0, part.z0);
    const n11 = p(x1, y0, part.z1);
    const n01 = p(x0, y0, part.z1);
    const f00 = p(x0, y1, part.z0);
    const f10 = p(x1, y1, part.z0);
    const f11 = p(x1, y1, part.z1);
    const f01 = p(x0, y1, part.z1);
    if (n00 === null || n10 === null || n11 === null || n01 === null || f00 === null || f10 === null || f11 === null || f01 === null) {
      return;
    }
    // The camera stands over the median, so it sees the inner side.
    const side = x > 0 ? [n00, f00, f01, n01] : [n10, f10, f11, n11];
    quad(ctx, side, rgb(part.colour, light * 0.42));
    if (part.gloss !== undefined) {
      // Glass: dark, with the sky and the lamps reflected toward the top.
      const pane = ctx.createLinearGradient(0, n01.v, 0, n00.v);
      pane.addColorStop(0, `rgb(120 140 176 / ${0.5 + 0.3 * light})`);
      pane.addColorStop(0.45, rgb(part.nearColour ?? part.colour, 0.9));
      pane.addColorStop(1, rgb(part.nearColour ?? part.colour, 0.7));
      quad(ctx, [n00, n10, n11, n01], pane);
    } else {
      quad(ctx, [n00, n10, n11, n01], rgb(part.nearColour ?? part.colour, light * 0.62));
    }
    quad(ctx, [n01, n11, f11, f01], rgb(part.colour, light * 0.98));
    // The edge between the near face and the top catches the light: it is
    // what gives a box in the dark its shape.
    ctx.strokeStyle = `rgb(220 230 255 / ${(0.08 + 0.2 * light).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.5, camera.scaleAt(n01.depth) * 0.04);
    ctx.beginPath();
    ctx.moveTo(n01.u, n01.v);
    ctx.lineTo(n11.u, n11.v);
    ctx.stroke();
  }

  private busWindows(ctx: Ctx, vehicle: Vehicle, at: (s: number) => number, light: number): void {
    const camera = this.camera;
    const x = vehicle.x > 0 ? vehicle.x - vehicle.width / 2 : vehicle.x + vehicle.width / 2;
    const corners = [
      camera.project(x, at(1.2), 1.3),
      camera.project(x, at(vehicle.length - 0.8), 1.3),
      camera.project(x, at(vehicle.length - 0.8), 2.6),
      camera.project(x, at(1.2), 2.6),
    ];
    if (corners.some((corner) => corner === null)) {
      return;
    }
    quad(ctx, corners as Projected[], rgb([18, 26, 38], 0.9));
    ctx.globalCompositeOperation = "lighter";
    quad(ctx, corners as Projected[], `rgb(255 200 130 / ${0.16 + 0.1 * light})`);
    ctx.globalCompositeOperation = "source-over";
  }

  private shadow(ctx: Ctx, vehicle: Vehicle): void {
    const strip = groundStrip(
      this.camera,
      vehicle.x - vehicle.width / 2 - 0.25,
      vehicle.x + vehicle.width / 2 + 0.25,
      vehicle.y - vehicle.length / 2 - 0.3,
      vehicle.y + vehicle.length / 2 + 0.3,
    );
    if (strip !== null) {
      quad(ctx, strip, "rgb(2 3 6 / 0.55)");
    }
  }

  private lamp(ctx: Ctx, sprites: Sprites, side: -1 | 1, y: number): void {
    const camera = this.camera;
    const foot = camera.project(side * LAMP_POLE_X, y, 0);
    const top = camera.project(side * LAMP_POLE_X, y, LAMP_HEIGHT_M);
    const head = camera.project(side * LAMP_HEAD_X, y, LAMP_HEIGHT_M - 0.2);
    if (foot === null || top === null || head === null) {
      return;
    }
    const scale = camera.scaleAt(top.depth);
    ctx.strokeStyle = "#1c232d";
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(0.6, 0.22 * scale);
    ctx.beginPath();
    ctx.moveTo(foot.u, foot.v);
    ctx.lineTo(top.u, top.v);
    ctx.lineTo(head.u, head.v);
    ctx.stroke();
    ctx.globalCompositeOperation = "lighter";
    const core = Math.max(1.2, 0.45 * scale);
    glow(ctx, sprites.lamp, head.u, head.v + core * 0.2, core * 3.4, core * 2.4, 1);
    glow(ctx, sprites.lamp, head.u, head.v, core * 14, core * 11, 0.4);
    // The cone of light under the head, faint in the damp air.
    glow(ctx, sprites.lamp, head.u, head.v + core * 9, core * 9, core * 18, 0.07);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  /** The overhead gantry: two posts, a beam, lane signals over the oncoming
   * lanes and a message sign showing the count. */
  private gantry(ctx: Ctx, sprites: Sprites, count: number, time: number): void {
    const camera = this.camera;
    const y = GANTRY_Y;
    const steel = "#1d242e";
    const post = (x: number): void => {
      const a = camera.project(x - 0.3, y, 0);
      const b = camera.project(x + 0.3, y, 0);
      const c = camera.project(x + 0.3, y, 7.4);
      const d = camera.project(x - 0.3, y, 7.4);
      if (a !== null && b !== null && c !== null && d !== null) {
        quad(ctx, [a, b, c, d], steel);
      }
    };
    post(-(ROAD_HALF_M + 0.4));
    post(ROAD_HALF_M + 0.4);
    const beam = panelCorners(camera, BEAM);
    if (beam === null) {
      return;
    }
    quad(ctx, beam, steel);
    // Truss diagonals, faint.
    ctx.strokeStyle = "rgb(120 135 155 / 0.18)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let x = -ROAD_HALF_M; x < ROAD_HALF_M; x += 1.6) {
      const a = camera.project(x, y, 6.25);
      const b = camera.project(x + 0.8, y, 7.35);
      const c = camera.project(x + 1.6, y, 6.25);
      if (a !== null && b !== null && c !== null) {
        ctx.moveTo(a.u, a.v);
        ctx.lineTo(b.u, b.v);
        ctx.lineTo(c.u, c.v);
      }
    }
    ctx.stroke();

    // Over the far carriageway the camera sees the backs of the signals.
    LANES.forEach((lane, index) => {
      const signal = SIGNALS[index];
      const panel = signal === undefined ? null : panelCorners(camera, signal);
      if (panel === null) {
        return;
      }
      quad(ctx, panel, lane.direction < 0 ? "#050608" : "#20272f");
      if (lane.direction < 0 && lane.position !== "inner") {
        // A green arrow pointing down: this lane is open.
        const centre = camera.project(lane.x, y - 0.32, 5.62);
        if (centre !== null) {
          const s = camera.scaleAt(centre.depth) * 0.3;
          ctx.globalCompositeOperation = "lighter";
          glow(ctx, sprites.green, centre.u, centre.v, s * 3.4, s * 3.4, 0.35);
          ctx.globalCompositeOperation = "source-over";
          ctx.globalAlpha = 1;
          ctx.fillStyle = "#4dffa6";
          ctx.beginPath();
          ctx.moveTo(centre.u - s * 0.7, centre.v - s * 0.5);
          ctx.lineTo(centre.u + s * 0.7, centre.v - s * 0.5);
          ctx.lineTo(centre.u, centre.v + s * 0.75);
          ctx.closePath();
          ctx.fill();
        }
      }
    });
    this.sign(ctx, sprites, count, time);
  }

  /** The message sign over the oncoming lanes, showing the count in the same
   * five-by-seven LEDs as the readout beside the video. */
  private sign(ctx: Ctx, sprites: Sprites, count: number, time: number): void {
    const camera = this.camera;
    const { y, z0, z1 } = SIGN;
    // x0 here is the sign's right-hand edge as the camera sees it, x1 its
    // left: the text runs from x1 to x0.
    const x0 = SIGN.x1;
    const x1 = SIGN.x0;
    const corners = panelCorners(camera, SIGN);
    if (corners === null) {
      return;
    }
    quad(ctx, corners, "#020304");

    const text = signText(count);
    const columns = text.length * GLYPH_COLUMNS + (text.length - 1) * CHARACTER_GAP;
    const width = x0 - x1 - 0.7;
    const pitch = Math.min(width / columns, (z1 - z0 - 0.4) / GLYPH_ROWS);
    const startX = x1 + 0.35 + (width - pitch * columns) / 2;
    const topZ = z1 - 0.2 - ((z1 - z0 - 0.4) - pitch * GLYPH_ROWS) / 2;
    const glowing: Projected[] = [];
    [...text].forEach((character, index) => {
      const glyph = GLYPHS[character] ?? GLYPHS[" "];
      if (glyph === undefined) {
        return;
      }
      glyph.forEach((row, ry) => {
        for (let cx = 0; cx < GLYPH_COLUMNS; cx += 1) {
          if (row[cx] !== "1") {
            continue;
          }
          const column = index * (GLYPH_COLUMNS + CHARACTER_GAP) + cx;
          const point = camera.project(startX + (column + 0.5) * pitch, y - 0.02, topZ - (ry + 0.5) * pitch);
          if (point !== null) {
            glowing.push(point);
          }
        }
      });
    });
    const first = glowing[0];
    if (first === undefined) {
      return;
    }
    const dot = Math.max(0.7, camera.scaleAt(first.depth) * pitch * 0.82);
    ctx.fillStyle = "#ffb31a";
    for (const point of glowing) {
      ctx.fillRect(point.u - dot / 2, point.v - dot / 2, dot, dot);
    }
    ctx.globalCompositeOperation = "lighter";
    const flicker = 0.92 + 0.08 * Math.sin(time * 7.3);
    for (const point of glowing) {
      glow(ctx, sprites.amber, point.u, point.v, dot * 4, dot * 4, 0.16 * flicker);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  /** Low mist over the far road, so distance reads as distance. */
  private haze(ctx: Ctx): void {
    const horizon = this.camera.horizonV;
    const mist = ctx.createLinearGradient(0, horizon - 6, 0, horizon + 70);
    mist.addColorStop(0, "rgb(60 70 96 / 0)");
    mist.addColorStop(0.18, "rgb(60 70 96 / 0.32)");
    mist.addColorStop(1, "rgb(60 70 96 / 0)");
    ctx.fillStyle = mist;
    ctx.fillRect(0, horizon - 6, this.camera.spec.width, 76);
  }
}
