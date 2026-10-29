// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { toggleContentSearch, useContentSearchOpen } from "./content-search-open";

describe("content search open store", () => {
  it("starts closed and flips only its own key", () => {
    const own = renderHook(() => useContentSearchOpen("s1:w1"));
    const other = renderHook(() => useContentSearchOpen("s1:w2"));
    expect(own.result.current).toBe(false);

    act(() => toggleContentSearch("s1:w1"));
    expect(own.result.current).toBe(true);
    expect(other.result.current).toBe(false);

    act(() => toggleContentSearch("s1:w1"));
    expect(own.result.current).toBe(false);
  });

  it("survives the pane unmounting", () => {
    const first = renderHook(() => useContentSearchOpen("s2:w1"));
    act(() => toggleContentSearch("s2:w1"));
    first.unmount();

    const second = renderHook(() => useContentSearchOpen("s2:w1"));
    expect(second.result.current).toBe(true);
  });
});
