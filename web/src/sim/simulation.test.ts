/** The simulated motorway, counted by the engine.
 *
 * The simulation knows the truth -- every vehicle's exact box, every frame --
 * so here the tracker and the counter can be scored the way the real clip is
 * scored against hand labels, without the labelling. A crossing in the truth is
 * the counting rule applied to the true boxes: the bottom-centre of a
 * vehicle's box moving across the line between two frames. The engine sees
 * only the stand-in detector's boxes, with their misses, noise and occlusion.
 *
 * What this pins is that the scene on the page is one the engine counts
 * correctly. If the simulation drifted into territory the tracker cannot
 * follow -- vehicles too fast for the frame rate, boxes too small, too much
 * noise -- the demo would show an engine miscounting, and these would fail
 * first. */

import { describe, expect, test } from "vitest";

/** These run minutes of simulated traffic through the engine; on a slow CI
 * runner that is more than the default five seconds. */
const LONG = { timeout: 60_000 };

import { Gate } from "../engine/gate";
import { boxAnchor, crossingDirection, segmentsIntersect } from "../engine/geometry";
import type { Point } from "../engine/geometry";
import { SessionPipeline } from "../engine/pipeline";
import { sourceById } from "../ui/sources";
import { trueBox } from "./detector";
import { SEED, STEP_S, Simulation, WARM_S } from "./simulation";
import type { Density } from "./traffic";

interface Score {
  readonly truth: Record<string, number>;
  readonly counted: Record<string, number>;
  readonly truthTotal: number;
  readonly countedTotal: number;
}

/** Run the page's own source settings for `seconds` and compare the engine's
 * counts with the truth, keyed "<class> <direction>". */
function score(seconds: number, density: Density, seed: number = SEED): Score {
  const source = sourceById("simulation");
  const sim = new Simulation(seed, density);
  const { width, height } = sim.camera.spec;
  const start: Point = [source.gate.start[0] * width, source.gate.start[1] * height];
  const end: Point = [source.gate.end[0] * width, source.gate.end[1] * height];
  const pipeline = new SessionPipeline({
    gates: [
      new Gate(source.gate.name, start, end, {
        labelPositive: source.gate.labelPositive,
        labelNegative: source.gate.labelNegative,
        expectedDirection: source.gate.expectedDirection,
      }),
    ],
    plane: null,
    fps: source.fps,
    speedLimitKmh: null,
  });

  const truth: Record<string, number> = {};
  const previous = new Map<number, Point>();
  // The tracker starts with the session, and a track takes a few frames to be
  // confirmed; a vehicle on the line in the first second was already crossing
  // before there was anything to follow it.
  const settled = Math.round(1 / STEP_S);
  let frame = 0;
  const steps = Math.round(seconds / STEP_S);
  for (let index = 0; index < steps; index += 1) {
    sim.advance(STEP_S + 1e-9, (detections, clock) => {
      pipeline.step(detections, frame, clock);
      frame += 1;
      for (const vehicle of sim.traffic.vehicles) {
        const box = trueBox(sim.camera, vehicle);
        if (box === null) {
          previous.delete(vehicle.id);
          continue;
        }
        const anchor = boxAnchor(box.x1, box.y1, box.x2, box.y2);
        const before = previous.get(vehicle.id);
        if (frame > settled && before !== undefined && segmentsIntersect(before, anchor, start, end)) {
          const side = crossingDirection(start, end, before, anchor);
          if (side !== 0) {
            const direction = side > 0 ? source.gate.labelPositive : source.gate.labelNegative;
            const key = `${vehicle.kind} ${direction}`;
            truth[key] = (truth[key] ?? 0) + 1;
          }
        }
        previous.set(vehicle.id, anchor);
      }
    });
  }

  const counted: Record<string, number> = {};
  const byClass = pipeline.counts()[source.gate.name] ?? {};
  for (const [className, directions] of Object.entries(byClass)) {
    for (const [direction, count] of Object.entries(directions)) {
      counted[`${className} ${direction}`] = count;
    }
  }
  const sum = (record: Record<string, number>): number =>
    Object.values(record).reduce((a, b) => a + b, 0);
  return { truth, counted, truthTotal: sum(truth), countedTotal: sum(counted) };
}

describe("the engine on the simulated motorway", () => {
  test("starts mid-flow, with vehicles already on the road both ways", () => {
    const sim = new Simulation();
    expect(sim.traffic.time).toBeCloseTo(WARM_S, 6);
    const directions = new Set(sim.traffic.vehicles.map((vehicle) => vehicle.lane.direction));
    expect(directions).toEqual(new Set([-1, 1]));
  });

  for (const density of ["light", "busy", "rush"] as const) {
    test(`counts ${density} traffic the way the truth does`, LONG, () => {
      const result = score(150, density);
      // Enough crossings to mean something, in both directions.
      expect(result.truthTotal).toBeGreaterThan(density === "light" ? 25 : 80);
      // Within 4 % overall: a vehicle hidden behind a lorry for the whole of its
      // crossing can be missed, as it would be on real footage. Never more
      // counts than crossings by more than one in fifty, which is the failure
      // that matters most to a counter -- a vehicle counted twice.
      expect(result.countedTotal).toBeGreaterThanOrEqual(Math.floor(result.truthTotal * 0.96));
      expect(result.countedTotal).toBeLessThanOrEqual(Math.ceil(result.truthTotal * 1.02));
      // And class by class, direction by direction, nothing is counted under
      // a name it does not have.
      for (const key of Object.keys(result.counted)) {
        expect(result.truth[key], `counted "${key}" with no such crossing`).toBeGreaterThan(0);
      }
    });
  }

  test("counts both directions, the way they actually went", LONG, () => {
    const result = score(120, "busy");
    const away = Object.entries(result.counted)
      .filter(([key]) => key.endsWith(" away"))
      .reduce((sum, [, count]) => sum + count, 0);
    const toward = result.countedTotal - away;
    expect(away).toBeGreaterThan(20);
    expect(toward).toBeGreaterThan(20);
  });
});
