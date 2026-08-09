import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { androidDeviceSchema, androidLaunchInputSchema, type AndroidDevice } from '@voidr/capture-contracts';

const execFileAsync = promisify(execFile);
const SESSION_PATTERN = /VoidrReplay started, sessionId=([A-Za-z0-9_-]{8,200})\./g;

export function resolveAdbPath(): string {
  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const sdkRoots = [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME].filter(
    (value): value is string => Boolean(value),
  );
  const candidates = [
    ...sdkRoots.map((root) => join(root, 'platform-tools', executable)),
    join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', executable),
    join(homedir(), 'Android', 'Sdk', 'platform-tools', executable),
    join(homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', executable),
    join('/opt/homebrew/share/android-commandlinetools/platform-tools', executable),
    join('/usr/local/share/android-commandlinetools/platform-tools', executable),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? executable;
}

export interface AndroidDoctor {
  available: boolean;
  adbPath?: string;
  version?: string;
  devices: AndroidDevice[];
  message: string;
}

async function adb(arguments_: string[], timeout = 8_000): Promise<string> {
  const { stdout } = await execFileAsync(resolveAdbPath(), arguments_, {
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export function parseAdbDevices(output: string): AndroidDevice[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial = '', rawState = 'unknown', ...meta] = line.split(/\s+/);
      const fields = Object.fromEntries(
        meta.map((item) => item.split(':', 2)).filter((pair) => pair.length === 2),
      );
      const state = ['device', 'offline', 'unauthorized'].includes(rawState)
        ? rawState
        : 'unknown';
      return androidDeviceSchema.parse({
        serial,
        state,
        model: fields.model,
        product: fields.product,
        transportId: fields.transport_id,
      });
    });
}

export function discoverSessionIds(output: string): string[] {
  return [...output.matchAll(SESSION_PATTERN)].map((match) => match[1]!).reverse();
}

export function parseLauncherComponent(output: string, packageName: string): string {
  const component = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${packageName}/`));
  if (!component || !/^[A-Za-z][A-Za-z0-9_.]{2,199}\/[A-Za-z0-9_.$]+$/.test(component)) {
    throw new Error(`O package ${packageName} não expõe uma Activity de lançamento.`);
  }
  return component;
}

export async function doctorAndroid(): Promise<AndroidDoctor> {
  try {
    const [version, devices] = await Promise.all([adb(['version']), adb(['devices', '-l'])]);
    return {
      available: true,
      adbPath: resolveAdbPath(),
      version: version.split(/\r?\n/)[0]?.trim(),
      devices: parseAdbDevices(devices),
      message: 'ADB pronto. A captura semântica continua no SDK Voidr.',
    };
  } catch (error) {
    return {
      available: false,
      devices: [],
      message:
        error instanceof Error
          ? `ADB indisponível: ${error.message}`
          : 'ADB indisponível neste computador.',
    };
  }
}

export async function launchAndroid(input: unknown): Promise<{ launched: true }> {
  const { serial, packageName } = androidLaunchInputSchema.parse(input);
  const resolved = await adb(['-s', serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', packageName]);
  const component = parseLauncherComponent(resolved, packageName);
  const result = await adb(['-s', serial, 'shell', 'am', 'start', '-W', '-n', component]);
  if (!/Status:\s*ok/i.test(result)) throw new Error(`O Android recusou abrir ${packageName}.`);
  return { launched: true };
}

export async function discoverAndroidSessions(serial: string): Promise<string[]> {
  androidDeviceSchema.shape.serial.parse(serial);
  const output = await adb(['-s', serial, 'logcat', '-d', '-t', '2000', '-s', 'VoidrReplay:D', '*:S']);
  return [...new Set(discoverSessionIds(output))].slice(0, 10);
}
