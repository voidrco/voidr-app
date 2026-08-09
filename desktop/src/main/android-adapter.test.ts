import { describe, expect, it } from 'vitest';
import {
  discoverSessionIds,
  parseAdbDevices,
  parseLauncherComponent,
  resolveAdbPath,
} from './android-adapter';

describe('Android adapter parsers', () => {
  it('resolves an executable without accepting a UI supplied command', () => {
    expect(resolveAdbPath()).toMatch(/(?:^|[/\\])adb(?:\.exe)?$/);
  });

  it('keeps only bounded device metadata', () => {
    expect(
      parseAdbDevices('List of devices attached\nemulator-5554 device product:sdk model:Pixel_8 transport_id:1\n'),
    ).toEqual([
      {
        serial: 'emulator-5554',
        state: 'device',
        product: 'sdk',
        model: 'Pixel_8',
        transportId: '1',
      },
    ]);
  });

  it('discovers newest SDK session first', () => {
    expect(
      discoverSessionIds(
        'VoidrReplay started, sessionId=session-one-123.\nVoidrReplay started, sessionId=session-two-456.',
      ),
    ).toEqual(['session-two-456', 'session-one-123']);
  });

  it('accepts only a launcher component owned by the requested package', () => {
    expect(
      parseLauncherComponent(
        'priority=0 preferredOrder=0\nco.voidr.replay.demo.itau/.IdentificacaoActivity\n',
        'co.voidr.replay.demo.itau',
      ),
    ).toBe('co.voidr.replay.demo.itau/.IdentificacaoActivity');
    expect(() => parseLauncherComponent('com.attacker/.Main', 'co.voidr.replay.demo.itau')).toThrow(
      'não expõe uma Activity',
    );
  });
});
