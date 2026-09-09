import type { UpdateState } from '../shared/update';

export interface UpdateRelease {
  version: string;
  notes?: string;
  url: string;
  sizeBytes?: number;
}
export interface UpdateDependencies {
  currentVersion: string;
  enabled: boolean;
  automatic: boolean;
  release: (interactive: boolean) => Promise<UpdateRelease | null | 'sign-in'>;
  download: (release: UpdateRelease, progress: (transferred: number, total: number | undefined, bytesPerSecond: number) => void) => Promise<string>;
  stage: (file: string, release: UpdateRelease) => Promise<void>;
  cleanup: () => Promise<void>;
  canRestart: () => boolean;
  preserveLaunch: () => void;
  install: () => void;
  publish: (state: UpdateState) => void;
}

// Release channels publish stable versions. Fail closed on malformed/prerelease
// manifests instead of accidentally downgrading or crossing release channels.
export function isNewerRelease(candidate: string, current: string): boolean {
  const parse = (value: string) => /^\d+\.\d+\.\d+$/.test(value)
    ? value.split('.').map(Number) : undefined;
  const next = parse(candidate);
  const installed = parse(current);
  if (!next || !installed || [...next, ...installed].some((n) => !Number.isSafeInteger(n))) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== installed[index]) return next[index]! > installed[index]!;
  }
  return false;
}

export class CaptureUpdater {
  state: UpdateState;
  private flight?: Promise<UpdateState>;
  constructor(private readonly deps: UpdateDependencies) {
    this.state = { phase: deps.enabled ? 'idle' : 'disabled', currentVersion: deps.currentVersion };
  }
  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    this.deps.publish(this.state);
  }
  check(interactive = false): Promise<UpdateState> {
    if (this.flight) return this.flight;
    if (['disabled', 'ready', 'installing'].includes(this.state.phase)) return Promise.resolve(this.state);
    this.flight = this.run(interactive).finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async run(interactive: boolean): Promise<UpdateState> {
    this.set({ phase: 'checking', message: undefined, version: undefined, notes: undefined, transferred: undefined, total: undefined, bytesPerSecond: undefined });
    try {
      const release = await this.deps.release(interactive);
      if (release === 'sign-in') {
        this.set({ phase: 'sign-in' });
      } else if (!release || !isNewerRelease(release.version, this.state.currentVersion)) {
        this.set({ phase: 'current' });
      } else if (!this.deps.automatic) {
        this.set({ phase: 'manual', version: release.version, notes: release.notes });
      } else {
        this.set({ phase: 'downloading', version: release.version, notes: release.notes, transferred: 0, total: release.sizeBytes });
        const file = await this.deps.download(release, (transferred, total, bytesPerSecond) => {
          this.set({ transferred, total, bytesPerSecond });
        });
        this.set({ phase: 'verifying' });
        await this.deps.stage(file, release);
        this.set({ phase: 'ready' });
      }
    } catch {
      // Transport errors may contain signed URLs, headers or internal paths.
      const message = this.state.phase === 'verifying'
        ? 'Não foi possível verificar o novo aplicativo. A versão atual foi mantida. Tente novamente ou reinstale pela plataforma.'
        : 'Não foi possível concluir a atualização. Verifique sua conexão e tente novamente. A versão atual continua disponível.';
      this.set({ phase: 'error', message });
    } finally {
      await this.deps.cleanup().catch(() => undefined);
    }
    return this.state;
  }
  restart(): UpdateState {
    if (this.state.phase !== 'ready') return this.state;
    if (!this.deps.canRestart()) {
      this.set({ message: 'Conclua o teste e sincronize as evidências antes de reiniciar. A atualização já está pronta.' });
      return this.state;
    }
    try {
      this.deps.preserveLaunch();
      this.set({ phase: 'installing', message: undefined });
      this.deps.install();
    } catch {
      this.set({ phase: 'ready', message: 'Não foi possível reiniciar. Tente novamente; a atualização continua pronta.' });
    }
    return this.state;
  }
}
