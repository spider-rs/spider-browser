// spider-browser — OSS Browser Automation Client for Spider
// https://spider.cloud

export { SpiderBrowser, type SpiderBrowserOptions } from './spider-browser.js';
export { SpiderPage } from './page.js';

// Events
export { SpiderEventEmitter } from './events/emitter.js';
export type { SpiderEvents, SpiderEventName, Browser } from './events/types.js';

// Protocol (advanced usage)
export { Transport, type TransportOptions } from './protocol/transport.js';
export { ProtocolAdapter } from './protocol/protocol-adapter.js';
export { CDPSession } from './protocol/cdp-session.js';
export { BiDiSession } from './protocol/bidi-session.js';

// Retry
export { RetryEngine, type RetryOptions } from './retry/retry-engine.js';
export { FailureTracker } from './retry/failure-tracker.js';
export { BrowserSelector } from './retry/browser-selector.js';

// AI
export { createProvider, type LLMConfig, type LLMProvider, type LLMMessage } from './ai/llm-provider.js';
export { act } from './ai/act.js';
export { observe, type ObserveResult } from './ai/observe.js';
export { extract } from './ai/extract.js';
export { Agent, type AgentOptions, type AgentResult, type AgentAction, type AgentPlan } from './ai/agent.js';
export { SYSTEM_PROMPT } from './ai/prompts.js';

// Utils
export { truncateHtml } from './utils/html.js';
export * from './utils/errors.js';
export { Logger, logger } from './utils/logger.js';
