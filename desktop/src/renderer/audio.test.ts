import { describe, expect, it } from 'vitest';
import { downsamplePcm, pcmToWavBlob } from './audio';

describe('voice audio encoding', () => {
  it('downsamples to the service PCM contract', () => {
    const source = new Float32Array(48_000).fill(0.25);
    const pcm = downsamplePcm(source, 48_000);
    expect(pcm).toHaveLength(16_000);
    expect(pcm[0]).toBeGreaterThan(8_000);
  });

  it('creates a playable mono WAV preview without changing the PCM bytes', async () => {
    const pcm = new Int16Array([0, 10, -10, 100]);
    const wav = pcmToWavBlob(pcm);
    const bytes = new Uint8Array(await wav.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE');
    expect(bytes.byteLength).toBe(44 + pcm.byteLength);
  });
});
