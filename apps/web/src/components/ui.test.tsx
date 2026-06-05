import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { Photo } from "./ui";

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
