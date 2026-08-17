import fs from "node:fs";
import OpenAI from "openai";
import type { Config } from "./config.js";
import { logEgress, logUsage } from "./log.js";

export interface CompleteOptions {
  task: "report" | "resolve" | "distill";
  maxTokens?: number;
}

export interface CompleteResult {
  text: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
  costUsd: number | null;
}

const MAX_ATTEMPTS = 5;

/**
 * The only module that talks to a model provider. Everything else calls
 * complete(); swapping OpenRouter out means changing this file only.
 */
export class Llm {
  private client: OpenAI;

  constructor(private config: Config) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Export it before running commands that call the LLM."
      );
    }
    this.client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/abhinavnair/fetch-my-contributions",
        "X-Title": "fetch-my-contributions",
      },
      maxRetries: 0, // backoff is handled here so 429 policy stays in one place
    });
  }

  async complete(
    prompt: string,
    opts: CompleteOptions
  ): Promise<CompleteResult> {
    const primary = this.config.models[opts.task];
    const egressFile = logEgress(prompt);
    console.error(
      `→ sending ${prompt.length.toLocaleString()} chars to ${primary} (payload logged to ${egressFile})`
    );
    try {
      return await this.callWithBackoff(primary, prompt, opts, egressFile);
    } catch (err) {
      if (!isModelUnavailable(err)) throw err;
      const fallback = this.config.models.fallback;
      console.error(
        `model ${primary} unavailable (${(err as Error).message}); falling back to ${fallback}`
      );
      return await this.callWithBackoff(fallback, prompt, opts, egressFile);
    }
  }

  private async callWithBackoff(
    model: string,
    prompt: string,
    opts: CompleteOptions,
    egressFile: string
  ): Promise<CompleteResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.client.chat.completions.create({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: opts.maxTokens ?? 4096,
          // OpenRouter extension: include token counts and dollar cost in the response.
          usage: { include: true },
        } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
        const text = res.choices[0]?.message?.content ?? "";
        const usage = res.usage as
          | (OpenAI.CompletionUsage & { cost?: number })
          | undefined;
        const result: CompleteResult = {
          text,
          model: res.model ?? model,
          usage: {
            promptTokens: usage?.prompt_tokens ?? 0,
            completionTokens: usage?.completion_tokens ?? 0,
          },
          costUsd: usage?.cost ?? null,
        };
        logUsage({
          timestamp: new Date().toISOString(),
          task: opts.task,
          model: result.model,
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          cost_usd: result.costUsd,
          egress_file: egressFile,
        });
        return result;
      } catch (err) {
        lastErr = decorateApiError(err);
        err = lastErr;
        if (isRateLimit(err) && attempt < MAX_ATTEMPTS - 1) {
          const delay = retryDelayMs(err, attempt);
          console.error(
            `429 from OpenRouter; retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 2}/${MAX_ATTEMPTS})`
          );
          await sleep(delay);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
}

/** OpenRouter hides the upstream provider's message in error.metadata.raw — surface it. */
function decorateApiError(err: unknown): unknown {
  if (!(err instanceof OpenAI.APIError)) return err;
  const meta = (
    err.error as { metadata?: { raw?: string; provider_name?: string } } | undefined
  )?.metadata;
  const detail = [meta?.provider_name, meta?.raw].filter(Boolean).join(": ");
  if (detail && !err.message.includes(detail)) {
    err.message = `${err.message} — ${detail}`;
  }
  return err;
}

function isRateLimit(err: unknown): boolean {
  return err instanceof OpenAI.APIError && err.status === 429;
}

function isModelUnavailable(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.status === 404) return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("not a valid model") ||
    msg.includes("no endpoints found") ||
    msg.includes("model is not available")
  );
}

function retryDelayMs(err: unknown, attempt: number): number {
  if (err instanceof OpenAI.APIError) {
    const retryAfter = Number(err.headers?.["retry-after"]);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  }
  return Math.min(60_000, 2 ** attempt * 2000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Load a prompt template from prompts/ and fill {{placeholders}}. */
export function renderPrompt(
  name: string,
  vars: Record<string, string>
): string {
  const url = new URL(`../prompts/${name}.md`, import.meta.url);
  let template = fs.readFileSync(url, "utf8");
  // Check the TEMPLATE for unknown placeholders before substituting — substituted
  // values are data and may legitimately contain {{...}} themselves.
  for (const m of template.matchAll(/\{\{([a-zA-Z_]+)\}\}/g)) {
    if (!(m[1] in vars)) {
      throw new Error(`Prompt ${name}.md has an unfilled placeholder: ${m[0]}`);
    }
  }
  for (const [key, value] of Object.entries(vars)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }
  return template;
}
