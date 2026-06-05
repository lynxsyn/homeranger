import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { Photo, ScoreRing, scoreTone } from "./ui";

describe("scoreTone", () => {
  it("bands the match score strong / fair / weak (and pending for null)", () => {
    expect(scoreTone(100)).toBe("strong");
    expect(scoreTone(70)).toBe("strong");
    expect(scoreTone(69)).toBe("fair");
    expect(scoreTone(50)).toBe("fair");
    expect(scoreTone(49)).toBe("weak");
    expect(scoreTone(0)).toBe("weak");
    expect(scoreTone(null)).toBe("pending");
  });
});

describe("ScoreRing colour", () => {
  const fill = (el: Element | null) =>
    (el as HTMLElement).style.getPropertyValue("--score-fill").trim();

  it("fills green for a strong score, amber for fair, red for weak", () => {
    const strong = render(<ScoreRing value={82} />);
    expect(fill(strong.container.querySelector(".hs-score__ring"))).toBe(
      "var(--success)",
    );
    const fair = render(<ScoreRing value={58} />);
    expect(fill(fair.container.querySelector(".hs-score__ring"))).toBe(
      "var(--warning)",
    );
    const weak = render(<ScoreRing value={31} />);
    expect(fill(weak.container.querySelector(".hs-score__ring"))).toBe(
      "var(--danger)",
    );
  });

  it("renders a pending dash with no score-fill when value is null", () => {
    const { container } = render(<ScoreRing value={null} />);
    expect(container.querySelector(".hs-score__num")).toHaveTextContent("–");
    expect(fill(container.querySelector(".hs-score__ring"))).toBe("");
  });
});

describe("Photo", () => {
  it("renders the placeholder glyph (no img) when src is absent", () => {
    const { container } = render(<Photo />);
    expect(container.querySelector("img.hs-photo__img")).toBeNull();
    expect(container.querySelector("svg")).toBeInTheDocument(); // the image glyph
  });

  it("hotlinks the source image from src (lazy, no-referrer)", () => {
    const { container } = render(<Photo src="https://cdn.test/a.jpg" />);
    const img = container.querySelector("img.hs-photo__img");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "https://cdn.test/a.jpg");
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("falls back to the placeholder when the hotlink fails (onError)", () => {
    const { container } = render(<Photo src="https://cdn.test/broken.jpg" />);
    fireEvent.error(container.querySelector("img.hs-photo__img")!);
    expect(container.querySelector("img.hs-photo__img")).toBeNull();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("re-attempts a NEW src after a prior failure (broken state resets on src change)", () => {
    const { container, rerender } = render(
      <Photo src="https://cdn.test/broken.jpg" />,
    );
    fireEvent.error(container.querySelector("img.hs-photo__img")!);
    expect(container.querySelector("img.hs-photo__img")).toBeNull(); // fell back
    // A re-used row whose listing got a new image URL on a later scrape.
    rerender(<Photo src="https://cdn.test/fresh.jpg" />);
    const img = container.querySelector("img.hs-photo__img");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "https://cdn.test/fresh.jpg");
  });
});
