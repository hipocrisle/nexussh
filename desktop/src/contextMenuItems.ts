// Builds Copy / Cut / Paste / Select All menu items for the generic
// app-wide right-click handler (non-terminal areas).

import type { MenuItem } from "./ContextMenu";

type Editable = HTMLInputElement | HTMLTextAreaElement;

function isEditable(el: HTMLElement | null): el is Editable {
  if (!el) return false;
  if (el.tagName === "INPUT") {
    const t = (el as HTMLInputElement).type;
    // password / text / search / email / url / number — editable types
    return t !== "checkbox" && t !== "radio" && t !== "button" && t !== "submit";
  }
  return el.tagName === "TEXTAREA";
}

/** Insert text at the input/textarea cursor, preserving React's controlled
 *  value tracking by dispatching a synthetic input event after using the
 *  native setter (React tracks the last-seen value via setter override). */
function insertAtCursor(el: Editable, text: string) {
  const proto =
    el.tagName === "INPUT"
      ? window.HTMLInputElement.prototype
      : window.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  setter?.call(el, next);
  el.selectionStart = el.selectionEnd = start + text.length;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function deleteSelection(el: Editable) {
  const proto =
    el.tagName === "INPUT"
      ? window.HTMLInputElement.prototype
      : window.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  if (start === end) return;
  setter?.call(el, el.value.slice(0, start) + el.value.slice(end));
  el.selectionStart = el.selectionEnd = start;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

type Tr = (key: string) => string;

export function buildAppContextMenu(
  target: HTMLElement | null,
  t: Tr,
): MenuItem[] {
  const items: MenuItem[] = [];
  const selection = window.getSelection()?.toString() ?? "";
  const editable = isEditable(target);
  const editableSel =
    editable &&
    (target as Editable).selectionStart !== (target as Editable).selectionEnd;

  // Copy — appears when there's any text selected (anywhere, not just in
  // editable). For inputs we prefer their own selection range.
  const hasCopyable =
    selection || (editable && editableSel);
  if (hasCopyable) {
    items.push({
      label: t("ctx.copy"),
      onClick: () => {
        const text = editable
          ? (target as Editable).value.slice(
              (target as Editable).selectionStart ?? 0,
              (target as Editable).selectionEnd ?? 0,
            )
          : selection;
        if (text) navigator.clipboard.writeText(text).catch(() => {});
      },
    });
  }

  if (editable) {
    if (editableSel) {
      items.push({
        label: t("ctx.cut"),
        onClick: () => {
          const el = target as Editable;
          const s = el.selectionStart ?? 0;
          const e = el.selectionEnd ?? 0;
          const sel = el.value.slice(s, e);
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
          deleteSelection(el);
        },
      });
    }
    items.push({
      label: t("ctx.paste"),
      onClick: async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) insertAtCursor(target as Editable, text);
        } catch {
          /* clipboard denied */
        }
      },
    });
    items.push({
      label: t("ctx.select_all"),
      onClick: () => (target as Editable).select(),
    });
  }

  return items;
}
