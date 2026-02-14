export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export class Logger {
  private level: number;

  constructor(level: LogLevel = 'info') {
    this.level = LEVELS[level];
  }

  setLevel(level: LogLevel): void {
    this.level = LEVELS[level];
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    if (this.level <= LEVELS.debug) this.log('DEBUG', msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    if (this.level <= LEVELS.info) this.log('INFO', msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    if (this.level <= LEVELS.warn) this.log('WARN', msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    if (this.level <= LEVELS.error) this.log('ERROR', msg, data);
  }

  private log(level: string, msg: string, data?: Record<string, unknown>): void {
    const ts = new Date().toISOString();
    const extra = data ? ' ' + JSON.stringify(data) : '';
    const line = `[${ts}] ${level} spider-browser: ${msg}${extra}`;
    if (level === 'ERROR') {
      console.error(line);
    } else if (level === 'WARN') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

/** Shared default logger instance. */
export const logger = new Logger('info');
