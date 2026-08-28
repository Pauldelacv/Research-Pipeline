/**
 * The logging contract used across packages. The concrete transport (pino) is
 * wired in the applications, so packages stay free of a logging dependency.
 *
 * Every log line carries run/step correlation fields. That is the difference
 * between "a pipeline failed" and "the extract step of run_8x2 failed on its
 * second attempt against the bright-data provider with PROVIDER_RATE_LIMITED".
 */
export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  child(fields: LogFields): Logger;
}

export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

/** Minimal structured logger used by tests and one-off scripts. */
export function createConsoleLogger(base: LogFields = {}): Logger {
  const write = (level: string, fields: LogFields, message: string) => {
    const merged = { level, time: new Date().toISOString(), ...base, ...fields, message };
    console.log(JSON.stringify(merged));
  };
  return {
    debug: (fields, message) => write('debug', fields, message),
    info: (fields, message) => write('info', fields, message),
    warn: (fields, message) => write('warn', fields, message),
    error: (fields, message) => write('error', fields, message),
    child: (fields) => createConsoleLogger({ ...base, ...fields }),
  };
}
