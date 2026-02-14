import type { ProtocolAdapter } from '../protocol/protocol-adapter.js';
import type { LLMProvider } from './llm-provider.js';
import { truncateHtml } from '../utils/html.js';
import type { z } from 'zod';

/**
 * Extract structured data from the page.
 *
 * Takes a screenshot + HTML, sends to LLM with the instruction and optional
 * Zod schema, returns parsed and validated data.
 */
export async function extract<T>(
  adapter: ProtocolAdapter,
  llm: LLMProvider,
  instruction: string,
  schema?: z.ZodType<T>,
): Promise<T> {
  // Capture page state
  const [screenshot, html, url, title] = await Promise.all([
    adapter.captureScreenshot(),
    adapter.getHTML(),
    adapter.evaluate('window.location.href') as Promise<string>,
    adapter.evaluate('document.title') as Promise<string>,
  ]);

  const truncatedHtml = truncateHtml(html, 12000);

  // Build schema description if provided
  let schemaDesc = '';
  if (schema) {
    // Zod schemas have a ._def property we can inspect
    try {
      schemaDesc = `\n\nReturn data matching this JSON schema:\n${JSON.stringify((schema as any)._def, null, 2)}`;
    } catch {
      schemaDesc = '\n\nReturn a JSON object matching the expected structure.';
    }
  }

  const systemPrompt = `You are a data extraction agent. Given a webpage screenshot and HTML, extract the requested information as JSON.${schemaDesc}

Return ONLY a valid JSON object. No prose, no markdown.`;

  const userText = `URL: ${url}\nTitle: ${title}\nInstruction: ${instruction}\n\nHTML (truncated):\n${truncatedHtml}`;

  const result = await llm.chatJSON<T>([
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${screenshot}` },
        },
      ],
    },
  ]);

  // Validate with Zod if schema provided
  if (schema) {
    return schema.parse(result);
  }

  return result;
}
