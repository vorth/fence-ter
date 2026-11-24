import './style.css';
import { App } from '@capacitor/app';
import { Geolocation } from '@capacitor/geolocation';
import {
  getStore,
  runLength,
  totalLength,
  type Fix,
  type Job,
  type JobDetails,
  type JobsStore,
  type Point,
  type Terminal,
} from './db';
import { createTracker, type Tracker, type TrackerStatus } from './tracker';
import { drawJob, enablePinch, hitTest, type LiveRun, type View } from './drawing';

const FEET_PER_METRE = 1 / 0.3048;
const GPS_TIMEOUT_MS = 15000;

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <header class="toolbar">
    <h1>Jobs</h1>
  </header>
  <main class="card">
    <ol id="job-list" class="job-list"></ol>
    <p id="empty" class="empty" hidden>No jobs yet. Tap New Job to start one.</p>
  </main>
  <button id="new-job" type="button" class="new-job-btn">New Job</button>
  <dialog id="job-form" class="form-dialog" aria-labelledby="job-form-title">
    <form method="dialog">
      <h2 id="job-form-title"></h2>
      <label>
        Name
        <input id="job-name" type="text" autocapitalize="words" enterkeyhint="next" />
      </label>
      <label>
        Description
        <textarea id="job-description" rows="4" autocapitalize="sentences"></textarea>
      </label>
      <div class="dialog-actions">
        <button type="submit" value="cancel" class="secondary-btn">Cancel</button>
        <button id="job-form-save" type="submit" value="save"></button>
      </div>
    </form>
  </dialog>
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
        <details id="job-details" class="job-details">
          <summary>Details</summary>
          <p id="job-time"></p>
          <p id="job-place"></p>
          <button id="job-description-text" type="button" class="job-description"></button>
        </details>
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
      <div id="measure-actions" class="measure-actions" hidden>
        <button id="add-terminal" type="button" class="measure-btn">Add terminal</button>
        <button id="finish-run" type="button" class="measure-btn finish">Finish run</button>
        <button id="cancel-measuring" type="button" class="text-btn">Cancel</button>
      </div>
      <p id="measure-hint" class="hint"></p>
    </footer>
  </dialog>
`;

const listEl = document.querySelector<HTMLOListElement>('#job-list')!;
const emptyEl = document.querySelector<HTMLParagraphElement>('#empty')!;
const newJobBtn = document.querySelector<HTMLButtonElement>('#new-job')!;
const jobFormEl = document.querySelector<HTMLDialogElement>('#job-form')!;
const jobFormTitleEl = document.querySelector<HTMLHeadingElement>('#job-form-title')!;
const jobNameIn = document.querySelector<HTMLInputElement>('#job-name')!;
const jobDescriptionIn = document.querySelector<HTMLTextAreaElement>('#job-description')!;
const jobFormSaveBtn = document.querySelector<HTMLButtonElement>('#job-form-save')!;
const jobEl = document.querySelector<HTMLDialogElement>('#job')!;
const cameraEl = document.querySelector<HTMLDivElement>('#camera')!;
const jobTitleEl = document.querySelector<HTMLHeadingElement>('#job-title')!;
const backBtn = document.querySelector<HTMLButtonElement>('#job-back')!;
const deleteBtn = document.querySelector<HTMLButtonElement>('#job-delete')!;
const renameBtn = document.querySelector<HTMLButtonElement>('#job-rename')!;
const timeEl = document.querySelector<HTMLParagraphElement>('#job-time')!;
const placeEl = document.querySelector<HTMLParagraphElement>('#job-place')!;
const detailsEl = document.querySelector<HTMLDetailsElement>('#job-details')!;
const descriptionBtn = document.querySelector<HTMLButtonElement>('#job-description-text')!;
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
const measureActionsEl = document.querySelector<HTMLDivElement>('#measure-actions')!;
const addTerminalBtn = document.querySelector<HTMLButtonElement>('#add-terminal')!;
const finishRunBtn = document.querySelector<HTMLButtonElement>('#finish-run')!;
const cancelMeasuringBtn = document.querySelector<HTMLButtonElement>('#cancel-measuring')!;
const hintEl = document.querySelector<HTMLParagraphElement>('#measure-hint')!;

let store: JobsStore;
let jobs: Job[] = [];
let current: Job | null = null;
/** The open job's terminals, by index. */
let terminals: Terminal[] = [];

// ---------- Formatting ----------

const jobTitle = (j: Job) => j.title ?? `Job ${j.id}`;

const formatDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });

const formatTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function formatPlace(j: Job): string {
  if (j.latitude == null || j.longitude == null) return 'Location unavailable';
  const lat = `${Math.abs(j.latitude).toFixed(5)}° ${j.latitude >= 0 ? 'N' : 'S'}`;
  const lng = `${Math.abs(j.longitude).toFixed(5)}° ${j.longitude >= 0 ? 'E' : 'W'}`;
  const acc = j.accuracy != null ? ` ±${Math.round(j.accuracy)} m` : '';
  return `${lat}, ${lng}${acc}`;
}

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

const TRASH_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>`;

// Each row is a delete button with the row's content over it; dragging the
// content left uncovers the button.
function renderList() {
  openRow = null;
  listEl.replaceChildren(
    ...jobs.map((j) => {
      const li = document.createElement('li');
      li.dataset.id = String(j.id);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'row-delete';
      del.setAttribute('aria-label', `Delete ${jobTitle(j)}`);
      del.innerHTML = `<span class="trash-circle">${TRASH_ICON}</span>`;
      const content = document.createElement('div');
      content.className = 'row-content';
      const top = document.createElement('div');
      top.className = 'row-top';
      const title = document.createElement('strong');
      title.textContent = jobTitle(j);
      const total = document.createElement('span');
      total.className = 'total';
      total.textContent = feetInches(j.totalLength);
      top.append(title, total);
      const sub = document.createElement('div');
      sub.className = 'row-sub';
      sub.textContent = formatDate(j.createdAt);
      content.append(top, sub);
      li.append(del, content);
      return li;
    }),
  );
  emptyEl.hidden = jobs.length > 0;
}

async function refreshList() {
  jobs = await store.getJobs();
  renderList();
}

// ---------- Swipe to delete ----------

// How far an open row slides, uncovering the delete button.
const REVEAL_PX = 88;
// Movement before a touch counts as a drag, in either direction.
const DRAG_SLOP_PX = 8;

/** The content of the row slid open, if any. */
let openRow: HTMLElement | null = null;
let drag: {
  content: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  /** Where the content started: 0, or -REVEAL_PX if it was open. */
  base: number;
  dx: number;
  /** Null until the drag's direction is known; vertical drags scroll the list. */
  horizontal: boolean | null;
} | null = null;
// A drag ends with a click on the row, which mustn't open the job.
let suppressClick = false;

function slide(content: HTMLElement, x: number) {
  content.style.transform = x ? `translateX(${x}px)` : '';
}

function closeRow() {
  if (openRow) slide(openRow, 0);
  openRow = null;
}

listEl.addEventListener('pointerdown', (e) => {
  const content = (e.target as Element).closest<HTMLElement>('.row-content');
  if (!content) return;
  drag = {
    content,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    base: content === openRow ? -REVEAL_PX : 0,
    dx: 0,
    horizontal: null,
  };
});

listEl.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (drag.horizontal === null) {
    if (Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
    drag.horizontal = Math.abs(dx) > Math.abs(dy);
    if (!drag.horizontal) {
      drag = null;
      return;
    }
    if (openRow && openRow !== drag.content) closeRow();
    drag.content.setPointerCapture(e.pointerId);
    drag.content.classList.add('dragging');
  }
  drag.dx = dx;
  // Follows the finger, with resistance past the open position.
  let x = Math.min(0, drag.base + dx);
  if (x < -REVEAL_PX) x = -REVEAL_PX + (x + REVEAL_PX) / 3;
  slide(drag.content, x);
});

function endDrag(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { content, base, dx, horizontal } = drag;
  drag = null;
  if (!horizontal) return;
  content.classList.remove('dragging');
  // Ignore the click that may follow, but not a later tap if none does.
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 400);
  if (base + dx < -REVEAL_PX / 2) {
    slide(content, -REVEAL_PX);
    openRow = content;
  } else {
    slide(content, 0);
    if (openRow === content) openRow = null;
  }
}

listEl.addEventListener('pointerup', endDrag);
listEl.addEventListener('pointercancel', endDrag);

listEl.addEventListener('click', async (e) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const target = e.target as Element;
  const li = target.closest<HTMLLIElement>('li[data-id]');
  const job = li && jobs.find((j) => j.id === Number(li.dataset.id));
  if (target.closest('.row-delete')) {
    if (job && confirm(`Delete “${jobTitle(job)}” and its measurements?`)) {
      await store.deleteJob(job.id);
      await refreshList();
    } else {
      closeRow();
    }
    return;
  }
  // A tap while a row is open just closes it.
  if (openRow) {
    closeRow();
    return;
  }
  if (job) openJob(job);
});

// A tap anywhere else closes an open row too.
document.addEventListener('pointerdown', (e) => {
  if (openRow && !openRow.parentElement!.contains(e.target as Node)) closeRow();
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

/**
 * Asks for a job's name and description, starting from `initial` (a new job
 * when null). Resolves with what was entered, blanks as null, or null if
 * cancelled.
 */
function askJobDetails(
  initial: JobDetails | null,
  focus: 'name' | 'description' = 'name',
): Promise<JobDetails | null> {
  jobFormTitleEl.textContent = initial ? 'Edit Job' : 'New Job';
  jobFormSaveBtn.textContent = initial ? 'Save' : 'Create';
  jobNameIn.value = initial?.title ?? '';
  jobDescriptionIn.value = initial?.description ?? '';
  jobFormEl.returnValue = '';
  jobFormEl.showModal();
  (focus === 'description' ? jobDescriptionIn : jobNameIn).focus();
  return new Promise((resolve) => {
    jobFormEl.addEventListener('close', () => {
      if (jobFormEl.returnValue !== 'save') {
        resolve(null);
        return;
      }
      resolve({
        title: jobNameIn.value.trim() || null,
        description: jobDescriptionIn.value.trim() || null,
      });
    }, { once: true });
  });
}

// Return in the name moves to the description. Otherwise it would submit
// the form through its first button, Cancel.
jobNameIn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    jobDescriptionIn.focus();
  }
});

newJobBtn.addEventListener('click', async () => {
  const details = await askJobDetails(null);
  if (!details) return;
  // The job's time is the moment it's created; the fix may take a few seconds.
  const createdAt = Date.now();
  newJobBtn.disabled = true;
  newJobBtn.classList.add('busy');
  newJobBtn.textContent = 'Finding location…';
  try {
    const fix = await currentFix();
    const job = await store.insertJob(createdAt, fix, details);
    await refreshList();
    await openJob(job);
    if (!fix) alert('Couldn’t get a GPS fix, so the job was saved without a location.');
  } catch (err) {
    alert(`Couldn’t create the job: ${err}`);
  } finally {
    newJobBtn.disabled = false;
    newJobBtn.classList.remove('busy');
    newJobBtn.textContent = 'New Job';
  }
});

// ---------- Job screen ----------

function renderJob() {
  if (!current) return;
  jobTitleEl.textContent = jobTitle(current);
  renameBtn.textContent = jobTitle(current);
  timeEl.textContent = formatTime(current.createdAt);
  placeEl.textContent = formatPlace(current);
  descriptionBtn.textContent = current.description ?? 'Add a description';
  descriptionBtn.classList.toggle('placeholder', !current.description);
}

// The run shown in the detail panel, by the index of the terminal it ends
// at; null for none.
let selectedRun: number | null = null;

function renderRunDetail() {
  const end = selectedRun != null ? terminals[selectedRun] : undefined;
  const start = end?.start != null ? terminals[end.start] : undefined;
  runEmptyEl.hidden = !!start;
  runInfoEl.hidden = !start;
  if (!end || !start) return;
  runNameEl.textContent = `r${end.index} · t${start.index} → t${end.index}`;
  runLengthEl.textContent = feetInches(runLength(start, end));
  const [dx, dy, dz] = [end.x - start.x, end.y - start.y, end.z - start.z];
  const level = Math.hypot(dx, dy);
  const extra: string[] = [];
  if (Math.abs(dz) >= 1 / 48) {
    extra.push(`level ${feetInches(level)}`, `${dz > 0 ? 'rises' : 'falls'} ${feetInches(dz)}`);
  }
  if (level >= 0.05) extra.push(bearing(dx, dy));
  runExtraEl.textContent = extra.join(' · ');
}

function renderTotal() {
  totalEl.textContent = feetInches(totalLength(terminals));
  const n = terminals.length - 1;
  totalLabelEl.textContent = n === 0 ? 'No runs yet' : n === 1 ? 'Total of 1 run' : `Total of ${n} runs`;
}

function renderTerminals() {
  renderTotal();
  renderRunDetail();
  redraw();
}

// The run from its start terminal to where the phone is now; null when not
// measuring. Updated on every tracker sample, drawn at most once per frame.
let live: LiveRun | null = null;
let redrawQueued = false;
// Set by pinching; null means fit all the terminals (until Fit is tapped).
let pinchedView: View | null = null;
let shownView: View | null = null;

function redraw() {
  const drawn = drawJob(drawingEl, terminals, live, pinchedView, selectedRun);
  shownView = drawn.view;
  fitBtn.hidden = !pinchedView;
  drawingCaptionEl.textContent = `Seen from above. Grid ${feetInches(drawn.step)}.`;
}

enablePinch(drawingEl, () => shownView, (v) => {
  pinchedView = v;
  queueRedraw();
});

// Tap a terminal to measure from it, or a run to show it in the detail
// panel; tap elsewhere to clear. Terminals are ignored while measuring.
drawingEl.addEventListener('click', (e) => {
  if (!shownView) return;
  const hit = hitTest(drawingEl, terminals, shownView, e.clientX, e.clientY);
  if (hit?.kind === 'terminal') {
    if (!measuring) void startMeasuring(hit.index);
    return;
  }
  selectedRun = hit?.index ?? null;
  renderRunDetail();
  redraw();
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
  terminals = await store.getTerminals(job.id);
  pinchedView = null;
  selectedRun = null;
  // Details start collapsed each time a job is opened.
  detailsEl.open = false;
  renderJob();
  renderTerminals();
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

// Tapping the name or the description edits both, in the job dialog.
async function editJob(focus: 'name' | 'description') {
  if (!current) return;
  const details = await askJobDetails(current, focus);
  if (!details || !current) return;
  Object.assign(current, details);
  await store.setDetails(current.id, details);
  renderJob();
}

renameBtn.addEventListener('click', () => void editJob('name'));
descriptionBtn.addEventListener('click', () => void editJob('description'));

deleteBtn.addEventListener('click', async () => {
  if (!current) return;
  if (!confirm(`Delete “${jobTitle(current)}” and its measurements?`)) return;
  await store.deleteJob(current.id);
  closeJob();
});

// ---------- Measuring ----------
//
// Tapping a terminal starts a tracking session there: the phone is assumed
// to be at that terminal. Add terminal records a terminal where the phone is
// now, ending a run from the previous one, and keeps measuring from it.
// Finish run does the same and ends the session; Cancel ends it without
// recording.

let tracker: Tracker | null = null;
let measuring = false;
/** The terminal the session started at; tracker positions are relative to it. */
let sessionStart: Point = { x: 0, y: 0, z: 0 };
/** The index of the terminal the current run starts at. */
let runFrom = 0;
// Set while a terminal is being saved, so a double tap records it once.
let recording = false;
let hintTimer: number | undefined;

function idleHint(): string {
  return terminals.length === 1
    ? 'Stand at t0 and tap it in the drawing to start measuring.'
    : 'Stand at a terminal and tap it in the drawing to measure from it.';
}

const measuringHint = () => `Measuring from t${runFrom}`;

function showMeasureIdle() {
  measureActionsEl.hidden = true;
  liveEl.hidden = true;
  clearTimeout(hintTimer);
  hintEl.textContent = idleHint();
}

/** Shows `text` in place of the hint for a couple of seconds. */
function flashHint(text: string) {
  clearTimeout(hintTimer);
  hintEl.textContent = text;
  hintTimer = window.setTimeout(() => {
    hintEl.textContent = measuring ? measuringHint() : idleHint();
  }, 2500);
}

/** Where a tracker position (metres from the session start) is, in feet from the origin. */
function toJob(position: { x: number; y: number; z: number }): Point {
  return {
    x: sessionStart.x + position.x * FEET_PER_METRE,
    y: sessionStart.y + position.y * FEET_PER_METRE,
    z: sessionStart.z + position.z * FEET_PER_METRE,
  };
}

function showLive(s: TrackerStatus) {
  if (!measuring) return;
  const to = toJob(s.position);
  liveEl.textContent = `${feetInches(runLength(terminals[runFrom], to))}  ·  ${s.detail}`;
  liveEl.dataset.quality = s.quality;
  live = { from: runFrom, to };
  queueRedraw();
}

async function startMeasuring(from: number) {
  if (!current || measuring) return;
  tracker ??= await createTracker(cameraEl);
  tracker.onUpdate = showLive;
  tracker.onError = (message) => {
    void stopMeasuring();
    alert(`Measuring stopped: ${message}`);
  };
  measuring = true;
  runFrom = from;
  sessionStart = { x: terminals[from].x, y: terminals[from].y, z: terminals[from].z };
  live = { from, to: sessionStart };
  redraw();
  measureActionsEl.hidden = false;
  hintEl.textContent = measuringHint();
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

/** Records a terminal where the phone is now; then keeps measuring unless `finish`. */
async function recordTerminal(finish: boolean) {
  if (!current || !tracker || !measuring || recording) return;
  recording = true;
  try {
    const s = await tracker.status();
    if (!s || s.quality === 'lost') {
      flashHint(`Can’t record yet: ${s?.detail ?? 'starting'}`);
      return;
    }
    const t = await store.insertTerminal({
      jobId: current.id,
      index: terminals.length,
      start: runFrom,
      ...toJob(s.position),
      recordedAt: Date.now(),
    });
    terminals.push(t);
    // Show the new run's length; the next run starts here.
    selectedRun = t.index;
    runFrom = t.index;
    live = { from: runFrom, to: t };
    renderTerminals();
    if (finish) {
      await stopMeasuring();
    } else {
      hintEl.textContent = measuringHint();
      addTerminalBtn.classList.remove('flash');
      void addTerminalBtn.offsetWidth;
      addTerminalBtn.classList.add('flash');
    }
    if (s.quality === 'limited') flashHint(`Recorded t${t.index}, but ${s.detail.toLowerCase()}`);
  } finally {
    recording = false;
  }
}

addTerminalBtn.addEventListener('click', () => void recordTerminal(false));
finishRunBtn.addEventListener('click', () => void recordTerminal(true));
cancelMeasuringBtn.addEventListener('click', () => void stopMeasuring());

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
