import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isControlRendererUrl, resolveControlAsset } from './app-protocol';

describe('control protocol', () => {
  const root = path.resolve('/opt/voidr/renderer');

  it('serves only assets inside the packaged renderer root', () => {
    expect(resolveControlAsset(root, 'voidr-app://app/index.html')).toBe(
      path.join(root, 'index.html'),
    );
    expect(resolveControlAsset(root, 'voidr-app://app/assets/index.js')).toBe(
      path.join(root, 'assets/index.js'),
    );
  });

  it('rejects traversal, foreign hosts, queries and malformed encodings', () => {
    for (const input of [
      'voidr-app://evil/index.html',
      'voidr-app://app/%2e%2e/secret',
      'voidr-app://app/index.html?override=1',
      'voidr-app://app/%EA%A4%A',
      'file:///etc/passwd',
    ]) {
      expect(resolveControlAsset(root, input)).toBeNull();
    }
  });

  it('recognizes only the control origin or the explicit dev-server origin', () => {
    expect(isControlRendererUrl('voidr-app://app/index.html')).toBe(true);
    expect(isControlRendererUrl('voidr-app://attacker/index.html')).toBe(false);
    expect(isControlRendererUrl('http://127.0.0.1:4173/', 'http://127.0.0.1:4173')).toBe(true);
    expect(isControlRendererUrl('http://127.0.0.1:4174/', 'http://127.0.0.1:4173')).toBe(false);
  });
});
