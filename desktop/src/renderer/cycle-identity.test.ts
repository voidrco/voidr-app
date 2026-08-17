import { describe, expect, it } from 'vitest';
import {
  compactParticipantName,
  cycleParticipantLabel,
  formatCycleStartedAt,
} from './cycle-identity';

describe('Cycle participant identity', () => {
  it('keeps the recording label compact while using canonical profile data', () => {
    expect(compactParticipantName('Milson Ramos de Carvalho Júnior')).toBe('Milson Júnior');
    expect(
      cycleParticipantLabel(
        {
          name: 'Milson Ramos de Carvalho Júnior',
          role: 'Software Developer',
          picture: 'https://images.example/milson.png',
        },
        '2026-08-17T15:45:00.000Z',
      ),
    ).toMatch(/^Milson Júnior - Developer - /);
  });

  it('formats the immutable Cycle creation time in the local product language', () => {
    expect(
      formatCycleStartedAt('2026-08-17T15:45:00.000Z', {
        timeZone: 'America/Sao_Paulo',
      }),
    ).toBe('Seg. 17 de ago. 12:45');
  });
});
