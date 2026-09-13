/**
 * Shared error type for @modes/orchestrator. Every refusal/conflict carries a stable
 * machine-readable `code` — contract tests match on it, callers dispatch on it.
 */
export class OrchestratorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
  }
}
