/**
 * The per-command wall-clock budget (#162), shared vocabulary.
 *
 * The backend has always published how long it will wait
 * (`BrowserCommandEvent.timeout_seconds`); until this existed the extension
 * ignored it, so a command whose stages were each individually bounded could
 * sum past the transport deadline and the agent got the backend's bare
 * "[Error]: timed out" with NO payload. The budget converts that into an
 * in-time honest answer.
 *
 * One encoding: a command either HAS a budget (an `ExecContext` with both
 * fields set) or has none (no context). Callers must not invent a second
 * spelling with nullable fields; the dead fallback branches that shape
 * produces were a review finding the first time around.
 */

export interface ExecContext {
  /** Epoch ms the command should finish by. */
  deadline: number
  /** The full wire budget in ms, kept so failure copy can name it. */
  budgetMs: number
}

/**
 * How much of the wire budget is reserved for getting the result OUT: payload
 * assembly, the result POST, and the SSE delivery latency the receipt-anchored
 * clock cannot see (the backend's clock started at publish, ours at receipt).
 * The point is that an honest partial-progress payload must ARRIVE before the
 * backend's `timeout_s + 1` wait gives up and returns the bare timeout.
 */
export const BUDGET_RESERVE_MS = 3_000

/** True when a caller-supplied deadline has passed. No deadline, never spent. */
export function budgetSpent(deadline?: number | null): boolean {
  return typeof deadline === 'number' && Date.now() >= deadline
}

/** Milliseconds left on the clock; Infinity when there is no deadline. */
export function budgetLeft(deadline: number | null): number {
  return deadline === null ? Infinity : deadline - Date.now()
}

/** `ms` shrunk to what the clock still allows (never negative). */
export function clampToDeadline(ms: number, deadline: number | null): number {
  return deadline === null ? ms : Math.max(0, Math.min(ms, deadline - Date.now()))
}

/** The human label for failure copy: "the command's 30s time budget". */
export function budgetLabel(budgetMs: number | null | undefined): string {
  return typeof budgetMs === 'number'
    ? `the command's ${Math.round(budgetMs / 1000)}s time budget`
    : "the command's time budget"
}
