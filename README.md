# Fictionflow (Node.js CLI)

A single-source starter to build a **bias-aware micro-fiction pipeline** with **deep POV enforcement** using OpenAI (writer/aggregator), Claude (focus group A), and OpenRouter (focus group B, default DeepSeek). It ships a deterministic loop with a **2-cycle max** so you publish instead of spiral.

> Flow: **logline → Story Bible → draft → two judges → aggregate plan → revise → retell test → publish gate**.

---

## 0) TL;DR — get running in minutes

```bash
# 1) New project
mkdir fictionflow && cd fictionflow && git init

# 2) Deps
npm init -y
npm i openai @anthropic-ai/sdk zod yargs chalk ora dotenv fs-extra yaml uuid
npm i -D typescript ts-node @types/node @types/yargs prettier

# 3) Scaffolding
mkdir -p src/prompts src/lib out config

# 4) Environment (.env)
cat > .env <<'ENV'
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=...
OPENROUTER_API_KEY=...
# Defaults (override via flags if you like)
WRITER_MODEL=openai/gpt-4o-mini
AGGREGATOR_MODEL=openai/gpt-5
JUDGE_A_MODEL=anthropic/claude-sonnet-4-5
JUDGE_B_MODEL=openrouter/deepseek/deepseek-chat
ENV

# 5) Config → Story Bible template
cat > config/bible.yaml <<'YAML'
premise: "A night janitor discovers the building forgets people who work late."
pov: first-person deep POV
tense: past
voice: minimal, concrete imagery, no purple prose, deep POV
theme: memory vs. erasure
constraints:
  - "≤180 words"
  - "no clichés"
  - "clear stakes"
  - "deep POV: no filter words (I saw, I heard, I felt, I thought)"
  - "direct sensory experience only"
  - "zero narrative distance"
beat_budget:
  setup: 40
  turn: 70
  aftershock: 60
  button: 10
must_include:
  - "a buzzing exit sign"
  - "a coffee stain shaped like a country"
  - "a name-tag with the wrong name"
off_limits:
  - "amnesia as a diagnosis"
YAML

# 6) Minimal TypeScript config
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
JSON

# 7) NPM scripts
jq '.scripts={"dev":"ts-node src/cli.ts","build":"tsc","start":"node dist/cli.js"}' package.json > package.tmp && mv package.tmp package.json || true

# 8) (If you have the scaffold) Run end-to-end
# Build (optional) and run
npx ts-node src/cli.ts run --bible config/bible.yaml --out out/
```

> **Note**: If you prefer plain JS, skip TypeScript/ts-node and name files `.js`.

---

## 1) What this project does

- **Drafts** a micro-fiction piece in **deep POV** from a Story Bible using **OpenAI writer** (default `openai/gpt-4o-mini`).
- Runs two **independent focus groups** (Claude + OpenRouter/DeepSeek) that return **quote-bound JSON** critiques—no rewrites. Both judges **flag filter words** (I saw/heard/felt/thought) as POV violations.
- **Aggregates** only **overlapping issues** into a short plan with a **publish gate** (OpenAI aggregator, default `gpt-5`).
- Applies a **must-fix-only revision**, then a **retell test** (both judges summarize in 2 sentences).
- Generates a final **title** and packages the story artifacts per run.
- Decides **Publish: YES/NO** using thresholds + retell agreement. **Max two cycles.**

**Why:** avoids judge‑gaming, reduces indecision, keeps the story tight (≤180w, beat budget), and enforces zero narrative distance through deep POV.

---

## 2) Deep POV Enforcement

**What is Deep POV?** Deep POV (deep point of view) eliminates narrative distance by removing filter words that separate the reader from direct experience.

**Filter words to avoid:**
- ❌ I saw, I heard, I felt, I thought
- ❌ I noticed, I realized, I wondered, I knew

**Instead, show direct experience:**
- ✅ "The exit sign buzzed" (not "I heard the exit sign buzzing")
- ✅ "My chest tightened" (not "I felt my chest tighten")
- ✅ "The name tag read 'Marcus'" (not "I saw the name tag said 'Marcus'")

**How the pipeline enforces it:**
1. **Writer** is instructed to write in deep POV with zero filter words
2. **Both judges** flag any filter words or narrative distance as confusions
3. **Aggregator** surfaces overlapping POV violations as must-fix issues
4. **Revision** removes filter words while maintaining the story

This creates immersive, visceral micro-fiction that puts readers directly inside the narrator's experience.

---

## 3) Command design (CLI spec)

Use `yargs`. All commands accept `--verbose`, `--speak` (optional macOS TTS), and `--dry` (no API calls).

### `run`

End-to-end: `draft → critique(A,B) → aggregate → revise → retell → gate`.
Artifacts land in a numbered run directory (e.g. `out/001_title-slug/`) with incrementally prefixed files (`01-draft.md`, `02-critique_claude.json`, … `10-metadata.json`) so everything stays in order alongside the titled `published.md`.

```bash
npx ts-node src/cli.ts run --bible config/bible.yaml --out out/ [--seed out/seed.md]
```

### `draft`

Create a first draft from the Story Bible.

```bash
npx ts-node src/cli.ts draft --bible config/bible.yaml --out out/draft.md [--writer $WRITER_MODEL]
```

### `critique`

Run **Focus Group A** (Claude) and **B** (OpenRouter/DeepSeek). Deterministic (temperature 0). Saves: `out/critique_claude.json`, `out/critique_deepseek.json`.

```bash
npx ts-node src/cli.ts critique --story out/draft.md --out out/ \
  [--judgeA $JUDGE_A_MODEL] [--judgeB $JUDGE_B_MODEL]
```

### `aggregate`

Merge **overlapping** issues into a concise plan + publish gate (OpenAI). Saves `out/plan.json`.

```bash
npx ts-node src/cli.ts aggregate --story out/draft.md \
  --a out/critique_claude.json --b out/critique_deepseek.json \
  --out out/plan.json [--model $AGGREGATOR_MODEL]
```

### `revise`

Apply **must\_fix only** from the plan. Keep ≤180 words and beat tags. Saves `out/revised.md`.

```bash
npx ts-node src/cli.ts revise --bible config/bible.yaml --story out/draft.md \
  --plan out/plan.json --out out/revised.md [--writer $WRITER_MODEL]
```

### `retell`

Ask both judges for a 2-sentence retell; saves `out/retell_claude.json`, `out/retell_deepseek.json`.

```bash
npx ts-node src/cli.ts retell --story out/revised.md --out out/
```

### `gate`

Decide publish/no based on averages, confusion count, and retell match.

```bash
npx ts-node src/cli.ts gate \
  --a out/critique_claude.json --b out/critique_deepseek.json \
  --ra out/retell_claude.json --rb out/retell_deepseek.json
```

---

## 4) Prompts (short + deterministic)

### Writer (OpenAI)

```
You are a micro‑fiction writer specializing in deep POV.
Constraints: ≤180 words, 1st‑person past deep POV, clear stakes, concrete images, no clichés.
Deep POV rules: NO filter words (I saw/heard/felt/thought/noticed/realized). Direct sensory experience only. Zero narrative distance.
Beats: [SETUP 40w] [TURN 70w] [AFTERSHOCK 60w] [BUTTON ≤10w].
Story Bible:
{BIBLE_JSON}

Draft only with beat tags; no explanations.
```

### Focus Group (Claude/OpenRouter) — **no rewrites**

```
Role: Critical but fair focus group. Do NOT rewrite the story.
Return JSON only:
{
  "retell": "2-sentence literal summary of what happens",
  "stakes": "1 sentence: what the narrator wants / what's in the way",
  "confusions": [{"quote":"...","why":"...","fix_hint":"structural|line"}],
  "strengths": [{"quote":"...","why":"..."}],
  "ratings": {"clarity":0-3,"stakes":0-3,"momentum":0-3,"ending_resonance":0-3}
}
Rules: Quote exact spans for each confusion/strength. No style judgements without a quote.
Deep POV check: Flag any filter words (I saw, I heard, I felt, I thought, I noticed, I realized) or narrative distance as confusions.
```

### Aggregator (OpenAI)

```
You are an impartial aggregator. Think silently; output JSON only with keys:
{
  "must_fix": [{"issue":"...","evidence":["A:quote","B:quote"],"type":"structural|line"}],
  "optional": ["..."],
  "revision_plan": [
    {"action":"...","target_span":"...","success_metric":"retells match across judges"}
  ],
  "gate": {"min_avg_scores":{"clarity":2.5,"stakes":2.5,"momentum":2.5,"ending_resonance":2.5},"max_confusions":2}
}
Do not copy judge wording; use plain language.
```

### Retell-only (both judges)

```
Return only: {"retell": "2 sentences"}.
```

### Title (model-agnostic)

```
You are titling a micro-fiction story. Read the story and return a concise, evocative title no longer than six words. Avoid quotation marks or trailing punctuation.
```

---

## 5) JSON Schemas (Zod)

Create `src/schemas.ts`:

```ts
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
    min_avg_scores: z.object({ clarity: z.number(), stakes: z.number(), momentum: z.number(), ending_resonance: z.number() }),
    max_confusions: z.number()
  })
});
```

---

## 6) File layout

```
fictionflow/
  ├─ src/
  │   ├─ cli.ts               # provided scaffold
  │   ├─ schemas.ts           # Zod schemas
  │   ├─ lib/
  │   │   ├─ model-router.ts  # Provider-prefixed router (OpenAI/Anthropic/OpenRouter)
  │   │   └─ clients.ts       # Optional direct SDK helpers
  │   └─ prompts/
  │       ├─ writer.txt
  │       ├─ focus_group.txt
  │       ├─ aggregator.txt
  │       ├─ retell.txt
  │       └─ title.txt
  ├─ config/
  │   └─ bible.yaml
  ├─ out/                     # artifacts
  ├─ .env
  ├─ tsconfig.json
  └─ package.json
```

---

## 7) Implementation plan (for Codex/Claude Code)

1. **Wire CLI** with `yargs` commands above; keep options short & typed.
2. **Model routing** in `src/lib/model-router.ts`:
   - Accept `provider/model` strings (`openai/`, `anthropic/`, `openrouter/`).
   - Invoke the right SDK (OpenRouter piggybacks on the OpenAI client). Keep judges at `temperature: 0` when requesting JSON.
3. **Prompts** as text files; load & template with Bible/Story.
4. **Validation**: parse JSON with Zod; on failure, save raw text and **retry once** with a “return valid JSON” reminder.
5. **Publish gate**: avg of both judge ratings ≥ 2.5, `confusions_total ≤ 2`, and **retell match** (exact string compare after trim).
6. **Loop limit**: `run` performs at most **two** `revise → retell → gate` cycles.
7. **Per-run packaging**: store artifacts in `out/<index>_<slug>/`, include `metadata.json`, `title.txt`, and prepend the title to `published.md`.
8. **Exit codes**: non-zero on API error or invalid JSON after retry; print clear blockers.

**Acceptance criteria**

- `run` outputs live in a numbered directory with prefixed filenames (`01-draft.md`, `02-critique_claude.json`, …, `10-metadata.json`) plus a titled `published.md` when the gate passes.
- Judges never rewrite; critiques must quote spans.
- Aggregator includes only **overlapping issues** (or logically equivalent) with quotes from both.

---

## 8) Accessibility & productivity

- `--speak` flag for progress cues (macOS `say`); otherwise no‑op.
- `--verbose` to echo prompts/model names.
- `--dry` mode to simulate without API calls.
- One‑command flow to reduce context switching on low‑energy days.

---

## 9) Troubleshooting

- **Invalid JSON** from a judge → write `*_raw.txt`, retry once with a JSON‑strict reminder.
- **Retells don’t match** → Aggregator should target the confused span in `revision_plan`.
- **Slow/costly** → change models via env; try smaller OpenAI or OpenRouter variants for drafting.
- **403/keys** → confirm `.env` is loaded (Node `dotenv`) and model names are available in your account/region.

---

## 10) License

MIT (or your choice). Add a `LICENSE` file if publishing.

---

## Appendix — One‑shot request for Codex or Claude Code

Use this as the **single task** to generate remaining files:

> **“Create a Node.js CLI in **``** named **``** that implements commands **``**, **``**, **``**, **``**, **``**, **``**, and **``** exactly as specified in README. Add **``** wrapping OpenAI/Anthropic/OpenRouter SDKs, Zod schemas in **``**, and prompt text files in **``**. Validate judge outputs against **``**; aggregator against **``**; retry once on invalid JSON. Save artifacts to **``**. Provide **``** and NPM scripts (**``**, **``**, **``**). Deterministic judges (temperature=0). Include a **``** flag using macOS **``** when available.”**

---

### Next

Paste your **logline** and we’ll convert it into a Story Bible YAML you can drop into `config/bible.yaml`. Then run:

```bash
npx ts-node src/cli.ts run --bible config/bible.yaml --out out/
```
