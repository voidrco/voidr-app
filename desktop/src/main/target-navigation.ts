export function isExpectedNavigationAbort(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /(?:ERR_ABORTED|\(-3\))/i.test(message);
}
