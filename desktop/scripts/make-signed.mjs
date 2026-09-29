import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const project = process.env.GCP_SIGNING_PROJECT ?? 'perceptive-bay-340802';
const names = ['APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'MACOS_CERTIFICATE_P12_BASE64', 'MACOS_CERTIFICATE_PASSWORD'];

function mask(value) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const escaped = value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.log(`::add-mask::${escaped}`);
}

async function quiet(command, args, options = {}) {
  try {
    return (await execute(command, args, options)).stdout.trim();
  } catch (error) {
    const detail = args.filter(value => value.length > 8).reduce((message, value) => message.replaceAll(value, '[redacted]'), error.stderr ?? '');
    throw new Error(`${command} ${args[0]} failed (exit ${error.code}): ${detail}`);
  }
}

async function loadSecrets() {
  const values = await Promise.all(names.map(name => quiet('gcloud', [
    'secrets', 'versions', 'access', 'latest', `--secret=${name}`, `--project=${project}`,
  ])));
  if (values.some(value => !value)) throw new Error('A signing secret is empty.');
  values.forEach(mask);
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

async function prepareKeychain(directory, values) {
  const keychain = path.join(directory, 'signing.keychain-db');
  const certificate = await prepareCertificate(directory, values);
  const password = randomBytes(32).toString('hex');
  mask(password);
  await quiet('security', ['create-keychain', '-p', password, keychain]);
  await quiet('security', ['set-keychain-settings', '-lut', '21600', keychain]);
  await quiet('security', ['unlock-keychain', '-p', password, keychain]);
  await quiet('security', ['import', certificate, '-P', values.MACOS_CERTIFICATE_PASSWORD, '-k', keychain, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
  await importIntermediate(directory, keychain);
  const searchList = await keychains();
  await quiet('security', ['list-keychains', '-d', 'user', '-s', keychain, ...searchList.filter(value => value !== keychain)]);
  await quiet('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain]);
  const identities = await quiet('security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
  const identity = identities.match(/"(Developer ID Application:[^"]+)"/)?.[1];
  if (!identity?.endsWith(`(${values.APPLE_TEAM_ID})`)) {
    const diagnostic = await quiet('security', ['find-identity', '-p', 'codesigning', keychain]);
    throw new Error(`No valid Developer ID identity for the configured team. ${diagnostic}`);
  }
  console.log(`Signing identity verified: ${identity}`);
  await quiet('xcrun', ['notarytool', 'store-credentials', 'voidr-release', '--apple-id', values.APPLE_ID,
    '--team-id', values.APPLE_TEAM_ID, '--password', values.APPLE_APP_SPECIFIC_PASSWORD, '--keychain', keychain]);
  console.log('Apple notarization credentials validated.');
  return { APPLE_CODESIGN_IDENTITY: identity, APPLE_NOTARY_KEYCHAIN: keychain,
    APPLE_NOTARY_KEYCHAIN_PROFILE: 'voidr-release', VOIDR_PUBLIC_RELEASE: '1' };
}

async function prepareCertificate(directory, values) {
  const certificate = path.join(directory, 'certificate.p12');
  await writeFile(certificate, Buffer.from(values.MACOS_CERTIFICATE_P12_BASE64, 'base64'), { mode: 0o600 });
  const pem = path.join(directory, 'identity.pem');
  const options = { env: { ...process.env, VOIDR_P12_PASSWORD: values.MACOS_CERTIFICATE_PASSWORD } };
  await quiet('openssl', ['pkcs12', '-in', certificate, '-out', pem, '-passin', 'env:VOIDR_P12_PASSWORD', '-nodes'], options);
  await quiet('openssl', ['pkcs12', '-export', '-in', pem, '-out', certificate, '-passout', 'env:VOIDR_P12_PASSWORD', '-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'], options);
  await rm(pem);
  return certificate;
}

async function importIntermediate(directory, keychain) {
  const intermediate = path.join(directory, 'DeveloperIDG2CA.cer');
  const response = await fetch('https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer', { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Could not retrieve Apple Developer ID intermediate certificate.');
  await writeFile(intermediate, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  await quiet('security', ['import', intermediate, '-k', keychain]);
}

async function keychains() {
  return (await quiet('security', ['list-keychains', '-d', 'user'])).match(/"([^"]+)"/g)?.map(value => value.slice(1, -1)) ?? [];
}

async function ensureDmgDependencies() {
  try {
    require('macos-alias');
    require('fs-xattr');
  } catch {
    await quiet('npm', ['rebuild', 'macos-alias', 'fs-xattr', '--loglevel=error'], {
      cwd: root, env: { ...process.env, npm_config_loglevel: 'error', PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` },
    });
    require('macos-alias');
    require('fs-xattr');
  }
}

function make(environment) {
  const reusePackage = process.argv.includes('--skip-package');
  const command = reusePackage ? process.execPath : 'npm';
  const args = reusePackage
    ? [path.join(root, 'node_modules/@electron-forge/cli/dist/electron-forge-make.js'), '--skip-package', `--arch=${process.arch}`]
    : ['run', 'make', '--workspace', '@voidr/capture-desktop', '--', `--arch=${process.arch}`];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: reusePackage ? path.join(root, 'desktop') : root, stdio: 'inherit', env: { ...process.env, ...environment, VITE_VOIDR_CAPTURE_CHANNEL: process.env.VITE_VOIDR_CAPTURE_CHANNEL ?? 'production' },
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Packaging failed (${code}).`)));
  });
}

async function verify() {
  const application = path.join(root, 'desktop/out', `Voidr-darwin-${process.arch}`, 'Voidr.app');
  const artifacts = await readdir(path.join(root, 'desktop/out/make'), { recursive: true });
  const dmgs = artifacts.filter(file => file.endsWith('.dmg'));
  if (dmgs.length !== 1) throw new Error('Expected exactly one DMG.');
  const dmg = path.join(root, 'desktop/out/make', dmgs[0]);
  for (const artifact of [application, dmg]) {
    await quiet('codesign', ['--verify', '--strict', '--verbose=2', ...(artifact === application ? ['--deep'] : []), artifact]);
    await quiet('xcrun', ['stapler', 'validate', artifact]);
  }
  await quiet('spctl', ['--assess', '--type', 'execute', '--verbose=4', application]);
  await quiet('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg]);
  console.log(`Signed, notarized and verified:\n${application}\n${dmg}`);
}

if (process.platform !== 'darwin') throw new Error('macOS is required.');
if (!process.argv.includes('--check-credentials')) await ensureDmgDependencies();
const directory = await mkdtemp(path.join(tmpdir(), 'voidr-signing-'));
const originalKeychains = await keychains();
try {
  const environment = await prepareKeychain(directory, await loadSecrets());
  if (!process.argv.includes('--check-credentials')) {
    await make(environment);
    await verify();
  }
} finally {
  try {
    await quiet('security', ['list-keychains', '-d', 'user', '-s', ...originalKeychains]);
  } finally {
    await quiet('security', ['delete-keychain', path.join(directory, 'signing.keychain-db')]).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
