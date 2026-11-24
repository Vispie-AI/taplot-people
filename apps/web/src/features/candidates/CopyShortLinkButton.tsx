"use client";

import { useTransition } from "react";
import { Link2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { toast } from "@/lib/notification-island/toast";
import { saveDirectoryFilterAction } from "@/features/candidates/short-link-actions";
import { buildSavedFilterShortUrl } from "@/features/candidates/short-links";
import type { DirectoryOriginFilters } from "@/features/candidates/origin";

/** Filters that actually narrow the list (sorting alone is not worth a link). */
export function hasShareableFilters(filters: DirectoryOriginFilters): boolean {
  return Object.keys(filters).some((key) => key !== "sort");
}

/**
 * "Copy short link": saves the current filters and copies `/v/<id>`, a link
 * short enough to read in a chat message.
 */
export function CopyShortLinkButton({ filters }: { filters: DirectoryOriginFilters }) {
  const t = useTranslations("candidates.table");
  const [pending, startTransition] = useTransition();

  if (!hasShareableFilters(filters)) return null;

  function copy() {
    startTransition(async () => {
      const result = await saveDirectoryFilterAction(filters);
      if (!result.success) {
        toast.error(t("shortLinkFailed"));
        return;
      }
      const url = buildSavedFilterShortUrl(window.location.origin, result.shortId);
      try {
        await navigator.clipboard.writeText(url);
        toast.success(`${t("shortLinkCopied")}: ${url}`);
      } catch {
        // Clipboard blocked (permissions, insecure origin): show the link instead.
        toast.success(url);
      }
    });
  }

  return (
    <Button
      type="button"
      variant="soft"
      className="h-9 rounded-full"
      onClick={copy}
      disabled={pending}
    >
      <Link2 className="size-4" />
      {t("copyShortLink")}
    </Button>
  );
}
