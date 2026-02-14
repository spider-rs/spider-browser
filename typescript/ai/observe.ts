import type { ProtocolAdapter } from '../protocol/protocol-adapter.js';
import type { LLMProvider } from './llm-provider.js';
import { GET_INTERACTIVE_ELEMENTS } from '../utils/dom.js';
import { truncateHtml } from '../utils/html.js';

/** An observed interactive element on the page. */
export interface ObserveResult {
  /** CSS selector that can target this element. */
  selector: string;
  /** HTML tag name. */
  tag: string;
  /** Input type (for input elements). */
  type: string;
  /** Visible text content (truncated). */
  text: string;
  /** aria-label attribute. */
  ariaLabel: string;
  /** Placeholder text. */
  placeholder: string;
  /** href attribute (for links). */
  href: string;
  /** Current input value (for inputs/textareas). */
  value: string;
  /** Bounding rectangle in viewport coordinates. */
  rect: { x: number; y: number; width: number; height: number };
  /** Relevance score (0-1) when LLM ranking is used. */
  score?: number;
}

/**
 * Discover interactive elements on the page.
 *
 * Works WITHOUT an LLM — injects a DOM traversal script to collect
 * interactive elements (buttons, links, inputs) with selectors, text,
 * and bounding rects.
 *
 * When instruction is provided + LLM is available, adds ranking/filtering.
 */
export async function observe(
  adapter: ProtocolAdapter,
  instruction?: string,
  llm?: LLMProvider,
): Promise<ObserveResult[]> {
  // Collect all interactive elements via DOM traversal
  const elements = (await adapter.evaluate(GET_INTERACTIVE_ELEMENTS)) as ObserveResult[];

  if (!Array.isArray(elements) || elements.length === 0) {
    return [];
  }

  // If no instruction or no LLM, return all elements
  if (!instruction || !llm) {
    return elements;
  }

  // Use LLM to rank/filter elements by relevance to the instruction
  const elementSummary = elements
    .map((el, i) => {
      const parts = [`[${i}] <${el.tag}>`];
      if (el.text) parts.push(`text="${el.text}"`);
      if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.href) parts.push(`href="${el.href}"`);
      if (el.type) parts.push(`type="${el.type}"`);
      return parts.join(' ');
    })
    .join('\n');

  const response = await llm.chatJSON<{ indices: number[] }>([
    {
      role: 'system',
      content:
        'You are an element selector. Given a list of page elements and an instruction, return a JSON object with an "indices" array of element indices that match the instruction. Order by relevance (most relevant first). Return {"indices": []} if none match.',
    },
    {
      role: 'user',
      content: `Instruction: ${instruction}\n\nElements:\n${elementSummary}`,
    },
  ]);

  const indices = response.indices ?? [];
  return indices
    .filter((i) => i >= 0 && i < elements.length)
    .map((i, rank) => ({
      ...elements[i]!,
      score: 1 - rank / Math.max(indices.length, 1),
    }));
}
