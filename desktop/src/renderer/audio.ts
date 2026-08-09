interface ActiveAudioCapture {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  sampleRate: number;
}

function downsample(input: Float32Array, sourceRate: number, targetRate = 16_000): Int16Array {
  if (sourceRate < targetRate) throw new Error('O sample rate do microfone é incompatível.');
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
  const bytes = new Uint8Array(value.buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(binary);
}

export async function startAudioCapture(): Promise<ActiveAudioCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4_096, 1, 1);
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(context.destination);
  return { stream, context, source, processor, chunks, sampleRate: context.sampleRate };
}

export async function stopAudioCapture(capture: ActiveAudioCapture): Promise<string> {
  capture.processor.disconnect();
  capture.source.disconnect();
  capture.stream.getTracks().forEach((track) => track.stop());
  await capture.context.close();
  const length = capture.chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of capture.chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return toBase64(downsample(merged, capture.sampleRate));
}

export type { ActiveAudioCapture };
