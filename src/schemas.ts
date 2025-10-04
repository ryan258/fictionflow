import { z } from "zod";

export const Ratings = z.object({
  clarity: z.number().min(0).max(3),
  stakes: z.number().min(0).max(3),
  momentum: z.number().min(0).max(3),
  ending_resonance: z.number().min(0).max(3)
});

export const QuoteWhy = z.object({
  quote: z.string(),
  why: z.string(),
  fix_hint: z.enum(["structural","line"]).optional()
});

export const Critique = z.object({
  retell: z.string(),
  stakes: z.string(),
  confusions: z.array(QuoteWhy).default([]),
  strengths: z.array(QuoteWhy).default([]),
  ratings: Ratings
});

export const Plan = z.object({
  must_fix: z.array(z.object({
    issue: z.string(),
    evidence: z.array(z.string()),
    type: z.enum(["structural","line"])
  })).default([]),
  optional: z.array(z.string()).default([]),
  revision_plan: z.array(z.object({
    action: z.string(),
    target_span: z.string(),
    success_metric: z.string()
  })).max(3),
  gate: z.object({
    min_avg_scores: z.object({
      clarity: z.number(),
      stakes: z.number(),
      momentum: z.number(),
      ending_resonance: z.number()
    }),
    max_confusions: z.number()
  })
});

export const Retell = z.object({
  retell: z.string()
});
