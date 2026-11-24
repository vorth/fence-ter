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
  /** Sum of the lengths of all its runs (measurements), in decimal feet. */
  totalLength: number;
}

/** The fields of a job the user types in. */
export type JobDetails = Pick<Job, 'title' | 'description'>;

/** Where a job was created: a GPS fix, as captured. */
export type Fix = Pick<Job, 'latitude' | 'longitude' | 'accuracy' | 'altitude'>;

/** Displacement in decimal feet: x east, y north, z up. */
export interface Displacement {
  dx: number;
  dy: number;
  dz: number;
}

/** One measured point, relative to the point before it in the same session. */
export interface Measurement extends Displacement {
  id: number;
  jobId: number;
  /**
   * Measuring sessions within the job, from 1. Each session starts at its own
   * origin, so the first measurement of a session is not relative to the last
   * one of the previous session.
   */
  session: number;
  /** Epoch milliseconds. */
  recordedAt: number;
}

/** The persistence surface the app depends on. Backed by SQLite natively, stubbed on web. */
export interface JobsStore {
  init(): Promise<void>;
  /** All jobs, newest first. */
  getJobs(): Promise<Job[]>;
  insertJob(createdAt: number, fix: Fix | null, details: JobDetails): Promise<Job>;
  setDetails(id: number, details: JobDetails): Promise<void>;
  /** Deletes the job and its measurements. */
  deleteJob(id: number): Promise<void>;
  /** The job's measurements, in the order recorded. */
  getMeasurements(jobId: number): Promise<Measurement[]>;
  insertMeasurement(m: Omit<Measurement, 'id'>): Promise<Measurement>;
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
      `CREATE TABLE IF NOT EXISTS measurements (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        session     INTEGER NOT NULL,
        dx          REAL    NOT NULL,
        dy          REAL    NOT NULL,
        dz          REAL    NOT NULL,
        recorded_at INTEGER NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_measurements_job_id ON measurements(job_id);`,
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

interface MeasurementRow {
  id: number;
  job_id: number;
  session: number;
  dx: number;
  dy: number;
  dz: number;
  recorded_at: number;
}

function rowToMeasurement(r: MeasurementRow): Measurement {
  return {
    id: r.id,
    jobId: r.job_id,
    session: r.session,
    dx: r.dx,
    dy: r.dy,
    dz: r.dz,
    recordedAt: r.recorded_at,
  };
}

const JOB_COLUMNS = 'id, title, description, created_at, latitude, longitude, accuracy, altitude';

const runLength = (m: Displacement) => Math.hypot(m.dx, m.dy, m.dz);

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
    // Run lengths are summed here: SQLite's sqrt() isn't available everywhere.
    const runs = await this.conn().query(`SELECT job_id, dx, dy, dz FROM measurements;`);
    const totals = new Map<number, number>();
    for (const m of (runs.values ?? []) as (Displacement & { job_id: number })[]) {
      totals.set(m.job_id, (totals.get(m.job_id) ?? 0) + runLength(m));
    }
    return ((res.values ?? []) as JobRow[]).map((r) => rowToJob(r, totals.get(r.id) ?? 0));
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
    await this.conn().run(`DELETE FROM measurements WHERE job_id = ?;`, [id]);
    await this.conn().run(`DELETE FROM jobs WHERE id = ?;`, [id]);
  }

  async getMeasurements(jobId: number): Promise<Measurement[]> {
    const res = await this.conn().query(
      `SELECT id, job_id, session, dx, dy, dz, recorded_at
         FROM measurements WHERE job_id = ? ORDER BY id;`,
      [jobId],
    );
    return ((res.values ?? []) as MeasurementRow[]).map(rowToMeasurement);
  }

  async insertMeasurement(m: Omit<Measurement, 'id'>): Promise<Measurement> {
    const res = await this.conn().run(
      `INSERT INTO measurements (job_id, session, dx, dy, dz, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [m.jobId, m.session, m.dx, m.dy, m.dz, m.recordedAt],
    );
    const id = res.changes?.lastId;
    if (id == null) throw new Error('Insert did not return a measurement id.');
    return { id, ...m };
  }
}

/**
 * In-memory stub used on web so `npm run dev` runs without the jeep-sqlite/wasm
 * setup. Data does NOT persist across reloads.
 */
class WebStubJobsStore implements JobsStore {
  private jobs: Omit<Job, 'totalLength'>[] = [];
  private measurements: Measurement[] = [];
  private nextJobId = 1;
  private nextMeasurementId = 1;

  async init(): Promise<void> {
    console.warn(
      '[db] Using in-memory web stub — jobs will not persist across reloads. ' +
        'Native builds (iOS/Android) use SQLite.',
    );
  }

  private withTotal(j: Omit<Job, 'totalLength'>): Job {
    const runs = this.measurements.filter((m) => m.jobId === j.id);
    return { ...j, totalLength: runs.reduce((sum, m) => sum + runLength(m), 0) };
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
    return this.withTotal(job);
  }

  async setDetails(id: number, details: JobDetails): Promise<void> {
    const job = this.jobs.find((j) => j.id === id);
    if (job) Object.assign(job, details);
  }

  async deleteJob(id: number): Promise<void> {
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.measurements = this.measurements.filter((m) => m.jobId !== id);
  }

  async getMeasurements(jobId: number): Promise<Measurement[]> {
    return this.measurements.filter((m) => m.jobId === jobId);
  }

  async insertMeasurement(m: Omit<Measurement, 'id'>): Promise<Measurement> {
    const saved = { id: this.nextMeasurementId++, ...m };
    this.measurements.push(saved);
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
