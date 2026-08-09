import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { redactText } from '@voidr/capture-contracts';

export interface LedgerEntry {
  type: string;
  generation?: string;
  sessionId?: string;
  stage?: string;
  data?: Record<string, unknown>;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/token|secret|authorization|apiKey/i.test(key))
        .slice(0, 50)
        .map(([key, item]) => [key, sanitizeValue(item)]),
    );
  }
  return value;
}

export class CaptureLedger {
  readonly file: string;

  constructor(userDataDirectory: string) {
    this.file = path.join(userDataDirectory, 'capture-ledger', 'events.jsonl');
  }

  async append(entry: LedgerEntry): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const safe = sanitizeValue({
      ...entry,
      version: 'CAPTURE-HOST/1',
      occurredAt: new Date().toISOString(),
    });
    await appendFile(this.file, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async tail(limit = 50): Promise<LedgerEntry[]> {
    try {
      return (await readFile(this.file, 'utf8'))
        .trim()
        .split('\n')
        .slice(-Math.max(1, Math.min(limit, 200)))
        .map((line) => JSON.parse(line) as LedgerEntry);
    } catch {
      return [];
    }
  }
}
