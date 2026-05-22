/** Verbose console output for reference traversal, stats, and API diagnostics. */
const DEBUG_FROM_SOURCE = false;

export const DEBUG_ENABLED =
	DEBUG_FROM_SOURCE || import.meta.env.VITE_DEBUG === "true";

export function debugLog(...args: unknown[]): void {
	if (DEBUG_ENABLED) console.log(...args);
}

export function debugError(...args: unknown[]): void {
	if (DEBUG_ENABLED) console.error(...args);
}

/** Always logged — publish failures, sidebar fetch errors, etc. */
export function logError(...args: unknown[]): void {
	console.error(...args);
}

export function debugWarn(...args: unknown[]): void {
	if (DEBUG_ENABLED) console.warn(...args);
}
