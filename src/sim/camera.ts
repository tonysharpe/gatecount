/** The simulated camera: a pinhole on an overpass, looking down the motorway.
 *
 * The world frame is the one `trafficlens.bench.simulate` uses for the speed
 * benchmark: `x` metres across the road (right positive), `y` metres along it
 * away from the camera, `z` metres up from the road surface. The camera sits at
 * `(0, 0, heightM)` looking along +y, pitched down by `pitchDeg`.
 *
 * The frame is 960 x 540, the size of the motorway clip the engine's tracking
 * constants were tuned on, so the tracker sees boxes of the sizes and speeds it
 * meets on real footage. */

export interface CameraSpec {
  readonly width: number;
  readonly height: number;
  readonly focalPx: number;
  readonly heightM: number;
  readonly pitchDeg: number;
}

export const CAMERA: CameraSpec = {
  width: 960,
  height: 540,
  focalPx: 800,
  heightM: 9,
  pitchDeg: 9.6,
};

/** A world point on screen: pixel position and depth along the optical axis. */
export interface Projected {
  readonly u: number;
  readonly v: number;
  readonly depth: number;
}

/** Closer than this to the lens a point is not drawn: the projection blows up
 * long before it reaches zero, and nothing on the road comes that close. */
export const NEAR_M = 0.5;

export class Camera {
  readonly spec: CameraSpec;
  private readonly sin: number;
  private readonly cos: number;
  private readonly cx: number;
  private readonly cy: number;

  constructor(spec: CameraSpec = CAMERA) {
    this.spec = spec;
    const pitch = (spec.pitchDeg * Math.PI) / 180;
    this.sin = Math.sin(pitch);
    this.cos = Math.cos(pitch);
    this.cx = spec.width / 2;
    this.cy = spec.height / 2;
  }

  /** Where a world point lands on the frame, or null behind the lens. Points
   * outside the frame still project; clipping is the caller's business. */
  project(x: number, y: number, z: number): Projected | null {
    const dz = z - this.spec.heightM;
    const down = -this.sin * y - this.cos * dz;
    const depth = this.cos * y - this.sin * dz;
    if (depth <= NEAR_M) {
      return null;
    }
    return {
      u: this.cx + (this.spec.focalPx * x) / depth,
      v: this.cy + (this.spec.focalPx * down) / depth,
      depth,
    };
  }

  /** The image row of the horizon: where the road plane ends at infinity. */
  get horizonV(): number {
    return this.cy - this.spec.focalPx * (this.sin / this.cos);
  }

  /** Pixels per metre for something standing at this depth. */
  scaleAt(depth: number): number {
    return this.spec.focalPx / depth;
  }

  /** The road point under an image pixel, or null at or above the horizon. */
  groundAt(u: number, v: number): { readonly x: number; readonly y: number } | null {
    const ray = (v - this.cy) / this.spec.focalPx;
    // On the road dz = -H, so down = cos*H - sin*y and depth = cos*y + sin*H;
    // setting down / depth = ray and solving for y gives the line below.
    const h = this.spec.heightM;
    const denominator = this.sin + ray * this.cos;
    if (denominator <= 1e-9) {
      return null;
    }
    const y = (h * (this.cos - ray * this.sin)) / denominator;
    const depth = this.cos * y + this.sin * h;
    return { x: ((u - this.cx) * depth) / this.spec.focalPx, y };
  }
}
