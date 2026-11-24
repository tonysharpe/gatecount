/** The stand-in detector is imperfect on purpose, and in the right ways: it
 * cannot see what is too small or hidden, it never reports a box outside the
 * frame, and its confidence follows size the way a real detector's does --
 * near vehicles can start a track, far ones can only keep one alive. */

import { describe, expect, test } from "vitest";

import { TRACK_HIGH_CONF } from "../generated/constants";
import { Camera } from "./camera";
import { COCO_CLASS, DETECTOR, detect, sightings, trueBox } from "./detector";
import { Random } from "./random";
import { GANTRY_Y, structureBoxes } from "./structures";
import { LANES, Traffic } from "./traffic";
import type { Lane, Vehicle } from "./traffic";

const camera = new Camera();

function car(id: number, lane: Lane, y: number, kind: Vehicle["kind"] = "car"): Vehicle {
  const big = kind === "truck";
  return {
    id,
    kind,
    lane,
    x: lane.x,
    length: big ? 15 : 4.5,
    width: big ? 2.55 : 1.82,
    height: big ? 3.9 : 1.45,
    paint: 0,
    desired: 30,
    y,
    previousY: y,
    speed: 30,
    braking: false,
  };
}

const innerToward = LANES.find((lane) => lane.direction === -1 && lane.position === "inner") as Lane;
const middleToward = LANES.find((lane) => lane.direction === -1 && lane.position === "middle") as Lane;

describe("trueBox", () => {
  test("is smaller further away and gone behind the lens", () => {
    const near = trueBox(camera, car(1, innerToward, 25));
    const far = trueBox(camera, car(2, innerToward, 90));
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    const height = (box: typeof near): number => (box ? box.y2 - box.y1 : 0);
    expect(height(near)).toBeGreaterThan(height(far) * 2);
    expect(trueBox(camera, car(3, innerToward, -3))).toBeNull();
  });
});

describe("sightings", () => {
  test("misses what is too small to see", () => {
    const seen = sightings(camera, [car(1, innerToward, 30), car(2, innerToward, 500)]);
    expect(seen.map((s) => s.vehicle.id)).toEqual([1]);
  });

  test("misses a car hidden behind a lorry, and sees it again once it is not", () => {
    // Both straight down the camera's line of sight, the car 10 m behind the
    // lorry's tail: from 9 m up, a 3.9 m lorry hides the road for 28 m behind
    // it, so the car is out of view.
    const sightline = { ...middleToward, x: 0 };
    const lorry = car(1, sightline, 30, "truck");
    const hidden = car(2, sightline, 47.5);
    const seen = sightings(camera, [lorry, hidden]).map((s) => s.vehicle.id);
    expect(seen).toEqual([1]);
    const alone = sightings(camera, [hidden]).map((s) => s.vehicle.id);
    expect(alone).toEqual([2]);
  });

  test("lists the nearest first and keeps every box inside the frame", () => {
    const traffic = new Traffic(4, "rush");
    traffic.warm(40, 1 / 30);
    const seen = sightings(camera, traffic.vehicles);
    expect(seen.length).toBeGreaterThan(5);
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]?.depth).toBeGreaterThanOrEqual(seen[index - 1]?.depth ?? 0);
    }
    for (const { box } of seen) {
      expect(box.x1).toBeGreaterThanOrEqual(0);
      expect(box.y1).toBeGreaterThanOrEqual(0);
      expect(box.x2).toBeLessThanOrEqual(camera.spec.width);
      expect(box.y2).toBeLessThanOrEqual(camera.spec.height);
      expect(box.y2 - box.y1).toBeGreaterThanOrEqual(DETECTOR.minHeightPx);
    }
  });
});

describe("detect", () => {
  const traffic = new Traffic(9, "busy");
  traffic.warm(45, 1 / 30);

  test("is the same for the same noise seed", () => {
    expect(detect(camera, traffic.vehicles, new Random(1))).toEqual(
      detect(camera, traffic.vehicles, new Random(1)),
    );
  });

  test("reports at most what it can see, inside the frame, in the model's classes", () => {
    const seen = sightings(camera, traffic.vehicles);
    const found = detect(camera, traffic.vehicles, new Random(2));
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(seen.length);
    const classes = new Map(Object.values(COCO_CLASS).map(([id, name]) => [id, name]));
    for (const box of found) {
      expect(box.x1).toBeGreaterThanOrEqual(0);
      expect(box.x2).toBeLessThanOrEqual(camera.spec.width);
      expect(box.y2).toBeLessThanOrEqual(camera.spec.height);
      expect(box.x2).toBeGreaterThan(box.x1);
      expect(box.y2).toBeGreaterThan(box.y1);
      expect(classes.get(box.classId)).toBe(box.className);
    }
  });

  test("is sure enough of a near vehicle to start a track, and not of a far one", () => {
    const rng = new Random(3);
    const scores = (y: number): number[] =>
      Array.from({ length: 40 }, () => detect(camera, [car(1, innerToward, y)], rng))
        .flat()
        .map((box) => box.score);
    const near = scores(30);
    const far = scores(110);
    expect(Math.min(...near)).toBeGreaterThanOrEqual(TRACK_HIGH_CONF);
    expect(far.length).toBeGreaterThan(0);
    expect(Math.max(...far)).toBeLessThan(TRACK_HIGH_CONF);
  });
});

describe("the gantry", () => {
  const structures = structureBoxes(camera);

  test("hides a lorry passing behind its sign, which is then not detected", () => {
    // Somewhere beyond the gantry, an oncoming lorry is visible on an empty
    // road and hidden once the sign is in the way.
    const hiddenAt: number[] = [];
    for (let y = GANTRY_Y + 10; y <= 220; y += 2) {
      const lorry = car(1, middleToward, y, "truck");
      const open = sightings(camera, [lorry]).length;
      const behind = sightings(camera, [lorry], DETECTOR, structures).length;
      if (open === 1 && behind === 0) {
        hiddenAt.push(y);
      }
    }
    expect(hiddenAt.length).toBeGreaterThan(3);
  });

  test("hides nothing in front of it", () => {
    for (const y of [20, 30, 40, GANTRY_Y - 8]) {
      const lorry = car(1, middleToward, y, "truck");
      expect(sightings(camera, [lorry], DETECTOR, structures)).toHaveLength(1);
    }
  });
});
