#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }));
  return nested.flat();
}

async function sha256(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

function releaseNotes(appleSigned) {
  const product =
    'Diagnóstico do ambiente acessível pelo status de conexão e restrito a contas Voidr.';
  if (appleSigned) return `${product} macOS assinado e notarizado pela Apple; Windows validado pelo CI.`;
  return `${product} Versão temporária para testes internos: macOS usa assinatura ad-hoc e pode exigir liberação individual em Privacidade e Segurança; Windows validado pelo CI.`;
}

export async function assembleRelease({
  input,
  output,
  minimumSupportedVersion,
  appleSigned,
  publishedAt = new Date().toISOString(),
}) {
  const allFiles = await filesBelow(input);
  const manifestFiles = allFiles.filter((file) => path.basename(file) === 'latest.json');
  if (manifestFiles.length < 2) {
    throw new Error(`Expected release manifests from macOS and Windows, found ${manifestFiles.length}.`);
  }

  const manifests = await Promise.all(
    manifestFiles.map(async (file) => JSON.parse(await readFile(file, 'utf8'))),
  );
  const versions = new Set(manifests.map((manifest) => manifest.version));
  if (versions.size !== 1) throw new Error('Release jobs produced different versions.');
  const [version] = versions;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Release version must be a stable semantic version.');
  }
  if (!/^\d+\.\d+\.\d+$/.test(minimumSupportedVersion)) {
    throw new Error('Minimum supported version must be a stable semantic version.');
  }

  const builds = manifests.flatMap((manifest) => manifest.builds ?? []);
  const required = [
    ['mac', 'arm64', 'dmg'],
    ['mac', 'arm64', 'zip'],
    ['windows', 'x64', 'exe'],
  ];
  const selected = [];
  for (const [platform, arch, format] of required) {
    const matches = builds.filter(
      (build) => build.platform === platform && build.arch === arch && build.format === format,
    );
    if (matches.length !== 1) {
      throw new Error(`Expected one ${platform}/${arch}/${format} build, found ${matches.length}.`);
    }
    selected.push(matches[0]);
  }

  const versionDirectory = path.join(output, 'capture', version);
  await mkdir(versionDirectory, { recursive: true });
  for (const build of selected) {
    const candidates = allFiles.filter((file) => path.basename(file) === build.filename);
    if (candidates.length !== 1) {
      throw new Error(`Expected one artifact named ${build.filename}, found ${candidates.length}.`);
    }
    const source = candidates[0];
    const metadata = await stat(source);
    if (metadata.size !== build.sizeBytes) throw new Error(`Size mismatch for ${build.filename}.`);
    if ((await sha256(source)) !== build.sha256) throw new Error(`SHA-256 mismatch for ${build.filename}.`);
    await copyFile(source, path.join(versionDirectory, build.filename));
  }

  const manifest = {
    version,
    minimumSupportedVersion,
    publishedAt,
    notes: releaseNotes(appleSigned),
    builds: selected,
  };
  const manifestPath = path.join(output, 'capture', 'latest.json');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestPath, versionDirectory };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const input = argument('input');
  const output = argument('output');
  const minimumSupportedVersion = argument('minimum-supported-version');
  const appleSigned = argument('apple-signed', 'false') === 'true';
  if (!input || !output || !minimumSupportedVersion) {
    throw new Error(
      'Usage: assemble-release.mjs --input=<dir> --output=<dir> --minimum-supported-version=<version> [--apple-signed=true|false]',
    );
  }
  const result = await assembleRelease({ input, output, minimumSupportedVersion, appleSigned });
  console.log(`Assembled Capture ${result.manifest.version} with ${result.manifest.builds.length} artifacts.`);
}
