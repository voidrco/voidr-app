import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const makeRoot = path.join(repositoryRoot, 'desktop/out/make');
const releaseRoot = path.join(repositoryRoot, 'desktop/out/release');

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(target) : [target];
    }),
  );
  return nested.flat();
}

async function sha256(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

const platform = argument('platform');
const arch = argument('arch');
const channel = argument('channel') ?? 'production';
if (!['mac', 'windows', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
  throw new Error(
    'Usage: node prepare-release.mjs --platform=mac|windows|linux --arch=arm64|x64 [--channel=staging|production]',
  );
}
if (!['staging', 'production'].includes(channel)) {
  throw new Error('Release channel must be staging or production.');
}

const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('The root package version is not a valid release version.');
}

const extensions = platform === 'mac' ? ['dmg', 'zip'] : platform === 'windows' ? ['exe'] : ['deb'];
const candidates = await filesBelow(makeRoot);
const selected = extensions.map((extension) => {
  const matches = candidates.filter((file) => path.extname(file).toLowerCase() === `.${extension}`);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one .${extension} artifact, found ${matches.length}.`);
  }
  return { extension, source: matches[0] };
});

const platformFilename = platform === 'mac' ? 'darwin' : platform === 'windows' ? 'windows' : 'linux';
const channelDirectory = channel === 'staging' ? path.join('capture', 'preview') : 'capture';
const versionDirectory = path.join(releaseRoot, channelDirectory, version);
await mkdir(versionDirectory, { recursive: true });

const builds = [];
for (const { extension, source } of selected) {
  const filename = `voidr-capture-${version}-${platformFilename}-${arch}.${extension}`;
  const destination = path.join(versionDirectory, filename);
  await copyFile(source, destination);
  const metadata = await stat(destination);
  builds.push({
    platform,
    arch,
    format: extension,
    filename,
    key: `${channelDirectory}/${version}/${filename}`,
    sizeBytes: metadata.size,
    sha256: await sha256(destination),
  });
}

const manifest = {
  version,
  publishedAt: new Date().toISOString(),
  notes: 'Conexão guiada ao workspace e acesso autenticado aos Loops.',
  builds,
};
const manifestPath = path.join(releaseRoot, channelDirectory, 'latest.json');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`Prepared ${builds.length} release artifacts and ${path.relative(repositoryRoot, manifestPath)}.`);
