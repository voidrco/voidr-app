import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export type EvidenceFile = { journeyId: string; name: string; file: string; contentType: string; uploaded?: boolean; sha256?: string };
export type EvidenceApi = <T>(path: string, body?: unknown) => Promise<T>;
export type UploadContract = { id: string; uploaded: boolean; upload?: {
  uploadUrl: string; method?: 'PUT' | 'POST'; headers?: Record<string, string>; formFields?: Record<string, string>;
} };

/** Resumable artifact delivery shared by desktop and external execution adapters. */
export async function uploadEvidenceFiles(options: {
  runId: string; executorId: string; files: EvidenceFile[]; api: EvidenceApi;
  persist: () => Promise<void>; fetch?: typeof globalThis.fetch;
}) {
  const request = options.fetch ?? globalThis.fetch;
  for (const file of options.files.filter(item => !item.uploaded)) {
    const bytes = await readFile(file.file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (file.sha256 && file.sha256 !== sha256) throw new Error('O arquivo de evidência mudou após o registro.');
    file.sha256 = sha256;
    await options.persist();
    const prefix = `/${options.runId}/artifacts`;
    const contract = await options.api<UploadContract>(prefix, { executorId: options.executorId,
      artifact: { journeyId: file.journeyId, name: file.name, contentType: file.contentType, size: bytes.length, sha256 } });
    if (!contract.uploaded) {
      if (!contract.upload) throw new Error('Contrato de upload ausente.');
      const upload = contract.upload;
      const blob = new Blob([new Uint8Array(bytes)], { type: file.contentType });
      const form = new FormData();
      Object.entries(upload.formFields ?? {}).forEach(([key, value]) => form.append(key, value));
      form.append('file', blob, file.name);
      const response = await request(upload.uploadUrl, { method: upload.method ?? 'PUT', signal: AbortSignal.timeout(120_000),
        redirect: 'error', headers: upload.method === 'POST' ? upload.headers : { 'Content-Type': file.contentType, ...upload.headers },
        body: upload.method === 'POST' ? form : blob });
      // A create-only conflict is only acceptable if the service confirms the exact stored bytes.
      if (!response.ok && ![409, 412].includes(response.status)) throw new Error(`Falha ao enviar evidência (HTTP ${response.status}).`);
    }
    await options.api(`${prefix}/${contract.id}/confirm`, { executorId: options.executorId });
    file.uploaded = true;
    await options.persist();
  }
}
