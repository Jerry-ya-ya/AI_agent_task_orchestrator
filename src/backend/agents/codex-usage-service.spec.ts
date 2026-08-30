import { describe, expect, it, vi } from 'vitest';

import type { ProcessResult } from '../domain/types.js';
import { CodexUsageService, parseCodexUsage } from './codex-usage-service.js';

describe('CodexUsageService', () => {
  it('maps app-server rate-limit windows to remaining percentages', () => {
    const usage = parseCodexUsage(resultWith({
      id: 1,
      result: {
        rateLimits: {
          planType: 'plus',
          primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: 1_788_108_000 },
          secondary: { usedPercent: 80, windowDurationMins: 10_080, resetsAt: null },
          rateLimitReachedType: null
        },
        rateLimitResetCredits: { availableCount: 2 }
      }
    }), new Date('2026-08-31T00:00:00.000Z'));

    expect(usage).toMatchObject({
      available: true,
      planType: 'plus',
      primary: { usedPercent: 27, remainingPercent: 73 },
      secondary: { usedPercent: 80, remainingPercent: 20 },
      resetCredits: 2
    });
  });

  it('returns a safe unavailable result for authentication errors', () => {
    const usage = parseCodexUsage(resultWith({
      id: 1,
      error: { code: -32_600, message: 'codex account authentication required' }
    }), new Date('2026-08-31T00:00:00.000Z'));

    expect(usage).toMatchObject({
      available: false,
      primary: null,
      message: 'codex account authentication required'
    });
  });

  it('caches successful queries so board polling does not repeatedly spawn Codex', async () => {
    const run = vi.fn(async () => resultWith({
      id: 1,
      result: {
        rateLimits: { primary: { usedPercent: 10 }, secondary: null },
        rateLimitResetCredits: null
      }
    }));
    const service = new CodexUsageService({
      command: 'codex',
      query: run,
      clock: () => new Date('2026-08-31T00:00:00.000Z')
    });

    await service.read();
    await service.read();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('codex');
  });
});

function resultWith(message: object): ProcessResult {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ id: 0, result: {} })}\n${JSON.stringify(message)}\n`,
    stderr: '',
    timedOut: false,
    aborted: false
  };
}
