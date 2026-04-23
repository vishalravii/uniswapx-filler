// ============================================================
// Structured logger — daily file rotation + colour-coded console
// ============================================================
import { createWriteStream, mkdirSync, WriteStream } from 'fs';
import { join } from 'path';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_DIR = join(process.cwd(), 'logs');
const COLORS: Record<LogLevel, string> = {
  DEBUG: '\x1b[37m', // white
  INFO:  '\x1b[36m', // cyan
  WARN:  '\x1b[33m', // yellow
  ERROR: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

function ensureLogDir(): void {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* exists */ }
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

ensureLogDir();

let currentDay = todayStr();
let fileStream: WriteStream = createWriteStream(
  join(LOG_DIR, `filler-${currentDay}.log`),
  { flags: 'a' },
);

function rotateIfNeeded(): void {
  const today = todayStr();
  if (today !== currentDay) {
    fileStream.end();
    currentDay = today;
    fileStream = createWriteStream(join(LOG_DIR, `filler-${currentDay}.log`), { flags: 'a' });
  }
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) return ` | ${meta.message}${meta.stack ? '\n' + meta.stack : ''}`;
  try { return ` | ${JSON.stringify(meta)}`; } catch { return ` | [unserializable]`; }
}

function write(level: LogLevel, message: string, meta?: unknown): void {
  rotateIfNeeded();
  const ts = new Date().toISOString();
  const metaStr = formatMeta(meta);
  const line = `[${ts}] [${level.padEnd(5)}] ${message}${metaStr}`;

  const debugEnabled = process.env.DEBUG === 'true';
  if (level !== 'DEBUG' || debugEnabled) {
    console.log(`${COLORS[level]}${line}${RESET}`);
  }

  fileStream.write(line + '\n');
}

export const logger = {
  debug: (msg: string, meta?: unknown) => write('DEBUG', msg, meta),
  info:  (msg: string, meta?: unknown) => write('INFO',  msg, meta),
  warn:  (msg: string, meta?: unknown) => write('WARN',  msg, meta),
  error: (msg: string, meta?: unknown) => write('ERROR', msg, meta),
};
