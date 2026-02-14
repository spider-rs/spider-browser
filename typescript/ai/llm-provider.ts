/** LLM configuration for AI methods. */
export interface LLMConfig {
  /** Provider: 'openai', 'anthropic', or 'openrouter'. */
  provider: 'openai' | 'anthropic' | 'openrouter';
  /** Model name (e.g. 'gpt-4o', 'claude-sonnet-4-5-20250929'). */
  model: string;
  /** API key for the provider. */
  apiKey: string;
  /** Base URL override (e.g. for OpenRouter or local vLLM). */
  baseUrl?: string;
  /** Max tokens (default: 4096). */
  maxTokens?: number;
  /** Temperature (default: 0.1). */
  temperature?: number;
}

/** Message format for LLM calls. */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMContentPart[];
}

export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** Pluggable LLM provider interface. */
export interface LLMProvider {
  /** Call the LLM with messages and get a text response. */
  chat(messages: LLMMessage[], options?: { jsonMode?: boolean }): Promise<string>;
  /** Call the LLM with messages and get a parsed JSON response. */
  chatJSON<T = unknown>(messages: LLMMessage[]): Promise<T>;
}

/** Create an LLM provider from config. */
export function createProvider(config: LLMConfig): LLMProvider {
  switch (config.provider) {
    case 'openai':
    case 'openrouter': {
      // Dynamic import to keep this module sync
      const { OpenAICompatibleProvider } = require('./providers/openai.js') as typeof import('./providers/openai.js');
      return new OpenAICompatibleProvider(config);
    }
    case 'anthropic': {
      const { AnthropicProvider } = require('./providers/anthropic.js') as typeof import('./providers/anthropic.js');
      return new AnthropicProvider(config);
    }
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
