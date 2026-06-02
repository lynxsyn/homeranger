/**
 * Vitest setup for the web unit tests — adds @testing-library/jest-dom matchers
 * (toBeInTheDocument, toHaveAttribute, …) and clears the DOM + localStorage
 * between tests so per-test state (theme, view) never leaks.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
