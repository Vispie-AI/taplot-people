import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import en from "../../../messages/en.json";
import { AiScreeningCard } from "./AiScreeningCard";

function render(screenings: Parameters<typeof AiScreeningCard>[0]["screenings"]) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <AiScreeningCard screenings={screenings} />
    </NextIntlClientProvider>,
  );
}

describe("AI first-pass screen card", () => {
  it("shows verdict, reason, criteria, model and job", () => {
    const html = render([
      {
        jobTitle: "Narrative designer",
        sourceJobId: "recJOB1",
        verdict: "strong",
        reason: "Shipped two interactive dramas",
        criteria: [{ label: "Narrative", result: "yes", quote: "Wrote 12 episodes" }],
        model: "claude-opus-5-5",
        screenedAt: "2026-11-20T01:00:00.000Z",
      },
    ]);
    expect(html).toContain("AI first-pass screen");
    expect(html).toContain("Strong match");
    expect(html).toContain("Narrative designer");
    expect(html).toContain("Shipped two interactive dramas");
    expect(html).toContain("Narrative");
    expect(html).toContain("Wrote 12 episodes");
    expect(html).toContain("claude-opus-5-5");
    expect(html).not.toContain("features.candidates.AiScreeningCard");
  });

  it("renders nothing without a screen", () => {
    expect(render([])).toBe("");
  });
});
