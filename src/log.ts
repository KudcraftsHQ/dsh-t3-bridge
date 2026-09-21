/**
 * Optional wire log. Set `DSH_T3_LOG=/tmp/dsh-t3-bridge.log` on the provider
 * instance to see exactly what T3 sends and what the bridge answers — the only
 * way to diagnose a probe that T3 reports as a bare "warning".
 */
import { appendFileSync } from "node:fs";

const target = process.env.DSH_T3_LOG?.trim();

export function log(direction: string, payload: unknown): void {
  if (!target) return;
  try {
    const line = typeof payload === "string" ? payload : JSON.stringify(payload);
    appendFileSync(target, `[${new Date().toISOString()}] ${direction} ${line.slice(0, 2000)}\n`);
  } catch {
    // Logging must never break a session.
  }
}
