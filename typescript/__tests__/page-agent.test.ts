import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpiderPage } from '../page.js';
import { SpiderEventEmitter } from '../events/emitter.js';
import { GUARDRAIL_JS } from '../ai/agent.js';
import { SYSTEM_PROMPT, PAGE_SCOPE_ADDENDUM } from '../ai/prompts.js';
import type { ProtocolAdapter } from '../protocol/protocol-adapter.js';
import type { LLMMessage, LLMProvider } from '../ai/llm-provider.js';

// Mock createProvider so the `options.llm` override path doesn't hit the
// real provider constructors (which use require() and network clients).
const { createProviderMock, overrideProvider } = vi.hoisted(() => {
  const overrideProvider = {
    chat: vi.fn().mockResolvedValue(''),
    chatJSON: vi.fn().mockResolvedValue({ label: 'override done', done: true, steps: [] }),
  };
  return { createProviderMock: vi.fn(() => overrideProvider), overrideProvider };
});

vi.mock('../ai/llm-provider.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../ai/llm-provider.js')>();
  return { ...mod, createProvider: createProviderMock };
});

function createMockAdapter(overrides?: Partial<Record<string, unknown>>): ProtocolAdapter {
  return {
    evaluate: vi.fn().mockImplementation(async (expr: string) => {
      if (expr === 'window.location.href') return 'https://example.com';
      if (expr === 'document.title') return 'Example';
      return undefined;
    }),
    captureScreenshot: vi.fn().mockResolvedValue('c2NyZWVuc2hvdA=='),
    getHTML: vi.fn().mockResolvedValue('<html><body>hi</body></html>'),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ProtocolAdapter;
}

function createMockLLM(): LLMProvider {
  return {
    chat: vi.fn().mockResolvedValue(''),
    chatJSON: vi.fn().mockResolvedValue({ label: 'done', done: true, steps: [] }),
  };
}

describe('SpiderPage.agent()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the page-scoped system prompt (SYSTEM_PROMPT + addendum)', async () => {
    const adapter = createMockAdapter();
    const llm = createMockLLM();
    const page = new SpiderPage(adapter, new SpiderEventEmitter(), llm);

    const result = await page.agent('do the thing');

    expect(result.done).toBe(true);
    expect(llm.chatJSON).toHaveBeenCalledTimes(1);
    const messages = (llm.chatJSON as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LLMMessage[];
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe(SYSTEM_PROMPT + '\n\n' + PAGE_SCOPE_ADDENDUM);
  });

  it('evaluates the guardrail script and installs it as a preload script', async () => {
    const adapter = createMockAdapter();
    const llm = createMockLLM();
    const page = new SpiderPage(adapter, new SpiderEventEmitter(), llm);

    await page.agent('do the thing');

    expect(adapter.evaluate).toHaveBeenCalledWith(GUARDRAIL_JS);
    expect(adapter.sendCommand).toHaveBeenCalledWith('Page.addScriptToEvaluateOnNewDocument', {
      source: GUARDRAIL_JS,
    });
  });

  it('re-evaluates the guardrail each round when preload install fails (e.g. BiDi)', async () => {
    const adapter = createMockAdapter({
      sendCommand: vi.fn().mockRejectedValue(new Error('not supported over BiDi')),
    });
    const llm = createMockLLM();
    const page = new SpiderPage(adapter, new SpiderEventEmitter(), llm);

    await page.agent('do the thing');

    const guardrailCalls = (adapter.evaluate as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([expr]) => expr === GUARDRAIL_JS,
    );
    // Once before the loop + once at the start of the (single) round.
    expect(guardrailCalls.length).toBe(2);
  });

  it('throws the standard LLM-not-configured error when no LLM is available', async () => {
    const adapter = createMockAdapter();
    const page = new SpiderPage(adapter, new SpiderEventEmitter());

    await expect(page.agent('do the thing')).rejects.toThrow(
      'LLM not configured. Pass `llm` option to SpiderBrowser constructor for AI methods.',
    );
    expect(createProviderMock).not.toHaveBeenCalled();
  });

  it('options.llm override takes precedence over the browser-configured LLM', async () => {
    const adapter = createMockAdapter();
    const browserLLM = createMockLLM();
    const page = new SpiderPage(adapter, new SpiderEventEmitter(), browserLLM);

    const llmConfig = { provider: 'openai' as const, model: 'gpt-4o', apiKey: 'sk-test' };
    const result = await page.agent('do the thing', { maxRounds: 5, llm: llmConfig });

    expect(createProviderMock).toHaveBeenCalledWith(llmConfig);
    expect(overrideProvider.chatJSON).toHaveBeenCalledTimes(1);
    expect(browserLLM.chatJSON).not.toHaveBeenCalled();
    expect(result.label).toBe('override done');
  });
});
