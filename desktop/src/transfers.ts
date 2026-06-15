// Module-level registry of active SFTP transfers.
//
// The SFTPPanel is conditionally mounted (App renders it only while a target is
// set), so its component state is destroyed the moment the panel is closed.
// Keeping the in-flight transfers here — outside any component — means the
// progress bars (with their file name / direction / destination labels) survive
// a close-and-reopen and re-render correctly when the panel comes back, while
// the underlying backend transfer keeps running (it holds its own Arc to the
// SFTP session, so a panel-close disconnect doesn't kill it).
//
// Deliberately tiny: a plain object + listener set, consumed via
// useSyncExternalStore. No external dependency, mirrors the localStorage-style
// minimalism already used in SFTPPanel.

import { useSyncExternalStore } from "react";

/** Direction of a transfer, for the bar's arrow / label. */
export type TransferDirection = "download" | "upload";

/** A streaming transfer with live progress (total === 0 ⇒ unknown size). */
export interface Transfer {
  id: string;
  /** File name being transferred. */
  name: string;
  phase: TransferDirection;
  /** Destination path (local path for a download, remote path for an upload). */
  dest: string;
  transferred: number;
  total: number;
  /** Set once the user has asked to cancel; the bar shows "cancelling…". */
  cancelling?: boolean;
}

let transfers: Record<string, Transfer> = {};
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Record<string, Transfer> {
  return transfers;
}

/** Register a transfer so its label shows before the first progress event. */
export function addTransfer(
  t: Omit<Transfer, "transferred" | "total">,
): void {
  transfers = { ...transfers, [t.id]: { ...t, transferred: 0, total: 0 } };
  emit();
}

/** Merge a progress update into an existing transfer (no-op if it's gone). */
export function updateTransfer(
  id: string,
  patch: Partial<Transfer>,
): void {
  const cur = transfers[id];
  if (!cur) return;
  transfers = { ...transfers, [id]: { ...cur, ...patch } };
  emit();
}

/** Mark a transfer as cancelling (the bar reflects this until it resolves). */
export function markCancelling(id: string): void {
  updateTransfer(id, { cancelling: true });
}

/** Remove a transfer (finished, errored, or cancelled). */
export function removeTransfer(id: string): void {
  if (!(id in transfers)) return;
  const next = { ...transfers };
  delete next[id];
  transfers = next;
  emit();
}

/** React hook: the live map of active transfers (re-renders on any change). */
export function useTransfers(): Record<string, Transfer> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
