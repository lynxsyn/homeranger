/**
 * CoverageCell unit tests — the Agents Coverage column. The cell now renders the
 * server-computed coverage summary (AgentRow.coverage), so the tests feed it
 * summary objects directly. Asserts the two render modes (single-outcode static
 * vs multi-outcode rollup), the popover's open / content / close behaviour, and
 * that a scroll INSIDE the popover does not close it. The popover is portaled to
 * document.body, so it is queried off `screen` (document), not the cell subtree.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CoverageCell } from "./CoverageCell";

/** A Gwynedd patch: Bangor (HQ) + Caernarfon, mirroring the server rollup. */
const GWYNEDD = {
  count: 3,
  region: "Gwynedd",
  regions: ["Gwynedd"],
  groups: { Bangor: ["LL57"], Caernarfon: ["LL55", "LL54"] },
  towns: ["Bangor", "Caernarfon"],
  primary: "LL57",
  primaryTown: "Bangor",
};

const SINGLE = {
  count: 1,
  region: "Gwynedd",
  regions: ["Gwynedd"],
  groups: { Bangor: ["LL57"] },
  towns: ["Bangor"],
  primary: "LL57",
  primaryTown: "Bangor",
};

const EMPTY = {
  count: 0,
  region: null,
  regions: [],
  groups: {},
  towns: [],
  primary: null,
  primaryTown: null,
};

describe("CoverageCell", () => {
  it("renders a single outcode as town + code with no rollup trigger", () => {
    render(<CoverageCell coverage={SINGLE} />);
    const cell = screen.getByTestId("agent-coverage");
    expect(cell).toHaveTextContent("Bangor");
    expect(cell).toHaveTextContent("LL57");
    expect(screen.queryByTestId("agent-coverage-roll")).not.toBeInTheDocument();
  });

  it("rolls a multi-outcode patch up to dominant region + count", () => {
    render(<CoverageCell coverage={GWYNEDD} />);
    const roll = screen.getByTestId("agent-coverage-roll");
    expect(roll).toHaveTextContent("Gwynedd");
    expect(roll).toHaveTextContent("3 outcodes");
    expect(roll).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a popover with the town breakdown and HQ footer on click", () => {
    render(<CoverageCell coverage={GWYNEDD} />);
    const roll = screen.getByTestId("agent-coverage-roll");
    fireEvent.click(roll);
    expect(roll).toHaveAttribute("aria-expanded", "true");

    const pop = screen.getByRole("dialog", { name: /coverage detail/i });
    expect(pop).toHaveTextContent("Covers");
    expect(pop).toHaveTextContent("3 outcodes");
    // Each town that the patch touches is a group heading.
    expect(within(pop).getByText("Bangor")).toBeInTheDocument();
    expect(within(pop).getByText("Caernarfon")).toBeInTheDocument();
    // The head-office footer names the primary (first) outcode + its town.
    expect(pop).toHaveTextContent(/Head office/i);
    expect(pop).toHaveTextContent("LL57");
  });

  it("stays open on a scroll inside the popover, closes on a page scroll", () => {
    render(<CoverageCell coverage={GWYNEDD} />);
    fireEvent.click(screen.getByTestId("agent-coverage-roll"));
    const pop = screen.getByRole("dialog");
    // A scroll INSIDE the popover must NOT close it (the reported bug).
    fireEvent.scroll(pop);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // A scroll of the page/table DOES close it (the fixed popover would detach).
    fireEvent.scroll(document);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("toggles the popover closed on a second trigger click", () => {
    render(<CoverageCell coverage={GWYNEDD} />);
    const roll = screen.getByTestId("agent-coverage-roll");
    fireEvent.click(roll);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(roll);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the popover on Escape and returns focus to the trigger", () => {
    render(<CoverageCell coverage={GWYNEDD} />);
    const roll = screen.getByTestId("agent-coverage-roll");
    fireEvent.click(roll);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(roll).toHaveFocus();
  });

  it("renders an em dash for an empty coverage list", () => {
    render(<CoverageCell coverage={EMPTY} />);
    expect(screen.getByTestId("agent-coverage")).toHaveTextContent("—");
    expect(screen.queryByTestId("agent-coverage-roll")).not.toBeInTheDocument();
  });
});
