/** Drawing the camera view: the frame, the boxes, the trails, the counting line
 * and the moment a vehicle is counted.
 *
 * Everything drawn here answers one question a visitor has while watching:
 * what did it see (a box per vehicle, coloured by type and named), where has
 * that vehicle been (a short trail), where is the line they can move, and what
 * just got counted (the line flashes and a "+1" rises from the exact point the
 * path crossed it). The count and the picture are the same event, so the
 * marker is drawn where the engine says the crossing happened, not where the
 * box happens to be.
 *
 * The fit maths is separated out and tested because the pointer depends on it:
 * the line is dragged in CSS pixels and lives in frame pixels, and if the two
 * disagree the handle drifts away from the finger. */

import type { CrossingEvent } from "../engine/gate";
import type { Point } from "../engine/geometry";
import type { TrackView } from "../engine/pipeline";
import type { Segment } from "./gate-drag";
import { colourToken, displayName } from "./vehicles";
import type { ColourToken } from "./vehicles";

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** How a frame of `frame` size sits inside a `box`-sized canvas, letterboxed:
 * one scale for both axes, centred, never cropping. */
export interface Fit {
  readonly scale: number;
  readonly dx: number;
  readonly dy: number;
}

export function fitContain(frame: Size, box: Size): Fit {
  if (frame.width <= 0 || frame.height <= 0) {
    return { scale: 1, dx: 0, dy: 0 };
  }
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  return {
    scale,
    dx: (box.width - frame.width * scale) / 2,
    dy: (box.height - frame.height * scale) / 2,
  };
}

export function frameToBox(p: Point, fit: Fit): Point {
  return [p[0] * fit.scale + fit.dx, p[1] * fit.scale + fit.dy];
}

/** The inverse: a pointer position in the box's coordinates, in frame pixels.
 * Unclamped -- a drag that leaves the frame is a real event and the clamp
 * belongs to `moveGate`, which knows the frame's bounds. */
export function boxToFrame(p: Point, fit: Fit): Point {
  return [(p[0] - fit.dx) / fit.scale, (p[1] - fit.dy) / fit.scale];
}

export interface Palette {
  readonly gate: string;
  readonly chipInk: string;
  readonly wrongWay: string;
  readonly ink: string;
  readonly types: Readonly<Record<ColourToken, string>>;
}

const TYPE_TOKENS: readonly ColourToken[] = [
  "--class-car",
  "--class-truck",
  "--class-bus",
  "--class-other",
];

/** Read the live colours off the document, so the canvas draws in the same
 * tokens as the markup instead of carrying a second, drifting copy. */
export function readPalette(element: Element): Palette {
  const style = getComputedStyle(element);
  const read = (token: string, fallback: string): string =>
    style.getPropertyValue(token).trim() || fallback;
  const types = {} as Record<ColourToken, string>;
  for (const token of TYPE_TOKENS) {
    types[token] = read(token, "#c3cad1");
  }
  return {
    gate: read("--gate", "#f7b500"),
    chipInk: read("--chip-ink", "#0a0e12"),
    wrongWay: read("--wrong-way", "#d03b3b"),
    ink: read("--console-text", "#f1f0ea"),
    types,
  };
}

export type Trail = readonly { readonly t: number; readonly p: Point }[];

export interface OverlayScene {
  readonly frame: Size;
  readonly gate: Segment;
  readonly gateLabels: { readonly positive: string; readonly negative: string };
  readonly tracks: readonly TrackView[];
  readonly trails: ReadonlyMap<number, Trail>;
  /** How much of each trail to draw, in seconds. Near traffic on a wide
   * motorway crosses the picture fast, and a long trail there is a streak
   * across half the frame. */
  readonly trailSeconds: number;
  /** The vehicle type of each trail, which outlives the track it came from. */
  readonly trailTypes: ReadonlyMap<number, string>;
  readonly events: readonly CrossingEvent[];
  readonly now: number;
  /** The device pixel ratio the canvas backing store was sized at. */
  readonly dpr: number;
  readonly source: CanvasImageSource | null;
  /** Draws a picture the page makes itself -- the simulated motorway -- in
   * frame pixels, in place of a video frame. `resolution` is device pixels per
   * frame pixel. */
  readonly paint: ((ctx: CanvasRenderingContext2D, resolution: number) => void) | null;
  readonly wrongWay: ReadonlySet<number>;
  /** Tracks already counted at the current line. Their chip carries a tick, so
   * a visitor can see which vehicles are done. */
  readonly counted: ReadonlySet<number>;
  /** When true nothing moves: the marker is drawn at a fixed place and size,
   * because the information is the marker, not its motion. */
  readonly reducedMotion: boolean;
}

/** How long a trail stays on the video, in seconds of clip time. */
export const TRAIL_SECONDS = 2.5;

/** How long the "+1" stays up after a crossing. */
export const POP_SECONDS = 1.4;

/** How long the line glows after a crossing. */
export const GLOW_SECONDS = 0.45;

/** Where along the line, from its start, the two direction tags sit: near an
 * end, clear of the drag handle in the middle and of the lanes where most
 * crossings -- and their "+1" -- happen. */
export const DIRECTION_TAG_AT = 0.16;

export interface PopFrame {
  /** Opacity of the "+1" tag. */
  readonly alpha: number;
  /** How far above the crossing point the tag sits, in CSS pixels. */
  readonly rise: number;
  /** Radius and opacity of the ring that spreads from the crossing point. */
  readonly ring: number;
  readonly ringAlpha: number;
}

/** The "+1" at `age` seconds after its crossing, or null once it has gone.
 *
 * It rises and eases out, holds, then fades over the last 30 %. With reduced
 * motion it simply appears in place for the same time, and there is no ring:
 * the tag alone says what happened. */
export function popFrame(age: number, reducedMotion: boolean): PopFrame | null {
  if (!(age >= 0) || age > POP_SECONDS) {
    return null;
  }
  if (reducedMotion) {
    return { alpha: 1, rise: 20, ring: 0, ringAlpha: 0 };
  }
  const progress = age / POP_SECONDS;
  const eased = 1 - (1 - progress) ** 3;
  const alpha = progress < 0.7 ? 1 : Math.max(0, 1 - (progress - 0.7) / 0.3);
  const ringProgress = Math.min(1, age / 0.6);
  return {
    alpha,
    rise: 14 + 26 * eased,
    ring: 6 + 22 * (1 - (1 - ringProgress) ** 2),
    ringAlpha: 1 - ringProgress,
  };
}

/** How brightly the line glows: 1 at the instant of a crossing, falling to 0
 * over `GLOW_SECONDS`. With reduced motion it is on or off, never fading. */
export function gateGlow(
  events: readonly { readonly timestamp: number }[],
  now: number,
  reducedMotion = false,
): number {
  let glow = 0;
  for (const event of events) {
    const age = now - event.timestamp;
    if (age >= 0 && age < GLOW_SECONDS) {
      glow = Math.max(glow, reducedMotion ? 1 : 1 - age / GLOW_SECONDS);
    }
  }
  return glow;
}

/** What a box's chip says: the type and the track's ID, which is the visible
 * proof that the tracker kept one identity across frames. */
export function chipLabel(
  track: { readonly className: string; readonly trackId: number },
  wrongWay: boolean,
): string {
  return wrongWay ? "Wrong way" : `${displayName(track.className)} ${track.trackId}`;
}

/** The unit normal of the line in box space, pointing to its positive side --
 * `geometry.sideOfLine`'s +1, left of the line's own direction. */
export function gateNormal(a: Point, b: Point): Point {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy) || 1;
  return [dy / length, -dx / length];
}

const CHIP_FONT = "700 12px Overpass, system-ui, sans-serif";

/** Boxes shorter than this, in CSS pixels, carry no label. */
export const CHIP_MIN_BOX_PX = 22;
const TAG_FONT = "700 11.5px Overpass, system-ui, sans-serif";
const POP_FONT = "800 14px Overpass, system-ui, sans-serif";
const CASING = "rgb(0 0 0 / 45%)";

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, radius);
  } else {
    ctx.rect(x, y, width, height);
  }
}

function line(ctx: CanvasRenderingContext2D, a: Point, b: Point, width: number, colour: string): void {
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.lineWidth = width;
  ctx.strokeStyle = colour;
  ctx.stroke();
}

/** A detection box drawn the way a camera's overlay draws one: a faint frame
 * and a faint wash, with the four corners marked strongly. The corners carry
 * the box's extent while leaving the vehicle itself in view, which matters
 * once a busy road has a dozen boxes on it. A counted vehicle's frame is
 * drawn solid, so what is done reads differently from what is still coming. */
function bracketBox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colour: string,
  counted: boolean,
  wash: boolean,
): void {
  ctx.save();
  if (wash) {
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, width, height);
  }
  ctx.globalAlpha = counted ? 0.85 : 0.45;
  ctx.lineWidth = counted ? 1.6 : 1.1;
  ctx.strokeStyle = colour;
  ctx.strokeRect(x, y, width, height);
  ctx.restore();

  const arm = Math.max(4, Math.min(14, Math.min(width, height) * 0.34));
  ctx.beginPath();
  for (const [cx, cy, sx, sy] of [
    [x, y, 1, 1],
    [x + width, y, -1, 1],
    [x + width, y + height, -1, -1],
    [x, y + height, 1, -1],
  ] as const) {
    ctx.moveTo(cx + sx * arm, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + sy * arm);
  }
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = CASING;
  ctx.stroke();
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = colour;
  ctx.stroke();
}

/** A tick drawn as a path, so it never depends on a glyph the font may lack. */
function tick(ctx: CanvasRenderingContext2D, x: number, y: number, colour: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 3, y + 3);
  ctx.lineTo(x + 8.5, y - 3);
  ctx.lineWidth = 2;
  ctx.strokeStyle = colour;
  ctx.stroke();
}

function typeColour(palette: Palette, className: string | undefined): string {
  return palette.types[colourToken(className ?? "")];
}

/** Draw one frame of the camera view and return the fit the pointer must use. */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  box: Size,
  scene: OverlayScene,
  palette: Palette,
): Fit {
  ctx.save();
  ctx.setTransform(scene.dpr, 0, 0, scene.dpr, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, box.width, box.height);

  const fit = fitContain(scene.frame, box);
  if (scene.paint !== null) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(fit.dx, fit.dy, scene.frame.width * fit.scale, scene.frame.height * fit.scale);
    ctx.clip();
    ctx.translate(fit.dx, fit.dy);
    ctx.scale(fit.scale, fit.scale);
    scene.paint(ctx, fit.scale * scene.dpr);
    ctx.restore();
  } else if (scene.source !== null) {
    ctx.drawImage(
      scene.source,
      fit.dx,
      fit.dy,
      scene.frame.width * fit.scale,
      scene.frame.height * fit.scale,
    );
  }

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  drawTrails(ctx, scene, fit, palette);
  drawBoxes(ctx, scene, fit, palette, box.width, box.height);
  drawGate(ctx, scene, fit, palette);
  drawPops(ctx, scene, fit, palette);

  ctx.restore();
  return fit;
}

/** A trail drawn through every anchor would wobble with every box's
 * frame-to-frame noise, which is the detector's, not the vehicle's path.
 * A centred moving average over five samples keeps the path and loses the
 * wobble; the two ends keep their true positions, so the trail still starts
 * under the vehicle. */
export function smoothTrail(points: readonly Point[], radius = 2): Point[] {
  if (points.length <= 2) {
    return [...points];
  }
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) {
      return point;
    }
    const reach = Math.min(radius, index, points.length - 1 - index);
    let x = 0;
    let y = 0;
    for (let offset = -reach; offset <= reach; offset += 1) {
      const neighbour = points[index + offset] as Point;
      x += neighbour[0];
      y += neighbour[1];
    }
    const count = 2 * reach + 1;
    return [x / count, y / count] as const;
  });
}

/** The longest trail drawn, in CSS pixels. A vehicle close to the camera
 * crosses a lot of picture in a second; its trail is kept to its newest part
 * rather than drawn as a line across half the frame. */
export const TRAIL_MAX_PX = 150;

/** The newest part of a path, no longer than `maxLength`; the cut falls part
 * way along a segment, so the trail shortens smoothly as it ages. */
export function capLength(points: readonly Point[], maxLength: number): Point[] {
  const out: Point[] = [];
  let length = 0;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index] as Point;
    const next = out[0];
    if (next === undefined) {
      out.unshift(point);
      continue;
    }
    const step = Math.hypot(next[0] - point[0], next[1] - point[1]);
    if (length + step >= maxLength) {
      const keep = step > 0 ? (maxLength - length) / step : 0;
      out.unshift([next[0] + (point[0] - next[0]) * keep, next[1] + (point[1] - next[1]) * keep]);
      break;
    }
    length += step;
    out.unshift(point);
  }
  return out;
}

/** Trails first, so a box is never hidden behind its own history. Each one
 * fades towards its tail, which is what makes it read as motion. */
function drawTrails(
  ctx: CanvasRenderingContext2D,
  scene: OverlayScene,
  fit: Fit,
  palette: Palette,
): void {
  ctx.lineWidth = 2.5;
  for (const [trackId, trail] of scene.trails) {
    // An anchor on the frame's bottom edge belongs to a box the edge has cut
    // off: it marks the edge, not where the vehicle was.
    const bottom = scene.frame.height - 1;
    const visible = trail.filter(
      (sample) => scene.now - sample.t <= scene.trailSeconds && sample.p[1] < bottom,
    );
    if (visible.length < 2) {
      continue;
    }
    ctx.strokeStyle = scene.wrongWay.has(trackId)
      ? palette.wrongWay
      : typeColour(palette, scene.trailTypes.get(trackId));
    const points = capLength(
      smoothTrail(visible.map((sample) => frameToBox(sample.p, fit))),
      TRAIL_MAX_PX,
    );
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1] as Point;
      const to = points[index] as Point;
      ctx.globalAlpha = 0.12 + 0.68 * (index / (points.length - 1));
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(to[0], to[1]);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawBoxes(
  ctx: CanvasRenderingContext2D,
  scene: OverlayScene,
  fit: Fit,
  palette: Palette,
  boxWidth: number,
  boxHeight: number,
): void {
  ctx.font = CHIP_FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const track of scene.tracks) {
    const alerting = scene.wrongWay.has(track.trackId);
    const counted = !alerting && scene.counted.has(track.trackId);
    const colour = alerting ? palette.wrongWay : typeColour(palette, track.className);
    const [x1, y1] = frameToBox([track.box[0], track.box[1]], fit);
    const [x2, y2] = frameToBox([track.box[2], track.box[3]], fit);
    const width = Math.max(1, x2 - x1);
    const height = Math.max(1, y2 - y1);

    // No wash on a box that fills much of the picture: a vehicle right under
    // the camera would tint a fifth of the frame.
    const wash = width * height < 0.12 * boxWidth * boxHeight;
    bracketBox(ctx, x1, y1, width, height, colour, counted, wash);

    // A distant vehicle's box is smaller than its label, and on a busy road a
    // row of them would stack their labels into one unreadable block. Its
    // corners still mark it; the name appears once it is near enough to read
    // beside -- unless it is the one going the wrong way.
    if (height < CHIP_MIN_BOX_PX && !alerting) {
      continue;
    }
    const label = chipLabel(track, alerting);
    const tickSpace = counted ? 13 : 0;
    const chipWidth = ctx.measureText(label).width + 12 + tickSpace;
    const chipHeight = 18;
    // Above the box where there is room, tucked inside its top edge where the
    // box touches the top of the frame.
    const chipY = y1 - chipHeight - 2 >= 0 ? y1 - chipHeight - 2 : y1 + 2;
    // Aligned to the box's left edge, and pushed back in where a box at the
    // right of the frame would carry its chip off the canvas.
    const chipX = Math.max(0, Math.min(x1 - 1, boxWidth - chipWidth));
    roundedRect(ctx, chipX, chipY, chipWidth, chipHeight, 4);
    ctx.fillStyle = colour;
    ctx.fill();
    const ink = alerting ? "#ffffff" : palette.chipInk;
    if (counted) {
      tick(ctx, chipX + 6, chipY + chipHeight / 2, ink);
    }
    ctx.fillStyle = ink;
    ctx.fillText(label, chipX + 6 + tickSpace, chipY + chipHeight / 2 + 1);
  }
}

function drawGate(ctx: CanvasRenderingContext2D, scene: OverlayScene, fit: Fit, palette: Palette): void {
  const a = frameToBox(scene.gate.start, fit);
  const b = frameToBox(scene.gate.end, fit);
  const glow = gateGlow(scene.events, scene.now, scene.reducedMotion);

  // A dark casing first, so the line reads against any footage, then the line
  // itself with a soft halo -- wider and brighter for a moment after each
  // crossing.
  line(ctx, a, b, 10, CASING);
  ctx.save();
  ctx.shadowColor = palette.gate;
  ctx.shadowBlur = 10 + 26 * glow;
  line(ctx, a, b, 4 + 2.5 * glow, palette.gate);
  ctx.restore();
  line(ctx, a, b, 4, palette.gate);

  drawDirectionTags(ctx, scene, a, b, palette);

  // The two ends: the visible targets for the handle buttons over the canvas.
  for (const point of [a, b]) {
    ctx.beginPath();
    ctx.arc(point[0], point[1], 10, 0, Math.PI * 2);
    ctx.fillStyle = CASING;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(point[0], point[1], 7.5, 0, Math.PI * 2);
    ctx.fillStyle = palette.ink;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = palette.gate;
    ctx.stroke();
  }

  // The middle: a grip, laid along the line, for moving it whole.
  const middle: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  ctx.save();
  ctx.translate(middle[0], middle[1]);
  ctx.rotate(Math.atan2(b[1] - a[1], b[0] - a[0]));
  roundedRect(ctx, -17, -9, 34, 18, 9);
  ctx.fillStyle = CASING;
  ctx.fill();
  roundedRect(ctx, -15, -7, 30, 14, 7);
  ctx.fillStyle = palette.ink;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = palette.gate;
  ctx.stroke();
  for (const x of [-5, 0, 5]) {
    line(ctx, [x, -3.5], [x, 3.5], 1.6, palette.chipInk);
  }
  ctx.restore();
}

/** The names of the two directions, one on each side of the line, each with an
 * arrow pointing the way a vehicle has to go to be counted under that name --
 * so the two numbers in the readout can be told apart on the picture. */
function drawDirectionTags(
  ctx: CanvasRenderingContext2D,
  scene: OverlayScene,
  a: Point,
  b: Point,
  palette: Palette,
): void {
  const normal = gateNormal(a, b);
  const anchor: Point = [
    a[0] + (b[0] - a[0]) * DIRECTION_TAG_AT,
    a[1] + (b[1] - a[1]) * DIRECTION_TAG_AT,
  ];
  ctx.font = TAG_FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const [label, sign] of [
    [scene.gateLabels.positive, 1],
    [scene.gateLabels.negative, -1],
  ] as const) {
    const direction: Point = [normal[0] * sign, normal[1] * sign];
    const centre: Point = [anchor[0] + direction[0] * 24, anchor[1] + direction[1] * 24];
    const textWidth = ctx.measureText(label).width;
    const width = textWidth + 32;
    const height = 20;
    const left = centre[0] - width / 2;
    const top = centre[1] - height / 2;
    roundedRect(ctx, left, top, width, height, 10);
    ctx.fillStyle = "rgb(10 14 18 / 82%)";
    ctx.fill();

    // The arrow, turned to the line's own normal: right for any angle the
    // visitor drags the line to.
    ctx.save();
    ctx.translate(left + 12, centre[1]);
    ctx.rotate(Math.atan2(direction[1], direction[0]));
    ctx.beginPath();
    ctx.moveTo(5, 0);
    ctx.lineTo(-3.5, -4.5);
    ctx.lineTo(-3.5, 4.5);
    ctx.closePath();
    ctx.fillStyle = palette.gate;
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = palette.ink;
    ctx.fillText(label, left + 22, centre[1] + 1);
  }
}

/** The "+1", rising from the point on the line where the path crossed it. */
function drawPops(ctx: CanvasRenderingContext2D, scene: OverlayScene, fit: Fit, palette: Palette): void {
  ctx.font = POP_FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (const event of scene.events) {
    const frame = popFrame(scene.now - event.timestamp, scene.reducedMotion);
    if (frame === null) {
      continue;
    }
    const wrong = scene.wrongWay.has(event.trackId);
    const colour = wrong ? palette.wrongWay : palette.gate;
    const at = frameToBox([event.crossingX, event.crossingY], fit);

    if (frame.ringAlpha > 0) {
      ctx.globalAlpha = frame.ringAlpha;
      ctx.beginPath();
      ctx.arc(at[0], at[1], frame.ring, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = colour;
      ctx.stroke();
    }

    const text = wrong ? "+1 wrong way" : `+1 ${displayName(event.className)}`;
    const width = ctx.measureText(text).width + 20;
    const height = 24;
    const centreY = at[1] - frame.rise - height / 2;
    ctx.globalAlpha = frame.alpha;
    roundedRect(ctx, at[0] - width / 2, centreY - height / 2, width, height, 12);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.fillStyle = wrong ? "#ffffff" : palette.chipInk;
    ctx.fillText(text, at[0], centreY + 1);
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = "left";
}
