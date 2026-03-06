import type { LLMConfig, LLMMessage, LLMProvider } from '../llm-provider.js';
import { LLMError } from '../../utils/errors.js';

const DEFAULT_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

/**
 * OpenAI-compatible LLM provider.
 *
 * Works with OpenAI, OpenRouter, Qwen/vLLM, or any /v1/chat/completions endpoint.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private url: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: LLMConfig) {
    this.url = config.baseUrl ?? DEFAULT_URLS[config.provider] ?? DEFAULT_URLS.openai!;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.1;
  }

  async chat(messages: LLMMessage[], options?: { jsonMode?: boolean }): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_completion_tokens: this.maxTokens,
      temperature: this.temperature,
    };

    if (options?.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new LLMError(`OpenAI API error ${resp.status}: ${text}`);
    }

    const json = (await resp.json()) as any;
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new LLMError('OpenAI response missing choices[0].message.content');
    }
    return content;
  }

  async chatJSON<T = unknown>(messages: LLMMessage[]): Promise<T> {
    const text = await this.chat(messages, { jsonMode: true });
    try {
      return JSON.parse(text) as T;
    } catch {
      // Try extracting JSON from markdown code blocks
      const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        return JSON.parse(match[1]!) as T;
      }
      throw new LLMError(`LLM response is not valid JSON: ${text.slice(0, 200)}`);
    }
  }
}
