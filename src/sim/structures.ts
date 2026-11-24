/** The fixed things over the simulated road that a vehicle can pass behind:
 * the overhead gantry, its message sign and its lane signals.
 *
 * Shared by the renderer, which draws them, and the stand-in detector, which
 * must not report a vehicle the camera cannot see -- a lorry behind the sign
 * is hidden from a real detector too, and the tracker then has to carry it
 * across the gap, which is exactly what its coasting rule is for. */

import type { Camera } from "./camera";
import type { Box } from "./detector";
import { LANES, LANE_WIDTH_M, MEDIAN_HALF_M, ROAD_HALF_M } from "./traffic";

/** Distance along the road of the overhead sign gantry. */
export const GANTRY_Y = 58;

/** A flat panel facing the camera, in world metres. */
export interface Panel {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly y: number;
}

export const BEAM: Panel = {
  x0: -(ROAD_HALF_M + 0.7),
  x1: ROAD_HALF_M + 0.7,
  z0: 6.2,
  z1: 7.4,
  y: GANTRY_Y,
};

/** The message sign, over the oncoming carriageway: it faces the drivers
 * coming toward the camera, so the camera reads it too. */
export const SIGN: Panel = {
  x0: -(MEDIAN_HALF_M + 3.2 * LANE_WIDTH_M) + 0.15,
  x1: -(MEDIAN_HALF_M + 0.4) - 0.15,
  z0: 4.2,
  z1: 6.05,
  y: GANTRY_Y - 0.35,
};

/** One signal head over each lane. */
export const SIGNALS: readonly Panel[] = LANES.map((lane) => ({
  x0: lane.x - 0.5,
  x1: lane.x + 0.5,
  z0: 5.1,
  z1: 6.1,
  y: GANTRY_Y - 0.3,
}));

/** Every panel's box on the frame, with its depth, for the detector to test
 * vehicles behind it against. */
export function structureBoxes(camera: Camera): { readonly box: Box; readonly depth: number }[] {
  const out: { box: Box; depth: number }[] = [];
  for (const panel of [BEAM, SIGN, ...SIGNALS]) {
    const a = camera.project(panel.x0, panel.y, panel.z0);
    const b = camera.project(panel.x1, panel.y, panel.z1);
    if (a === null || b === null) {
      continue;
    }
    out.push({
      box: {
        x1: Math.min(a.u, b.u),
        y1: Math.min(a.v, b.v),
        x2: Math.max(a.u, b.u),
        y2: Math.max(a.v, b.v),
      },
      depth: Math.min(a.depth, b.depth),
    });
  }
  return out;
}
