import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/**
 * @param {keyof typeof LEVELS} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const extra = fields && Object.keys(fields).length
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')
    : '';
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function fmt(v) {
  if (v == null) return String(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v;
  if (Array.isArray(v)) return JSON.stringify(v.slice(0, 8));
  return JSON.stringify(v);
}

export const log = {
  debug: (m, f) => emit('debug', m, f),
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
};
