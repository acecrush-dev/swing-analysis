/**
 * Plan 005 — shared types for the BusyModal system.
 *
 * `BusyKind` enumerates the four long-running ops that get a busy
 * modal. The renderer uses it to look up a per-op title in i18n; the
 * main process uses it implicitly via the callId-cancel registry (the
 * handlers themselves don't need the kind — they each just take a
 * callId and an abort signal).
 */

export type BusyKind = 'export-package' | 'clear-output-dir' | 'cleanup-clips' | 'open-output-dir';