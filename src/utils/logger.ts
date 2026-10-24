import type { LogLevel } from "../types/contracts";

/**
 * Structured logger for the plugin. Only warnings and errors reach the console.
 *
 * Callers pass identifiers, counts and classifications only. Prompts, replies, error bodies and
 * file contents must never reach this surface.
 */
export class Logger {
  constructor(private readonly prefix = "Hermes Control Center") {}

  private emit(level: LogLevel, message: string, fields: Record<string, string | number | boolean>): void {
    const rendered = Object.entries(fields)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    const line = `[${this.prefix}] ${level} | ${message}${rendered === "" ? "" : ` | ${rendered}`}`;
    if (level === "error") console.error(line);
    else console.warn(line);
  }

  warn(message: string, fields: Record<string, string | number | boolean> = {}): void {
    this.emit("warn", message, fields);
  }

  error(message: string, fields: Record<string, string | number | boolean> = {}): void {
    this.emit("error", message, fields);
  }
}
