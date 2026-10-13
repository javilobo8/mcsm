import { stepMessage, stepProgress, type MigrationStep } from "@mcsm/shared";
import type { JobService } from "../jobs/service.js";

/** How the steps report their progress. In production, the migration job (JobReporter). */
export interface Reporter {
  /** Starts step n: progress at the start of its range, message and a log line. */
  step(n: MigrationStep, detail: string): void;
  /** Progress within the step (fraction 0-1). Only writes if the percentage or the text changes. */
  within(n: MigrationStep, fraction: number, detail: string): void;
  /** Changes the message without touching progress (e.g. “rolling back”). */
  message(n: MigrationStep, detail: string): void;
  log(line: string): void;
}

/** Reporter over the `migrate` job: each change emits the `job` event (the web sees it live, `jobs` topic). */
export class JobReporter implements Reporter {
  private last = { progress: -1, message: "" };

  constructor(private jobs: JobService, private jobId: string) {}

  step(n: MigrationStep, detail: string): void {
    const progress = stepProgress(n);
    const message = stepMessage(n, detail);
    this.last = { progress, message };
    this.jobs.update(this.jobId, { progress, message, logChunk: `${message}\n` });
  }

  within(n: MigrationStep, fraction: number, detail: string): void {
    const progress = stepProgress(n, fraction);
    const message = stepMessage(n, detail);
    if (progress === this.last.progress && message === this.last.message) return;
    this.last = { progress, message };
    this.jobs.update(this.jobId, { progress, message });
  }

  message(n: MigrationStep, detail: string): void {
    const message = stepMessage(n, detail);
    this.last = { ...this.last, message };
    this.jobs.update(this.jobId, { message });
  }

  log(line: string): void {
    this.jobs.update(this.jobId, { logChunk: `${line}\n` });
  }
}
