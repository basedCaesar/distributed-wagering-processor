export type HealthCheckResult =
  | { status: "ok" }
  | { status: "error"; reason: string };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
