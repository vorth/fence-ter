# Fence-ter

Mobile app (Capacitor 8, iOS + Android) that keeps a record of fencing
**jobs**. Each job has a name, description, the time and GPS location where
it was created, and a tree of **terminals**: points with X/Y/Z coordinates
in decimal feet from the job's origin, t0, each but t0 measured from an
earlier terminal (ending a **run** from it). Measured with ARKit (iOS) or
ARCore (Android), camera + motion sensors; phones without either fall back
to motion-sensor dead reckoning, which the user found far too inaccurate.
Stored locally in SQLite. Early prototype; no users.

Formerly "Fence Jobs" (app ID `org.vorthmann.fencejobs`); now app/bundle ID
and Android Java package `org.vorthmann.fenceter`. Only the project
directory keeps the old name.

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
- `tools.sh` (`iphone <udid>` / `ios` / `android <path>`) is the user's
  build-and-deploy script. Don't run any of these commands unasked.

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
  - Android: `android/app/src/main/java/org/vorthmann/fenceter/ARTrackerPlugin.java`,
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
- `src/db.ts` — `Job`, `Terminal`, `Point`, `runLength`, `totalLength`,
  `JobsStore` interface, schema, SQLite store (native) and in-memory stub
  (web, `npm run dev`).
- `src/tracker.ts` — `Tracker` interface (`start`/`stop`/`status`,
  `onUpdate`/`onError`; positions in metres east/north/up from the start),
  `SensorTracker` (wraps `MotionTracker`) and `createTracker` (AR if
  supported, else sensors).
- `src/arTracker.ts` — `ARCameraTracker`, `arSupported` and the `ARTracker`
  plugin interface.
- `src/motion.ts` — `MotionTracker` (dead reckoning) and
  `requestMotionPermission`.
- `src/drawing.ts` — `drawJob(svg, terminals, live, view, selected)`: the
  plan view; `hitTest` (terminal or run under a tap); `enablePinch`.
- `src/style.css` — light/dark themes via CSS variables, iOS-like look.

## Data model

- `jobs`: `id`, `title` (the job's *name* in the UI; null → shown as
  "Job <id>"), `description` (null when blank), `created_at` (epoch ms of
  the Create tap), `latitude`, `longitude`, `accuracy`, `altitude` (all
  nullable: the job is still created when there's no fix). `Job.totalLength`
  (sum of run lengths, decimal feet) is computed in TS in `getJobs`, not
  SQL, since SQLite's `sqrt` isn't available on every platform.
- `terminals`: `id`, `job_id`, `idx` (zero-based within the job, in
  creation order), `start` (the `idx` measured from; null only for idx 0),
  `x`, `y`, `z` (decimal feet from the origin: east, north, up; cumulative,
  not displacements), `recorded_at`. UNIQUE (job_id, idx); CHECKs that only
  idx 0 has a null start and that start < idx. **No lengths are stored**
  (the user's rule): run lengths and totals are computed from coordinates
  when shown. `insertJob` also creates t0 at (0, 0, 0) with the job's time;
  it is a real row so it can later carry tags, a description or a label.
- **Terms (the user's):** a *terminal* is a measured point, "tN" by its
  index; t0 is the origin. Every other terminal ends a *run* from its start
  terminal, named after the terminal it ends at ("r5" goes t2 → t5 if t5's
  start is 2). Measuring from an earlier terminal makes a branch.
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
  Notes (separate fields, Notes 18 rows tall, at most half the screen;
  stored as `description`; return in Name moves to Notes, since
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
- **Measuring** (no Measure button, no long press): tapping a terminal in
  the drawing starts the camera and a tracker session at once; the phone is
  assumed to be at that terminal (`sessionStart`), and tracker positions
  (metres from the session start) become job coordinates via `toJob`.
  Taps on terminals are ignored while measuring. The footer then shows
  **Add terminal** (green; records a terminal at the phone's position with
  `start` = the run's start terminal, then keeps measuring from the new
  one), **Finish run** (blue, below; records, then ends the session) and a
  Cancel text button (ends without recording; earlier terminals stay).
  `recording` guards double taps. The hint reads "Measuring from tN"; when
  idle it tells the user to stand at a terminal and tap it. Backgrounding
  the app ends measuring. A live line shows the distance from the run's
  start terminal and the tracker's `detail`, coloured by quality
  (`data-quality`): `good`, `limited` (recorded with a warning in the hint)
  or `lost` (refused, "Can't record yet"). The sensor tracker reports still
  as good, moving as limited.
- **AR tracking, iOS (ARKit)**: `.gravityAndHeading`, so ARKit's +x/−z/+y are
  east/north/up (converted natively). A new session per measuring start;
  its world origin is the phone's position then, i.e. the tapped terminal.
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
  per measuring start; the first tracking pose is the origin. ARCore has y up
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
  drawn); always shown, since every job has t0. Auto-fits all terminals
  (never tighter than 10 ft across) with a round-number grid named in the
  caption. Runs are lines from start to end terminal labelled "rN" at their
  midpoints; terminals are dots labelled "tN" up and to the right; the
  run's start terminal is green while measuring. Both labels share one style (`.label`, with a card-coloured halo
  that must stay `vector-effect: non-scaling-stroke`, or it is drawn in feet
  and becomes a large blob). While measuring, a dashed green segment runs
  from the run's start terminal to the tracker's current position, redrawn
  at most once per animation frame. Two-finger pinch pans, zooms and rotates
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
- **Taps on the drawing** (`hitTest`, geometric, not SVG hit-testing): the
  nearest terminal within 30 px wins (and starts measuring); otherwise the
  nearest run within 24 px is selected, highlighted in accent with its two
  terminals' labels; tapping empty space clears it.
- **Run detail**: heading "r5 · t2 → t5". Recording a terminal selects its
  run. The panel shows
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
