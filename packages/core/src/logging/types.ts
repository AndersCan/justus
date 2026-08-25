/** Shared log types for the `justus.logs` plugin (issue #15).
 *
 * These mirror the wire shape the backend {@link LogCollector} produces so the
 * backend and web layer agree on a single entry contract. */

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export interface LogEntry {
  seq: number;
  ts: number;
  level: LogLevel;
  source: string;
  tag?: string;
  message: string;
}
