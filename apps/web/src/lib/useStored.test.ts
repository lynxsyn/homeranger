import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useStored } from "./useStored";

const VIEWS = ["table", "cards"] as const;

describe("useStored", () => {
  it("returns the fallback when nothing is stored", () => {
    const { result } = renderHook(() => useStored("v-empty", "table", VIEWS));
    expect(result.current[0]).toBe("table");
  });

  it("returns a stored value that is in the accepted set", () => {
    localStorage.setItem("v-stored", "cards");
    const { result } = renderHook(() => useStored("v-stored", "table", VIEWS));
    expect(result.current[0]).toBe("cards");
  });

  it("falls back when the stored value is not in the accepted set", () => {
    localStorage.setItem("v-bad", "grid"); // not a valid view
    const { result } = renderHook(() => useStored("v-bad", "table", VIEWS));
    expect(result.current[0]).toBe("table");
  });

  it("persists the value on set", () => {
    const { result } = renderHook(() => useStored("v-set", "table", VIEWS));
    act(() => result.current[1]("cards"));
    expect(result.current[0]).toBe("cards");
    expect(localStorage.getItem("v-set")).toBe("cards");
  });
});
