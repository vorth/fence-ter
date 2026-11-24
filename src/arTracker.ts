import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Tracker, TrackerStatus, TrackingQuality } from './tracker';

/** A camera pose from the native plugin: metres east (x), north (y), up (z). */
interface Pose {
  x: number;
  y: number;
  z: number;
  quality: TrackingQuality;
  detail: string;
}

/** Where to show the camera, in CSS pixels from the web view's top left. */
interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The app's own native plugin, with the same interface on both platforms:
 * `ARTrackerPlugin.swift` (ARKit world tracking aligned to gravity and
 * compass heading) and `ARTrackerPlugin.java` (ARCore, with north from the
 * compass). Either shows the live camera in a native view over part of the
 * page.
 */
interface ARTrackerPlugin {
  isSupported(): Promise<{ supported: boolean }>;
  start(frame: Frame): Promise<void>;
  setFrame(frame: Frame): Promise<void>;
  stop(): Promise<void>;
  /** An empty object before the first camera frame. */
  getPosition(): Promise<Partial<Pose>>;
  addListener(event: 'pose', fn: (p: Pose) => void): Promise<PluginListenerHandle>;
  addListener(event: 'error', fn: (e: { message: string }) => void): Promise<PluginListenerHandle>;
}

const ARTracker = registerPlugin<ARTrackerPlugin>('ARTracker');

/** True on phones with ARKit (iOS) or ARCore (Android, possibly not yet installed). */
export async function arSupported(): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('ARTracker')) return false;
  try {
    return (await ARTracker.isSupported()).supported;
  } catch {
    return false;
  }
}

const toStatus = (p: Pose): TrackerStatus => ({
  position: { x: p.x, y: p.y, z: p.z },
  quality: p.quality,
  detail: p.detail,
});

/**
 * Tracks with ARKit or ARCore, showing the camera over `camera`: an element that is
 * hidden except while tracking, outside any scrolling container (the native
 * view doesn't follow page scrolling).
 */
export class ARCameraTracker implements Tracker {
  readonly startingLabel = 'camera';
  onUpdate: ((s: TrackerStatus) => void) | null = null;
  onError: ((message: string) => void) | null = null;

  private handles: PluginListenerHandle[] = [];
  private observer: ResizeObserver | null = null;
  private readonly onResize = () => void ARTracker.setFrame(this.frame());

  private readonly camera: HTMLElement;

  constructor(camera: HTMLElement) {
    this.camera = camera;
  }

  private frame(): Frame {
    const r = this.camera.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  async start(): Promise<void> {
    this.camera.hidden = false;
    // Let the page lay out around the camera slot before measuring it.
    await new Promise(requestAnimationFrame);
    try {
      this.handles = await Promise.all([
        ARTracker.addListener('pose', (p) => this.onUpdate?.(toStatus(p))),
        ARTracker.addListener('error', (e) => this.onError?.(e.message)),
      ]);
      await ARTracker.start(this.frame());
    } catch (err) {
      await this.stop();
      throw err;
    }
    this.observer = new ResizeObserver(this.onResize);
    this.observer.observe(this.camera);
    window.addEventListener('resize', this.onResize);
  }

  async stop(): Promise<void> {
    this.observer?.disconnect();
    this.observer = null;
    window.removeEventListener('resize', this.onResize);
    await Promise.all(this.handles.map((h) => h.remove()));
    this.handles = [];
    this.camera.hidden = true;
    await ARTracker.stop();
  }

  async status(): Promise<TrackerStatus | null> {
    const p = await ARTracker.getPosition();
    return p.quality ? toStatus(p as Pose) : null;
  }
}
