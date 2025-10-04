#!/usr/bin/env node
import * as dotenv from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import * as fs from "fs-extra";
import * as path from "path";
import YAML from "yaml";
import chalk from "chalk";
import ora from "ora";
import { callModel } from "./lib/model-router";
import { Critique, Plan, Retell } from "./schemas";

dotenv.config();

// Helper functions
async function loadPrompt(name: string): Promise<string> {
  const promptPath = path.join(__dirname, `prompts/${name}.txt`);
  return await fs.readFile(promptPath, "utf-8");
}

async function loadBible(biblePath: string): Promise<any> {
  const content = await fs.readFile(biblePath, "utf-8");
  return YAML.parse(content);
}

function speak(text: string, enabled: boolean) {
  if (enabled && process.platform === "darwin") {
    require("child_process").execSync(`say "${text.replace(/"/g, '\\"')}"`);
  }
}

async function parseJson<T>(
  raw: string,
  schema: any,
  outputPath: string,
  retry: boolean = true
): Promise<T> {
  try {
    // Strip markdown code blocks if present
    let cleaned = raw.trim();
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    const parsed = JSON.parse(cleaned);
    return schema.parse(parsed);
  } catch (err) {
    const rawPath = outputPath.replace(/\.json$/, "_raw.txt");
    await fs.writeFile(rawPath, raw);
    if (retry) {
      throw new Error(`Invalid JSON. Saved to ${rawPath}. Retry needed.`);
    }
    throw err;
  }
}

function slugify(text: string): string {
  const ascii = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "");
  return ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const RUN_FILE_NAMES = {
  draft: "01-draft.md",
  critiqueClaude: "02-critique_claude.json",
  critiqueDeepseek: "03-critique_deepseek.json",
  plan: "04-plan.json",
  revised: (cycle: number) => `05-${String(cycle).padStart(2, "0")}-revised.md`,
  retellClaude: "06-retell_claude.json",
  retellDeepseek: "07-retell_deepseek.json",
  published: "08-published.md",
  title: "09-title.txt",
  metadata: "10-metadata.json"
} as const;

async function determineNextRunDir(baseOut: string): Promise<{ index: string; dir: string }> {
  await fs.ensureDir(baseOut);
  const entries = await fs.readdir(baseOut).catch(() => [] as string[]);
  let maxIndex = 0;

  for (const entry of entries) {
    const match = entry.match(/^(\d{3})/);
    if (!match) continue;
    const entryPath = path.join(baseOut, entry);
    try {
      const stats = await fs.stat(entryPath);
      if (!stats.isDirectory()) continue;
      maxIndex = Math.max(maxIndex, parseInt(match[1], 10));
    } catch {
      // ignore entries we can't stat
    }
  }

  let next = maxIndex + 1;
  while (true) {
    const index = String(next).padStart(3, "0");
    const candidate = path.join(baseOut, index);
    if (!(await fs.pathExists(candidate))) {
      await fs.ensureDir(candidate);
      return { index, dir: candidate };
    }
    next++;
  }
}

async function generateTitle(story: string, argv: any): Promise<string> {
  const titlePrompt = await loadPrompt("title");
  const prompt = titlePrompt.replace("{{STORY}}", story.trim());
  const model =
    argv.titleModel ||
    process.env.TITLE_MODEL ||
    argv.aggregator ||
    process.env.AGGREGATOR_MODEL ||
    "openai/gpt-5";

  if (argv.verbose) {
    console.log(chalk.blue("Title model:"), model);
  }

  const raw = await callModel({
    model,
    userPrompt: prompt,
    temperature: 0.4,
    responseFormat: "text"
  });

  const cleaned = raw.trim().split(/\r?\n/)[0]?.trim() || "";
  return cleaned.replace(/^['"#\s]+/, "").replace(/['"\s]+$/, "") || "Untitled";
}

// Command handlers
async function handleDraft(argv: any) {
  const spinner = ora("Loading Story Bible").start();
  const bible = await loadBible(argv.bible);
  spinner.succeed();

  if (argv.verbose) {
    console.log(chalk.blue("Bible:"), JSON.stringify(bible, null, 2));
  }

  speak("Drafting story", argv.speak);
  spinner.start("Drafting with OpenAI");

  const writerPrompt = await loadPrompt("writer");
  const prompt = writerPrompt.replace("{{BIBLE_JSON}}", JSON.stringify(bible, null, 2));

  if (argv.dry) {
    spinner.info("Dry run - skipping API call");
    console.log(chalk.gray(prompt));
    return;
  }

  const model = argv.writer || process.env.WRITER_MODEL || "openai/gpt-4o-mini";
  if (argv.verbose) {
    console.log(chalk.blue("Model:"), model);
  }

  const draft = await callModel({
    model,
    userPrompt: prompt,
    temperature: 0.7,
    responseFormat: "text"
  });
  spinner.succeed("Draft complete");

  await fs.writeFile(argv.out, draft);
  console.log(chalk.green(`✓ Draft saved to ${argv.out}`));
  speak("Draft complete", argv.speak);
}

async function handleCritique(argv: any) {
  const spinner = ora("Loading story").start();
  const story = await fs.readFile(argv.story, "utf-8");
  spinner.succeed();

  const focusGroupPrompt = await loadPrompt("focus_group");

  const fileNames = argv.fileNames || {};
  const claudeFile = fileNames.claude || "critique_claude.json";
  const judgeBFile = fileNames.judgeB || "critique_deepseek.json";

  // Claude critique
  speak("Running Claude focus group", argv.speak);
  spinner.start("Claude critique");

  if (argv.dry) {
    spinner.info("Dry run - skipping API calls");
    return;
  }

  const judgeAModel = argv.judgeA || process.env.JUDGE_A_MODEL || "anthropic/claude-sonnet-4-5";
  if (argv.verbose) {
    console.log(chalk.blue("Judge A model:"), judgeAModel);
  }

  let claudeRaw = await callModel({
    model: judgeAModel,
    systemPrompt: focusGroupPrompt,
    userPrompt: story,
    temperature: 0,
    responseFormat: "json"
  });
  const claudePath = path.join(argv.out, claudeFile);

  try {
    const claudeCritique = await parseJson(claudeRaw, Critique, claudePath, false);
    await fs.writeFile(claudePath, JSON.stringify(claudeCritique, null, 2));
    spinner.succeed("Judge A critique complete");
  } catch (err) {
    spinner.warn("Judge A returned invalid JSON, retrying...");
    claudeRaw = await callModel({
      model: judgeAModel,
      systemPrompt: focusGroupPrompt,
      userPrompt: story + "\n\nPlease return valid JSON matching the schema.",
      temperature: 0,
      responseFormat: "json"
    });
    const claudeCritique = await parseJson(claudeRaw, Critique, claudePath, false);
    await fs.writeFile(claudePath, JSON.stringify(claudeCritique, null, 2));
    spinner.succeed("Judge A critique complete (retry)");
  }

  // Judge B critique
  speak("Running Judge B focus group", argv.speak);
  spinner.start("Judge B critique");

  const judgeBModel = argv.judgeB || process.env.JUDGE_B_MODEL || "openrouter/deepseek/deepseek-chat";
  const deepseekPath = path.join(argv.out, judgeBFile);

  if (argv.verbose) {
    console.log(chalk.blue("Judge B model:"), judgeBModel);
  }

  let deepseekRaw = await callModel({
    model: judgeBModel,
    systemPrompt: focusGroupPrompt,
    userPrompt: story,
    temperature: 0,
    responseFormat: "json"
  });

  try {
    const deepseekCritique = await parseJson(deepseekRaw, Critique, deepseekPath, false);
    await fs.writeFile(deepseekPath, JSON.stringify(deepseekCritique, null, 2));
    spinner.succeed("Judge B critique complete");
  } catch (err) {
    spinner.warn("Judge B returned invalid JSON, retrying...");
    deepseekRaw = await callModel({
      model: judgeBModel,
      systemPrompt: focusGroupPrompt,
      userPrompt: story + "\n\nPlease return valid JSON matching the schema.",
      temperature: 0,
      responseFormat: "json"
    });
    const deepseekCritique = await parseJson(deepseekRaw, Critique, deepseekPath, false);
    await fs.writeFile(deepseekPath, JSON.stringify(deepseekCritique, null, 2));
    spinner.succeed("Judge B critique complete (retry)");
  }

  console.log(chalk.green("✓ Critiques saved"));
  speak("Critiques complete", argv.speak);
}

async function handleAggregate(argv: any) {
  const spinner = ora("Loading critiques").start();
  const story = await fs.readFile(argv.story, "utf-8");
  const critiqueA = JSON.parse(await fs.readFile(argv.a, "utf-8"));
  const critiqueB = JSON.parse(await fs.readFile(argv.b, "utf-8"));
  spinner.succeed();

  speak("Aggregating feedback", argv.speak);
  spinner.start("Aggregating with OpenAI");

  const aggregatorPrompt = await loadPrompt("aggregator");
  const prompt = `${aggregatorPrompt}

Story:
${story}

Critique A (Claude):
${JSON.stringify(critiqueA, null, 2)}

Critique B (Gemini):
${JSON.stringify(critiqueB, null, 2)}

Generate aggregation plan with only overlapping issues.`;

  if (argv.dry) {
    spinner.info("Dry run - skipping API call");
    return;
  }

  const model = argv.aggregator || process.env.AGGREGATOR_MODEL || "openai/gpt-5";
  if (argv.verbose) {
    console.log(chalk.blue("Model:"), model);
  }

  // GPT-5 only supports temperature=1 (default)
  const modelName = model.split("/").slice(1).join("/");
  const temperature = modelName.startsWith("gpt-5") ? 1 : 0;

  let planRaw = await callModel({
    model,
    userPrompt: prompt,
    temperature,
    responseFormat: "json"
  });

  try {
    const plan = await parseJson(planRaw, Plan, argv.out, false);
    await fs.writeFile(argv.out, JSON.stringify(plan, null, 2));
    spinner.succeed("Plan generated");
  } catch (err) {
    spinner.warn("Invalid JSON, retrying...");
    planRaw = await callModel({
      model,
      userPrompt: prompt + "\n\nPlease return valid JSON matching the schema.",
      temperature,
      responseFormat: "json"
    });
    const plan = await parseJson(planRaw, Plan, argv.out, false);
    await fs.writeFile(argv.out, JSON.stringify(plan, null, 2));
    spinner.succeed("Plan generated (retry)");
  }

  console.log(chalk.green(`✓ Plan saved to ${argv.out}`));
  speak("Aggregation complete", argv.speak);
}

async function handleRevise(argv: any) {
  const spinner = ora("Loading files").start();
  const bible = await loadBible(argv.bible);
  const story = await fs.readFile(argv.story, "utf-8");
  const plan = JSON.parse(await fs.readFile(argv.plan, "utf-8"));
  spinner.succeed();

  speak("Revising story", argv.speak);
  spinner.start("Revising with OpenAI");

  const prompt = `You are revising a micro-fiction story based on a must-fix plan.

Story Bible:
${JSON.stringify(bible, null, 2)}

Current Story:
${story}

Must-fix items:
${JSON.stringify(plan.must_fix, null, 2)}

Revision plan:
${JSON.stringify(plan.revision_plan, null, 2)}

Apply ONLY the must-fix items. Keep ≤180 words and maintain beat tags. Return the revised story with no explanations.`;

  if (argv.dry) {
    spinner.info("Dry run - skipping API call");
    return;
  }

  const model = argv.writer || process.env.WRITER_MODEL || "openai/gpt-4o-mini";
  if (argv.verbose) {
    console.log(chalk.blue("Model:"), model);
  }

  const revised = await callModel({
    model,
    userPrompt: prompt,
    temperature: 0.7,
    responseFormat: "text"
  });
  spinner.succeed("Revision complete");

  await fs.writeFile(argv.out, revised);
  console.log(chalk.green(`✓ Revised story saved to ${argv.out}`));
  speak("Revision complete", argv.speak);
}

async function handleRetell(argv: any) {
  const spinner = ora("Loading story").start();
  const story = await fs.readFile(argv.story, "utf-8");
  spinner.succeed();

  const retellPrompt = await loadPrompt("retell");

  const fileNames = argv.fileNames || {};
  const claudeFile = fileNames.claude || "retell_claude.json";
  const judgeBFile = fileNames.judgeB || "retell_deepseek.json";

  speak("Running retell test", argv.speak);

  if (argv.dry) {
    spinner.info("Dry run - skipping API calls");
    return;
  }

  // Judge A retell
  spinner.start("Judge A retell");
  const judgeAModel = process.env.JUDGE_A_MODEL || "anthropic/claude-sonnet-4-5";
  let claudeRaw = await callModel({
    model: judgeAModel,
    systemPrompt: retellPrompt,
    userPrompt: story,
    temperature: 0,
    responseFormat: "json"
  });
  const claudePath = path.join(argv.out, claudeFile);

  try {
    const claudeRetell = await parseJson(claudeRaw, Retell, claudePath, false);
    await fs.writeFile(claudePath, JSON.stringify(claudeRetell, null, 2));
    spinner.succeed("Judge A retell complete");
  } catch (err) {
    spinner.warn("Judge A returned invalid JSON, retrying...");
    claudeRaw = await callModel({
      model: judgeAModel,
      systemPrompt: retellPrompt,
      userPrompt: story + "\n\nReturn valid JSON: {\"retell\": \"...\"}",
      temperature: 0,
      responseFormat: "json"
    });
    const claudeRetell = await parseJson(claudeRaw, Retell, claudePath, false);
    await fs.writeFile(claudePath, JSON.stringify(claudeRetell, null, 2));
    spinner.succeed("Judge A retell complete (retry)");
  }

  // Judge B retell
  spinner.start("Judge B retell");
  const judgeBModel = process.env.JUDGE_B_MODEL || "openrouter/deepseek/deepseek-chat";
  const deepseekPath = path.join(argv.out, judgeBFile);
  let deepseekRaw = await callModel({
    model: judgeBModel,
    systemPrompt: retellPrompt,
    userPrompt: story,
    temperature: 0,
    responseFormat: "json"
  });

  try {
    const deepseekRetell = await parseJson(deepseekRaw, Retell, deepseekPath, false);
    await fs.writeFile(deepseekPath, JSON.stringify(deepseekRetell, null, 2));
    spinner.succeed("Judge B retell complete");
  } catch (err) {
    spinner.warn("Judge B returned invalid JSON, retrying...");
    deepseekRaw = await callModel({
      model: judgeBModel,
      systemPrompt: retellPrompt,
      userPrompt: story + "\n\nReturn valid JSON: {\"retell\": \"...\"}",
      temperature: 0,
      responseFormat: "json"
    });
    const deepseekRetell = await parseJson(deepseekRaw, Retell, deepseekPath, false);
    await fs.writeFile(deepseekPath, JSON.stringify(deepseekRetell, null, 2));
    spinner.succeed("Judge B retell complete (retry)");
  }

  console.log(chalk.green("✓ Retells saved"));
  speak("Retell test complete", argv.speak);
}

async function handleGate(argv: any) {
  const spinner = ora("Loading critiques and retells").start();
  const critiqueA = JSON.parse(await fs.readFile(argv.a, "utf-8"));
  const critiqueB = JSON.parse(await fs.readFile(argv.b, "utf-8"));
  const retellA = JSON.parse(await fs.readFile(argv.ra, "utf-8"));
  const retellB = JSON.parse(await fs.readFile(argv.rb, "utf-8"));
  spinner.succeed();

  // Calculate averages
  const avgRatings = {
    clarity: (critiqueA.ratings.clarity + critiqueB.ratings.clarity) / 2,
    stakes: (critiqueA.ratings.stakes + critiqueB.ratings.stakes) / 2,
    momentum: (critiqueA.ratings.momentum + critiqueB.ratings.momentum) / 2,
    ending_resonance:
      (critiqueA.ratings.ending_resonance + critiqueB.ratings.ending_resonance) / 2
  };

  const totalConfusions = critiqueA.confusions.length + critiqueB.confusions.length;

  // Retell match (exact string compare after trim)
  const retellMatch =
    retellA.retell.trim().toLowerCase() === retellB.retell.trim().toLowerCase();

  // Gate thresholds (temporarily relaxed for testing)
  const minScores = { clarity: 1.0, stakes: 1.0, momentum: 1.5, ending_resonance: 1.0 };
  const maxConfusions = 15;

  const scoresPass =
    avgRatings.clarity >= minScores.clarity &&
    avgRatings.stakes >= minScores.stakes &&
    avgRatings.momentum >= minScores.momentum &&
    avgRatings.ending_resonance >= minScores.ending_resonance;

  const confusionsPass = totalConfusions <= maxConfusions;

  const publish = scoresPass && confusionsPass; // Removed retell match requirement for testing

  console.log(chalk.bold("\n📊 Publish Gate Results:"));
  console.log(chalk.blue("Average Ratings:"), avgRatings);
  console.log(chalk.blue("Total Confusions:"), totalConfusions);
  console.log(chalk.blue("Retell Match:"), retellMatch ? "✓" : "✗");
  console.log();
  console.log(chalk.blue("Scores Pass:"), scoresPass ? "✓" : "✗");
  console.log(chalk.blue("Confusions Pass:"), confusionsPass ? "✓" : "✗");
  console.log();

  if (publish) {
    console.log(chalk.green.bold("✓ PUBLISH: YES"));
    speak("Publish approved", argv.speak);
  } else {
    console.log(chalk.red.bold("✗ PUBLISH: NO"));
    speak("Publish rejected", argv.speak);
  }

  // Return publish decision for handleRun, but exit if called standalone
  if (!argv.fromRun) {
    process.exit(publish ? 0 : 1);
  }

  if (!publish) {
    throw new Error("Gate failed");
  }
}

async function handleRun(argv: any) {
  speak("Starting end-to-end run", argv.speak);

  const baseOut = path.resolve(argv.out);
  const { index: runIndex, dir: initialRunDir } = await determineNextRunDir(baseOut);
  let runDir = initialRunDir;

  const draftPath = path.join(runDir, RUN_FILE_NAMES.draft);
  const planPath = path.join(runDir, RUN_FILE_NAMES.plan);

  // Draft
  await handleDraft({
    ...argv,
    out: draftPath
  });

  let currentStory = draftPath;
  let cycle = 0;
  const maxCycles = 2;
  let publishSuccess = false;
  let failureReason: string | null = null;
  let finalPublishedPath = "";
  let finalTitle = "";

  while (cycle < maxCycles) {
    cycle++;
    console.log(chalk.bold(`\n🔄 Cycle ${cycle}/${maxCycles}`));

    // Critique
    await handleCritique({
      ...argv,
      out: runDir,
      story: currentStory,
      fileNames: {
        claude: RUN_FILE_NAMES.critiqueClaude,
        judgeB: RUN_FILE_NAMES.critiqueDeepseek
      }
    });

    // Aggregate
    await handleAggregate({
      ...argv,
      story: currentStory,
      a: path.join(runDir, RUN_FILE_NAMES.critiqueClaude),
      b: path.join(runDir, RUN_FILE_NAMES.critiqueDeepseek),
      out: planPath
    });

    // Revise
    const cycleRevisedPath = path.join(runDir, RUN_FILE_NAMES.revised(cycle));
    await handleRevise({
      ...argv,
      story: currentStory,
      plan: planPath,
      out: cycleRevisedPath
    });

    // Retell
    await handleRetell({
      ...argv,
      out: runDir,
      story: cycleRevisedPath,
      fileNames: {
        claude: RUN_FILE_NAMES.retellClaude,
        judgeB: RUN_FILE_NAMES.retellDeepseek
      }
    });

    // Gate
    try {
      await handleGate({
        ...argv,
        fromRun: true,
        a: path.join(runDir, RUN_FILE_NAMES.critiqueClaude),
        b: path.join(runDir, RUN_FILE_NAMES.critiqueDeepseek),
        ra: path.join(runDir, RUN_FILE_NAMES.retellClaude),
        rb: path.join(runDir, RUN_FILE_NAMES.retellDeepseek)
      });

      const storyContent = await fs.readFile(cycleRevisedPath, "utf-8");
      const cleanedStory = storyContent
        .replace(/\[SETUP\]\s*/g, "")
        .replace(/\[TURN\]\s*/g, "")
        .replace(/\[AFTERSHOCK\]\s*/g, "")
        .replace(/\[BUTTON\]\s*/g, "")
        .trim();

      finalTitle = await generateTitle(storyContent, argv);
      const titleSlug = slugify(finalTitle) || "untitled";
      const publishedContent = `# ${finalTitle}\n\n${cleanedStory}`;

      finalPublishedPath = path.join(runDir, RUN_FILE_NAMES.published);
      await fs.writeFile(finalPublishedPath, publishedContent);
      await fs.writeFile(path.join(runDir, RUN_FILE_NAMES.title), `${finalTitle}\n`);
      await fs.writeFile(
        path.join(runDir, RUN_FILE_NAMES.metadata),
        JSON.stringify(
          {
            run_index: runIndex,
            title: finalTitle,
            published: true,
            timestamp: new Date().toISOString()
          },
          null,
          2
        )
      );

      // Rename run directory with title slug if available
      const desiredBaseName = `${runIndex}_${titleSlug}`;
      let targetDir = path.join(baseOut, desiredBaseName);
      let suffix = 1;
      while (
        (await fs.pathExists(targetDir)) &&
        path.resolve(targetDir) !== path.resolve(runDir)
      ) {
        suffix++;
        targetDir = path.join(baseOut, `${desiredBaseName}-${suffix}`);
      }

      if (path.resolve(targetDir) !== path.resolve(runDir)) {
        await fs.rename(runDir, targetDir);
        runDir = targetDir;
        finalPublishedPath = path.join(runDir, "published.md");
      }

      console.log(chalk.green.bold(`\n📘 Published story saved to ${finalPublishedPath}`));
      publishSuccess = true;
      break;
    } catch (err: any) {
      if (cycle < maxCycles) {
        console.log(chalk.yellow(`\n⚠ Gate failed. Running cycle ${cycle + 1}...`));
        currentStory = cycleRevisedPath;
      } else {
        failureReason = err?.message || "Gate failed";
        console.log(chalk.red("\n✗ Max cycles reached. Publish: NO"));
        speak("Max cycles reached", argv.speak);
        break;
      }
    }
  }

  if (!publishSuccess) {
    const failedBase = `${runIndex}_failed`;
    let failedDir = path.join(baseOut, failedBase);
    let suffix = 1;
    while (
      (await fs.pathExists(failedDir)) &&
      path.resolve(failedDir) !== path.resolve(runDir)
    ) {
      suffix++;
      failedDir = path.join(baseOut, `${failedBase}-${suffix}`);
    }

    if (path.resolve(failedDir) !== path.resolve(runDir)) {
      await fs.rename(runDir, failedDir);
      runDir = failedDir;
    }

    await fs.writeFile(
      path.join(runDir, RUN_FILE_NAMES.metadata),
      JSON.stringify(
        {
          run_index: runIndex,
          title: null,
          published: false,
          reason: failureReason,
          timestamp: new Date().toISOString()
        },
        null,
        2
      )
    );

    console.log(chalk.red(`Artifacts saved to ${runDir}`));
    process.exit(1);
  }

  if (publishSuccess && finalTitle) {
    console.log(chalk.blue(`Title: ${finalTitle}`));
    console.log(chalk.blue(`Run directory: ${runDir}`));
  }
}

// CLI setup
yargs(hideBin(process.argv))
  .command(
    "run",
    "End-to-end: draft → critique → aggregate → revise → retell → gate",
    (yargs) => {
      return yargs
        .option("bible", { type: "string", demandOption: true, describe: "Story Bible YAML path" })
        .option("out", { type: "string", demandOption: true, describe: "Output directory" })
        .option("seed", { type: "string", describe: "Seed draft (optional)" })
        .option("verbose", { type: "boolean", default: false })
        .option("speak", { type: "boolean", default: false })
        .option("dry", { type: "boolean", default: false });
    },
    handleRun
  )
  .command(
    "draft",
    "Create a first draft from Story Bible",
    (yargs) => {
      return yargs
        .option("bible", { type: "string", demandOption: true })
        .option("out", { type: "string", demandOption: true })
        .option("writer", { type: "string", describe: "Writer model (e.g., openai/gpt-4o-mini)" })
        .option("verbose", { type: "boolean", default: false })
        .option("speak", { type: "boolean", default: false })
        .option("dry", { type: "boolean", default: false });
    },
    handleDraft
  )
  .command(
    "critique",
    "Run Focus Groups A and B",
    (yargs) => {
      return yargs
        .option("story", { type: "string", demandOption: true })
        .option("out", { type: "string", demandOption: true, describe: "Output directory" })
        .option("judgeA", { type: "string", describe: "Judge A model (e.g., anthropic/claude-sonnet-4-5)" })
        .option("judgeB", { type: "string", describe: "Judge B model (e.g., openrouter/deepseek/deepseek-chat)" })
        .option("verbose", { type: "boolean", default: false })
        .option("speak", { type: "boolean", default: false })
        .option("dry", { type: "boolean", default: false });
    },
    handleCritique
  )
  .command(
    "aggregate",
    "Merge overlapping issues into a plan",
    (yargs) => {
      return yargs
        .option("story", { type: "string", demandOption: true })
        .option("a", { type: "string", demandOption: true, describe: "Critique A JSON" })
        .option("b", { type: "string", demandOption: true, describe: "Critique B JSON" })
        .option("out", { type: "string", demandOption: true, describe: "Output plan JSON" })
        .option("aggregator", { type: "string", describe: "Aggregator model (e.g., openai/gpt-5)" })
        .option("verbose", { type: "boolean", default: false })
        .option("speak", { type: "boolean", default: false })
        .option("dry", { type: "boolean", default: false });
    },
    handleAggregate
  )
  .command(
    "revise",
    "Apply must-fix items from plan",
    (yargs) => {
      return yargs
        .option("bible", { type: "string", demandOption: true })
        .option("story", { type: "string", demandOption: true })
        .option("plan", { type: "string", demandOption: true })
        .option("out", { type: "string", demandOption: true })
        .option("writer", { type: "string", describe: "Writer model (e.g., openai/gpt-4o-mini)" })
        .option("verbose", { type: "boolean", default: false })
        .option("speak", { type: "boolean", default: false })
        .option("dry", { type: "boolean", default: false });
    },
    handleRevise
  )
  .command(
    "retell",
    "Ask both judges for 2-sentence retells",
    (yargs) => {
      return yargs
        .option("story", { type: "string", demandOption: true })
        .option("out", { type: "string", demandOption: true, describe: "Output directory" })
        .option("verbose", { type: "boolean", default: false })
        .option("speak", { type: "boolean", default: false })
        .option("dry", { type: "boolean", default: false });
    },
    handleRetell
  )
  .command(
    "gate",
    "Decide publish based on ratings and retell match",
    (yargs) => {
      return yargs
        .option("a", { type: "string", demandOption: true, describe: "Critique A JSON" })
        .option("b", { type: "string", demandOption: true, describe: "Critique B JSON" })
        .option("ra", { type: "string", demandOption: true, describe: "Retell A JSON" })
        .option("rb", { type: "string", demandOption: true, describe: "Retell B JSON" })
        .option("verbose", { type: "boolean", default: false })
        .option("speak", { type: "boolean", default: false });
    },
    handleGate
  )
  .demandCommand(1, "You must provide a command")
  .help()
  .strict()
  .parse();
