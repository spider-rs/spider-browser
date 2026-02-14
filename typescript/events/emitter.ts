import type { SpiderEvents, SpiderEventName } from './types.js';

type Handler<T> = (data: T) => void;

/** Type-safe event emitter for SpiderBrowser events. */
export class SpiderEventEmitter {
  private handlers = new Map<string, Set<Handler<any>>>();

  on<K extends SpiderEventName>(event: K, handler: Handler<SpiderEvents[K]>): this {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return this;
  }

  off<K extends SpiderEventName>(event: K, handler: Handler<SpiderEvents[K]>): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  once<K extends SpiderEventName>(event: K, handler: Handler<SpiderEvents[K]>): this {
    const wrapped: Handler<SpiderEvents[K]> = (data) => {
      this.off(event, wrapped);
      handler(data);
    };
    return this.on(event, wrapped);
  }

  emit<K extends SpiderEventName>(event: K, data: SpiderEvents[K]): void {
    const set = this.handlers.get(event);
    if (set) {
      for (const handler of set) {
        try {
          handler(data);
        } catch {
          // Don't let user handlers crash the library
        }
      }
    }
  }

  removeAllListeners(event?: SpiderEventName): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }
}
