import { randomUUID } from "node:crypto";

export interface JobPoll<Result> {
  state: "running" | "done" | "failed";
  /** Every step so far, in order; the last one is current. */
  steps: string[];
  result: Result | null;
  error: string | null;
}

interface Job<Result> extends JobPoll<Result> {
  finishedAt: number | null;
}

const RETAIN_MS = 15 * 60 * 1000;

/**
 * Background jobs polled by id. A plugin RPC may take 30 seconds at most, so anything longer (a
 * large clone, a fork GitLab builds in the background) runs here and reports its step as it goes.
 */
export function createJobs<Result>(now: () => number = Date.now) {
  const jobs = new Map<string, Job<Result>>();

  function prune(): void {
    for (const [id, job] of jobs) {
      if (job.finishedAt !== null && now() - job.finishedAt > RETAIN_MS) jobs.delete(id);
    }
  }

  return {
    start(work: (report: (step: string) => void) => Promise<Result>, firstStep: string): string {
      prune();
      const id = randomUUID();
      const job: Job<Result> = {
        state: "running",
        steps: [firstStep],
        result: null,
        error: null,
        finishedAt: null,
      };
      jobs.set(id, job);
      void (async () => {
        try {
          job.result = await work((step) => {
            if (job.steps.at(-1) !== step) job.steps.push(step);
          });
          job.state = "done";
        } catch (error) {
          job.error = error instanceof Error ? error.message : String(error);
          job.state = "failed";
        } finally {
          job.finishedAt = now();
        }
      })();
      return id;
    },

    poll(id: string): JobPoll<Result> {
      const job = jobs.get(id);
      if (!job) {
        return {
          state: "failed",
          steps: [],
          result: null,
          error: "That job is no longer available",
        };
      }
      return { state: job.state, steps: [...job.steps], result: job.result, error: job.error };
    },
  };
}
