/**
 * CoverageCell unit tests — the Agents Coverage column. Asserts the two render
 * modes (single-outcode static vs multi-outcode rollup) and the popover's
 * open / content / close behaviour. The popover is portaled to document.body,
 * so it is queried off `screen` (document), not the cell subtree.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CoverageCell } from "./CoverageCell";

describe("CoverageCell", () => {
  it("renders a single outcode as town + code with no rollup trigger", () => {
    render(<CoverageCell outcodes={["SE16"]} />);
    const cell = screen.getByTestId("agent-coverage");
    expect(cell).toHaveTextContent("Bermondsey");
    expect(cell).toHaveTextContent("SE16");
    expect(screen.queryByTestId("agent-coverage-roll")).not.toBeInTheDocument();
  });

  it("rolls a multi-outcode patch up to dominant region + count", () => {
    render(<CoverageCell outcodes={["SE16", "SE1", "SE15"]} />);
    const roll = screen.getByTestId("agent-coverage-roll");
    expect(roll).toHaveTextContent("South East London");
    expect(roll).toHaveTextContent("3 outcodes");
    expect(roll).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a popover with the town breakdown and HQ footer on click", () => {
    render(<CoverageCell outcodes={["SE16", "SE1", "SE15"]} />);
    const roll = screen.getByTestId("agent-coverage-roll");
    fireEvent.click(roll);
    expect(roll).toHaveAttribute("aria-expanded", "true");

    const pop = screen.getByRole("dialog", { name: /coverage detail/i });
    expect(pop).toHaveTextContent("Covers");
    expect(pop).toHaveTextContent("3 outcodes");
    // Each town that the patch touches is a group heading.
    expect(within(pop).getByText("Bermondsey")).toBeInTheDocument();
    expect(within(pop).getByText("Peckham")).toBeInTheDocument();
    // The head-office footer names the primary (first) outcode + its town.
    expect(pop).toHaveTextContent(/Head office/i);
    expect(pop).toHaveTextContent("SE16");
  });

  it("toggles the popover closed on a second trigger click", () => {
    render(<CoverageCell outcodes={["SE16", "SE1"]} />);
    const roll = screen.getByTestId("agent-coverage-roll");
    fireEvent.click(roll);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(roll);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the popover on Escape and returns focus to the trigger", () => {
    render(<CoverageCell outcodes={["SE16", "SE1"]} />);
    const roll = screen.getByTestId("agent-coverage-roll");
    fireEvent.click(roll);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(roll).toHaveFocus();
  });

  it("renders an em dash for an empty coverage list", () => {
    render(<CoverageCell outcodes={[]} />);
    expect(screen.getByTestId("agent-coverage")).toHaveTextContent("—");
    expect(screen.queryByTestId("agent-coverage-roll")).not.toBeInTheDocument();
  });
});
