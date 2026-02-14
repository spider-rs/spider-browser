import type { ProtocolAdapter } from '../protocol/protocol-adapter.js';
import type { LLMProvider } from './llm-provider.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompts.js';
import { executeAction, type AgentAction, type AgentPlan } from './agent.js';

/**
 * Execute a single action from natural language.
 *
 * Takes a screenshot + HTML, sends to LLM with the instruction,
 * then executes the returned action steps.
 *
 * Example: `await act(adapter, llm, 'Click the login button')`
 */
export async function act(
  adapter: ProtocolAdapter,
  llm: LLMProvider,
  instruction: string,
): Promise<void> {
  // Capture current page state
  const [screenshot, html, url, title] = await Promise.all([
    adapter.captureScreenshot(),
    adapter.getHTML(),
    adapter.evaluate('window.location.href') as Promise<string>,
    adapter.evaluate('document.title') as Promise<string>,
  ]);

  const context = `Task: ${instruction}\nPAGE TITLE: ${title}`;

  // Call LLM
  const plan = await llm.chatJSON<AgentPlan>([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildUserMessage(url, html, screenshot, context),
    },
  ]);

  // Execute steps
  if (plan.steps && Array.isArray(plan.steps)) {
    for (const step of plan.steps) {
      await executeAction(adapter, step);
      await sleep(200);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
