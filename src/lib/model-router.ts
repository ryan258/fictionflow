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

export interface ModelCall {
  model: string;
  systemPrompt?: string;
  userPrompt: string;
  temperature?: number;
  responseFormat?: "text" | "json";
}

/**
 * Universal model caller - routes to appropriate provider based on model prefix
 *
 * Model format: "provider/model-name"
 * - openai/gpt-4o-mini
 * - anthropic/claude-sonnet-4-5
 * - openrouter/deepseek/deepseek-chat
 */
export async function callModel(call: ModelCall): Promise<string> {
  const { model, systemPrompt, userPrompt, temperature = 0.7, responseFormat = "text" } = call;

  // Parse provider from model string
  const parts = model.split("/");
  const provider = parts[0];
  const modelName = parts.slice(1).join("/"); // Rejoin for openrouter paths

  // Route to appropriate provider
  switch (provider) {
    case "openai": {
      // GPT-5 only supports temperature=1
      const temp = modelName.startsWith("gpt-5") ? 1 : temperature;

      const messages: any[] = [];
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      messages.push({ role: "user", content: userPrompt });

      const completion = await getOpenAI().chat.completions.create({
        model: modelName,
        messages,
        temperature: temp
      });
      return completion.choices[0]?.message?.content || "";
    }

    case "anthropic": {
      const response = await getAnthropic().messages.create({
        model: modelName,
        max_tokens: 4096,
        temperature: responseFormat === "json" ? 0 : temperature,
        system: systemPrompt || "",
        messages: [
          {
            role: "user",
            content: userPrompt
          }
        ]
      });

      const content = response.content[0];
      if (content.type === "text") {
        return content.text;
      }
      throw new Error("Unexpected response type from Anthropic");
    }

    case "openrouter": {
      const messages: any[] = [];
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      messages.push({ role: "user", content: userPrompt });

      const completion = await getOpenRouter().chat.completions.create({
        model: modelName,
        messages,
        temperature: responseFormat === "json" ? 0 : temperature,
        max_tokens: 4096
      });
      return completion.choices[0]?.message?.content || "";
    }

    default:
      throw new Error(`Unknown provider: ${provider}. Use format: provider/model-name (openai/, anthropic/, openrouter/)`);
  }
}
