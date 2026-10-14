import { describe, expect, it } from "vitest";

import { createJobs } from "./jobs.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("jobs", () => {
  it("reports each step while running and the result when done", async () => {
    const jobs = createJobs<string>();
    let finish!: (value: string) => void;
    let say!: (step: string) => void;
    const id = jobs.start(
      (report) =>
        new Promise<string>((resolve) => {
          say = report;
          finish = resolve;
        }),
      "Starting…",
    );
    expect(jobs.poll(id)).toEqual({
      state: "running",
      steps: ["Starting…"],
      result: null,
      error: null,
    });
    say("Halfway");
    expect(jobs.poll(id).steps).toEqual(["Starting…", "Halfway"]);
    finish("ok");
    await tick();
    expect(jobs.poll(id)).toEqual({
      state: "done",
      steps: ["Starting…", "Halfway"],
      result: "ok",
      error: null,
    });
    expect(jobs.poll(id).state).toBe("done");
  });

  it("keeps every step in order and does not repeat the one it is already on", async () => {
    const jobs = createJobs<string>();
    const id = jobs.start(async (report) => {
      report("Forking…");
      report("Forking…");
      report("Cloning…");
      return "ok";
    }, "Forking…");
    await tick();
    expect(jobs.poll(id).steps).toEqual(["Forking…", "Cloning…"]);
  });

  it("reports a failure with its message", async () => {
    const jobs = createJobs<string>();
    const id = jobs.start(async () => {
      throw new Error("no space left");
    }, "Cloning…");
    await tick();
    expect(jobs.poll(id)).toMatchObject({ state: "failed", error: "no space left", result: null });
  });

  it("answers an unknown id as failed, and drops finished jobs after a while", async () => {
    let clock = 0;
    const jobs = createJobs<string>(() => clock);
    expect(jobs.poll("nope").state).toBe("failed");
    const id = jobs.start(async () => "x", "…");
    await tick();
    clock = 16 * 60 * 1000;
    jobs.start(async () => "y", "…"); // starting a job prunes old ones
    expect(jobs.poll(id).state).toBe("failed");
  });
});
