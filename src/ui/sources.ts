/** The four things the control room can point at, and what is true about each.
 *
 * Every field here is a claim the interface will make, so the honest ones are
 * the important ones. The first is a simulation and says so: its vehicles and
 * their boxes are generated in the tab, and only the tracking and counting are
 * the engine's. The other three are pixels, read by the detector.
 *
 * `calibrated` is false on all four and that is not an
 * omission: no camera reachable from this page has an independent along-road
 * survey, so the engine returns `null` for every speed and the interface shows
 * none rather than a pixel-derived guess. The motorway clip is
 * the case worth naming -- a lane-marking survey exists for it, but its
 * along-road scale rests on an assumed 18 m dash period with no independent
 * corroboration, so no km/h figure derived from that clip appears anywhere on
 * this page. The simulation's geometry is known exactly, and it still shows no
 * speed: the page reports speed only where the engine can, and the engine
 * here is given no road plane.
 *
 * `speedLimitKmh` is null for the same family of reasons. A limit sign is
 * visible on the median of the motorway clip and its digits are not legible at
 * this resolution, so there is no posted limit to compare against; a limit here
 * would be user-set, and the interface would have to say so. */

import type { Point } from "../engine/geometry";

export interface GateSpec {
  readonly name: string;
  /** Normalized [0, 1] coordinates against the source's own frame. */
  readonly start: Point;
  readonly end: Point;
  readonly labelPositive: string;
  readonly labelNegative: string;
  readonly expectedDirection: string | null;
}

export interface SourceSpec {
  readonly id: string;
  readonly label: string;
  /** `simulation` draws its own frames and makes its own boxes; `clip` and
   * `camera` are video, read by the detector. */
  readonly kind: "simulation" | "clip" | "camera";
  /** Relative to the page, so the site works from a project subpath. */
  readonly url: string | null;
  /** Frame rate of the source, used for the detection cadence and the speed
   * estimator's memory bound -- not for any timing the page reports. */
  readonly fps: number;
  readonly classes: readonly (readonly [number, string])[];
  readonly gate: GateSpec;
  readonly calibrated: boolean;
  /** One line under the video saying what the visitor is looking at. */
  readonly caption: string;
}

/** COCO ids, matching the exported graph's class ordering. */
const PERSON = [0, "person"] as const;
const BICYCLE = [1, "bicycle"] as const;
const CAR = [2, "car"] as const;
const MOTORCYCLE = [3, "motorcycle"] as const;
const BUS = [5, "bus"] as const;
const TRUCK = [7, "truck"] as const;

export const SOURCES: readonly SourceSpec[] = [
  {
    id: "simulation",
    label: "Simulation",
    kind: "simulation",
    url: null,
    fps: 60,
    classes: [CAR, MOTORCYCLE, BUS, TRUCK],
    // Across both carriageways, so both directions count: on a road whose
    // traffic is generated there is no deployment to model, and two numbers
    // moving say more than one.
    gate: {
      name: "both",
      start: [0.13, 0.64],
      end: [0.87, 0.64],
      labelPositive: "away",
      labelNegative: "toward",
      expectedDirection: null,
    },
    calibrated: false,
    caption:
      "Simulated night traffic. The vehicles and their boxes are generated here; following and counting them is the same code that runs on the videos.",
  },
  {
    id: "motorway",
    label: "A40 video",
    kind: "clip",
    url: "clips/motorway-a40.mp4",
    fps: 30,
    classes: [CAR, MOTORCYCLE, BUS, TRUCK],
    // The inbound carriageway only. A single gate drawn across both
    // carriageways would count the opposing flow as wrong-way traffic, and the
    // half it leaves out is the useful half of the picture: those vehicles
    // cross the gate's infinite line without ever meeting the segment, which is
    // the difference between a line and a gate, drawn.
    gate: {
      name: "inbound",
      start: [0.06, 0.8],
      end: [0.46, 0.8],
      labelPositive: "away",
      labelNegative: "toward",
      expectedDirection: "toward",
    },
    calibrated: false,
    caption:
      "German A40, filmed from an overpass. The line spans the three lanes coming toward the camera.",
  },
  {
    id: "street",
    label: "Street video",
    kind: "clip",
    url: "clips/street-aisle.mp4",
    fps: 12,
    classes: [PERSON, BICYCLE, CAR],
    gate: {
      name: "aisle",
      start: [0.02, 0.55],
      end: [0.98, 0.55],
      labelPositive: "in",
      labelNegative: "out",
      expectedDirection: null,
    },
    calibrated: false,
    caption: "An open paved area from above. A car, a cyclist and a pedestrian cross the aisle.",
  },
  {
    id: "webcam",
    label: "Your camera",
    kind: "camera",
    url: null,
    fps: 30,
    // Deliberately wider than `configs/webcam.yaml`, which keeps `person` only.
    // That config describes one deployment; this is an arbitrary camera pointed
    // at an unknown scene, and there is no reason to assume it sees only
    // people. The wider set is also what makes the headless captureStream check
    // meaningful -- it counts real crossings rather than passing on an empty
    // scene. A divergence, on purpose, not a config that drifted.
    classes: [PERSON, BICYCLE, CAR, MOTORCYCLE, BUS, TRUCK],
    gate: {
      name: "midline",
      start: [0.0, 0.5],
      end: [1.0, 0.5],
      labelPositive: "in",
      labelNegative: "out",
      expectedDirection: null,
    },
    calibrated: false,
    caption: "Your own camera. Every frame is read, detected and discarded inside this tab.",
  },
];

export function sourceById(id: string): SourceSpec {
  const found = SOURCES.find((source) => source.id === id);
  if (found === undefined) {
    throw new Error(`unknown source ${JSON.stringify(id)}`);
  }
  return found;
}

export function keepClassesOf(source: SourceSpec): Map<number, string> {
  return new Map(source.classes.map(([id, name]) => [id, name]));
}
