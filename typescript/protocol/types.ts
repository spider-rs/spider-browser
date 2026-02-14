/** CDP JSON-RPC request. */
export interface CDPCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** CDP JSON-RPC response. */
export interface CDPResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: string };
  sessionId?: string;
}

/** CDP event (no id). */
export interface CDPEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** BiDi command. */
export interface BiDiCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** BiDi response. */
export interface BiDiResponse {
  id: number;
  type: 'success' | 'error';
  result?: Record<string, unknown>;
  error?: string;
  message?: string;
}

/** BiDi event. */
export interface BiDiEvent {
  type: 'event';
  method: string;
  params: Record<string, unknown>;
}

/** Spider-specific event sent by the server through the WebSocket. */
export interface SpiderProtocolEvent {
  method: string;
  params: Record<string, unknown>;
}

/** A message arriving from the WebSocket — either protocol or Spider event. */
export type IncomingMessage =
  | { kind: 'cdp-response'; data: CDPResponse }
  | { kind: 'cdp-event'; data: CDPEvent }
  | { kind: 'bidi-response'; data: BiDiResponse }
  | { kind: 'bidi-event'; data: BiDiEvent }
  | { kind: 'spider-event'; data: SpiderProtocolEvent };

/** Key mapping for Input.dispatchKeyEvent (mirrors inject.rs key_params). */
export const KEY_MAP: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  ' ': { key: ' ', code: 'Space', keyCode: 32 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

export function getKeyParams(keyName: string): { key: string; code: string; keyCode: number } {
  return KEY_MAP[keyName] ?? { key: keyName, code: keyName, keyCode: 0 };
}
