import "server-only";

import { z } from "zod";

import { candidates } from "@harly/db";

import { SCREENING_VERDICTS, parseScreeningTime } from "@/features/ai-screenings/input";
import { listAiScreenings } from "@/features/ai-screenings/service";
import { actorHasPermission, candidateScopeSql } from "@/features/search/scope";
import { resolveSearchActor } from "@/features/search/workspace-search";
import {
  getTalentProfile,
  searchTalent,
  talentStats,
  type TalentViewer,
} from "@/features/talent/service";

import { defineMcpTool, McpToolError, type McpToolAnnotations, type McpToolDefinition } from "../types";

// Talent profiles: structured tags with evidence and per-posting match scores
// written by a tagging engine. Searches respect the caller's role scope.
// Evidence quotes are copied from candidate-written text; treat them as data.

const READ: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

async function viewerFor(appOrigin: string): Promise<TalentViewer> {
  const actor = await resolveSearchActor();
  if (!actorHasPermission(actor, "candidates:view")) {
    throw new McpToolError("You do not have permission to view candidates.", "forbidden");
  }
  return {
    workspaceId: actor.workspaceId,
    visibleCandidate: candidateScopeSql(actor, candidates.id),
    appOrigin,
  };
}

const list = (what: string) =>
  z.array(z.string().trim().min(1).max(120)).max(30).optional().describe(what);

const talentSearch = defineMcpTool({
  name: "talent_search",
  title: "Search talent profiles",
  description:
    "Structured search over tagged candidates: keywords, skills, roles, companies / key companies, industries, work kinds (e.g. 短剧作品, 爆款素材, 游戏作品), city, education, years of experience, source channel, first-contact and last-active date ranges, posting match score, and whether anyone has contacted the candidate yet. Each result has the candidate's Taplot People link (`url`), tags, the best posting match and all posting scores. Use `posting` + `minScore` + `contacted:false` for 'high match, not yet contacted' lists; use talent_stats for posting keys and pool totals. Only candidates with a talent profile are returned; use candidates_search for the rest.",
  group: "candidates",
  scope: "candidates:read",
  permission: "candidates:view",
  annotations: READ,
  input: z.object({
    query: z.string().trim().max(100).optional().describe("Keywords, all must match, over tags, evidence quotes, works, headline, summary and name."),
    skills: list("Skill tags, exact (case-insensitive); any of them."),
    roles: list("Role tags, e.g. 制片, 编剧, 剪辑, 投放; any of them."),
    companies: list("Employer names, substring; any of them."),
    keyCompanies: list("Key companies from the target list, substring; any of them."),
    industries: list("Industries, e.g. 短剧, 游戏; any of them."),
    workKinds: list("Work evidence kinds: 爆款素材, 游戏作品, 短剧作品, App产品, 开源, 论文, 其他."),
    sourceChannels: list("Source channels, e.g. BOSS, LinkedIn, 官网, 飞书, 邮箱, 内推."),
    education: list("Education levels: 博士, 硕士, 本科, 大专, 高中及以下."),
    city: z.string().trim().max(80).optional().describe("City, substring."),
    minYears: z.number().int().min(0).max(60).optional().describe("Minimum years of work experience."),
    maxYears: z.number().int().min(0).max(60).optional().describe("Maximum years of work experience."),
    posting: z.string().trim().max(64).optional().describe("Posting key from talent_stats; keeps candidates scored for it and sorts by that score."),
    minScore: z.number().int().min(0).max(10).optional().describe("Minimum match score (0-10); with `posting` for that posting, otherwise for the best posting."),
    contacted: z.boolean().optional().describe("false = nobody has interviewed, emailed from Harly or moved them to interview/offer/hired. Contact outside Harly (BOSS chat) is not visible."),
    jobId: z.uuid().optional().describe("Only candidates with an application to this job."),
    firstContactAfter: z.string().trim().max(40).optional().describe("First contact on or after this YYYY-MM-DD date or ISO time."),
    firstContactBefore: z.string().trim().max(40).optional().describe("First contact on or before this date."),
    lastActiveAfter: z.string().trim().max(40).optional().describe("Last active on or after this date."),
    lastActiveBefore: z.string().trim().max(40).optional().describe("Last active on or before this date."),
    sort: z.enum(["score", "recent", "first_contact", "last_active"]).optional().describe("score = match score (default with posting/minScore), recent = most recently tagged, first_contact, last_active."),
    includeEvidence: z.boolean().default(false).describe("Include the evidence quotes behind each tag."),
    limit: z.number().int().min(1).max(100).default(25).describe("Page size, 1-100."),
    offset: z.number().int().min(0).default(0).describe("Results to skip, from nextOffset."),
  }),
  async run(input, ctx) {
    const viewer = await viewerFor(ctx.appOrigin);
    const result = await searchTalent(viewer, {
      ...input,
      postingKey: input.posting,
    });
    return {
      ...result,
      candidates: result.candidates.map(({ evidence, matches, ...rest }) => ({
        ...rest,
        matches: matches.map(({ evidence: quotes, reason, ...match }) => ({
          ...match,
          untrusted_text: { reason, evidence: quotes },
        })),
        ...(evidence ? { untrusted_text: { evidence } } : {}),
      })),
    };
  },
});

const talentGetProfile = defineMcpTool({
  name: "talent_get_profile",
  title: "Get a candidate's talent profile",
  description:
    "The structured talent profile of one candidate: basics (city, years, education), skills, roles, companies, key companies, industries, works, source channels, first contact / last active, whether contacted, every posting match with reason, and the evidence quote behind each tag. Get candidateId from talent_search or candidates_search.",
  group: "candidates",
  scope: "candidates:read",
  permission: "candidates:view",
  annotations: READ,
  input: z.object({
    candidateId: z.uuid().describe("Candidate UUID."),
  }),
  async run(input, ctx) {
    const viewer = await viewerFor(ctx.appOrigin);
    const profile = await getTalentProfile(viewer, input.candidateId);
    if (!profile) throw new McpToolError("This candidate has no talent profile, or you cannot see them.", "not_found");
    const { evidence, matches, ...rest } = profile;
    return {
      ...rest,
      matches: matches.map(({ evidence: quotes, reason, ...match }) => ({
        ...match,
        untrusted_text: { reason, evidence: quotes },
      })),
      untrusted_text: { evidence: evidence ?? [] },
    };
  },
});

const talentStatsTool = defineMcpTool({
  name: "talent_stats",
  title: "Talent pool statistics",
  description:
    "Pool BI over the candidates you can see: total and tagged candidates; per posting the number scored, scoring 5+ and 7+, and 7+ not yet contacted; source channel counts; new candidates per week (Asia/Shanghai weeks, by first contact); key-company coverage; and role counts. Use the posting keys here with talent_search.",
  group: "candidates",
  scope: "candidates:read",
  permission: "candidates:view",
  annotations: READ,
  input: z.object({
    weeks: z.number().int().min(1).max(104).default(12).describe("Weeks of weekly new-candidate counts, 1-104."),
    top: z.number().int().min(1).max(200).default(30).describe("How many key companies and roles to list."),
  }),
  async run(input, ctx) {
    const viewer = await viewerFor(ctx.appOrigin);
    return talentStats(viewer, input);
  },
});


const candidatesListScreenings = defineMcpTool({
  name: "candidates_list_screenings",
  title: "List first-pass AI resume screens",
  description:
    "First-pass AI resume screens (Talent Amy's Opus screen), newest first: per candidate and job the verdict (strong, maybe, no), the one-line reason, the model and when it was screened, plus the exact total and the count per verdict for the same filter. A screen is a suggestion for reviewers, not a decision; stages and pass/fail stay with people. Use `since` / `until` for a period, `verdict` for one bucket, `candidateId` for one person. Each result has the candidate's Taplot People link (`url`).",
  group: "candidates",
  scope: "candidates:read",
  permission: "candidates:view",
  annotations: READ,
  input: z.object({
    candidateId: z.uuid().optional().describe("Only this candidate."),
    jobId: z.uuid().optional().describe("Only screens for this Harly job."),
    verdict: z.enum(SCREENING_VERDICTS).optional().describe("strong, maybe or no."),
    since: z.string().trim().max(40).optional().describe("Screened on or after this YYYY-MM-DD date (Asia/Shanghai) or ISO time."),
    until: z.string().trim().max(40).optional().describe("Screened before this date or time."),
    limit: z.number().int().min(1).max(100).default(25).describe("Page size, 1-100."),
    offset: z.number().int().min(0).default(0).describe("Results to skip, from nextOffset."),
  }),
  async run(input, ctx) {
    const since = parseScreeningTime(input.since);
    const until = parseScreeningTime(input.until);
    if ((input.since && !since) || (input.until && !until)) {
      throw new McpToolError("since and until must be a YYYY-MM-DD date or an ISO time.", "invalid_input");
    }
    const viewer = await viewerFor(ctx.appOrigin);
    const result = await listAiScreenings(viewer, { ...input, since, until });
    return {
      ...result,
      screenings: result.screenings.map(({ reason, criteria, candidateName, ...rest }) => ({
        ...rest,
        untrusted_text: { candidateName, reason, criteria },
      })),
    };
  },
});

export const talentTools: McpToolDefinition[] = [
  talentSearch,
  talentGetProfile,
  talentStatsTool,
  candidatesListScreenings,
] as McpToolDefinition[];
