/** The simulated motorway as the live demo runs it: traffic, the camera over
 * it, and the stand-in detector, advanced on a fixed clock.
 *
 * The step is 1/60 s whatever the display's refresh rate. Fixed, because the
 * tracker counts in frames: a 120 Hz screen must not hand it twice as many
 * frames, each half as far apart, as a 60 Hz one -- the counts would then
 * depend on the visitor's monitor. Sixty rather than the motorway clip's
 * thirty, because the tracker only matches boxes that overlap by an IoU of at
 * least 0.8 from one frame to the next, and a car at motorway speed this close
 * to the camera moves too far in a thirtieth of a second to keep that overlap;
 * `simulation.test.ts` is where that shows. A frame drawn between two steps
 * shows the latest one. */

import type { Detection } from "../engine/tracker";
import { Camera } from "./camera";
import { DETECTOR, detect } from "./detector";
import type { Occluder } from "./detector";
import { Random } from "./random";
import { structureBoxes } from "./structures";
import { Traffic } from "./traffic";
import type { Density } from "./traffic";

export const STEP_S = 1 / 60;

/** Seconds the road runs before anyone sees it, so the first frame is
 * mid-flow in both directions rather than an empty motorway filling up. */
export const WARM_S = 26;

/** The traffic a visitor first sees. Any seed gives a working road; a fixed
 * one means every visit, and every test, starts from the same scene. */
export const SEED = 2026;

/** The most wall time one call may turn into steps. After a stall -- a
 * background tab, a breakpoint -- the road resumes where it was rather than
 * fast-forwarding through everything that would have happened meanwhile. */
const MAX_CATCH_UP_S = 0.25;

export class Simulation {
  readonly camera: Camera;
  readonly traffic: Traffic;
  /** Simulated seconds since the session began, warm-up excluded. */
  clock = 0;

  private readonly noise: Random;
  private readonly structures: readonly Occluder[];
  private carry = 0;

  constructor(seed: number = SEED, density: Density = "busy") {
    this.camera = new Camera();
    this.traffic = new Traffic(seed, density);
    this.traffic.warm(WARM_S, STEP_S);
    // The detector draws from its own stream, so changing how the boxes wobble
    // never changes which vehicles turn up.
    this.noise = new Random(seed ^ 0x9e3779b9);
    this.structures = structureBoxes(this.camera);
  }

  /** Turn `elapsed` seconds of wall time into steps, calling `onStep` with
   * each step's detections and clock, oldest first. */
  advance(elapsed: number, onStep: (detections: Detection[], clock: number) => void): void {
    this.carry += Math.min(Math.max(0, elapsed), MAX_CATCH_UP_S);
    while (this.carry >= STEP_S) {
      this.carry -= STEP_S;
      this.traffic.step(STEP_S);
      this.clock += STEP_S;
      onStep(detect(this.camera, this.traffic.vehicles, this.noise, DETECTOR, this.structures), this.clock);
    }
  }
}
