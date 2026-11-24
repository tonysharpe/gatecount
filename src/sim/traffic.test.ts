/** The simulated road behaves like a road: traffic keeps to its side and its
 * lane, never drives through the vehicle in front, gets busier when asked to,
 * and is the same traffic every time for the same seed. */

import { describe, expect, test } from "vitest";

import { DENSITY, FAR_Y, LANES, NEAR_Y, ROAD_HALF_M, Traffic } from "./traffic";
import type { Density, Vehicle } from "./traffic";

const STEP = 1 / 30;

function run(seed: number, seconds: number, density: Density = "busy"): Traffic {
  const traffic = new Traffic(seed, density);
  traffic.warm(seconds, STEP);
  return traffic;
}

describe("the road", () => {
  test("has three lanes each way, toward the camera on the left", () => {
    expect(LANES).toHaveLength(6);
    const toward = LANES.filter((lane) => lane.direction === -1);
    const away = LANES.filter((lane) => lane.direction === 1);
    expect(toward.every((lane) => lane.x < 0)).toBe(true);
    expect(away.every((lane) => lane.x > 0)).toBe(true);
    // The slow lane is the outer one on each carriageway.
    for (const side of [toward, away]) {
      const outer = side.find((lane) => lane.position === "outer");
      expect(Math.abs(outer?.x ?? 0)).toBe(Math.max(...side.map((lane) => Math.abs(lane.x))));
    }
    expect(Math.max(...LANES.map((lane) => Math.abs(lane.x)))).toBeLessThan(ROAD_HALF_M);
  });
});

describe("Traffic", () => {
  test("is the same traffic for the same seed, and different for another", () => {
    const summary = (traffic: Traffic): string =>
      traffic.vehicles.map((v) => `${v.id}:${v.kind}:${v.lane.index}:${v.y.toFixed(3)}`).join(",");
    expect(summary(run(7, 60))).toBe(summary(run(7, 60)));
    expect(summary(run(7, 60))).not.toBe(summary(run(8, 60)));
  });

  test("fills both carriageways once it has run a while", () => {
    const traffic = run(3, 40);
    const near = (v: Vehicle): boolean => v.y > 0 && v.y < 250;
    expect(traffic.vehicles.filter((v) => v.lane.direction === -1 && near(v)).length).toBeGreaterThan(3);
    expect(traffic.vehicles.filter((v) => v.lane.direction === 1 && near(v)).length).toBeGreaterThan(3);
  });

  test("moves every vehicle the way its lane goes, and never backwards", () => {
    const traffic = run(11, 30);
    for (let step = 0; step < 300; step += 1) {
      traffic.step(STEP);
      for (const vehicle of traffic.vehicles) {
        if (vehicle.previousY === vehicle.y) {
          continue;
        }
        expect(Math.sign(vehicle.y - vehicle.previousY)).toBe(vehicle.lane.direction);
      }
    }
  });

  test("never lets a vehicle run into the one in front", { timeout: 60_000 }, () => {
    for (const density of ["light", "busy", "rush"] as const) {
      const traffic = run(5, 30, density);
      for (let step = 0; step < 900; step += 1) {
        traffic.step(STEP);
        for (const lane of LANES) {
          const queue = traffic.inLane(lane);
          for (let index = 1; index < queue.length; index += 1) {
            const leader = queue[index - 1] as Vehicle;
            const follower = queue[index] as Vehicle;
            const gap =
              lane.direction * (leader.y - follower.y) - (leader.length + follower.length) / 2;
            expect(gap, `${density}: lane ${lane.index}`).toBeGreaterThan(0.5);
          }
        }
      }
    }
  });

  test("keeps every vehicle on the stretch of road between its two ends", () => {
    const traffic = run(13, 120, "rush");
    for (const vehicle of traffic.vehicles) {
      expect(vehicle.y).toBeGreaterThanOrEqual(NEAR_Y - 6);
      expect(vehicle.y).toBeLessThanOrEqual(FAR_Y + 40);
    }
  });

  test("gets busier when asked to", { timeout: 60_000 }, () => {
    const arrivals = (density: Density): number => {
      const traffic = new Traffic(21, density);
      traffic.warm(180, STEP);
      // Ids are handed out in arrival order, so the last id is the count.
      return Math.max(0, ...traffic.vehicles.map((vehicle) => vehicle.id));
    };
    const light = arrivals("light");
    const busy = arrivals("busy");
    const rush = arrivals("rush");
    expect(light).toBeLessThan(busy);
    expect(busy).toBeLessThan(rush);
    // Close to the stated rate: six lanes for 180 s, within a fifth either way.
    const expected = DENSITY.busy.rate * 6 * 180;
    expect(busy).toBeGreaterThan(expected * 0.8);
    expect(busy).toBeLessThan(expected * 1.2);
  });

  test("slows down for rush hour", () => {
    const meanSpeed = (density: Density): number => {
      const traffic = run(17, 60, density);
      const moving = traffic.vehicles.filter((v) => v.y > 0 && v.y < FAR_Y);
      return moving.reduce((sum, v) => sum + v.speed, 0) / moving.length;
    };
    expect(meanSpeed("rush")).toBeLessThan(meanSpeed("busy") * 0.75);
  });
});
