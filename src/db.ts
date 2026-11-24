import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';

/** A fencing job, as stored in the `jobs` table. */
export interface Job {
  id: number;
  /** The job's name, set by the user; null when left blank (shown as "Job <id>"). */
  title: string | null;
  /** Free text set by the user; null when left blank. */
  description: string | null;
  /** Epoch milliseconds when the job was created. */
  createdAt: number;
  /** Where the job was created; null when no GPS fix could be had. */
  latitude: number | null;
  longitude: number | null;
  /** Metres; null when unknown. */
  accuracy: number | null;
  /** Metres; null when the device does not report altitude. */
  altitude: number | null;
  /** Sum of the lengths of all its runs, in decimal feet; computed, not stored. */
  totalLength: number;
}

/** The fields of a job the user types in. */
export type JobDetails = Pick<Job, 'title' | 'description'>;

/** Where a job was created: a GPS fix, as captured. */
export type Fix = Pick<Job, 'latitude' | 'longitude' | 'accuracy' | 'altitude'>;

/** A position in decimal feet relative to the job's origin: x east, y north, z up. */
export interface Point {
  x: number;
  y: number;
  z: number;
}

/**
 * A measured point of a job. Terminal 0 is the job's origin, created with the
 * job, always at (0, 0, 0). Every other terminal ends a *run* from its
 * `start` terminal. Only coordinates are stored; run lengths are computed
 * from them when shown.
 */
export interface Terminal extends Point {
  id: number;
  jobId: number;
  /** Zero-based position in the job, in the order created; t0 is the origin. */
  index: number;
  /** Index of the terminal this one was measured from; null for the origin. */
  start: number | null;
  /** Epoch milliseconds. */
  recordedAt: number;
}

/** The length of the run from `a` to `b`, in decimal feet. */
export const runLength = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/** The sum of the job's run lengths, in decimal feet. `terminals` are indexed by `index`. */
export function totalLength(terminals: Terminal[]): number {
  return terminals.reduce(
    (sum, t) => (t.start == null ? sum : sum + runLength(terminals[t.start], t)), 0);
}

/** The persistence surface the app depends on. Backed by SQLite natively, stubbed on web. */
export interface JobsStore {
  init(): Promise<void>;
  /** All jobs, newest first. */
  getJobs(): Promise<Job[]>;
  /** Creates the job and its origin terminal, t0. */
  insertJob(createdAt: number, fix: Fix | null, details: JobDetails): Promise<Job>;
  setDetails(id: number, details: JobDetails): Promise<void>;
  /** Deletes the job and its terminals. */
  deleteJob(id: number): Promise<void>;
  /** The job's terminals, by index (so `result[i].index === i`). */
  getTerminals(jobId: number): Promise<Terminal[]>;
  insertTerminal(t: Omit<Terminal, 'id'>): Promise<Terminal>;
}

const DB_NAME = 'jobs';
const DB_VERSION = 1;

// Versioned schema. Until the first release, edit version 1 in place (and
// reinstall the app to recreate the database). After that, add migrations as
// new { toVersion, statements } entries and bump DB_VERSION — never edit an
// existing entry.
const UPGRADE_STATEMENTS = [
  {
    toVersion: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS jobs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT,
        description TEXT,
        created_at  INTEGER NOT NULL,
        latitude    REAL,
        longitude   REAL,
        accuracy    REAL,
        altitude    REAL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);`,
      // x, y, z: decimal feet from the job's origin (east, north, up).
      // idx: zero-based within the job. start: idx of the terminal measured
      // from, null for the origin (idx 0).
      `CREATE TABLE IF NOT EXISTS terminals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        idx         INTEGER NOT NULL,
        start       INTEGER,
        x           REAL    NOT NULL,
        y           REAL    NOT NULL,
        z           REAL    NOT NULL,
        recorded_at INTEGER NOT NULL,
        UNIQUE (job_id, idx),
        CHECK ((idx = 0) = (start IS NULL)),
        CHECK (start IS NULL OR start < idx)
      );`,
    ],
  },
];

interface JobRow {
  id: number;
  title: string | null;
  description: string | null;
  created_at: number;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  altitude: number | null;
}

function rowToJob(r: JobRow, totalLength: number): Job {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    createdAt: r.created_at,
    latitude: r.latitude,
    longitude: r.longitude,
    accuracy: r.accuracy,
    altitude: r.altitude,
    totalLength,
  };
}

interface TerminalRow {
  id: number;
  job_id: number;
  idx: number;
  start: number | null;
  x: number;
  y: number;
  z: number;
  recorded_at: number;
}

function rowToTerminal(r: TerminalRow): Terminal {
  return {
    id: r.id,
    jobId: r.job_id,
    index: r.idx,
    start: r.start,
    x: r.x,
    y: r.y,
    z: r.z,
    recordedAt: r.recorded_at,
  };
}

const TERMINAL_COLUMNS = 'id, job_id, idx, start, x, y, z, recorded_at';

/** The origin terminal of a new job. */
const origin = (jobId: number, createdAt: number): Omit<Terminal, 'id'> =>
  ({ jobId, index: 0, start: null, x: 0, y: 0, z: 0, recordedAt: createdAt });

const JOB_COLUMNS = 'id, title, description, created_at, latitude, longitude, accuracy, altitude';

/** Real SQLite-backed store for native (iOS/Android) platforms. */
class SqliteJobsStore implements JobsStore {
  private sqlite = new SQLiteConnection(CapacitorSQLite);
  private db: SQLiteDBConnection | null = null;

  async init(): Promise<void> {
    await this.sqlite.addUpgradeStatement(DB_NAME, UPGRADE_STATEMENTS);

    // Reuse an existing connection if one is already open (e.g. hot reload).
    const isConn = (await this.sqlite.isConnection(DB_NAME, false)).result;
    this.db = isConn
      ? await this.sqlite.retrieveConnection(DB_NAME, false)
      : await this.sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false);

    await this.db.open();
  }

  private conn(): SQLiteDBConnection {
    if (!this.db) throw new Error('JobsStore not initialized — call init() first.');
    return this.db;
  }

  async getJobs(): Promise<Job[]> {
    const res = await this.conn().query(
      `SELECT ${JOB_COLUMNS} FROM jobs ORDER BY created_at DESC;`,
    );
    // Totals are computed here, not in SQL: SQLite's sqrt() isn't available
    // everywhere.
    const all = await this.conn().query(
      `SELECT ${TERMINAL_COLUMNS} FROM terminals ORDER BY job_id, idx;`,
    );
    const byJob = new Map<number, Terminal[]>();
    for (const r of (all.values ?? []) as TerminalRow[]) {
      const list = byJob.get(r.job_id) ?? [];
      list.push(rowToTerminal(r));
      byJob.set(r.job_id, list);
    }
    return ((res.values ?? []) as JobRow[]).map(
      (r) => rowToJob(r, totalLength(byJob.get(r.id) ?? [])));
  }

  async insertJob(createdAt: number, fix: Fix | null, details: JobDetails): Promise<Job> {
    const res = await this.conn().run(
      `INSERT INTO jobs (title, description, created_at, latitude, longitude, accuracy, altitude)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [details.title, details.description, createdAt, fix?.latitude ?? null,
        fix?.longitude ?? null, fix?.accuracy ?? null, fix?.altitude ?? null],
    );
    const id = res.changes?.lastId;
    if (id == null) throw new Error('Insert did not return a job id.');
    await this.insertTerminal(origin(id, createdAt));
    const rows = await this.conn().query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?;`, [id]);
    return rowToJob((rows.values as JobRow[])[0], 0);
  }

  async setDetails(id: number, details: JobDetails): Promise<void> {
    await this.conn().run(
      `UPDATE jobs SET title = ?, description = ? WHERE id = ?;`,
      [details.title, details.description, id],
    );
  }

  async deleteJob(id: number): Promise<void> {
    // Explicit rather than relying on ON DELETE CASCADE, which needs
    // PRAGMA foreign_keys to be on for the connection.
    await this.conn().run(`DELETE FROM terminals WHERE job_id = ?;`, [id]);
    await this.conn().run(`DELETE FROM jobs WHERE id = ?;`, [id]);
  }

  async getTerminals(jobId: number): Promise<Terminal[]> {
    const res = await this.conn().query(
      `SELECT ${TERMINAL_COLUMNS} FROM terminals WHERE job_id = ? ORDER BY idx;`,
      [jobId],
    );
    return ((res.values ?? []) as TerminalRow[]).map(rowToTerminal);
  }

  async insertTerminal(t: Omit<Terminal, 'id'>): Promise<Terminal> {
    const res = await this.conn().run(
      `INSERT INTO terminals (job_id, idx, start, x, y, z, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [t.jobId, t.index, t.start, t.x, t.y, t.z, t.recordedAt],
    );
    const id = res.changes?.lastId;
    if (id == null) throw new Error('Insert did not return a terminal id.');
    return { id, ...t };
  }
}

/**
 * In-memory stub used on web so `npm run dev` runs without the jeep-sqlite/wasm
 * setup. Data does NOT persist across reloads.
 */
class WebStubJobsStore implements JobsStore {
  private jobs: Omit<Job, 'totalLength'>[] = [];
  private terminals: Terminal[] = [];
  private nextJobId = 1;
  private nextTerminalId = 1;

  async init(): Promise<void> {
    console.warn(
      '[db] Using in-memory web stub — jobs will not persist across reloads. ' +
        'Native builds (iOS/Android) use SQLite.',
    );
  }

  private withTotal(j: Omit<Job, 'totalLength'>): Job {
    return { ...j, totalLength: totalLength(this.terminalsOf(j.id)) };
  }

  private terminalsOf(jobId: number): Terminal[] {
    return this.terminals.filter((t) => t.jobId === jobId).sort((a, b) => a.index - b.index);
  }

  async getJobs(): Promise<Job[]> {
    return [...this.jobs]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => this.withTotal(j));
  }

  async insertJob(createdAt: number, fix: Fix | null, details: JobDetails): Promise<Job> {
    const job = {
      id: this.nextJobId++,
      ...details,
      createdAt,
      latitude: fix?.latitude ?? null,
      longitude: fix?.longitude ?? null,
      accuracy: fix?.accuracy ?? null,
      altitude: fix?.altitude ?? null,
    };
    this.jobs.push(job);
    await this.insertTerminal(origin(job.id, createdAt));
    return this.withTotal(job);
  }

  async setDetails(id: number, details: JobDetails): Promise<void> {
    const job = this.jobs.find((j) => j.id === id);
    if (job) Object.assign(job, details);
  }

  async deleteJob(id: number): Promise<void> {
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.terminals = this.terminals.filter((t) => t.jobId !== id);
  }

  async getTerminals(jobId: number): Promise<Terminal[]> {
    return this.terminalsOf(jobId);
  }

  async insertTerminal(t: Omit<Terminal, 'id'>): Promise<Terminal> {
    const saved = { id: this.nextTerminalId++, ...t };
    this.terminals.push(saved);
    return saved;
  }
}

let store: JobsStore | null = null;

/** Returns the singleton store, initializing it on first call. */
export async function getStore(): Promise<JobsStore> {
  if (store) return store;
  store = Capacitor.isNativePlatform() ? new SqliteJobsStore() : new WebStubJobsStore();
  await store.init();
  return store;
}
