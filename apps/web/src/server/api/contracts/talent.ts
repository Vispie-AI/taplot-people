import { z } from "zod";

import { talentProfileInputSchema } from "@/features/talent/profile-input";

import { defineContract } from "./core";
import { errorEnvelopeSchema, successEnvelopeSchema } from "./types";

const evidenceSchema = z.object({
  field: z.string(),
  value: z.string().optional(),
  quote: z.string(),
});

const matchSchema = z.object({
  postingKey: z.string(),
  postingLabel: z.string().nullable(),
  jobId: z.string().uuid().nullable(),
  score: z.number().int(),
  tier: z.string().nullable(),
  reason: z.string().nullable(),
  evidence: z.array(z.object({ quote: z.string() })),
});

export const talentProfileSchema = z.object({
  candidateId: z.string().uuid(),
  name: z.string(),
  headline: z.string().nullable(),
  location: z.string().nullable(),
  url: z.string(),
  tagVersion: z.string(),
  engine: z.string(),
  model: z.string().nullable(),
  taggedAt: z.string(),
  city: z.string().nullable(),
  experienceYears: z.number().int().nullable(),
  education: z.string().nullable(),
  skills: z.array(z.string()),
  roles: z.array(z.string()),
  companies: z.array(z.string()),
  keyCompanies: z.array(z.string()),
  industries: z.array(z.string()),
  workKinds: z.array(z.string()),
  sourceChannels: z.array(z.string()),
  works: z.array(
    z.object({ kind: z.string(), title: z.string(), metric: z.string().optional() }),
  ),
  firstContactAt: z.string().nullable(),
  lastActiveAt: z.string().nullable(),
  contacted: z.boolean(),
  best: z.object({ postingKey: z.string(), score: z.number().int() }).nullable(),
  matches: z.array(matchSchema),
  evidence: z.array(evidenceSchema).optional(),
});

const candidateIdPath = z.object({ id: z.string().uuid() });

const list = (what: string) =>
  z
    .string()
    .max(1000)
    .optional()
    .describe(`Comma-separated ${what}; matches candidates having any of them.`);

export const talentSearchQuery = z.object({
  q: z
    .string()
    .max(100)
    .optional()
    .describe(
      "Keywords (space-separated, all must match) over tags, evidence quotes, works, headline, summary and name.",
    ),
  skills: list("skills (exact, case-insensitive)"),
  roles: list("roles (exact, case-insensitive)"),
  companies: list("employer names (substring)"),
  keyCompanies: list("key companies (substring)"),
  industries: list("industries (exact)"),
  workKinds: list("work kinds, e.g. 短剧作品"),
  sourceChannels: list("source channels, e.g. BOSS,LinkedIn"),
  education: list("education levels, e.g. 本科,硕士"),
  city: z.string().max(80).optional().describe("City (substring)."),
  minYears: z.coerce.number().int().min(0).max(60).optional(),
  maxYears: z.coerce.number().int().min(0).max(60).optional(),
  posting: z
    .string()
    .max(64)
    .optional()
    .describe("Posting key; restricts to candidates scored for it and sorts by that score."),
  minScore: z.coerce.number().int().min(0).max(10).optional(),
  contacted: z
    .enum(["true", "false"])
    .optional()
    .describe("false = never interviewed, messaged or moved to interview/offer/hired."),
  jobId: z.string().uuid().optional(),
  firstContactAfter: z.string().max(40).optional(),
  firstContactBefore: z.string().max(40).optional(),
  lastActiveAfter: z.string().max(40).optional(),
  lastActiveBefore: z.string().max(40).optional(),
  sort: z.enum(["score", "recent", "first_contact", "last_active"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  includeEvidence: z.enum(["true", "false"]).optional(),
});

export const getTalentProfileContract = defineContract({
  method: "GET",
  path: "/api/v1/candidates/{id}/talent-profile",
  operationId: "getCandidateTalentProfile",
  summary: "Get candidate talent profile",
  description:
    "Structured tags of one candidate (skills, roles, companies, key companies, industries, works, basics), per-posting match scores and the evidence quotes behind every tag.",
  tags: ["Talent"],
  auth: { scopes: ["talent:read"] },
  parameters: { path: candidateIdPath },
  responses: {
    200: successEnvelopeSchema(talentProfileSchema),
    401: errorEnvelopeSchema,
    403: errorEnvelopeSchema,
    404: errorEnvelopeSchema,
  },
});

export const putTalentProfileContract = defineContract({
  method: "PUT",
  path: "/api/v1/candidates/{id}/talent-profile",
  operationId: "putCandidateTalentProfile",
  summary: "Replace candidate talent profile",
  description:
    "Replace the candidate's talent profile and match scores. Every value in skills, roles, companies, keyCompanies, industries and works needs an evidence entry with the same field and value, and every match scoring 5 or more needs an evidence quote; otherwise the request fails with 422. Each write is recorded in the audit log.",
  tags: ["Talent"],
  auth: { scopes: ["talent:write"], keyTypes: ["secret"] },
  parameters: { path: candidateIdPath },
  requestBody: talentProfileInputSchema,
  responses: {
    200: successEnvelopeSchema(talentProfileSchema),
    201: successEnvelopeSchema(talentProfileSchema),
    401: errorEnvelopeSchema,
    403: errorEnvelopeSchema,
    404: errorEnvelopeSchema,
    422: errorEnvelopeSchema,
  },
});

export const deleteTalentProfileContract = defineContract({
  method: "DELETE",
  path: "/api/v1/candidates/{id}/talent-profile",
  operationId: "deleteCandidateTalentProfile",
  summary: "Delete candidate talent profile",
  tags: ["Talent"],
  auth: { scopes: ["talent:write"], keyTypes: ["secret"] },
  parameters: { path: candidateIdPath },
  responses: {
    200: successEnvelopeSchema(z.object({ deleted: z.boolean() })),
    401: errorEnvelopeSchema,
    403: errorEnvelopeSchema,
  },
});

export const searchTalentContract = defineContract({
  method: "GET",
  path: "/api/v1/talent/search",
  operationId: "searchTalent",
  summary: "Search talent profiles",
  description:
    "Filter candidates by structured tags, keywords, time ranges, posting match score and whether anyone has contacted them. Every result carries the candidate's app link.",
  tags: ["Talent"],
  auth: { scopes: ["talent:read"] },
  parameters: { query: talentSearchQuery },
  responses: {
    200: successEnvelopeSchema(
      z.object({
        total: z.number().int(),
        limit: z.number().int(),
        offset: z.number().int(),
        nextOffset: z.number().int().nullable(),
        candidates: z.array(talentProfileSchema),
      }),
    ),
    400: errorEnvelopeSchema,
    401: errorEnvelopeSchema,
    403: errorEnvelopeSchema,
  },
});

export const talentStatsSchema = z.object({
  candidates: z.number().int(),
  profiled: z.number().int(),
  postings: z.array(
    z.object({
      postingKey: z.string(),
      postingLabel: z.string().nullable(),
      scored: z.number().int(),
      atLeast5: z.number().int(),
      atLeast7: z.number().int(),
      atLeast7NotContacted: z.number().int(),
    }),
  ),
  sourceChannels: z.array(z.object({ channel: z.string(), candidates: z.number().int() })),
  weekly: z.array(
    z.object({
      weekStart: z.string(),
      newCandidates: z.number().int(),
      profiled: z.number().int(),
    }),
  ),
  keyCompanies: z.array(
    z.object({ company: z.string(), candidates: z.number().int(), atLeast7: z.number().int() }),
  ),
  roles: z.array(z.object({ role: z.string(), candidates: z.number().int() })),
});

export const talentStatsContract = defineContract({
  method: "GET",
  path: "/api/v1/talent/stats",
  operationId: "getTalentStats",
  summary: "Talent pool statistics",
  description:
    "Pool size per posting (scores of 5+ and 7+, and 7+ not yet contacted), source channels, new candidates per week (Asia/Shanghai weeks) and key-company coverage.",
  tags: ["Talent"],
  auth: { scopes: ["talent:read"] },
  parameters: {
    query: z.object({
      weeks: z.coerce.number().int().min(1).max(104).optional(),
      top: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: successEnvelopeSchema(talentStatsSchema),
    401: errorEnvelopeSchema,
    403: errorEnvelopeSchema,
  },
});


export const taggingInputSchema = z.object({
  candidateId: z.string().uuid(),
  firstName: z.string(),
  lastName: z.string(),
  headline: z.string().nullable(),
  summary: z.string().nullable(),
  location: z.string().nullable(),
  createdAt: z.string(),
  sources: z.array(z.string()),
  applications: z.array(
    z.object({
      jobId: z.string().uuid(),
      jobTitle: z.string(),
      source: z.string().nullable(),
      appliedAt: z.string().nullable(),
    }),
  ),
  firstAppliedAt: z.string().nullable(),
  lastAppliedAt: z.string().nullable(),
  resume: z
    .object({
      fileId: z.string().uuid(),
      fileName: z.string(),
      uploadedAt: z.string(),
      text: z.string().nullable(),
      truncated: z.boolean(),
      diagnostics: z.array(z.string()),
    })
    .nullable(),
  inputHash: z.string(),
  current: z
    .object({ tagVersion: z.string(), inputHash: z.string().nullable(), taggedAt: z.string() })
    .nullable(),
});

export const getTaggingInputContract = defineContract({
  method: "GET",
  path: "/api/v1/candidates/{id}/talent-input",
  operationId: "getCandidateTaggingInput",
  summary: "Get tagging input",
  description:
    "What a tagging service reads for one candidate: headline, summary, location, application sources and dates, and the newest resume's extracted text, with a hash to skip unchanged candidates. Secret keys with talent:write only.",
  tags: ["Talent"],
  auth: { scopes: ["talent:write"], keyTypes: ["secret"] },
  parameters: {
    path: candidateIdPath,
    query: z.object({
      maxChars: z.coerce.number().int().min(500).max(60000).optional(),
    }),
  },
  responses: {
    200: successEnvelopeSchema(taggingInputSchema),
    401: errorEnvelopeSchema,
    403: errorEnvelopeSchema,
    404: errorEnvelopeSchema,
  },
});

export const listTaggingCandidatesContract = defineContract({
  method: "GET",
  path: "/api/v1/talent/candidates",
  operationId: "listTaggingCandidates",
  summary: "List candidates to tag",
  description:
    "Candidate ids in a stable order for a tagging run, keyset-paged with `after`. `untagged=true` keeps candidates without a talent profile.",
  tags: ["Talent"],
  auth: { scopes: ["talent:write"], keyTypes: ["secret"] },
  parameters: {
    query: z.object({
      after: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(1000).optional(),
      untagged: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: successEnvelopeSchema(
      z.object({ ids: z.array(z.string().uuid()), next: z.string().uuid().nullable() }),
    ),
    401: errorEnvelopeSchema,
    403: errorEnvelopeSchema,
  },
});

export const talentContracts = [
  getTalentProfileContract,
  putTalentProfileContract,
  deleteTalentProfileContract,
  searchTalentContract,
  talentStatsContract,
  getTaggingInputContract,
  listTaggingCandidatesContract,
];
