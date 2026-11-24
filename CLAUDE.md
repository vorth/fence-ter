# Fence Jobs

Mobile app (Capacitor 8, iOS + Android) that keeps a record of fencing
**jobs**. Each job has a title, the time and GPS location where it was
created, and a series of **measurements**: X/Y/Z displacements in decimal
feet, each relative to the previous point. Measured with ARKit (iOS) or
ARCore (Android), camera + motion sensors; phones without either fall back
to motion-sensor dead reckoning, which the user found far too inaccurate.
Stored locally in SQLite. Early prototype; no users.

The storage architecture follows the user's `../capacitor-poc` (CheckrSpot)
app; look there for precedents (native plugins, keyboard handling, printing,
export) before inventing new patterns. [README.md](README.md) is for humans;
keep it in sync.

## Workflow

- **Git is the user's alone.** Never run a git command that changes the
  repository (no commit, add, mv, rm, branch, stash, reset, push…). Rename
  or delete files with plain filesystem operations and leave staging to the
  user. Read-only `git status` / `git diff` / `git log` are fine.

- After every change to `src/`, `index.html` or config, run
  `npm run build && npx cap copy`. Adding or removing a native plugin needs
  `npx cap sync` instead.
- `npm run build` runs `tsc` first, so it doubles as the type check. No tests
  or linter yet.
- iOS compile check without a device:
  `xcodebuild -project ios/App/App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO`.
  Android: `cd android && ./gradlew assembleDebug`. Don't boot simulators;
  the user tests on their own phone.

## Stack

- Vanilla TypeScript + Vite 8, no framework. TypeScript 6. `vite.config.ts`
  targets `es2020`/`chrome91`/`safari15` (old platform WebViews).
- Vite is pinned to 8.2.0, and Rolldown and its darwin-arm64 binding to 1.2.1
  (`overrides` in `package.json`), the versions `capacitor-poc` uses. Vite
  8.3.8 with Rolldown 1.2.19 and binding 1.3.3 emitted broken JS
  (`import(...),[]<hash>)` where preload deps belong), which fails to parse
  at startup on iOS. Don't upgrade without checking each built chunk with
  `jsc -e "checkModuleSyntax(read('<file>'))"`.
- Capacitor 8, iOS via Swift Package Manager (new plugins must ship a
  `Package.swift`). Plugins: `@capacitor-community/sqlite`,
  `@capacitor/geolocation`, `@capacitor/app` (Android back button).
- AR via the app's own `ARTracker` plugin, same JS interface on both
  platforms (`start`/`setFrame`/`stop`/`getPosition`/`isSupported`, events
  `pose` and `error`):
  - iOS: `ios/App/App/ARTrackerPlugin.swift`, which also holds
    `AppViewController`, the `CAPBridgeViewController` subclass that
    registers it (`SceneDelegate` uses it as root). Added to
    `project.pbxproj` by hand (no synchronized folders). Camera usage string
    in `Info.plist`; ARKit is not a required device capability.
  - Android: `android/app/src/main/java/org/vorthmann/fencejobs/ARTrackerPlugin.java`,
    registered in `MainActivity`. `com.google.ar:core` 1.57.0 in
    `app/build.gradle`; manifest has `CAMERA`, `camera.ar` not required,
    and `com.google.ar.core` meta-data `optional` (AR Optional: the app
    installs everywhere; `start` asks to install Google Play Services for AR
    via `requestInstall` and rejects until it's there).
- Motion sensors via the web `devicemotion` / `deviceorientation` events, no
  plugin. Capacitor's iOS web view grants motion permission itself
  (`WebViewDelegationHandler`), so there is no prompt.

## Files

- `src/main.ts` — all UI: one `app.innerHTML` template (job list, + button,
  job `<dialog class="screen">`), then plain DOM code.
- `src/db.ts` — `Job`, `Measurement`, `JobsStore` interface, schema, SQLite
  store (native) and in-memory stub (web, `npm run dev`).
- `src/tracker.ts` — `Tracker` interface (`start`/`stop`/`status`,
  `onUpdate`/`onError`; positions in metres east/north/up from the start),
  `SensorTracker` (wraps `MotionTracker`) and `createTracker` (AR if
  supported, else sensors).
- `src/arTracker.ts` — `ARCameraTracker`, `arSupported` and the `ARTracker`
  plugin interface.
- `src/motion.ts` — `MotionTracker` (dead reckoning) and
  `requestMotionPermission`.
- `src/drawing.ts` — `drawJob(svg, measurements, live)`: the plan view.
- `src/style.css` — light/dark themes via CSS variables, iOS-like look.

## Data model

- `jobs`: `id`, `title` (the job's *name* in the UI; null → shown as
  "Job <id>"), `description` (null when blank), `created_at` (epoch ms of
  the Create tap), `latitude`, `longitude`, `accuracy`, `altitude` (all
  nullable: the job is still created when there's no fix). `Job.totalLength`
  (sum of run lengths, decimal feet) is computed in TS in `getJobs`, not
  SQL, since SQLite's `sqrt` isn't available on every platform.
- `measurements`: `id`, `job_id`, `session`, `dx`, `dy`, `dz` (decimal feet;
  x east, y north, z up), `recorded_at`. Each Measure session starts from a
  new origin, so a session's first point is not relative to the previous
  session's last.
- **Terms (the user's):** a *run* is one measurement, the segment from the
  previous point, labelled "rN" in measured order. A *terminal* is any
  endpoint of any run, labelled "tN": t1 is the start, so rN goes from tN
  to tN+1. A new session's start is drawn at the previous end, so it is the
  same terminal (no extra number).
- **Schema policy before first release:** edit the version-1 statements in
  place, keep `DB_VERSION = 1`, and tell the user to reinstall.

## Behaviour

- **List**: newest first; each row shows only the name, the date (no time)
  and the total run length in feet and inches.
- **Swipe to delete**: each `li` holds a `.row-delete` button (white trash
  on a red circle, 88 px wide) under a sliding `.row-content`. Pointer
  events on the list: after 8 px the drag's direction is decided; vertical
  ones are left to scroll (`touch-action: pan-y`), horizontal ones capture
  the pointer and move the content (resisting past −88 px). Released past
  halfway it stays open (`openRow`), else closes. One open row at a time;
  any other tap closes it without opening the job, and the click after a
  drag is ignored (`suppressClick`, expiring after 400 ms). The trash
  confirms, like Delete on the job screen.
- **New Job** (a full-width button, not "+") opens a dialog with Name and
  Description (separate fields; return in Name moves to Description, since
  it would otherwise submit via the first button, Cancel). Create takes the
  time, waits up to 15 s for a high-accuracy fix (button reads "Finding
  location…"), inserts, and opens the job. The same dialog, titled Edit Job
  with Save, opens when the job's name or description is tapped on its
  screen.
- **Job screen** slides in from the right; ‹ Jobs, Escape or Android back
  close it. Under the name, one `<details>` toggle ("Details", collapsed
  each time a job is opened) holds the date and time, the coordinates and
  the description (no label of its own; "Add a description", muted, when
  blank). Tapping the name or the description opens the Edit Job dialog,
  focused on that field. Delete confirms.
- **Measure button**: first tap starts the tracker (origin); each tap records
  the displacement since the previous point; a long press (600 ms) ends.
  Pointer events, not click, so a long press isn't also a tap. Backgrounding
  the app ends measuring. A live line shows distance since the last point and
  the tracker's `detail`, coloured by quality (`data-quality`): `good`,
  `limited` (recorded with a warning in the hint) or `lost` (tap refused,
  "Can't record yet"). The sensor tracker reports still as good, moving as
  limited.
- **AR tracking, iOS (ARKit)**: `.gravityAndHeading`, so ARKit's +x/−z/+y are
  east/north/up (converted natively). A new session per Measure start; its
  world origin is the phone's position then, so `lastPoint` starts at zero.
  The camera is an `ARSCNView` added to the web view (Capacitor's root view),
  so it sits above the page and doesn't scroll; it covers `#camera`, a 40%
  slot between the job screen's bar and its scrolling body, shown only while
  measuring, re-sent on resize. HTML can't draw over it. Poses stream at
  15 Hz (`pose`); `getPosition` reads the current frame when recording.
  Initializing and relocalizing count as lost.
- **AR tracking, Android (ARCore)**: a `GLSurfaceView` (`setZOrderOnTop`)
  added to the web view's parent and positioned with `setX`/`setY` in
  physical px (CSS px × density); the plugin draws the camera texture
  itself (external OES texture, `transformCoordinates2d` to crop). Session
  per Measure start; the first tracking pose is the origin. ARCore has y up
  but arbitrary heading, so north comes from `TYPE_ROTATION_VECTOR`: while
  the camera's view direction is ≥ 0.3 horizontal, (compass heading −
  ARCore heading) of that direction is averaged over 45 samples, then
  fixed, so earlier points don't shift; until then poses are `limited`
  ("Finding north — tilt the camera up"). PAUSED → lost, with the failure
  reason. GL-thread events are posted to the main thread before
  `notifyListeners`. `handleOnPause` tears the session down; JS also stops
  on the App plugin's `pause` event. Compass headings are magnetic, not
  corrected for declination.
- **Drawing** (there is no table): square SVG plan view between the job
  info and the run detail panel, north up until rotated, X/Y only (Z isn't
  drawn). Auto-fits all points (never tighter than 10 ft across) with a
  round-number grid named in the caption. Runs are lines labelled "rN" at
  their midpoints; terminals are small dots labelled "tN" up and to the
  right. Both labels share one style (`.label`, with a card-coloured halo
  that must stay `vector-effect: non-scaling-stroke`, or it is drawn in feet
  and becomes a large blob). Sessions are chained: each starts where the
  last ended, since their true offset is unknown. While measuring, a dashed green segment runs from
  the last point to the tracker's current position, redrawn at most once
  per animation frame. Two-finger pinch pans, zooms and rotates
  (`enablePinch`, touch events; the `View` is centre + span + angle, drawn
  as a rotated group in a zero-centred viewBox, with labels counter-rotated
  and a north arrow top left; `touch-action: pan-y` leaves one finger to
  scroll the screen) and stops auto-fit until Fit (north up again) is tapped
  or the job is reopened. The screen body's cards are `flex: none`; letting
  them shrink clipped the drawing.
- **Units shown**: lengths are stored and computed in decimal feet but
  **never displayed** that way (the user's rule): everything on screen,
  including the live line and grid caption, uses `feetInches` (12′ 4¼″).
- **Job header** shows the total 3D length of all runs, in the run-length
  style, with "Total of N runs" under it.
- **Run detail**: tapping the drawing selects the nearest run within 24 px
  (`runAt`, geometric, not SVG hit-testing), highlighted in accent along
  with its two terminals' labels; tapping away clears it. The panel's
  heading is "r3 · t3 → t4". Recording a point selects the new run. The panel shows
  the run's 3D length in feet and inches to the nearest ¼″, then level
  length and rise/fall when it rises or falls ¼″ or more, and a
  surveyor's bearing (N 45° E).
- **Sensor tracker**: rotates linear acceleration into east/north/up with the
  W3C orientation matrix, integrates twice (trapezoidal), and pins velocity
  to zero and re-estimates accelerometer bias while the phone is still
  (< 0.25 m/s² and < 15°/s for 300 ms). Android gives absolute alpha
  (`deviceorientationabsolute`); on iOS the offset to `webkitCompassHeading`
  is tracked while the phone is roughly flat. Drift grows with the square of
  time moving, so it is unusable beyond a second or two.
- Errors are shown with `alert()`.
