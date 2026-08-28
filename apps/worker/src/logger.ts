import type { Logger } from '@frp/core';
import pino, { type Logger as PinoLogger } from 'pino';

/**
 * Adapts pino to the engine's `Logger` port.
 *
 * The applications own the transport choice; packages depend only on the
 * interface. Every line carries the run/step correlation fields the context
 * attaches, which is what makes a failed run diagnosable from logs alone.
 */
export function createLogger(level: string, name: string): Logger {
  const instance = pino({
    level,
    name,
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
  return wrap(instance);
}

function wrap(instance: PinoLogger): Logger {
  return {
    debug: (fields, message) => instance.debug(fields, message),
    info: (fields, message) => instance.info(fields, message),
    warn: (fields, message) => instance.warn(fields, message),
    error: (fields, message) => instance.error(fields, message),
    child: (fields) => wrap(instance.child(fields)),
  };
}
