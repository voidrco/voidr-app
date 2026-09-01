import { describe, expect, it } from 'vitest';
import { isExpectedNavigationAbort } from './target-navigation';

describe('target navigation', () => {
  it('recognizes Electron navigation replacement errors', () => {
    expect(isExpectedNavigationAbort(new Error("ERR_ABORTED (-3) loading 'https://example.test/login'"))).toBe(true);
    expect(isExpectedNavigationAbort('net::ERR_ABORTED')).toBe(true);
  });

  it('does not hide real loading failures', () => {
    expect(isExpectedNavigationAbort(new Error('ERR_NAME_NOT_RESOLVED (-105)'))).toBe(false);
    expect(isExpectedNavigationAbort(new Error('A aplicação demorou demais para abrir.'))).toBe(false);
  });
});
