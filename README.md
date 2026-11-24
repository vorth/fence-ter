# Fence Jobs

A Capacitor app (iOS + Android) for recording fencing jobs: each job gets a
time and GPS location when it is created, and a set of terminals (measured
points) joined by runs, measured with the phone's camera and motion sensors
(ARKit or ARCore).

## Setup

```sh
npm install
npm run build
npx cap sync
```

- **iOS**: `npx cap open ios`, then run the **App** scheme on a device from Xcode.
- **Android**: `npx cap open android`, then run from Android Studio.
- **Browser**: `npm run dev`. Jobs live in memory only and vanish on reload;
  measuring needs a phone's motion sensors.

After changing anything in `src/`, run `npm run build && npx cap copy`.

## Using it

1. Tap **New Job**, enter a name and notes, and tap **Create**. The job is
   stamped with the current time and GPS position. Tap the name later to edit
   them.
2. Every job starts with one terminal, **t0**, its origin. Stand at a terminal
   with the phone and tap it in the drawing: the camera starts and measuring
   begins there.
3. Walk to the next point and tap **Add terminal**. It records a terminal and
   keeps measuring from it, so you can carry on along the fence.
4. Tap **Finish run** to record the last terminal and stop, or **Cancel** to
   stop without recording.

To branch, stand at any earlier terminal and tap it. Each terminal stores its
X (east), Y (north) and Z (up) position in feet from t0, and which terminal
it was measured from; run lengths are worked out from those. The phone can be
held any way up.

Measuring uses ARKit (iPhone) or ARCore (Android): the live camera appears
at the top of the job screen, and tracking works best when the camera sees
textured ground, posts or plants. The status line is green when tracking is
good, amber when it's limited, and red when it isn't ready (taps are ignored
until it is). On Android, ARCore needs Google Play Services for AR (the app
offers to install it), and finds north from the compass during the first
few seconds: keep the camera tilted up from straight down until the line
turns green. Phones without AR use the motion sensors alone, which are not
accurate.

## Permissions

- Location (when in use) — `NSLocationWhenInUseUsageDescription` in
  `ios/App/App/Info.plist`; `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`
  in `android/app/src/main/AndroidManifest.xml`.
- Camera (for AR) — `NSCameraUsageDescription` in `Info.plist`; `CAMERA` in
  `AndroidManifest.xml`, requested the first time measuring starts.
- Motion sensors need no permission inside the app.

## Data

Stored on the device in a SQLite database named `jobs`
(`@capacitor-community/sqlite`). Schema is in `src/db.ts`. Until the first
release the schema is edited in place, so delete and reinstall the app after
a schema change.
