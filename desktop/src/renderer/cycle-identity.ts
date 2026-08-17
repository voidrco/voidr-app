import type { DesktopCycleParticipant } from '@voidr/capture-contracts';

export function compactParticipantName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 2) return parts.join(' ');
  return `${parts[0]} ${parts.at(-1)}`;
}

export function compactParticipantRole(role: string | null): string | null {
  if (!role) return null;
  const normalized = role.trim();
  if (/^software developer$/i.test(normalized)) return 'Developer';
  return normalized;
}

export function formatCycleStartedAt(
  value: string,
  options: { timeZone?: string } = {},
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...options,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value.replace(/[.,]/g, '') ?? '';
  const weekday = part('weekday');
  const day = String(Number(part('day')) || '');
  const month = part('month');
  const hour = part('hour');
  const minute = part('minute');
  if (!weekday || !day || !month || !hour || !minute) return '';
  return `${weekday.charAt(0).toLocaleUpperCase('pt-BR')}${weekday.slice(1)}. ${day} de ${month}. ${hour}:${minute}`;
}

export function cycleParticipantLabel(
  participant: DesktopCycleParticipant | null | undefined,
  cycleStartedAt?: string,
): string | null {
  if (!participant) return null;
  const name = compactParticipantName(participant.name);
  const role = compactParticipantRole(participant.role);
  const startedAt = cycleStartedAt ? formatCycleStartedAt(cycleStartedAt) : '';
  return [name, role, startedAt].filter(Boolean).join(' - ');
}
