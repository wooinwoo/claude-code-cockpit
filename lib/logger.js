/**
 * Structured logger module for Cockpit Dashboard.
 *
 * A minimal logger that replaces raw console.log/warn/error with
 * timestamped, leveled, component-tagged output.
 *
 * @module lib/logger
 * @example
 * import { logger } from './lib/logger.js';
 * logger.info('server', 'Listening on port 3847');
 * logger.error('ws', 'Connection failed', { code: 1006 });
 * logger.setLevel('debug'); // show all messages
 */

/** @enum {number} Log level numeric values (lower = more verbose) */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

/** @type {number} Current minimum log level */
let _level = LEVELS.info;

/**
 * Write a log entry to the console with structured prefix.
 *
 * @param {'debug'|'info'|'warn'|'error'} level - Severity level
 * @param {string} component - Source component tag (e.g. 'server', 'ws', 'state')
 * @param {string} message - Human-readable log message
 * @param {*} [data] - Optional data payload (object, error, etc.)
 */
function log(level, component, message, data) {
  if (LEVELS[level] < _level) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts.slice(11, 19)}] [${level.toUpperCase().padEnd(5)}] [${component}]`;
  if (level === 'error') console.error(prefix, message, data || '');
  else if (level === 'warn') console.warn(prefix, message, data || '');
  else console.log(prefix, message, data || '');
}

/**
 * Structured logger instance.
 *
 * @namespace logger
 */
export const logger = {
  /**
   * Log a debug-level message (hidden at default level).
   * @param {string} component - Source component tag
   * @param {string} msg - Log message
   * @param {*} [data] - Optional payload
   */
  debug: (component, msg, data) => log('debug', component, msg, data),

  /**
   * Log an info-level message.
   * @param {string} component - Source component tag
   * @param {string} msg - Log message
   * @param {*} [data] - Optional payload
   */
  info: (component, msg, data) => log('info', component, msg, data),

  /**
   * Log a warning-level message.
   * @param {string} component - Source component tag
   * @param {string} msg - Log message
   * @param {*} [data] - Optional payload
   */
  warn: (component, msg, data) => log('warn', component, msg, data),

  /**
   * Log an error-level message.
   * @param {string} component - Source component tag
   * @param {string} msg - Log message
   * @param {*} [data] - Optional payload
   */
  error: (component, msg, data) => log('error', component, msg, data),

  /**
   * Set the minimum log level. Messages below this level are suppressed.
   * @param {'debug'|'info'|'warn'|'error'} level - Minimum level to display
   */
  setLevel: (level) => { _level = LEVELS[level] ?? LEVELS.info; },
};
