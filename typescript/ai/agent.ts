import type { ProtocolAdapter } from '../protocol/protocol-adapter.js';
import type { LLMProvider } from './llm-provider.js';
import type { SpiderEventEmitter } from '../events/emitter.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompts.js';
import { getKeyParams } from '../protocol/types.js';
import { logger } from '../utils/logger.js';
import { TimeoutError } from '../utils/errors.js';

// -------------------------------------------------------------------
// Action types (mirrors actions.rs AgentAction enum)
// -------------------------------------------------------------------

/** All possible agent actions. */
export type AgentAction =
  | { Click: string }
  | { ClickAll: string }
  | { ClickPoint: { x: number; y: number } }
  | { ClickHold: { selector: string; hold_ms: number } }
  | { ClickHoldPoint: { x: number; y: number; hold_ms: number } }
  | { DoubleClick: string }
  | { DoubleClickPoint: { x: number; y: number } }
  | { RightClick: string }
  | { RightClickPoint: { x: number; y: number } }
  | { WaitForAndClick: string }
  | { ClickDrag: { from: string; to: string; modifier?: number } }
  | { ClickDragPoint: { from_x: number; from_y: number; to_x: number; to_y: number; modifier?: number } }
  | { Type: { value: string } }
  | { Fill: { selector: string; value: string } }
  | { Clear: string }
  | { Press: string }
  | { KeyDown: string }
  | { KeyUp: string }
  | { Select: { selector: string; value: string } }
  | { Focus: string }
  | { Blur: string }
  | { Hover: string }
  | { HoverPoint: { x: number; y: number } }
  | { ScrollY: number }
  | { ScrollX: number }
  | { ScrollTo: { selector: string } }
  | { ScrollToPoint: { x: number; y: number } }
  | { InfiniteScroll: number }
  | { Wait: number }
  | { WaitFor: string }
  | { WaitForWithTimeout: { selector: string; timeout: number } }
  | { WaitForNavigation: null }
  | { WaitForDom: { selector?: string; timeout: number } }
  | { Navigate: string }
  | { GoBack: null }
  | { GoForward: null }
  | { Reload: null }
  | { SetViewport: { width: number; height: number; device_scale_factor?: number; mobile?: boolean } }
  | { Evaluate: string }
  | { Screenshot: null };

/** Parsed LLM response — mirrors actions.rs AgentPlan. */
export interface AgentPlan {
  label: string;
  done: boolean;
  steps: AgentAction[];
  extracted?: unknown;
  memory_ops?: unknown[];
}

export interface AgentOptions {
  /** Max automation rounds (default: 30). */
  maxRounds: number;
  /** Delay in ms after actions for page settle (default: 1500). */
  stepDelayMs: number;
  /** Extra context/instruction for each round. */
  instruction?: string;
}

export interface AgentResult {
  /** Whether the agent completed the task. */
  done: boolean;
  /** Number of rounds executed. */
  rounds: number;
  /** Extracted data (accumulated across rounds). */
  extracted?: unknown;
  /** Final label from the agent. */
  label: string;
}

/**
 * Autonomous multi-step agent.
 *
 * Uses the same action vocabulary and system prompt as Spider's
 * server-side captcha solver.
 *
 * Loop: screenshot → HTML → LLM → parse plan → execute actions → repeat.
 */
export class Agent {
  private adapter: ProtocolAdapter;
  private llm: LLMProvider;
  private emitter: SpiderEventEmitter;
  private opts: Required<Pick<AgentOptions, 'maxRounds' | 'stepDelayMs'>> & Pick<AgentOptions, 'instruction'>;

  constructor(
    adapter: ProtocolAdapter,
    llm: LLMProvider,
    emitter: SpiderEventEmitter,
    options?: Partial<AgentOptions>,
  ) {
    this.adapter = adapter;
    this.llm = llm;
    this.emitter = emitter;
    this.opts = {
      maxRounds: options?.maxRounds ?? 30,
      stepDelayMs: options?.stepDelayMs ?? 1500,
      instruction: options?.instruction,
    };
  }

  /**
   * Execute the agent loop until the task is done or max rounds reached.
   */
  async execute(instruction: string): Promise<AgentResult> {
    let extracted: unknown = undefined;
    let lastLabel = '';

    // Small initial delay for page to render
    await sleep(500);

    for (let round = 0; round < this.opts.maxRounds; round++) {
      // 1. Capture screenshot
      let screenshot: string;
      try {
        screenshot = await this.adapter.captureScreenshot();
      } catch (err) {
        logger.warn(`agent: screenshot failed round ${round}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }

      // 2. Get page HTML
      let html: string;
      try {
        html = await this.adapter.getHTML();
      } catch (err) {
        logger.warn(`agent: get HTML failed round ${round}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }

      // 3. Get URL and title
      const [url, title] = await Promise.all([
        this.adapter.evaluate('window.location.href').catch(() => 'unknown') as Promise<string>,
        this.adapter.evaluate('document.title').catch(() => '') as Promise<string>,
      ]);

      // 4. Call LLM
      const context = `Round ${round + 1}/${this.opts.maxRounds}. Task: ${instruction}\nPAGE TITLE: ${title}`;

      let plan: AgentPlan;
      try {
        plan = await this.llm.chatJSON<AgentPlan>([
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildUserMessage(url, html, screenshot, context),
          },
        ]);
      } catch (err) {
        logger.warn(`agent: LLM call failed round ${round}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(2000);
        continue;
      }

      lastLabel = plan.label ?? '';
      if (plan.extracted !== undefined) {
        extracted = plan.extracted;
      }

      logger.info(`agent: round ${round + 1}`, {
        label: plan.label,
        done: plan.done,
        steps: plan.steps?.length ?? 0,
      });

      this.emitter.emit('agent.step', {
        round: round + 1,
        label: plan.label,
        stepsCount: plan.steps?.length ?? 0,
      });

      // 5. Check if done
      if (plan.done) {
        this.emitter.emit('agent.done', { rounds: round + 1, result: extracted });
        return { done: true, rounds: round + 1, extracted, label: lastLabel };
      }

      if (!plan.steps || plan.steps.length === 0) {
        logger.info('agent: no steps, retrying');
        await sleep(this.opts.stepDelayMs);
        continue;
      }

      // 6. Execute each step
      for (let i = 0; i < plan.steps.length; i++) {
        const action = plan.steps[i]!;
        try {
          await executeAction(this.adapter, action);
        } catch (err) {
          logger.warn(`agent: action failed round ${round} step ${i}`, {
            action: JSON.stringify(action).slice(0, 100),
            error: err instanceof Error ? err.message : String(err),
          });
          break;
        }
        await sleep(200);
      }

      // 7. Wait for page to settle
      await sleep(this.opts.stepDelayMs);
    }

    // Max rounds exceeded
    logger.warn('agent: max rounds exceeded');
    this.emitter.emit('agent.error', {
      error: 'max rounds exceeded',
      round: this.opts.maxRounds,
    });
    return { done: false, rounds: this.opts.maxRounds, extracted, label: lastLabel };
  }
}

// -------------------------------------------------------------------
// Action executor — mirrors agent.rs execute_action()
// -------------------------------------------------------------------

/**
 * Execute a single agent action via the protocol adapter.
 * Handles all 40+ action types from the AgentAction union.
 */
export async function executeAction(
  adapter: ProtocolAdapter,
  action: AgentAction,
): Promise<void> {
  // Click actions
  if ('Click' in action) {
    const { x, y } = await getElementCenter(adapter, (action as any).Click);
    await adapter.clickPoint(x, y);
    return;
  }
  if ('ClickAll' in action) {
    const selector = (action as any).ClickAll as string;
    const points = (await adapter.evaluate(`
      (function() {
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        return Array.from(els).map(el => {
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
      })()
    `)) as Array<{ x: number; y: number }>;
    if (Array.isArray(points)) {
      for (const pt of points) {
        await adapter.clickPoint(pt.x, pt.y);
        await sleep(100);
      }
    }
    return;
  }
  if ('ClickPoint' in action) {
    const { x, y } = (action as any).ClickPoint;
    await adapter.clickPoint(x, y);
    return;
  }
  if ('ClickHold' in action) {
    const { selector, hold_ms } = (action as any).ClickHold;
    const { x, y } = await getElementCenter(adapter, selector);
    await adapter.clickHoldPoint(x, y, hold_ms);
    return;
  }
  if ('ClickHoldPoint' in action) {
    const { x, y, hold_ms } = (action as any).ClickHoldPoint;
    await adapter.clickHoldPoint(x, y, hold_ms);
    return;
  }
  if ('DoubleClick' in action) {
    const { x, y } = await getElementCenter(adapter, (action as any).DoubleClick);
    await adapter.doubleClickPoint(x, y);
    return;
  }
  if ('DoubleClickPoint' in action) {
    const { x, y } = (action as any).DoubleClickPoint;
    await adapter.doubleClickPoint(x, y);
    return;
  }
  if ('RightClick' in action) {
    const { x, y } = await getElementCenter(adapter, (action as any).RightClick);
    await adapter.rightClickPoint(x, y);
    return;
  }
  if ('RightClickPoint' in action) {
    const { x, y } = (action as any).RightClickPoint;
    await adapter.rightClickPoint(x, y);
    return;
  }
  if ('WaitForAndClick' in action) {
    const selector = (action as any).WaitForAndClick as string;
    await waitForElement(adapter, selector, 5000);
    const { x, y } = await getElementCenter(adapter, selector);
    await adapter.clickPoint(x, y);
    return;
  }

  // Drag actions
  if ('ClickDrag' in action) {
    const { from, to } = (action as any).ClickDrag;
    const f = await getElementCenter(adapter, from);
    const t = await getElementCenter(adapter, to);
    await adapter.dragPoint(f.x, f.y, t.x, t.y);
    return;
  }
  if ('ClickDragPoint' in action) {
    const { from_x, from_y, to_x, to_y } = (action as any).ClickDragPoint;
    await adapter.dragPoint(from_x, from_y, to_x, to_y);
    return;
  }

  // Input actions
  if ('Type' in action) {
    await adapter.insertText((action as any).Type.value);
    return;
  }
  if ('Fill' in action) {
    const { selector, value } = (action as any).Fill;
    // Clear via JS
    await adapter.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) { el.focus(); el.value = ''; }
      })()
    `);
    // Click for real focus
    try {
      const { x, y } = await getElementCenter(adapter, selector);
      await adapter.clickPoint(x, y);
    } catch {
      // element may not be clickable
    }
    // Insert text
    await adapter.insertText(value);
    // Dispatch events
    await adapter.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
    return;
  }
  if ('Clear' in action) {
    const selector = (action as any).Clear as string;
    await adapter.evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ''`);
    return;
  }
  if ('Press' in action) {
    await adapter.pressKey((action as any).Press);
    return;
  }
  if ('KeyDown' in action) {
    await adapter.keyDown((action as any).KeyDown);
    return;
  }
  if ('KeyUp' in action) {
    await adapter.keyUp((action as any).KeyUp);
    return;
  }

  // Select & Focus
  if ('Select' in action) {
    const { selector, value } = (action as any).Select;
    await adapter.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
    return;
  }
  if ('Focus' in action) {
    await adapter.evaluate(`document.querySelector(${JSON.stringify((action as any).Focus)})?.focus()`);
    return;
  }
  if ('Blur' in action) {
    await adapter.evaluate(`document.querySelector(${JSON.stringify((action as any).Blur)})?.blur()`);
    return;
  }
  if ('Hover' in action) {
    const { x, y } = await getElementCenter(adapter, (action as any).Hover);
    await adapter.hoverPoint(x, y);
    return;
  }
  if ('HoverPoint' in action) {
    const { x, y } = (action as any).HoverPoint;
    await adapter.hoverPoint(x, y);
    return;
  }

  // Scroll actions
  if ('ScrollY' in action) {
    await adapter.evaluate(`window.scrollBy(0, ${(action as any).ScrollY})`);
    return;
  }
  if ('ScrollX' in action) {
    await adapter.evaluate(`window.scrollBy(${(action as any).ScrollX}, 0)`);
    return;
  }
  if ('ScrollTo' in action) {
    const selector = (action as any).ScrollTo.selector;
    await adapter.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ behavior: 'smooth', block: 'center' })`,
    );
    return;
  }
  if ('ScrollToPoint' in action) {
    const { x, y } = (action as any).ScrollToPoint;
    await adapter.evaluate(`window.scrollTo(${x}, ${y})`);
    return;
  }
  if ('InfiniteScroll' in action) {
    const max = (action as any).InfiniteScroll as number;
    for (let i = 0; i < max; i++) {
      await adapter.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await sleep(500);
    }
    return;
  }

  // Wait actions
  if ('Wait' in action) {
    await sleep((action as any).Wait as number);
    return;
  }
  if ('WaitFor' in action) {
    await waitForElement(adapter, (action as any).WaitFor, 5000);
    return;
  }
  if ('WaitForWithTimeout' in action) {
    const { selector, timeout } = (action as any).WaitForWithTimeout;
    await waitForElement(adapter, selector, timeout);
    return;
  }
  if ('WaitForNavigation' in action) {
    await sleep(1000);
    return;
  }
  if ('WaitForDom' in action) {
    const timeout = (action as any).WaitForDom.timeout ?? 5000;
    await sleep(timeout);
    return;
  }

  // Navigation actions
  if ('Navigate' in action) {
    await adapter.navigate((action as any).Navigate);
    return;
  }
  if ('GoBack' in action) {
    await adapter.evaluate('window.history.back()');
    return;
  }
  if ('GoForward' in action) {
    await adapter.evaluate('window.history.forward()');
    return;
  }
  if ('Reload' in action) {
    await adapter.evaluate('window.location.reload()');
    return;
  }

  // Viewport
  if ('SetViewport' in action) {
    const { width, height, device_scale_factor, mobile } = (action as any).SetViewport;
    await adapter.setViewport(width, height, device_scale_factor ?? 2, mobile ?? false);
    return;
  }

  // JavaScript
  if ('Evaluate' in action) {
    await adapter.evaluate((action as any).Evaluate);
    return;
  }

  // Screenshot (no-op in client — handled by agent loop)
  if ('Screenshot' in action) {
    return;
  }

  logger.warn('agent: unknown action', { action: JSON.stringify(action).slice(0, 100) });
}

// -------------------------------------------------------------------
// Helpers (mirrors agent.rs get_element_center / wait_for_element)
// -------------------------------------------------------------------

async function getElementCenter(
  adapter: ProtocolAdapter,
  selector: string,
): Promise<{ x: number; y: number }> {
  const result = (await adapter.evaluate(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()
  `)) as { x: number; y: number } | null;

  if (!result) {
    throw new Error(`Element not found: ${selector}`);
  }
  return result;
}

async function waitForElement(
  adapter: ProtocolAdapter,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  const interval = 100;
  const maxIter = Math.ceil(timeoutMs / interval);
  const checkJs = `!!document.querySelector(${JSON.stringify(selector)})`;
  for (let i = 0; i < maxIter; i++) {
    const found = await adapter.evaluate(checkJs);
    if (found) return;
    await sleep(interval);
  }
  throw new TimeoutError(`Timeout waiting for element: ${selector}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
