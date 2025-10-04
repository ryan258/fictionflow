import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

let openai: OpenAI | null = null;
let anthropic: Anthropic | null = null;
let openrouter: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }
  return openai;
}

function getAnthropic(): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }
  return anthropic;
}

function getOpenRouter(): OpenAI {
  if (!openrouter) {
    openrouter = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1"
    });
  }
  return openrouter;
}

export async function openaiText(
  model: string,
  prompt: string,
  temperature: number = 0.7
): Promise<string> {
  const completion = await getOpenAI().chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature
  });
  return completion.choices[0]?.message?.content || "";
}

export async function claudeJson(
  story: string,
  systemPrompt: string,
  model: string = "claude-sonnet-4-5"
): Promise<string> {
  const response = await getAnthropic().messages.create({
    model,
    max_tokens: 4096,
    temperature: 0,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: story
      }
    ]
  });

  const content = response.content[0];
  if (content.type === "text") {
    return content.text;
  }
  throw new Error("Unexpected response type from Claude");
}

export async function deepseekJson(
  story: string,
  systemPrompt: string,
  model: string = "deepseek/deepseek-chat"
): Promise<string> {
  const completion = await getOpenRouter().chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: story }
    ],
    temperature: 0,
    max_tokens: 4096
  });
  return completion.choices[0]?.message?.content || "";
}
