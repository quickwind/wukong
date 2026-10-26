import { describe, expect, it } from "vitest";
import { Dismissals } from "./dismissal.js";

describe("Dismissals", () => {
  it("shows a level nobody dismissed", () => {
    expect(new Dismissals().visibleLevel("a", "warn")).toBe("warn");
  });

  it("hides the dismissed level", () => {
    const d = new Dismissals();
    d.dismiss("a", "warn");
    expect(d.visibleLevel("a", "warn")).toBe("none");
  });

  it("shows again when the level gets worse", () => {
    const d = new Dismissals();
    d.dismiss("a", "warn");
    expect(d.visibleLevel("a", "critical")).toBe("critical");
  });

  it("keeps a critical dismissal when the level drops back to warn", () => {
    const d = new Dismissals();
    d.dismiss("a", "critical");
    expect(d.visibleLevel("a", "warn")).toBe("none");
  });

  it("forgets the dismissal once usage is back below the threshold", () => {
    const d = new Dismissals();
    d.dismiss("a", "warn");
    expect(d.visibleLevel("a", "none")).toBe("none");
    expect(d.visibleLevel("a", "warn")).toBe("warn");
  });

  it("tracks agents separately and can forget one", () => {
    const d = new Dismissals();
    d.dismiss("a", "warn");
    expect(d.visibleLevel("b", "warn")).toBe("warn");
    d.forget("a");
    expect(d.visibleLevel("a", "warn")).toBe("warn");
  });
});
