import {
  VOIDR_CAPTURE_LAUNCH_VERSION,
  desktopCaptureLaunchSchema,
  isTrustedWebUrl,
  redactUrl,
  type DesktopCaptureLaunch,
} from '@voidr/capture-contracts';

const V1 = 'voidr-loop-v1=';
const V2 = 'voidr-loop-v2=';
const TOKEN_PATTERN = /^[a-z0-9]+\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{43}$/;
const LOOP_PARAMS = [
  'voidr_token',
  'voidr_record',
  'voidr_mode',
  'voidr_bootstrap',
  'voidr_scenario_id',
  'voidr_cycle_id',
  'voidr_session_n',
];

export interface SecretLoopLaunch {
  scenarioId: string;
  cycleId?: string;
  token: string;
  safeUrl: string;
  transportVersion: 'v1' | 'v2' | 'legacy';
}

export function parseDesktopCaptureLaunch(input: string): DesktopCaptureLaunch {
  const url = new URL(input);
  if (
    url.protocol !== 'voidr:' ||
    url.hostname !== 'capture' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('O link não pertence ao Voidr Capture.');
  }
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const keys = [...url.searchParams.keys()];
  if (
    segments.length !== 4 ||
    segments[0] !== 'loops' ||
    segments[2] !== 'cycles' ||
    keys.length < 3 ||
    keys.length > 6 ||
    new Set(keys).size !== keys.length ||
    keys.some((key) =>
      !['organization', 'surface', 'v', 'access', 'deployment', 'preview'].includes(key),
    ) ||
    (url.searchParams.has('access') && url.searchParams.get('access') !== 'participant') ||
    (url.searchParams.has('deployment') &&
      !['local', 'preview', 'staging', 'production'].includes(
        url.searchParams.get('deployment') ?? '',
      )) ||
    url.searchParams.get('v') !== '1'
  ) {
    throw new Error('O link do Voidr Capture está incompleto ou não é suportado.');
  }
  return desktopCaptureLaunchSchema.parse({
    version: VOIDR_CAPTURE_LAUNCH_VERSION,
    organizationId: url.searchParams.get('organization'),
    loopId: segments[1],
    cycleId: segments[3],
    surface: url.searchParams.get('surface'),
    access: url.searchParams.get('access') ?? 'organization',
    deployment: url.searchParams.get('deployment') ?? 'local',
    previewSlug: url.searchParams.get('preview') ?? undefined,
  });
}

function normalizeTransport(value: string): string {
  const decoded = decodeURIComponent(value);
  return /^[A-Za-z0-9_.~-]+`$/.test(decoded) ? decoded.slice(0, -1) : decoded;
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Loop bootstrap is malformed');
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function parseLoopLaunch(input: string): SecretLoopLaunch {
  if (!isTrustedWebUrl(input)) {
    throw new Error('A captura exige HTTPS ou HTTP em loopback, sem credenciais na URL.');
  }
  const url = new URL(input);
  if (
    url.searchParams.get('voidr_mode') !== 'loop-test' &&
    url.searchParams.get('voidr_record') !== '1'
  ) {
    throw new Error('Esta URL não prepara uma gravação de Loop.');
  }
  const scenarioId = url.searchParams.get('voidr_scenario_id')?.trim();
  if (!scenarioId) throw new Error('A URL não identifica o Loop.');

  let token = url.searchParams.get('voidr_token') ?? '';
  let cycleId = url.searchParams.get('voidr_cycle_id') ?? undefined;
  let originalHash: string | null = null;
  let transportVersion: SecretLoopLaunch['transportVersion'] = 'legacy';
  const fragment = url.hash.slice(1);

  if (url.searchParams.get('voidr_bootstrap') === 'v2' && fragment.startsWith(V2)) {
    const compact = normalizeTransport(fragment.slice(V2.length));
    const parts = compact.split('~');
    if (parts.length > 2) throw new Error('Loop bootstrap v2 is malformed');
    token = parts[0] ?? '';
    originalHash = parts[1] ? fromBase64Url(parts[1]) : '';
    transportVersion = 'v2';
  } else if (url.searchParams.get('voidr_bootstrap') === 'v1' && fragment.startsWith(V1)) {
    const envelope = JSON.parse(fromBase64Url(normalizeTransport(fragment.slice(V1.length)))) as {
      token?: unknown;
      originalHash?: unknown;
      cycleId?: unknown;
    };
    token = typeof envelope.token === 'string' ? envelope.token : '';
    if (!cycleId && typeof envelope.cycleId === 'string') cycleId = envelope.cycleId;
    originalHash = typeof envelope.originalHash === 'string' ? envelope.originalHash : '';
    transportVersion = 'v1';
  } else if (fragment.startsWith(V1) || fragment.startsWith(V2)) {
    throw new Error('A versão do bootstrap não corresponde à URL.');
  }

  if (!token || (transportVersion === 'v2' && !TOKEN_PATTERN.test(token))) {
    throw new Error('A autorização de gravação está ausente ou corrompida.');
  }
  if (transportVersion === 'v2' && !cycleId) {
    throw new Error('A URL v2 não identifica o Cycle.');
  }

  for (const key of LOOP_PARAMS) url.searchParams.delete(key);
  if (originalHash !== null) url.hash = originalHash;
  const safeUrl = url.toString();
  if (safeUrl.includes(token)) throw new Error('A autorização não pôde ser removida da URL.');

  return {
    scenarioId,
    ...(cycleId ? { cycleId } : {}),
    token,
    safeUrl,
    transportVersion,
  };
}

export function safePageUrl(input: string): string {
  return redactUrl(input).slice(0, 2_048);
}
