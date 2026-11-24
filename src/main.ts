import './style.css';
import { App } from '@capacitor/app';
import { Geolocation } from '@capacitor/geolocation';
import { getStore, type Fix, type Job, type JobsStore, type Measurement } from './db';
import { createTracker, type Tracker, type TrackerStatus, type Vec3 } from './tracker';
import { drawJob, enablePinch, runAt, type LiveSegment, type View } from './drawing';

const FEET_PER_METRE = 1 / 0.3048;
const LONG_PRESS_MS = 600;
const GPS_TIMEOUT_MS = 15000;

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <header class="toolbar">
    <h1>Jobs</h1>
  </header>
  <main class="card">
    <ol id="job-list" class="job-list"></ol>
    <p id="empty" class="empty" hidden>No jobs yet. Tap + to start one.</p>
  </main>
  <button id="new-job" type="button" class="fab" aria-label="New job">
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v16M4 12h16" />
    </svg>
  </button>
  <dialog id="job" class="screen" aria-labelledby="job-title">
    <header class="sheet-bar">
      <button id="job-back" type="button" class="text-btn">‹ Jobs</button>
      <h2 id="job-title"></h2>
      <button id="job-delete" type="button" class="text-btn danger">Delete</button>
    </header>
    <div id="camera" class="camera" hidden></div>
    <div class="screen-body">
      <section class="card job-info">
        <button id="job-rename" type="button" class="job-heading"></button>
        <p id="job-time"></p>
        <p id="job-place"></p>
        <p id="job-total" class="run-length"></p>
        <p id="job-total-label" class="units"></p>
      </section>
      <section class="card drawing-card">
        <svg id="drawing" class="drawing" aria-label="Plan view of the measured points"></svg>
        <button id="drawing-fit" type="button" class="fit-btn" hidden>Fit</button>
        <p id="drawing-caption" class="units"></p>
      </section>
      <section class="card run-detail" aria-live="polite">
        <p id="run-empty" class="units">Tap a run in the drawing to see its length.</p>
        <div id="run-info" hidden>
          <h3 id="run-name"></h3>
          <p id="run-length" class="run-length"></p>
          <p id="run-extra" class="units"></p>
        </div>
      </section>
    </div>
    <footer class="measure-bar">
      <p id="live" class="live" hidden></p>
      <button id="measure" type="button" class="measure-btn">Measure</button>
      <p id="measure-hint" class="hint">Tap to set the starting point</p>
    </footer>
  </dialog>
`;

const listEl = document.querySelector<HTMLOListElement>('#job-list')!;
const emptyEl = document.querySelector<HTMLParagraphElement>('#empty')!;
const newJobBtn = document.querySelector<HTMLButtonElement>('#new-job')!;
const jobEl = document.querySelector<HTMLDialogElement>('#job')!;
const cameraEl = document.querySelector<HTMLDivElement>('#camera')!;
const jobTitleEl = document.querySelector<HTMLHeadingElement>('#job-title')!;
const backBtn = document.querySelector<HTMLButtonElement>('#job-back')!;
const deleteBtn = document.querySelector<HTMLButtonElement>('#job-delete')!;
const renameBtn = document.querySelector<HTMLButtonElement>('#job-rename')!;
const timeEl = document.querySelector<HTMLParagraphElement>('#job-time')!;
const placeEl = document.querySelector<HTMLParagraphElement>('#job-place')!;
const totalEl = document.querySelector<HTMLParagraphElement>('#job-total')!;
const totalLabelEl = document.querySelector<HTMLParagraphElement>('#job-total-label')!;
const drawingEl = document.querySelector<SVGSVGElement>('#drawing')!;
const drawingCaptionEl = document.querySelector<HTMLParagraphElement>('#drawing-caption')!;
const fitBtn = document.querySelector<HTMLButtonElement>('#drawing-fit')!;
const runEmptyEl = document.querySelector<HTMLParagraphElement>('#run-empty')!;
const runInfoEl = document.querySelector<HTMLDivElement>('#run-info')!;
const runNameEl = document.querySelector<HTMLHeadingElement>('#run-name')!;
const runLengthEl = document.querySelector<HTMLParagraphElement>('#run-length')!;
const runExtraEl = document.querySelector<HTMLParagraphElement>('#run-extra')!;
const liveEl = document.querySelector<HTMLParagraphElement>('#live')!;
const measureBtn = document.querySelector<HTMLButtonElement>('#measure')!;
const hintEl = document.querySelector<HTMLParagraphElement>('#measure-hint')!;

let store: JobsStore;
let jobs: Job[] = [];
let current: Job | null = null;
let measurements: Measurement[] = [];

// ---------- Formatting ----------

const jobTitle = (j: Job) => j.title ?? `Job ${j.id}`;

const formatTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function formatPlace(j: Job): string {
  if (j.latitude == null || j.longitude == null) return 'Location unavailable';
  const lat = `${Math.abs(j.latitude).toFixed(5)}° ${j.latitude >= 0 ? 'N' : 'S'}`;
  const lng = `${Math.abs(j.longitude).toFixed(5)}° ${j.longitude >= 0 ? 'E' : 'W'}`;
  const acc = j.accuracy != null ? ` ±${Math.round(j.accuracy)} m` : '';
  return `${lat}, ${lng}${acc}`;
}

const distance = (d: { dx: number; dy: number; dz: number }) => Math.hypot(d.dx, d.dy, d.dz);

const FRACTIONS = ['', '¼', '½', '¾'];

/**
 * Feet as feet and inches to the nearest quarter inch, e.g. 12′ 4¼″. Lengths
 * are stored and computed in decimal feet but never shown that way.
 */
function feetInches(feet: number): string {
  const quarters = Math.round(Math.abs(feet) * 48);
  const whole = Math.floor(quarters / 48);
  const rest = quarters - whole * 48;
  const inches = `${Math.floor(rest / 4)}${FRACTIONS[rest % 4]}″`;
  return whole > 0 ? `${whole}′ ${inches}` : inches;
}

/** Surveyor's bearing of a horizontal direction, e.g. N 45° E. */
function bearing(dx: number, dy: number): string {
  const azimuth = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  const fromNorthOrSouth = azimuth <= 90 ? azimuth : azimuth <= 270 ? Math.abs(180 - azimuth) : 360 - azimuth;
  const deg = Math.round(fromNorthOrSouth);
  if (deg === 0) return azimuth > 90 && azimuth < 270 ? 'S' : 'N';
  if (deg === 90) return dx > 0 ? 'E' : 'W';
  return `${azimuth > 90 && azimuth < 270 ? 'S' : 'N'} ${deg}° ${dx > 0 ? 'E' : 'W'}`;
}

// ---------- Job list ----------

function renderList() {
  listEl.replaceChildren(
    ...jobs.map((j) => {
      const li = document.createElement('li');
      li.dataset.id = String(j.id);
      const top = document.createElement('div');
      top.className = 'row-top';
      const title = document.createElement('strong');
      title.textContent = jobTitle(j);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = j.measurementCount === 1 ? '1 run' : `${j.measurementCount} runs`;
      top.append(title, count);
      const sub = document.createElement('div');
      sub.className = 'row-sub';
      sub.textContent = `${formatTime(j.createdAt)} · ${formatPlace(j)}`;
      li.append(top, sub);
      return li;
    }),
  );
  emptyEl.hidden = jobs.length > 0;
}

async function refreshList() {
  jobs = await store.getJobs();
  renderList();
}

listEl.addEventListener('click', (e) => {
  const li = (e.target as Element).closest<HTMLLIElement>('li[data-id]');
  const job = li && jobs.find((j) => j.id === Number(li.dataset.id));
  if (job) openJob(job);
});

async function currentFix(): Promise<Fix | null> {
  try {
    const p = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: GPS_TIMEOUT_MS,
      maximumAge: 0,
    });
    return {
      latitude: p.coords.latitude,
      longitude: p.coords.longitude,
      accuracy: p.coords.accuracy,
      altitude: p.coords.altitude,
    };
  } catch (err) {
    console.warn('No location fix for the new job.', err);
    return null;
  }
}

newJobBtn.addEventListener('click', async () => {
  // The job's time is the moment of the tap; the fix may take a few seconds.
  const createdAt = Date.now();
  newJobBtn.disabled = true;
  newJobBtn.classList.add('busy');
  try {
    const fix = await currentFix();
    const job = await store.insertJob(createdAt, fix);
    await refreshList();
    await openJob(job);
    if (!fix) alert('Couldn’t get a GPS fix, so the job was saved without a location.');
  } catch (err) {
    alert(`Couldn’t create the job: ${err}`);
  } finally {
    newJobBtn.disabled = false;
    newJobBtn.classList.remove('busy');
  }
});

// ---------- Job screen ----------

function renderJob() {
  if (!current) return;
  jobTitleEl.textContent = jobTitle(current);
  renameBtn.textContent = jobTitle(current);
  timeEl.textContent = formatTime(current.createdAt);
  placeEl.textContent = formatPlace(current);
}

// The run shown in the detail panel (an index into measurements), or null.
let selectedRun: number | null = null;

function renderRunDetail() {
  const m = selectedRun != null ? measurements[selectedRun] : undefined;
  runEmptyEl.hidden = !!m;
  runInfoEl.hidden = !m;
  if (!m) return;
  const n = selectedRun! + 1;
  runNameEl.textContent = `r${n} · t${n} → t${n + 1}`;
  runLengthEl.textContent = feetInches(distance(m));
  const level = Math.hypot(m.dx, m.dy);
  const extra: string[] = [];
  if (Math.abs(m.dz) >= 1 / 48) {
    extra.push(`level ${feetInches(level)}`, `${m.dz > 0 ? 'rises' : 'falls'} ${feetInches(m.dz)}`);
  }
  if (level >= 0.05) extra.push(bearing(m.dx, m.dy));
  runExtraEl.textContent = extra.join(' · ');
}

function renderTotal() {
  const total = measurements.reduce((sum, m) => sum + distance(m), 0);
  totalEl.textContent = feetInches(total);
  const n = measurements.length;
  totalLabelEl.textContent = n === 0 ? 'No runs yet' : n === 1 ? 'Total of 1 run' : `Total of ${n} runs`;
}

function renderMeasurements() {
  renderTotal();
  renderRunDetail();
  redraw();
}

// The segment from the last point to where the phone is now; null when not
// measuring. Updated on every motion sample, drawn at most once per frame.
let live: LiveSegment | null = null;
let redrawQueued = false;
// Set by pinching; null means fit all the points (until Fit is tapped).
let pinchedView: View | null = null;
let shownView: View | null = null;

function redraw() {
  const drawn = drawJob(drawingEl, measurements, live, pinchedView, selectedRun);
  shownView = drawn?.view ?? null;
  fitBtn.hidden = !pinchedView || !drawn;
  drawingCaptionEl.textContent = drawn == null
    ? 'The drawing appears when you start measuring.'
    : `Seen from above. Grid ${feetInches(drawn.step)}.`;
}

enablePinch(drawingEl, () => shownView, (v) => {
  pinchedView = v;
  queueRedraw();
});

// Tap a run to show it in the detail panel; tap elsewhere to clear.
drawingEl.addEventListener('click', (e) => {
  if (!shownView) return;
  selectedRun = runAt(drawingEl, measurements, shownView, e.clientX, e.clientY);
  renderMeasurements();
});

fitBtn.addEventListener('click', () => {
  pinchedView = null;
  redraw();
});

function queueRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    redraw();
  });
}

async function openJob(job: Job) {
  current = job;
  measurements = await store.getMeasurements(job.id);
  pinchedView = null;
  selectedRun = null;
  renderJob();
  renderMeasurements();
  showMeasureIdle();
  jobEl.querySelector('.screen-body')!.scrollTop = 0;
  jobEl.showModal();
  // Start from off-screen, so adding .shown slides the screen in.
  void jobEl.offsetWidth;
  jobEl.classList.add('shown');
}

function closeJob() {
  void stopMeasuring();
  jobEl.classList.remove('shown');
  const done = () => {
    if (!jobEl.classList.contains('shown')) jobEl.close();
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
  else jobEl.addEventListener('transitionend', done, { once: true });
  current = null;
  void refreshList();
}

backBtn.addEventListener('click', closeJob);

// Escape on web; Android's back button is handled below.
jobEl.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeJob();
});

App.addListener('backButton', () => {
  if (jobEl.open) closeJob();
  else void App.exitApp();
});

renameBtn.addEventListener('click', async () => {
  if (!current) return;
  const text = prompt('Job title', current.title ?? '');
  if (text == null) return;
  current.title = text.trim() || null;
  await store.setTitle(current.id, current.title);
  renderJob();
});

deleteBtn.addEventListener('click', async () => {
  if (!current) return;
  if (!confirm(`Delete “${jobTitle(current)}” and its measurements?`)) return;
  await store.deleteJob(current.id);
  closeJob();
});

// ---------- Measuring ----------
//
// Tap Measure to start: tracking starts and the phone's position becomes the
// origin. Each later tap records the displacement since the previous point.
// A long press ends measuring.

let tracker: Tracker | null = null;
let measuring = false;
let session = 0;
let lastPoint: Vec3 = { x: 0, y: 0, z: 0 };
let pressTimer: number | undefined;
let hintTimer: number | undefined;

const MEASURING_HINT = 'Tap to record · hold to finish';

function showMeasureIdle() {
  measureBtn.textContent = 'Measure';
  measureBtn.classList.remove('measuring');
  clearTimeout(hintTimer);
  hintEl.textContent = 'Tap to set the starting point';
  liveEl.hidden = true;
}

/** Shows `text` in place of the hint for a couple of seconds. */
function flashHint(text: string) {
  clearTimeout(hintTimer);
  hintEl.textContent = text;
  hintTimer = window.setTimeout(() => {
    if (measuring) hintEl.textContent = MEASURING_HINT;
  }, 2500);
}

function showLive(s: TrackerStatus) {
  if (!measuring) return;
  const d = {
    dx: (s.position.x - lastPoint.x) * FEET_PER_METRE,
    dy: (s.position.y - lastPoint.y) * FEET_PER_METRE,
    dz: (s.position.z - lastPoint.z) * FEET_PER_METRE,
  };
  liveEl.textContent = `${feetInches(distance(d))}  ·  ${s.detail}`;
  liveEl.dataset.quality = s.quality;
  live = { d, newSession: !measurements.some((m) => m.session === session) };
  queueRedraw();
}

async function startMeasuring() {
  if (!current || measuring) return;
  tracker ??= await createTracker(cameraEl);
  tracker.onUpdate = showLive;
  tracker.onError = (message) => {
    void stopMeasuring();
    alert(`Measuring stopped: ${message}`);
  };
  measuring = true;
  session = measurements.reduce((max, m) => Math.max(max, m.session), 0) + 1;
  lastPoint = { x: 0, y: 0, z: 0 };
  live = { d: { dx: 0, dy: 0, dz: 0 }, newSession: true };
  redraw();
  measureBtn.textContent = 'Record point';
  measureBtn.classList.add('measuring');
  hintEl.textContent = MEASURING_HINT;
  liveEl.textContent = `Starting ${tracker.startingLabel}…`;
  delete liveEl.dataset.quality;
  liveEl.hidden = false;
  try {
    await tracker.start();
  } catch (err) {
    measuring = false;
    showMeasureIdle();
    live = null;
    redraw();
    alert(`Measuring can’t start: ${err instanceof Error ? err.message : err}`);
  }
}

async function stopMeasuring() {
  if (!measuring) return;
  measuring = false;
  showMeasureIdle();
  live = null;
  redraw();
  await tracker?.stop();
}

async function recordPoint() {
  if (!current || !tracker) return;
  const s = await tracker.status();
  if (!s || s.quality === 'lost') {
    flashHint(`Can’t record yet: ${s?.detail ?? 'starting'}`);
    return;
  }
  const p = s.position;
  const m = await store.insertMeasurement({
    jobId: current.id,
    session,
    dx: (p.x - lastPoint.x) * FEET_PER_METRE,
    dy: (p.y - lastPoint.y) * FEET_PER_METRE,
    dz: (p.z - lastPoint.z) * FEET_PER_METRE,
    recordedAt: Date.now(),
  });
  lastPoint = p;
  measurements.push(m);
  live = { d: { dx: 0, dy: 0, dz: 0 }, newSession: false };
  // Show the new run's length.
  selectedRun = measurements.length - 1;
  renderMeasurements();
  measureBtn.classList.remove('flash');
  void measureBtn.offsetWidth;
  measureBtn.classList.add('flash');
  if (s.quality === 'limited') flashHint(`Recorded, but ${s.detail.toLowerCase()}`);
}

// Taps and long presses come from pointer events rather than click, so a
// long press can end measuring without also counting as a tap.
measureBtn.addEventListener('pointerdown', (e) => {
  measureBtn.setPointerCapture(e.pointerId);
  pressTimer = window.setTimeout(() => {
    pressTimer = undefined;
    void stopMeasuring();
  }, LONG_PRESS_MS);
});

measureBtn.addEventListener('pointerup', () => {
  if (pressTimer === undefined) return; // Long press already handled.
  clearTimeout(pressTimer);
  pressTimer = undefined;
  if (measuring) void recordPoint();
  else void startMeasuring();
});

measureBtn.addEventListener('pointercancel', () => {
  clearTimeout(pressTimer);
  pressTimer = undefined;
});

measureBtn.addEventListener('contextmenu', (e) => e.preventDefault());

// Stop tracking when the app is backgrounded; no tracker can follow the
// phone while it's suspended. Android's web view doesn't reliably report
// visibility, hence the App plugin's pause event as well.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) void stopMeasuring();
});
App.addListener('pause', () => void stopMeasuring());

// ---------- Startup ----------

async function main() {
  try {
    store = await getStore();
    await refreshList();
  } catch (err) {
    alert(`Couldn’t open the database: ${err}`);
  }
}

void main();
