'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LEVELS = ['debug', 'info', 'warn', 'error'];

const SECRET_PATTERNS = [
  // GitHub PAT classic + fine-grained
  { re: /ghp_[A-Za-z0-9]{20,}/g,           mask: 'ghp_****' },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g,   mask: 'github_pat_****' },
  { re: /gho_[A-Za-z0-9]{20,}/g,           mask: 'gho_****' },
  { re: /ghs_[A-Za-z0-9]{20,}/g,           mask: 'ghs_****' },
  { re: /ghu_[A-Za-z0-9]{20,}/g,           mask: 'ghu_****' },
  // Anthropic-ish
  { re: /sk-ant-[A-Za-z0-9\-_]{20,}/g,     mask: 'sk-ant-****' },
  // bearer
  { re: /(Bearer\s+)[A-Za-z0-9_\-.]{16,}/gi, mask: '$1****' },
  // url-embedded credential (https://user:token@host)
  { re: /(https?:\/\/[^:\s\/]+:)([^@\s]+)(@)/g, mask: '$1****$3' },
];

function mask(input) {
  if (input == null) return input;
  let s = String(input);
  for (const { re, mask: m } of SECRET_PATTERNS) s = s.replace(re, m);
  return s;
}

function createLogger(opts = {}) {
  const events = opts.events || {};
  const buffer = [];
  const max = opts.maxEntries || 5000;

  // Persist on disk best-effort. Caller can override path (Electron will pass userData).
  const home = process.env.USERPROFILE || os.homedir();
  const defaultDir = path.join(home, '.imp-installer', 'logs');
  const logDir = opts.logDir || defaultDir;
  let logFile = null;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    logFile = path.join(logDir, `install-${stamp}.log`);
    fs.writeFileSync(logFile, `# IMP installer log — ${new Date().toISOString()}\n`, { flag: 'a' });
  } catch (_) {
    logFile = null; // disk write is optional; in-memory buffer is the source of truth
  }

  function emit(level, component, message, extra) {
    if (!LEVELS.includes(level)) level = 'info';
    const entry = {
      ts: new Date().toISOString(),
      level,
      component: component || 'core',
      message: mask(message),
      extra: extra ? mask(JSON.stringify(extra)) : undefined,
    };
    buffer.push(entry);
    if (buffer.length > max) buffer.splice(0, buffer.length - max);

    if (logFile) {
      try {
        const line = `${entry.ts} [${entry.level.toUpperCase()}] ${entry.component}: ${entry.message}${entry.extra ? ' ' + entry.extra : ''}\n`;
        fs.appendFileSync(logFile, line);
      } catch (_) { /* keep going */ }
    }

    if (typeof events.onLog === 'function') {
      try { events.onLog(entry); } catch (_) {}
    }
  }

  return {
    debug: (c, m, e) => emit('debug', c, m, e),
    info:  (c, m, e) => emit('info',  c, m, e),
    warn:  (c, m, e) => emit('warn',  c, m, e),
    error: (c, m, e) => emit('error', c, m, e),
    mask,
    getBuffer: () => buffer.slice(),
    getLogFile: () => logFile,
  };
}

module.exports = { createLogger, mask };
