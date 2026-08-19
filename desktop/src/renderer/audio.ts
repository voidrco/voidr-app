interface ActiveAudioCapture {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  silentGain: GainNode;
  chunks: Float32Array[];
  sampleRate: number;
  stopped: boolean;
}

export interface AudioDraft {
  pcmBase64: string;
  durationMs: number;
  previewUrl: string;
  byteLength: number;
}

interface AudioCaptureOptions {
  onLevel?: (level: number) => void;
  onEnded?: () => void;
}

export function downsamplePcm(
  input: Float32Array,
  sourceRate: number,
  targetRate = 16_000,
): Int16Array {
  if (sourceRate < targetRate) throw new Error('O microfone usa um formato incompatível.');
  const ratio = sourceRate / targetRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor] ?? 0;
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function toBase64(value: Int16Array): string {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(binary);
}

function fromBase64(value: string): Int16Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer);
}

export function pcmToWavBlob(value: Int16Array, sampleRate = 16_000): Blob {
  const buffer = new ArrayBuffer(44 + value.byteLength);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + value.byteLength, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, value.byteLength, true);
  new Uint8Array(buffer, 44).set(
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
  );
  return new Blob([buffer], { type: 'audio/wav' });
}

export function audioDraftFromPcmBase64(pcmBase64: string): AudioDraft {
  const pcm = fromBase64(pcmBase64);
  return {
    pcmBase64,
    durationMs: Math.max(1, Math.round((pcm.length / 16_000) * 1_000)),
    previewUrl: URL.createObjectURL(pcmToWavBlob(pcm)),
    byteLength: pcm.byteLength,
  };
}

function closeCapture(capture: ActiveAudioCapture): void {
  if (capture.stopped) return;
  capture.stopped = true;
  capture.processor.onaudioprocess = null;
  try { capture.processor.disconnect(); } catch {}
  try { capture.source.disconnect(); } catch {}
  try { capture.silentGain.disconnect(); } catch {}
  for (const track of capture.stream.getTracks()) {
    track.onended = null;
    track.stop();
  }
}

export async function startAudioCapture(
  options: AudioCaptureOptions = {},
): Promise<ActiveAudioCapture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Este dispositivo não oferece captura de microfone.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  try {
    const context = new AudioContext();
    if (context.state === 'suspended') await context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4_096, 1, 1);
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    const chunks: Float32Array[] = [];
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(input));
      if (options.onLevel) {
        let energy = 0;
        for (const sample of input) energy += sample * sample;
        const rms = Math.sqrt(energy / Math.max(1, input.length));
        options.onLevel(Math.min(1, Math.max(0, rms * 5)));
      }
    };
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    const capture: ActiveAudioCapture = {
      stream,
      context,
      source,
      processor,
      silentGain,
      chunks,
      sampleRate: context.sampleRate,
      stopped: false,
    };
    for (const track of stream.getAudioTracks()) {
      track.onended = () => {
        if (!capture.stopped) options.onEnded?.();
      };
    }
    return capture;
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}

export async function stopAudioCapture(capture: ActiveAudioCapture): Promise<AudioDraft> {
  closeCapture(capture);
  if (capture.context.state !== 'closed') await capture.context.close();
  const length = capture.chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of capture.chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const pcm = downsamplePcm(merged, capture.sampleRate);
  return {
    pcmBase64: toBase64(pcm),
    durationMs: Math.max(1, Math.round((pcm.length / 16_000) * 1_000)),
    previewUrl: URL.createObjectURL(pcmToWavBlob(pcm)),
    byteLength: pcm.byteLength,
  };
}

export async function abortAudioCapture(capture: ActiveAudioCapture): Promise<void> {
  closeCapture(capture);
  if (capture.context.state !== 'closed') await capture.context.close();
}

export function disposeAudioDraft(draft: AudioDraft | undefined): void {
  if (draft?.previewUrl) URL.revokeObjectURL(draft.previewUrl);
}

export type { ActiveAudioCapture };
