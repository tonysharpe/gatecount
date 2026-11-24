/** A stand-in for the detector, for the simulated motorway.
 *
 * On real video a YOLO model looks at pixels and reports boxes. Here the
 * vehicles are already known, so their boxes are worked out from geometry
 * instead -- and then made imperfect in the ways a real detector is
 * imperfect, because a tracker shown perfect boxes proves nothing:
 *
 *   - small, distant vehicles are not seen at all, and are missed more often
 *     than near ones when they are;
 *   - a vehicle mostly hidden behind a nearer one is not seen;
 *   - every box wobbles a little from frame to frame;
 *   - confidence falls with size, so a far vehicle can keep a track alive but
 *     cannot start one (the tracker's two-stage rule).
 *
 * Everything after this point -- the tracker, the counter, the overlay and
 * the readout -- is the same code the real videos run through. */

import type { Detection } from "../engine/tracker";
import type { Camera } from "./camera";
import type { Random } from "./random";
import type { Vehicle, VehicleKind } from "./traffic";

/** COCO class ids, matching the exported model's own ordering, so a simulated
 * car is the same class to the tracker as a detected one. */
export const COCO_CLASS: Readonly<Record<VehicleKind, readonly [number, string]>> = {
  car: [2, "car"],
  motorcycle: [3, "motorcycle"],
  bus: [5, "bus"],
  truck: [7, "truck"],
};

export interface Box {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface DetectorOptions {
  /** One standard deviation of edge noise, as a share of the box's size. */
  readonly jitter: number;
  /** How often a large, clearly visible vehicle is still missed. */
  readonly missRate: number;
  /** Boxes shorter than this, in pixels, are not seen. */
  readonly minHeightPx: number;
  /** A vehicle hidden by more than this share is not seen. */
  readonly hiddenAbove: number;
  /** Share of the box that has to be inside the frame. */
  readonly minInFrame: number;
}

export const DETECTOR: DetectorOptions = {
  jitter: 0.015,
  missRate: 0.02,
  minHeightPx: 12,
  hiddenAbove: 0.6,
  minInFrame: 0.4,
};

/** The vehicle's true box on the frame: the extent of its projected body,
 * not clipped. Null when part of it is behind the lens. `y` lets a caller ask
 * about a position other than the current one. */
export function trueBox(camera: Camera, vehicle: Vehicle, y: number = vehicle.y): Box | null {
  const halfWidth = vehicle.width / 2;
  const halfLength = vehicle.length / 2;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const dx of [-halfWidth, halfWidth]) {
    for (const dy of [-halfLength, halfLength]) {
      for (const z of [0, vehicle.height]) {
        const point = camera.project(vehicle.x + dx, y + dy, z);
        if (point === null) {
          return null;
        }
        x1 = Math.min(x1, point.u);
        y1 = Math.min(y1, point.v);
        x2 = Math.max(x2, point.u);
        y2 = Math.max(y2, point.v);
      }
    }
  }
  return { x1, y1, x2, y2 };
}

function area(box: Box): number {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

function intersection(a: Box, b: Box): number {
  const width = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const height = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  return width > 0 && height > 0 ? width * height : 0;
}

function clip(box: Box, width: number, height: number): Box {
  return {
    x1: Math.max(0, box.x1),
    y1: Math.max(0, box.y1),
    x2: Math.min(width, box.x2),
    y2: Math.min(height, box.y2),
  };
}

/** One vehicle as a perfect detector would report it this frame. */
export interface Sighting {
  readonly vehicle: Vehicle;
  /** The true box, clipped to the frame. */
  readonly box: Box;
  /** Distance from the lens to the vehicle's centre. */
  readonly depth: number;
}

/** Something fixed in front of the road that hides what is behind it. */
export interface Occluder {
  readonly box: Box;
  readonly depth: number;
}

/** Every vehicle a flawless detector would report: far enough into the frame,
 * big enough to see, and not mostly hidden behind something nearer -- another
 * vehicle, or one of `structures`. Nearest first. */
export function sightings(
  camera: Camera,
  vehicles: readonly Vehicle[],
  options: DetectorOptions = DETECTOR,
  structures: readonly Occluder[] = [],
): Sighting[] {
  const { width, height } = camera.spec;
  const candidates: { vehicle: Vehicle; full: Box; box: Box; depth: number }[] = [];
  for (const vehicle of vehicles) {
    const full = trueBox(camera, vehicle);
    const centre = camera.project(vehicle.x, vehicle.y, vehicle.height / 2);
    if (full === null || centre === null) {
      continue;
    }
    const box = clip(full, width, height);
    const total = area(full);
    if (total <= 0 || area(box) / total < options.minInFrame) {
      continue;
    }
    candidates.push({ vehicle, full, box, depth: centre.depth });
  }
  candidates.sort((a, b) => a.depth - b.depth);

  const seen: Sighting[] = [];
  candidates.forEach((candidate, index) => {
    if (candidate.box.y2 - candidate.box.y1 < options.minHeightPx) {
      return;
    }
    // Hidden share: what the nearer vehicles cover of this one. Summed rather
    // than unioned, so two nearer vehicles that overlap each other count
    // their shared part twice -- which only ever errs toward hiding.
    let hidden = 0;
    for (let nearer = 0; nearer < index; nearer += 1) {
      hidden += intersection(candidate.full, (candidates[nearer] as { full: Box }).full);
    }
    for (const structure of structures) {
      if (structure.depth < candidate.depth) {
        hidden += intersection(candidate.full, structure.box);
      }
    }
    if (hidden / area(candidate.full) > options.hiddenAbove) {
      return;
    }
    seen.push({ vehicle: candidate.vehicle, box: candidate.box, depth: candidate.depth });
  });
  return seen;
}

/** This frame's detections: the sightings, minus the misses, with noise on
 * every box and a confidence that falls with size. */
export function detect(
  camera: Camera,
  vehicles: readonly Vehicle[],
  rng: Random,
  options: DetectorOptions = DETECTOR,
  structures: readonly Occluder[] = [],
): Detection[] {
  const { width, height } = camera.spec;
  const out: Detection[] = [];
  for (const sighting of sightings(camera, vehicles, options, structures)) {
    const { box } = sighting;
    const boxWidth = box.x2 - box.x1;
    const boxHeight = box.y2 - box.y1;
    const missChance = options.missRate + Math.max(0, (24 - boxHeight) / 24) * 0.25;
    if (rng.next() < missChance) {
      continue;
    }
    const noisy = clip(
      {
        x1: box.x1 + rng.normal() * options.jitter * boxWidth,
        y1: box.y1 + rng.normal() * options.jitter * boxHeight,
        x2: box.x2 + rng.normal() * options.jitter * boxWidth,
        y2: box.y2 + rng.normal() * options.jitter * boxHeight,
      },
      width,
      height,
    );
    if (noisy.x2 - noisy.x1 < 2 || noisy.y2 - noisy.y1 < 2) {
      continue;
    }
    const score = Math.min(
      0.97,
      Math.max(0.15, 0.42 + 0.53 * Math.min(1, boxHeight / 64) + rng.normal() * 0.02),
    );
    const [classId, className] = COCO_CLASS[sighting.vehicle.kind];
    out.push({ ...noisy, score, classId, className });
  }
  return out;
}
