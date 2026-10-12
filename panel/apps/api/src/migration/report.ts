import { stepMessage, stepProgress, type MigrationStep } from "@mcsm/shared";
import type { JobService } from "../jobs/service.js";

/** Cómo cuentan los pasos su avance. En producción, el job de la migración (JobReporter). */
export interface Reporter {
  /** Empieza el paso n: progreso al inicio de su tramo, mensaje y una línea en el log. */
  step(n: MigrationStep, detail: string): void;
  /** Avance dentro del paso (fracción 0-1). Solo escribe si cambia el porcentaje o el texto. */
  within(n: MigrationStep, fraction: number, detail: string): void;
  /** Cambia el mensaje sin tocar el progreso (p. ej. «deshaciendo»). */
  message(n: MigrationStep, detail: string): void;
  log(line: string): void;
}

/** Reporter sobre el job `migrate`: cada cambio emite el evento `job` (la web lo ve en vivo, topic `jobs`). */
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
