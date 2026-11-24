// Dead reckoning from the phone's motion sensors, in an earth frame so the way
// the phone is held doesn't matter.
//
// Each `devicemotion` sample (linear acceleration, gravity removed, in the
// phone's own axes) is rotated into east/north/up using the latest
// `deviceorientation` (the OS's fusion of gyro, gravity and compass), then
// integrated twice. Double integration drifts quickly, so whenever the phone
// is held still for a moment the velocity is reset to zero and the
// accelerometer bias is re-estimated (a "zero-velocity update").
//
// Android reports an absolute (compass-referenced) alpha. iOS reports alpha
// relative to an arbitrary heading, plus `webkitCompassHeading`; the offset
// between them is tracked while the phone is roughly flat. Without either,
// x and y are still consistent within a session, just not aligned to north.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type HeadingSource = 'compass' | 'relative';

export interface MotionStatus {
  /** Metres from where tracking started: x east, y north, z up. */
  position: Vec3;
  /** True while the phone is being held still (velocity is pinned to zero). */
  stationary: boolean;
  /** Motion samples per second, averaged over the last second. */
  sampleRate: number;
  heading: HeadingSource;
}

const G = 9.80665;
const DEG = Math.PI / 180;

// Zero-velocity detection: linear acceleration and rotation rate both below
// these for STILL_MS counts as held still.
const STILL_ACCEL = 0.25; // m/s²
const STILL_ROTATION = 15; // °/s
const STILL_MS = 300;
// How quickly the bias estimate follows the readings while still.
const BIAS_SMOOTHING = 0.05;
// How quickly the iOS compass offset follows the compass.
const HEADING_SMOOTHING = 0.05;
// Gaps longer than this (e.g. the app was backgrounded) aren't integrated.
const MAX_STEP_S = 0.2;

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

// iOS WebKit additions, missing from TS's DOM types.
interface IOSOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}
type PermissionRequester = { requestPermission?: () => Promise<'granted' | 'denied'> };

/**
 * Asks for motion and orientation access where the platform requires it (iOS
 * Safari; Capacitor's iOS web view grants it without a prompt). Must be called
 * from a user gesture.
 */
export async function requestMotionPermission(): Promise<boolean> {
  for (const api of [DeviceMotionEvent, DeviceOrientationEvent] as PermissionRequester[]) {
    if (typeof api?.requestPermission === 'function') {
      if ((await api.requestPermission()) !== 'granted') return false;
    }
  }
  return typeof DeviceMotionEvent !== 'undefined';
}

/** Rotation matrix, row-major, taking phone axes to east/north/up (W3C DeviceOrientation). */
function rotation(alpha: number, beta: number, gamma: number): number[] {
  const cA = Math.cos(alpha * DEG), sA = Math.sin(alpha * DEG);
  const cB = Math.cos(beta * DEG), sB = Math.sin(beta * DEG);
  const cG = Math.cos(gamma * DEG), sG = Math.sin(gamma * DEG);
  return [
    cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG,
    sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG,
    -cB * sG, sB, cB * cG,
  ];
}

function apply(r: number[], v: Vec3): Vec3 {
  return {
    x: r[0] * v.x + r[1] * v.y + r[2] * v.z,
    y: r[3] * v.x + r[4] * v.y + r[5] * v.z,
    z: r[6] * v.x + r[7] * v.y + r[8] * v.z,
  };
}

const length = (v: Vec3) => Math.hypot(v.x, v.y, v.z);

/** Wraps an angle in degrees into (-180, 180]. */
function wrap(deg: number): number {
  const d = ((deg % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

export class MotionTracker {
  /** Called on every motion sample while tracking. */
  onUpdate: ((s: MotionStatus) => void) | null = null;

  private running = false;
  private orientation: { alpha: number; beta: number; gamma: number } | null = null;
  private absolute = false;
  // iOS only: absolute alpha minus reported alpha, once the compass has been seen.
  private headingOffset: number | null = null;

  private lastTime: number | null = null;
  private lastAccel: Vec3 = ZERO;
  private velocity: Vec3 = ZERO;
  private pos: Vec3 = ZERO;
  private bias: Vec3 = ZERO;
  private stillSince: number | null = null;
  private stationary = false;
  private sampleTimes: number[] = [];

  private readonly onMotion = (e: DeviceMotionEvent) => this.handleMotion(e);
  private readonly onOrientation = (e: DeviceOrientationEvent) => this.handleOrientation(e);
  private readonly orientationEvent =
    'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';

  get isRunning(): boolean {
    return this.running;
  }

  /** Starts tracking with the current position as the origin. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = null;
    this.lastAccel = ZERO;
    this.velocity = ZERO;
    this.pos = ZERO;
    this.stillSince = null;
    this.stationary = false;
    this.sampleTimes = [];
    window.addEventListener(this.orientationEvent, this.onOrientation as EventListener);
    window.addEventListener('devicemotion', this.onMotion);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    window.removeEventListener(this.orientationEvent, this.onOrientation as EventListener);
    window.removeEventListener('devicemotion', this.onMotion);
  }

  /** Metres from where tracking started: x east, y north, z up. */
  get position(): Vec3 {
    return { ...this.pos };
  }

  /** True once at least one motion sample has arrived since start(). */
  get hasSamples(): boolean {
    return this.lastTime != null;
  }

  private handleOrientation(e: DeviceOrientationEvent) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    this.absolute = e.absolute || e.type === 'deviceorientationabsolute';
    this.orientation = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };

    const compass = (e as IOSOrientationEvent).webkitCompassHeading;
    // The compass heading is the direction of the phone's top edge, which is
    // only meaningful while the phone is roughly flat.
    if (!this.absolute && compass != null && compass >= 0 &&
        Math.abs(e.beta) < 45 && Math.abs(e.gamma) < 45) {
      // Compass heading is clockwise from north; alpha is counter-clockwise.
      const offset = wrap(360 - compass - e.alpha);
      this.headingOffset = this.headingOffset == null
        ? offset
        : wrap(this.headingOffset + HEADING_SMOOTHING * wrap(offset - this.headingOffset));
    }
  }

  private handleMotion(e: DeviceMotionEvent) {
    const now = e.timeStamp;
    const o = this.orientation;
    if (!o) return;
    const r = rotation(o.alpha + (this.absolute ? 0 : this.headingOffset ?? 0), o.beta, o.gamma);

    // Linear acceleration in the phone's axes, bias removed. Fall back to
    // removing gravity ourselves where the platform doesn't separate it.
    let raw: Vec3;
    if (e.acceleration?.x != null && e.acceleration.y != null && e.acceleration.z != null) {
      raw = { x: e.acceleration.x, y: e.acceleration.y, z: e.acceleration.z };
    } else {
      const ig = e.accelerationIncludingGravity;
      if (ig?.x == null || ig.y == null || ig.z == null) return;
      // Gravity in phone axes: the transpose of r applied to (0, 0, g).
      raw = { x: ig.x - r[6] * G, y: ig.y - r[7] * G, z: ig.z - r[8] * G };
    }
    const local = { x: raw.x - this.bias.x, y: raw.y - this.bias.y, z: raw.z - this.bias.z };
    const accel = apply(r, local);

    const rr = e.rotationRate;
    const spin = rr ? Math.hypot(rr.alpha ?? 0, rr.beta ?? 0, rr.gamma ?? 0) : 0;
    if (length(accel) < STILL_ACCEL && spin < STILL_ROTATION) {
      this.stillSince ??= now;
    } else {
      this.stillSince = null;
    }
    this.stationary = this.stillSince != null && now - this.stillSince >= STILL_MS;

    if (this.stationary) {
      this.velocity = ZERO;
      this.bias = {
        x: this.bias.x + BIAS_SMOOTHING * (raw.x - this.bias.x),
        y: this.bias.y + BIAS_SMOOTHING * (raw.y - this.bias.y),
        z: this.bias.z + BIAS_SMOOTHING * (raw.z - this.bias.z),
      };
    } else if (this.lastTime != null) {
      const dt = (now - this.lastTime) / 1000;
      if (dt > 0 && dt <= MAX_STEP_S) {
        // Trapezoidal integration, acceleration → velocity → position.
        const v0 = this.velocity;
        const v1 = {
          x: v0.x + 0.5 * (this.lastAccel.x + accel.x) * dt,
          y: v0.y + 0.5 * (this.lastAccel.y + accel.y) * dt,
          z: v0.z + 0.5 * (this.lastAccel.z + accel.z) * dt,
        };
        this.pos = {
          x: this.pos.x + 0.5 * (v0.x + v1.x) * dt,
          y: this.pos.y + 0.5 * (v0.y + v1.y) * dt,
          z: this.pos.z + 0.5 * (v0.z + v1.z) * dt,
        };
        this.velocity = v1;
      }
    }
    this.lastTime = now;
    this.lastAccel = accel;

    this.sampleTimes.push(now);
    while (this.sampleTimes[0] < now - 1000) this.sampleTimes.shift();

    this.onUpdate?.({
      position: this.position,
      stationary: this.stationary,
      sampleRate: this.sampleTimes.length,
      heading: this.absolute || this.headingOffset != null ? 'compass' : 'relative',
    });
  }
}
