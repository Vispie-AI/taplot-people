"use client";

import { useTranslations } from "next-intl";

import { Card } from "@/components/ui/card";
import { ShortDate } from "@/lib/date-hydration";

export type AiScreeningRow = {
  jobTitle: string | null;
  sourceJobId: string;
  verdict: "strong" | "maybe" | "no";
  reason: string | null;
  criteria: Array<{ label: string; result: string; quote?: string }>;
  model: string | null;
  screenedAt: string;
};

const VERDICT_STYLE: Record<AiScreeningRow["verdict"], string> = {
  strong: "bg-emerald-100 text-emerald-900",
  maybe: "bg-amber-100 text-amber-900",
  no: "bg-muted text-muted-foreground",
};

/**
 * Left-column card with the first-pass AI screens of this candidate: verdict,
 * the one-line reason, the criteria it checked, the model and when. Hidden when
 * the candidate has none. The reason and quotes are model-written text.
 */
export function AiScreeningCard({ screenings }: { screenings: AiScreeningRow[] }) {
  const t = useTranslations("features.candidates.AiScreeningCard");
  if (screenings.length === 0) return null;
  return (
    <Card className="gap-0 py-0" data-testid="ai-screening-card">
      <div className="px-5 py-4">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-near-ink">{t("title")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("hint")}</p>
      </div>
      <ul className="divide-y divide-hairline border-t border-hairline">
        {screenings.map((screening) => (
          <li key={screening.sourceJobId} className="space-y-2 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${VERDICT_STYLE[screening.verdict]}`}
                data-testid="ai-screening-verdict"
              >
                {t(`verdicts.${screening.verdict}`)}
              </span>
              {screening.jobTitle ? (
                <span className="text-sm text-near-ink">{screening.jobTitle}</span>
              ) : null}
              <span className="ml-auto text-xs text-muted-foreground">
                {t("screenedAt")} <ShortDate value={screening.screenedAt} />
                {screening.model ? ` · ${screening.model}` : ""}
              </span>
            </div>
            <p className="text-sm text-near-ink">{screening.reason ?? t("noReason")}</p>
            {screening.criteria.length > 0 ? (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {screening.criteria.map((criterion, index) => (
                  <li key={`${criterion.label}-${index}`}>
                    <span className="font-medium">{criterion.label}</span>
                    {" — "}
                    {t(`results.${criterion.result}` as never)}
                    {criterion.quote ? ` “${criterion.quote}”` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
