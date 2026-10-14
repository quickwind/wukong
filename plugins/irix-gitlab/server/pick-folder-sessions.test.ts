import { describe, expect, it } from "vitest";

import { createFolderPickerSessions } from "./pick-folder-sessions.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("folder picker sessions", () => {
  it("starts at once and reports pending until the dialog closes, then the path", async () => {
    const dialog = deferred<string | null>();
    const sessions = createFolderPickerSessions(() => dialog.promise);
    const id = sessions.start();
    expect(sessions.poll(id)).toEqual({ state: "pending", path: null, error: null });
    dialog.resolve("D:\\work\\app");
    await tick();
    expect(sessions.poll(id)).toEqual({ state: "done", path: "D:\\work\\app", error: null });
  });

  it("hands a finished result out once", async () => {
    const sessions = createFolderPickerSessions(async () => null);
    const id = sessions.start();
    await tick();
    expect(sessions.poll(id)).toMatchObject({ state: "done", path: null });
    expect(sessions.poll(id)).toMatchObject({ state: "failed" });
  });

  it("reports a failing dialog", async () => {
    const sessions = createFolderPickerSessions(async () => {
      throw new Error("no dialog");
    });
    const id = sessions.start();
    await tick();
    expect(sessions.poll(id)).toEqual({ state: "failed", path: null, error: "no dialog" });
  });

  it("does not stack a second dialog while one is open", async () => {
    const dialog = deferred<string | null>();
    let opened = 0;
    const sessions = createFolderPickerSessions(() => {
      opened += 1;
      return dialog.promise;
    });
    expect(sessions.start()).toBe(sessions.start());
    expect(opened).toBe(1);
    dialog.resolve(null);
    await tick();
    expect(sessions.start()).not.toBeUndefined();
    expect(opened).toBe(2);
  });

  it("answers an unknown id as failed", () => {
    expect(createFolderPickerSessions(async () => null).poll("nope").state).toBe("failed");
  });
});
