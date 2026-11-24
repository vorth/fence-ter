// What the Measure button needs from a position source, and the choice of
// source: ARKit or ARCore (camera + motion sensors) where available,
// otherwise dead reckoning from the motion sensors alone, which drifts badly
// (see motion.ts).

import { ARCameraTracker, arSupported } from './arTracker';
import { MotionTracker, requestMotionPermission, type Vec3 } from './motion';

export type { Vec3 };

/** `good`; `limited` (usable, less accurate); `lost` (don't record a point). */
export type TrackingQuality = 'good' | 'limited' | 'lost';

export interface TrackerStatus {
  /** Metres from where tracking started: x east, y north, z up. */
  position: Vec3;
  quality: TrackingQuality;
  /** A few words for the live status line. */
  detail: string;
}

export interface Tracker {
  /** Shown while starting, e.g. "camera". */
  readonly startingLabel: string;
  /** Called with each new status while running. */
  onUpdate: ((s: TrackerStatus) => void) | null;
  /** Called if tracking fails while running. */
  onError: ((message: string) => void) | null;
  /** Starts tracking with the phone's current position as the origin. Must be called from a tap. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The latest status, or null before the first reading. */
  status(): Promise<TrackerStatus | null>;
}

// If no motion samples have arrived this long after starting, give up.
const SENSOR_CHECK_MS = 1500;

/** The motion-sensor tracker behind the Tracker interface. */
class SensorTracker implements Tracker {
  readonly startingLabel = 'sensors';
  onUpdate: ((s: TrackerStatus) => void) | null = null;
  onError: ((message: string) => void) | null = null;

  private motion = new MotionTracker();
  private latest: TrackerStatus | null = null;
  private sensorCheck: number | undefined;

  constructor() {
    this.motion.onUpdate = (s) => {
      // Held still is when a reading is least wrong.
      this.latest = {
        position: s.position,
        quality: s.stationary ? 'good' : 'limited',
        detail: `${s.stationary ? 'still' : 'moving'} · ${s.sampleRate} Hz · ` +
          (s.heading === 'compass' ? 'compass' : 'no compass'),
      };
      this.onUpdate?.(this.latest);
    };
  }

  async start(): Promise<void> {
    if (!(await requestMotionPermission())) {
      throw new Error('Motion sensors aren’t available.');
    }
    this.latest = null;
    this.motion.start();
    this.sensorCheck = window.setTimeout(() => {
      if (this.motion.isRunning && !this.motion.hasSamples) {
        this.onError?.('No readings from the motion sensors.');
      }
    }, SENSOR_CHECK_MS);
  }

  async stop(): Promise<void> {
    clearTimeout(this.sensorCheck);
    this.motion.stop();
  }

  async status(): Promise<TrackerStatus | null> {
    return this.latest;
  }
}

/** ARKit or ARCore on phones that support them; the motion sensors everywhere else. */
export async function createTracker(camera: HTMLElement): Promise<Tracker> {
  return (await arSupported()) ? new ARCameraTracker(camera) : new SensorTracker();
}
