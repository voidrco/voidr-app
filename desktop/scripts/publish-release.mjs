#!/usr/bin/env node
/**
 * Publishes the installers produced by `npm run capture:make` to the Voidr
 * private bucket and refreshes `capture/latest.json`, which is what
 * voidr-service reads to mint signed download links.
 *
 * Usage: node desktop/scripts/publish-release.mjs --bucket voidr_private_staging [--dry-run]
 *
 * Runs one platform at a time on purpose: each machine publishes what it can
 * build, and the manifest is merged instead of replaced.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAKE_DIR = path.join(DESKTOP_ROOT, 'out', 'make');
const MANIFEST_PATH = 'capture/latest.json';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const bucket = arg('bucket');
const dryRun = process.argv.includes('--dry-run');
if (!bucket) {
  console.error('Missing --bucket (e.g. voidr_private_staging).');
  process.exit(1);
}

const version = JSON.parse(
  readFileSync(path.join(DESKTOP_ROOT, '..', 'package.json'), 'utf8')
).version;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** Forge encodes platform/arch in the maker's output path, with the filename as fallback. */
function classify(file) {
  const relative = path.relative(MAKE_DIR, file).toLowerCase();
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!['dmg', 'zip', 'exe', 'nupkg', 'deb', 'rpm'].includes(ext)) return null;
  if (ext === 'nupkg') return null;

  const arch = /arm64|aarch64/.test(relative) ? 'arm64' : 'x64';
  let platform = null;
  if (ext === 'dmg') platform = 'mac';
  else if (ext === 'exe') platform = 'windows';
  else if (ext === 'deb' || ext === 'rpm') platform = 'linux';
  else if (ext === 'zip') {
    if (relative.includes('darwin')) platform = 'mac';
    else if (relative.includes('win32')) platform = 'windows';
    else if (relative.includes('linux')) platform = 'linux';
  }
  if (!platform) return null;

  const osSlug = platform === 'mac' ? 'darwin' : platform === 'windows' ? 'win32' : 'linux';
  return {
    platform,
    arch,
    format: ext,
    // Spaces in a filename survive every layer badly; publish a predictable name.
    filename: `voidr-capture-${version}-${osSlug}-${arch}.${ext}`,
    source: file
  };
}

const builds = walk(MAKE_DIR).map(classify).filter(Boolean);
if (builds.length === 0) {
  console.error(`No installers found in ${MAKE_DIR}. Run "npm run capture:make" first.`);
  process.exit(1);
}

function gsutil(args) {
  return execFileSync('gsutil', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function readRemoteManifest() {
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'capture-manifest-'));
    const local = path.join(dir, 'latest.json');
    gsutil(['cp', `gs://${bucket}/${MANIFEST_PATH}`, local]);
    return JSON.parse(readFileSync(local, 'utf8'));
  } catch {
    return null;
  }
}

const previous = readRemoteManifest();
// A version bump invalidates older entries: keep siblings only within the same version.
const kept = previous?.version === version ? previous.builds : [];

const entries = builds.map((build) => {
  const buffer = readFileSync(build.source);
  return {
    platform: build.platform,
    arch: build.arch,
    format: build.format,
    filename: build.filename,
    key: `capture/${version}/${build.filename}`,
    sizeBytes: statSync(build.source).size,
    sha256: createHash('sha256').update(buffer).digest('hex')
  };
});

const manifest = {
  version,
  publishedAt: new Date().toISOString(),
  builds: [
    ...entries,
    ...kept.filter(
      (old) =>
        !entries.some(
          (fresh) =>
            fresh.platform === old.platform &&
            fresh.arch === old.arch &&
            fresh.format === old.format
        )
    )
  ]
};

console.log(`voidr-capture ${version} → gs://${bucket}/capture/${version}/`);
for (const entry of entries) {
  console.log(`  ${entry.platform}/${entry.arch}/${entry.format}  ${entry.filename}`);
}
if (dryRun) {
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

for (let i = 0; i < entries.length; i += 1) {
  gsutil(['cp', builds[i].source, `gs://${bucket}/${entries[i].key}`]);
}

// Manifest last: it must never advertise an object that is not uploaded yet.
const manifestFile = path.join(mkdtempSync(path.join(tmpdir(), 'capture-publish-')), 'latest.json');
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
gsutil(['-h', 'Content-Type:application/json', 'cp', manifestFile, `gs://${bucket}/${MANIFEST_PATH}`]);
console.log(`manifest → gs://${bucket}/${MANIFEST_PATH}`);
