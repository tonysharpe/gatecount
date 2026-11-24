/** The simulated camera is a plain pinhole, and the rest of the simulation
 * leans on three of its properties: the road meets the sky on one known row,
 * a pixel below that row names exactly one point on the road, and nearer
 * things are bigger. */

import { describe, expect, test } from "vitest";

import { CAMERA, Camera } from "./camera";

const camera = new Camera();

describe("Camera", () => {
  test("puts the vanishing point of the road on the horizon row, in the middle", () => {
    const far = camera.project(0, 1e9, 0);
    expect(far).not.toBeNull();
    expect(far?.u).toBeCloseTo(CAMERA.width / 2, 6);
    expect(far?.v).toBeCloseTo(camera.horizonV, 4);
    // Between a quarter and a third of the frame is sky: room for the city on
    // the horizon, and most of the picture is road.
    expect(camera.horizonV / CAMERA.height).toBeGreaterThan(0.2);
    expect(camera.horizonV / CAMERA.height).toBeLessThan(0.33);
  });

  test("names the road point under a pixel, the inverse of projecting it", () => {
    for (const [x, y] of [
      [0, 20],
      [-9.5, 35],
      [12, 80],
      [3.5, 250],
    ] as const) {
      const pixel = camera.project(x, y, 0);
      expect(pixel).not.toBeNull();
      const ground = camera.groundAt(pixel?.u ?? 0, pixel?.v ?? 0);
      expect(ground?.x).toBeCloseTo(x, 6);
      expect(ground?.y).toBeCloseTo(y, 6);
    }
  });

  test("has no road point at or above the horizon", () => {
    expect(camera.groundAt(480, camera.horizonV)).toBeNull();
    expect(camera.groundAt(480, camera.horizonV - 40)).toBeNull();
  });

  test("draws a car smaller the further away it is", () => {
    const widthAt = (y: number): number => {
      const left = camera.project(-0.9, y, 0);
      const right = camera.project(0.9, y, 0);
      return (right?.u ?? 0) - (left?.u ?? 0);
    };
    expect(widthAt(20)).toBeGreaterThan(widthAt(40));
    expect(widthAt(40)).toBeGreaterThan(widthAt(160));
    // About 40 px across at the default line, which is where the counting
    // happens: the size of the cars on the motorway clip there.
    expect(widthAt(34)).toBeGreaterThan(35);
    expect(widthAt(34)).toBeLessThan(55);
  });

  test("refuses points behind the lens", () => {
    expect(camera.project(0, -5, 0)).toBeNull();
  });
});
