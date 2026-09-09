export function isVoidrTeamEmail(email: string | null | undefined): boolean {
  return email?.trim().toLocaleLowerCase("en-US").endsWith("@voidr.co") ?? false;
}
