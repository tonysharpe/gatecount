/** The simulated motorway: six lanes, two carriageways, and the vehicles on
 * them.
 *
 * Traffic arrives in each lane as a Poisson stream, keeps to its lane, and
 * follows the vehicle in front with the Intelligent Driver Model, so it bunches
 * and brakes the way real traffic does instead of sliding along at constant
 * speed. Vehicles coming toward the camera use the left carriageway, as on a
 * German motorway seen from a bridge; vehicles driving away use the right one.
 * Slow lanes are on the outside of each carriageway, and that is where the
 * lorries are.
 *
 * Nothing here knows about pixels. The camera projects it, the synthetic
 * detector turns it into boxes, and the renderer draws it. */

import { Random } from "./random";

export type VehicleKind = "car" | "truck" | "bus" | "motorcycle";

export type LanePosition = "inner" | "middle" | "outer";

export interface Lane {
  readonly index: number;
  /** Centre line, metres from the middle of the road. */
  readonly x: number;
  /** +1 drives away from the camera (y grows), -1 comes toward it. */
  readonly direction: 1 | -1;
  readonly position: LanePosition;
}

export const LANE_WIDTH_M = 3.75;
/** Half the central reservation, barrier included. */
export const MEDIAN_HALF_M = 1.6;
export const SHOULDER_M = 3;
/** Outer edge of the paved road, either side. */
export const ROAD_HALF_M = MEDIAN_HALF_M + 3 * LANE_WIDTH_M + SHOULDER_M;

const POSITIONS: readonly LanePosition[] = ["inner", "middle", "outer"];

export const LANES: readonly Lane[] = [-1, 1].flatMap((side) =>
  POSITIONS.map((position, slot) => ({
    index: (side < 0 ? 0 : 3) + slot,
    x: side * (MEDIAN_HALF_M + LANE_WIDTH_M * (slot + 0.5)),
    direction: (side < 0 ? -1 : 1) as 1 | -1,
    position,
  })),
);

/** Where vehicles enter and leave, in metres along the road. Toward traffic
 * appears far out, near the horizon; away traffic comes out from under the
 * bridge the camera stands on. */
export const FAR_Y = 640;
export const NEAR_Y = -8;

export interface Vehicle {
  readonly id: number;
  readonly kind: VehicleKind;
  readonly lane: Lane;
  /** Lateral position: the lane's centre and the driver's own offset. */
  readonly x: number;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  /** Index into the renderer's paint list. */
  readonly paint: number;
  /** The speed this driver would hold on an empty road, in m/s. */
  readonly desired: number;
  /** Centre of the vehicle along the road. */
  y: number;
  /** `y` one step ago: which way, and how far, the last step moved it. */
  previousY: number;
  speed: number;
  braking: boolean;
}

export type Density = "light" | "busy" | "rush";

export const DENSITIES: readonly Density[] = ["light", "busy", "rush"];

interface DensitySpec {
  /** Arrivals per lane per second. */
  readonly rate: number;
  /** Multiplies every driver's desired speed. */
  readonly speed: number;
}

export const DENSITY: Readonly<Record<Density, DensitySpec>> = {
  light: { rate: 0.055, speed: 1 },
  busy: { rate: 0.18, speed: 0.95 },
  rush: { rate: 0.26, speed: 0.58 },
};

/** Which vehicles use which lane: the outer lane carries the lorries. */
const MIX: Readonly<Record<LanePosition, readonly (readonly [VehicleKind, number])[]>> = {
  inner: [
    ["car", 0.96],
    ["motorcycle", 0.03],
    ["truck", 0.01],
  ],
  middle: [
    ["car", 0.85],
    ["truck", 0.1],
    ["bus", 0.03],
    ["motorcycle", 0.02],
  ],
  outer: [
    ["car", 0.55],
    ["truck", 0.38],
    ["bus", 0.06],
    ["motorcycle", 0.01],
  ],
};

/** Free-flow speed by lane, m/s: about 128, 113 and 95 km/h. */
const LANE_SPEED: Readonly<Record<LanePosition, number>> = {
  inner: 35.5,
  middle: 31.5,
  outer: 26.5,
};

/** Heavy vehicles are limited whatever lane they are in. */
const KIND_LIMIT: Readonly<Record<VehicleKind, number>> = {
  car: Infinity,
  motorcycle: Infinity,
  truck: 23.5,
  bus: 26,
};

interface BodySpec {
  readonly length: readonly [number, number];
  readonly width: number;
  readonly height: number;
}

export const BODY: Readonly<Record<VehicleKind, BodySpec>> = {
  car: { length: [4.1, 4.9], width: 1.82, height: 1.45 },
  truck: { length: [12.5, 16.5], width: 2.55, height: 3.9 },
  bus: { length: [12, 12.4], width: 2.55, height: 3.2 },
  motorcycle: { length: [2.1, 2.2], width: 0.8, height: 1.4 },
};

/** How many paints the renderer has to choose from. */
export const PAINTS = 9;

// The Intelligent Driver Model (Treiber, Hennecke and Helbing, 2000).
const IDM_ACCEL = 1.4;
const IDM_BRAKE = 2.5;
const IDM_MIN_GAP = 4;
const IDM_HEADWAY = 1.3;
const HARD_BRAKE = 8;
const FREE_ROAD_BRAKE = 2;

export class Traffic {
  readonly vehicles: Vehicle[] = [];
  /** Seconds since the simulation began, warm-up included. */
  time = 0;

  private readonly rng: Random;
  private density: Density;
  private nextId = 1;
  private readonly arrivals: number[];

  constructor(seed: number, density: Density = "busy") {
    this.rng = new Random(seed);
    this.density = density;
    this.arrivals = LANES.map(() => this.rng.exponential(DENSITY[density].rate));
  }

  get currentDensity(): Density {
    return this.density;
  }

  /** Change how busy the road is. Arrivals already scheduled keep their time;
   * the next ones follow the new rate. */
  setDensity(density: Density): void {
    this.density = density;
  }

  /** Run with nobody watching until the road has filled up in both
   * directions, so the first frame anyone sees is mid-flow. */
  warm(seconds: number, dt: number): void {
    const steps = Math.round(seconds / dt);
    for (let index = 0; index < steps; index += 1) {
      this.step(dt);
    }
  }

  step(dt: number): void {
    for (const vehicle of this.vehicles) {
      vehicle.previousY = vehicle.y;
    }
    for (const lane of LANES) {
      this.drive(lane, dt);
    }
    for (let index = this.vehicles.length - 1; index >= 0; index -= 1) {
      const vehicle = this.vehicles[index] as Vehicle;
      if (vehicle.y < NEAR_Y - 6 || vehicle.y > FAR_Y + 40) {
        this.vehicles.splice(index, 1);
      }
    }
    this.time += dt;
    this.arrive();
  }

  /** The vehicles in a lane, the one furthest along its direction first. */
  inLane(lane: Lane): Vehicle[] {
    return this.vehicles
      .filter((vehicle) => vehicle.lane === lane)
      .sort((a, b) => lane.direction * (b.y - a.y));
  }

  private drive(lane: Lane, dt: number): void {
    const queue = this.inLane(lane);
    const factor = DENSITY[this.density].speed;
    queue.forEach((vehicle, place) => {
      const leader = place === 0 ? null : (queue[place - 1] as Vehicle);
      const v0 = vehicle.desired * factor;
      // Free-road term, floored at a comfortable deceleration: when the road
      // turns to rush hour, drivers slow down; they do not stamp on the brake.
      let accel = Math.max(-FREE_ROAD_BRAKE, IDM_ACCEL * (1 - (vehicle.speed / v0) ** 4));
      if (leader !== null) {
        const gap = Math.max(
          0.1,
          lane.direction * (leader.y - vehicle.y) - (leader.length + vehicle.length) / 2,
        );
        const closing = vehicle.speed - leader.speed;
        const wanted =
          IDM_MIN_GAP +
          Math.max(0, vehicle.speed * IDM_HEADWAY + (vehicle.speed * closing) / (2 * Math.sqrt(IDM_ACCEL * IDM_BRAKE)));
        accel -= IDM_ACCEL * (wanted / gap) ** 2;
      }
      accel = Math.max(-HARD_BRAKE, accel);
      vehicle.braking = accel < -1;
      vehicle.speed = Math.max(0, vehicle.speed + accel * dt);
      vehicle.y += lane.direction * vehicle.speed * dt;
    });
  }

  private arrive(): void {
    const spec = DENSITY[this.density];
    LANES.forEach((lane, index) => {
      if (this.time < (this.arrivals[index] as number)) {
        return;
      }
      const entry = lane.direction > 0 ? NEAR_Y : FAR_Y;
      const kind = this.rng.weighted(MIX[lane.position]);
      const body = BODY[kind];
      const length = this.rng.range(body.length[0], body.length[1]);
      const desired =
        Math.min(LANE_SPEED[lane.position], KIND_LIMIT[kind]) * this.rng.range(0.92, 1.08);

      // The last vehicle to have entered this lane is the one nearest the
      // entry point. A newcomer waits until it can join behind it at a safe
      // distance, and joins no faster than it is going.
      const queue = this.inLane(lane);
      const last = queue[queue.length - 1];
      let speed = desired * spec.speed;
      if (last !== undefined) {
        const gap = lane.direction * (last.y - entry) - (last.length + length) / 2;
        speed = Math.min(speed, last.speed);
        if (gap < IDM_MIN_GAP + speed * IDM_HEADWAY * 1.2) {
          // Try again a moment later rather than dropping the arrival.
          this.arrivals[index] = this.time + 0.4;
          return;
        }
      }

      this.vehicles.push({
        id: this.nextId,
        kind,
        lane,
        x: lane.x + this.rng.range(-0.22, 0.22),
        length,
        width: body.width,
        height: body.height,
        paint: Math.floor(this.rng.next() * PAINTS),
        desired,
        y: entry,
        previousY: entry,
        speed,
        braking: false,
      });
      this.nextId += 1;
      this.arrivals[index] = this.time + this.rng.exponential(spec.rate);
    });
  }
}
