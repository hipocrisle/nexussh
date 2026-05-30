// Themed-dialogs singleton — replaces window.confirm() / window.prompt() /
// Tauri ask() everywhere in the app. Any component can `await askConfirm(...)`
// or `await askPrompt(...)` without prop drilling or React Context: one
// <DialogHost/> mounted by App subscribes and renders the modal. No context
// provider needed.

import { useEffect, useState } from "react";

interface ConfirmOpts {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}
interface PromptOpts {
  title?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}
interface ConfirmReq extends ConfirmOpts {
  message: string;
  resolve: (v: boolean) => void;
}
interface PromptReq extends PromptOpts {
  message: string;
  resolve: (v: string | null) => void;
}

let confirmReq: ConfirmReq | null = null;
let promptReq: PromptReq | null = null;
const subs = new Set<() => void>();
function notify() {
  subs.forEach((s) => s());
}

export function askConfirm(
  message: string,
  opts: ConfirmOpts = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    confirmReq = { message, ...opts, resolve };
    notify();
  });
}

export function askPrompt(
  message: string,
  opts: PromptOpts = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    promptReq = { message, ...opts, resolve };
    notify();
  });
}

/** Hook used by <DialogHost/> — subscribes to singleton changes. */
export function useDialogState() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  }, []);
  return {
    confirm: confirmReq,
    prompt: promptReq,
    resolveConfirm: (v: boolean) => {
      if (!confirmReq) return;
      const r = confirmReq.resolve;
      confirmReq = null;
      notify();
      r(v);
    },
    resolvePrompt: (v: string | null) => {
      if (!promptReq) return;
      const r = promptReq.resolve;
      promptReq = null;
      notify();
      r(v);
    },
  };
}
