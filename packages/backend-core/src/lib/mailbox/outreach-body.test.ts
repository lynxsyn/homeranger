import { describe, expect, it } from "vitest";
import { analyzeOutreachBody } from "./outreach-body.js";

describe("analyzeOutreachBody", () => {
  it("reports the HTML length and absent flags for a clean body", () => {
    const a = analyzeOutreachBody({
      text: "Hello, I am a private buyer. To stop these, unsubscribe here: ...",
      html: "<p>Hello</p>",
    });
    expect(a.htmlLength).toBe("<p>Hello</p>".length);
    expect(a.hasEmDash).toBe(false);
    expect(a.hasUnsubscribe).toBe(true);
  });

  it("flags an em dash or en dash anywhere in the copy (AI tell)", () => {
    expect(analyzeOutreachBody({ text: "a — b" }).hasEmDash).toBe(true);
    expect(analyzeOutreachBody({ text: "", html: "<p>a – b</p>" }).hasEmDash).toBe(
      true,
    );
    expect(analyzeOutreachBody({ text: "a - b" }).hasEmDash).toBe(false);
  });

  it("flags a MISSING unsubscribe affordance (compliance)", () => {
    expect(analyzeOutreachBody({ text: "no opt out here" }).hasUnsubscribe).toBe(
      false,
    );
    expect(
      analyzeOutreachBody({ html: "<a>Unsubscribe</a>" }).hasUnsubscribe,
    ).toBe(true);
  });

  it("treats null/undefined parts as empty", () => {
    const a = analyzeOutreachBody({ text: null, html: null });
    expect(a).toEqual({ htmlLength: 0, hasEmDash: false, hasUnsubscribe: false });
    expect(analyzeOutreachBody({}).htmlLength).toBe(0);
  });
});
