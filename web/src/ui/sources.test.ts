/** What the source list promises about each thing the page can count, and how
 * the simulation's entry fits the simulation it describes. */

import { describe, expect, test } from "vitest";

import { Camera } from "../sim/camera";
import { COCO_CLASS } from "../sim/detector";
import { STEP_S } from "../sim/simulation";
import { LANES, LANE_WIDTH_M, ROAD_HALF_M } from "../sim/traffic";
import { SOURCES, keepClassesOf, sourceById } from "./sources";

describe("SOURCES", () => {
  test("opens on the simulation, which needs nothing downloaded to start", () => {
    expect(SOURCES[0]?.kind).toBe("simulation");
    expect(SOURCES[0]?.url).toBeNull();
  });

  test("puts every line inside its own frame", () => {
    for (const source of SOURCES) {
      for (const point of [source.gate.start, source.gate.end]) {
        for (const value of point) {
          expect(value, source.id).toBeGreaterThanOrEqual(0);
          expect(value, source.id).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test("claims a calibration on none of them, so no speed is ever shown", () => {
    expect(SOURCES.every((source) => !source.calibrated)).toBe(true);
  });
});

describe("the simulation's entry", () => {
  const source = sourceById("simulation");

  test("steps the tracker at the simulation's own frame rate", () => {
    // The pipeline is built with this rate; the simulation steps at STEP_S.
    // If they drifted apart, the tracker's memory in frames would no longer
    // be the memory in seconds it was given.
    expect(source.fps).toBeCloseTo(1 / STEP_S, 9);
  });

  test("counts exactly the classes the stand-in detector reports", () => {
    const counted = keepClassesOf(source);
    for (const [id, name] of Object.values(COCO_CLASS)) {
      expect(counted.get(id), name).toBe(name);
    }
    expect(counted.size).toBe(Object.keys(COCO_CLASS).length);
  });

  test("draws its line across all six lanes, and no further than the road", () => {
    const camera = new Camera();
    const { width, height } = camera.spec;
    const start = camera.groundAt(source.gate.start[0] * width, source.gate.start[1] * height);
    const end = camera.groundAt(source.gate.end[0] * width, source.gate.end[1] * height);
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    const outerLane = Math.max(...LANES.map((lane) => Math.abs(lane.x))) + LANE_WIDTH_M / 2;
    expect(start?.x).toBeLessThan(-outerLane);
    expect(end?.x).toBeGreaterThan(outerLane);
    expect(start?.x).toBeGreaterThanOrEqual(-ROAD_HALF_M);
    expect(end?.x).toBeLessThanOrEqual(ROAD_HALF_M);
  });
});
