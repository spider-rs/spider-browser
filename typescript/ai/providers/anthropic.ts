import type { LLMConfig, LLMMessage, LLMProvider, LLMContentPart } from '../llm-provider.js';
import { LLMError } from '../../utils/errors.js';

/**
 * Anthropic native API provider.
 *
 * Converts OpenAI-style messages to Anthropic's format.
 */
export class AnthropicProvider implements LLMProvider {
  private url: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: LLMConfig) {
    this.url = config.baseUrl ?? 'https://api.anthropic.com/v1/messages';
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.1;
  }

  async chat(messages: LLMMessage[], _options?: { jsonMode?: boolean }): Promise<string> {
    // Extract system message
    const systemMsg = messages.find((m) => m.role === 'system');
    const userMessages = messages.filter((m) => m.role !== 'system');

    // Convert to Anthropic format
    const anthropicMessages = userMessages.map((m) => {
      if (typeof m.content === 'string') {
        return { role: m.role, content: m.content };
      }
      // Convert content parts
      const parts = (m.content as LLMContentPart[]).map((part) => {
        if (part.type === 'text') {
          return { type: 'text' as const, text: part.text };
        }
        // Convert image_url to Anthropic's image format
        const dataUrl = part.image_url.url;
        const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: match[1]!,
              data: match[2]!,
            },
          };
        }
        // URL-based image
        return {
          type: 'image' as const,
          source: { type: 'url' as const, url: dataUrl },
        };
      });
      return { role: m.role, content: parts };
    });

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      messages: anthropicMessages,
    };

    if (systemMsg) {
      body.system = typeof systemMsg.content === 'string'
        ? systemMsg.content
        : (systemMsg.content as LLMContentPart[]).map((p) => (p as any).text).join('\n');
    }

    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new LLMError(`Anthropic API error ${resp.status}: ${text}`);
    }

    const json = (await resp.json()) as any;
    const content = json?.content?.[0]?.text;
    if (typeof content !== 'string') {
      throw new LLMError('Anthropic response missing content[0].text');
    }
    return content;
  }

  async chatJSON<T = unknown>(messages: LLMMessage[]): Promise<T> {
    const text = await this.chat(messages);
    try {
      return JSON.parse(text) as T;
    } catch {
      const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        return JSON.parse(match[1]!) as T;
      }
      throw new LLMError(`LLM response is not valid JSON: ${text.slice(0, 200)}`);
    }
  }
}
