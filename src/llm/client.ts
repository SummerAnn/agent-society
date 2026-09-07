import type { ProviderConfig } from "./provider";

export type LLMRequest = {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  structuredOutput?: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
};

export type LLMUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type LLMResponse = {
  text: string;
  usage: LLMUsage;
  estimatedCostUsd: number | null;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 45000;
const MAX_RETRIES = 5;
const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

type RetryContext = {
  provider: ProviderConfig;
  attempt: number;
  error: unknown;
};

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("terminated") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    msg.includes("network")
  );
}

function makeStatusError(prefix: string, status: number, body: string): Error {
  const err = new Error(`${prefix} ${status}: ${body.slice(0, 300)}`);
  (err as Error & { status?: number }).status = status;
  return err;
}

function isRetryableStatus(error: unknown): boolean {
  const status = (error as Error & { status?: number })?.status;
  return typeof status === "number" && RETRYABLE_STATUS_CODES.has(status);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function truncateForLog(text: string, maxLen = 160): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

export function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function withRetries<T>(fn: () => Promise<T>, ctx: Omit<RetryContext, "attempt" | "error">): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const retryable = isRetryableStatus(error) || isRetryableError(error);
      if (!retryable || attempt === MAX_RETRIES) {
        throw error;
      }
      const delayMs = 1_500 * 2 ** attempt;
      console.warn(
        `[llm] retry ${attempt + 1}/${MAX_RETRIES} for ${ctx.provider.type}:${ctx.provider.model} after ${delayMs}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callAnthropic(
  provider: ProviderConfig,
  request: LLMRequest,
): Promise<LLMResponse> {
  return withRetries(async () => {
    console.log(
      `[llm] request anthropic model=${provider.model} max_tokens=${request.maxTokens ?? 512} prompt_preview="${truncateForLog(request.userPrompt.replace(/\s+/g, " "))}"`,
    );
    const res = await withTimeout(`${provider.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
        ...(provider.workspaceId ? { "anthropic-workspace-id": provider.workspaceId } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: request.maxTokens ?? 512,
        system: request.systemPrompt,
        temperature: request.temperature,
        messages: [{ role: "user", content: request.userPrompt }],
        ...(request.structuredOutput ? {
          tools: [{
            name: request.structuredOutput.name,
            description: request.structuredOutput.description,
            input_schema: request.structuredOutput.inputSchema,
          }],
          tool_choice: { type: "tool", name: request.structuredOutput.name },
        } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw makeStatusError("Anthropic API error", res.status, body);
    }

    const data = await res.json() as {
      content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const toolUse = request.structuredOutput
      ? data.content.find((block) => block.type === "tool_use" && block.name === request.structuredOutput?.name)
      : undefined;
    const textBlock = data.content.find((block) => block.type === "text");
    const text = toolUse?.input ? JSON.stringify(toolUse.input) : textBlock?.text ?? "";
    const promptTokens = data.usage?.input_tokens ?? estimateTokenCount(`${request.systemPrompt}\n${request.userPrompt}`);
    const completionTokens = data.usage?.output_tokens ?? estimateTokenCount(text);
    return {
      text,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      estimatedCostUsd: null,
    };
  }, { provider });
}

async function callOpenAICompatible(
  provider: ProviderConfig,
  request: LLMRequest,
): Promise<LLMResponse> {
  return withRetries(async () => {
    console.log(
      `[llm] request ${provider.type} model=${provider.model} max_tokens=${request.maxTokens ?? 512} prompt_preview="${truncateForLog(request.userPrompt.replace(/\s+/g, " "))}"`,
    );
    const res = await withTimeout(`${provider.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: request.maxTokens ?? 512,
        temperature: request.temperature,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw makeStatusError("OpenAI API error", res.status, body);
    }

    const data = await res.json() as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const text = data.choices[0]?.message?.content ?? "";
    const promptTokens = data.usage?.prompt_tokens ?? estimateTokenCount(`${request.systemPrompt}\n${request.userPrompt}`);
    const completionTokens = data.usage?.completion_tokens ?? estimateTokenCount(text);
    return {
      text,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: data.usage?.total_tokens ?? (promptTokens + completionTokens),
      },
      estimatedCostUsd: null,
    };
  }, { provider });
}

export async function callLLM(
  provider: ProviderConfig,
  request: LLMRequest,
): Promise<LLMResponse> {
  if (provider.type === "anthropic") {
    return callAnthropic(provider, request);
  }
  return callOpenAICompatible(provider, request);
}
