import { describe, expect, it } from "vitest";
import { floatingPlacement } from "./float-position";

const viewport = { viewportWidth: 1400, viewportHeight: 900 };
const box = { width: 360, height: 260 };

describe("floatingPlacement", () => {
  it("sits below the selection when there is room", () => {
    expect(
      floatingPlacement({ rectLeft: 100, rectTop: 100, rectBottom: 120, ...viewport, ...box }),
    ).toEqual({ left: 100, top: 128 });
  });

  it("goes above the selection when the room below is too small", () => {
    expect(
      floatingPlacement({ rectLeft: 100, rectTop: 800, rectBottom: 820, ...viewport, ...box }),
    ).toEqual({ left: 100, bottom: 108 });
  });

  it("stays inside the window when there is room neither above nor below", () => {
    expect(
      floatingPlacement({
        rectLeft: 100,
        rectTop: 100,
        rectBottom: 300,
        viewportWidth: 1400,
        viewportHeight: 400,
        ...box,
      }),
    ).toEqual({ left: 100, top: 132 });
  });

  it("keeps the box off the right and left edges", () => {
    expect(
      floatingPlacement({ rectLeft: 1350, rectTop: 100, rectBottom: 120, ...viewport, ...box }),
    ).toMatchObject({ left: 1032 });
    expect(
      floatingPlacement({ rectLeft: -50, rectTop: 100, rectBottom: 120, ...viewport, ...box }),
    ).toMatchObject({ left: 8 });
  });
});
