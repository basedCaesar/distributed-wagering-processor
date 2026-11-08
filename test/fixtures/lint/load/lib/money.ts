export function forbiddenCents(amount: string): number {
  return Math.round(Number(amount) * 100);
}
