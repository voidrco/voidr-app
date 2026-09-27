const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), { createHash } = require('node:crypto');
const { uploadEvidenceFiles } = require('../../.runtime/ai-evidence-upload.cjs');
async function fixture(t, method = 'PUT') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voidr-upload-test-'));
  const file = path.join(root, 'proof.png'); await fs.writeFile(file, Buffer.from('real transferred bytes'));
  let uploadedBytes, uploads = 0, confirmations = 0, confirmed = false, failConfirm = false, conflict = false;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const bytes = Buffer.concat(chunks); uploads++;
    if (conflict) { res.writeHead(412); res.end(); return; }
    if (method === 'POST') {
      const form = await new Request('http://localhost/', { method: 'POST', headers: req.headers, body: bytes }).formData();
      assert.equal(form.get('policy'), 'test-policy');
      uploadedBytes = Buffer.from(await form.get('file').arrayBuffer());
    } else { assert.equal(req.headers['content-type'], 'image/png'); uploadedBytes = bytes; }
    res.writeHead(200); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true }); });
  let expectedHash;
  const options = { runId: 'run', executorId: 'executor', files: [{ journeyId: 'j', name: 'proof.png', file, contentType: 'image/png' }],
    persist: async () => {}, api: async (suffix, body) => {
      assert.equal(body.executorId, 'executor');
      if (suffix.endsWith('/confirm')) {
        confirmations++;
        if (failConfirm) { failConfirm = false; throw new Error('confirmation transport interrupted'); }
        assert.ok(uploadedBytes);
        assert.equal(createHash('sha256').update(uploadedBytes).digest('hex'), expectedHash);
        confirmed = true; return { uploaded: true };
      }
      expectedHash = body.artifact.sha256;
      return { id: 'artifact', uploaded: confirmed, upload: { uploadUrl: `http://127.0.0.1:${server.address().port}/object`, method, formFields: { policy: 'test-policy' } } };
    } };
  return { options, setFailConfirm: () => { failConfirm = true; }, setConflict: () => { conflict = true; },
    tamper: () => { uploadedBytes = Buffer.from('wrong data'); }, stats: () => ({ uploads, confirmations, confirmed }), file };
}
for (const method of ['PUT', 'POST']) test(`transfers exact bytes with ${method} and confirms before marking uploaded`, async t => {
  const f = await fixture(t, method); await uploadEvidenceFiles(f.options);
  assert.equal(f.options.files[0].uploaded, true); assert.deepEqual(f.stats(), { uploads: 1, confirmations: 1, confirmed: true });
});
test('a failed confirmation remains pending; a create-only conflict retries confirmation without re-running a test', async t => {
  const f = await fixture(t); f.setFailConfirm();
  await assert.rejects(uploadEvidenceFiles(f.options), /interrupted/); assert.equal(f.options.files[0].uploaded, undefined);
  f.setConflict(); await uploadEvidenceFiles(f.options); assert.equal(f.options.files[0].uploaded, true);
  assert.equal(f.stats().confirmations, 2);
});
test('a conflicting object with different bytes is never accepted', async t => {
  const f = await fixture(t); f.setFailConfirm(); await assert.rejects(uploadEvidenceFiles(f.options));
  f.tamper(); f.setConflict(); await assert.rejects(uploadEvidenceFiles(f.options)); assert.equal(f.options.files[0].uploaded, undefined);
});
test('changing the local file after a pending upload is rejected before reissuing a contract', async t => {
  const f = await fixture(t); f.setFailConfirm(); await assert.rejects(uploadEvidenceFiles(f.options));
  await fs.writeFile(f.file, 'changed'); await assert.rejects(uploadEvidenceFiles(f.options), /mudou/); assert.equal(f.stats().uploads, 1);
});
test('confirmed files are skipped on retry', async t => {
  const f = await fixture(t); await uploadEvidenceFiles(f.options); await uploadEvidenceFiles(f.options);
  assert.equal(f.stats().uploads, 1); assert.equal(f.stats().confirmations, 1);
});
