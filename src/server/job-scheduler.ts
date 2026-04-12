type ScheduledJob = {
  id: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: "success" | "error" | null;
  activeRuns: number;
  timeout: ReturnType<typeof setTimeout> | null;
  schedule:
    | {
        type: "interval";
        intervalMs: number;
      }
    | {
        type: "daily";
        hour: number;
        minute: number;
      };
  task: () => Promise<void>;
};

export class JobScheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private loadPersistedState?: (id: string) => {
    lastRunAt: string | null;
    lastRunStatus: "success" | "error" | null;
  } | null;
  private savePersistedState?: (
    id: string,
    state: { lastRunAt: string | null; lastRunStatus: "success" | "error" | null }
  ) => void;

  setPersistence(options: {
    load: (id: string) => {
      lastRunAt: string | null;
      lastRunStatus: "success" | "error" | null;
    } | null;
    save: (
      id: string,
      state: { lastRunAt: string | null; lastRunStatus: "success" | "error" | null }
    ) => void;
  }) {
    this.loadPersistedState = options.load;
    this.savePersistedState = options.save;
  }

  registerRecurringJob(options: {
    id: string;
    intervalMs: number;
    enabled?: boolean;
    task: () => Promise<void>;
  }) {
    const job: ScheduledJob = {
      id: options.id,
      enabled: options.enabled ?? true,
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: null,
      activeRuns: 0,
      timeout: null,
      schedule: {
        type: "interval",
        intervalMs: options.intervalMs
      },
      task: options.task
    };

    this.hydrateState(job);
    this.jobs.set(job.id, job);
    this.reschedule(job);
  }

  registerDailyJob(options: {
    id: string;
    hour: number;
    minute?: number;
    enabled?: boolean;
    task: () => Promise<void>;
  }) {
    const job: ScheduledJob = {
      id: options.id,
      enabled: options.enabled ?? true,
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: null,
      activeRuns: 0,
      timeout: null,
      schedule: {
        type: "daily",
        hour: options.hour,
        minute: options.minute ?? 0
      },
      task: options.task
    };

    this.hydrateState(job);
    this.jobs.set(job.id, job);
    this.reschedule(job);
  }

  updateJob(id: string, patch: { intervalMs?: number; enabled?: boolean }) {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }

    if (patch.intervalMs !== undefined) {
      if (job.schedule.type === "interval") {
        job.schedule.intervalMs = patch.intervalMs;
      }
    }

    if (patch.enabled !== undefined) {
      job.enabled = patch.enabled;
    }

    this.reschedule(job);
  }

  getNextRunAt(id: string) {
    return this.jobs.get(id)?.nextRunAt ?? null;
  }

  getLastRunAt(id: string) {
    return this.jobs.get(id)?.lastRunAt ?? null;
  }

  getLastRunStatus(id: string) {
    return this.jobs.get(id)?.lastRunStatus ?? null;
  }

  isRunning(id: string) {
    return (this.jobs.get(id)?.activeRuns ?? 0) > 0;
  }

  runNow(id: string) {
    const job = this.jobs.get(id);
    if (!job) {
      return false;
    }

    void this.execute(job, false);
    return true;
  }

  async runNowAndWait(id: string) {
    const job = this.jobs.get(id);
    if (!job) {
      return null;
    }

    return this.execute(job, false);
  }

  private reschedule(job: ScheduledJob) {
    if (job.timeout) {
      clearTimeout(job.timeout);
      job.timeout = null;
    }

    if (!job.enabled) {
      job.nextRunAt = null;
      return;
    }

    const nextRunAt = this.computeNextRunAt(job);
    job.nextRunAt = nextRunAt.toISOString();
    job.timeout = setTimeout(() => {
      void this.execute(job, true);
    }, Math.max(0, nextRunAt.getTime() - Date.now()));
  }

  private async execute(job: ScheduledJob, scheduled: boolean) {
    if (scheduled) {
      this.reschedule(job);
    }

    job.activeRuns += 1;
    try {
      await job.task();
      job.lastRunAt = new Date().toISOString();
      job.lastRunStatus = "success";
      this.persistState(job);
      return true;
    } catch {
      // Do not advance lastRunAt on failure — it serves as the incremental
      // fetch cursor for jobs like activity-cache-fetch and must not skip
      // the failed window on the next run.
      job.lastRunStatus = "error";
      this.persistState(job);
      return false;
    } finally {
      job.activeRuns = Math.max(0, job.activeRuns - 1);
    }
  }

  private hydrateState(job: ScheduledJob) {
    const state = this.loadPersistedState?.(job.id);
    if (!state) {
      return;
    }

    job.lastRunAt = state.lastRunAt;
    job.lastRunStatus = state.lastRunStatus;
  }

  private persistState(job: ScheduledJob) {
    this.savePersistedState?.(job.id, {
      lastRunAt: job.lastRunAt,
      lastRunStatus: job.lastRunStatus
    });
  }

  private computeNextRunAt(job: ScheduledJob) {
    if (job.schedule.type === "interval") {
      return new Date(Date.now() + job.schedule.intervalMs);
    }

    const next = new Date();
    next.setSeconds(0, 0);
    next.setHours(job.schedule.hour, job.schedule.minute, 0, 0);

    if (next.getTime() <= Date.now()) {
      next.setDate(next.getDate() + 1);
    }

    return next;
  }
}
