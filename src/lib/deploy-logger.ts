/**
 * Lightweight ANSI-colored log helpers for the container startup sequence.
 *
 * Runs BEFORE Winston / env-store are available, so it writes directly to
 * process.stdout / process.stderr with zero external dependencies.
 */

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const GREEN_BOLD = "\x1b[1;32m";

function write(stream: NodeJS.WriteStream, color: string, label: string, message: string): void {
  stream.write(`${color}[${label}]${RESET} ${message}\n`);
}

export function migrationLog(message: string): void {
  write(process.stdout, CYAN, "MIGRATION", message);
}

export function seedLog(message: string): void {
  write(process.stdout, GREEN, "SEED", message);
}

export function appLog(message: string): void {
  write(process.stdout, BLUE, "APP", message);
}

export function errorLog(phase: string, message: string): void {
  write(process.stderr, RED, "ERROR", `${phase}: ${message}`);
}

export function successLog(phase: string, message: string): void {
  write(process.stdout, GREEN_BOLD, "OK", `${phase} ${message}`);
}
