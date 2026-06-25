// SnippetsModal — grid of saved commands that fire into the active terminal,
// with editor, categories, drag-reorder, 1–9 hotkeys, import/export, sync toggle.
// Design handoff step 12 (screens/07-snippets.md).

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  X, Plus, Download, Upload, Cloud, SquarePen, Trash2, GripVertical, Zap,
} from "lucide-react";
import {
  Snippet,
  listSnippets,
  listCategories,
  addSnippet,
  updateSnippet,
  deleteSnippet,
  reorderSnippets,
  addCategory,
  removeCategory,
  exportSnippets,
  importSnippets,
  expandPlaceholders,
  snippetsSyncEnabled,
  setSnippetsSyncEnabled,
  onSnippetsChanged,
} from "./snippets";
import { Button, Input, Checkbox, Toggle, RowLabel } from "./components/primitives";
import { useBackdropClose } from "./useBackdropClose";
import { askPrompt, askConfirm } from "./dialogs";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";

const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Props {
  onClose: () => void;
  /** Send a string to the active terminal (already includes trailing \r if autoRun). */
  onRun: (data: string) => void;
  /** Active session context for {{host/user/port}} placeholders + the header line. */
  activeCtx: { host?: string; user?: string; port?: number; name?: string } | null;
  /** Toast for "no active terminal". */
  onToast?: (msg: string, kind?: "error") => void;
  /** Run an account sync now (header cloud button). Omit to hide it. */
  onSync?: () => void;
}

export function SnippetsModal({ onClose, onRun, activeCtx, onToast, onSync }: Props) {
  const { t } = useTranslation();
  const [list, setList] = useState<Snippet[]>(() => listSnippets());
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const [editing, setEditing] = useState<Snippet | "new" | null>(null);
  const [syncOn, setSyncOn] = useState(snippetsSyncEnabled());
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [selIdx, setSelIdx] = useState(-1);
  const fileRef = useRef<HTMLInputElement>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  useEffect(() => onSnippetsChanged(() => setList(listSnippets())), []);
  // Reset grid selection whenever the visible set changes (search / category).
  useEffect(() => setSelIdx(-1), [q, cat]);

  // Pointer-based drag-reorder. HTML5 `draggable` doesn't fire reliably in
  // Tauri/webkit, so we grab on the grip (onDragStart sets dragId) and track
  // the pointer over tiles via elementFromPoint + [data-snippet-id].
  const overIdRef = useRef<string | null>(null);
  overIdRef.current = overId;
  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: MouseEvent) => {
      const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest(
        "[data-snippet-id]",
      );
      const id = el?.getAttribute("data-snippet-id") ?? null;
      setOverId(id && id !== dragId ? id : null);
    };
    const onUp = () => {
      const target = overIdRef.current;
      if (target) onDrop(target);
      else setDragId(null);
      setOverId(null);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId]);

  const categories = listCategories();
  const needle = q.trim().toLowerCase();
  const filtered = list.filter(
    (s) =>
      (cat === "all" || s.category === cat) &&
      (!needle ||
        s.name.toLowerCase().includes(needle) ||
        s.command.toLowerCase().includes(needle)),
  );

  const hasTerminal = !!activeCtx;

  async function run(s: Snippet) {
    if (!hasTerminal) {
      onToast?.(t("snippets.no_terminal"), "error");
      return;
    }
    if (s.confirm && !(await askConfirm(t("snippets.confirm_run", { name: s.name })))) return;
    const cmd = expandPlaceholders(s.command, activeCtx);
    onRun(cmd + (s.autoRun ? "\r" : ""));
    onClose();
  }

  // In-modal keyboard. Поиск всегда в фокусе, поэтому:
  //  • поле ПУСТОЕ → цифры 1–9 запускают сниппет с этим хоткеем (пусто=хоткеи);
  //  • есть текст → цифры идут в фильтр (печать=поиск), запуск ↵ по выделенному;
  //  • ←→↑↓ двигают выделение по гриду (2 кол), ↵ запускает выделенную плитку;
  //  • Esc закрывает.
  useEffect(() => {
    if (editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const empty = !q.trim();
      const n = parseInt(e.key, 10);
      if (empty && n >= 1 && n <= 9) {
        const s = list.find((x) => x.hotkey === n);
        if (s) {
          e.preventDefault();
          void run(s);
        }
        return;
      }
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        if (filtered.length === 0) return;
        e.preventDefault();
        const cols = 2;
        setSelIdx((i) => {
          if (i < 0) return 0;
          if (e.key === "ArrowRight") return Math.min(filtered.length - 1, i + 1);
          if (e.key === "ArrowLeft") return Math.max(0, i - 1);
          if (e.key === "ArrowDown") return Math.min(filtered.length - 1, i + cols);
          return Math.max(0, i - cols); // ArrowUp
        });
        return;
      }
      if (e.key === "Enter" && selIdx >= 0 && filtered[selIdx]) {
        e.preventDefault();
        void run(filtered[selIdx]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, filtered, selIdx, editing, hasTerminal, activeCtx, q]);

  function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      setOverId(null);
      return;
    }
    const ids = filtered.map((s) => s.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    // Merge reordered visible ids with the rest (other categories) preserving order.
    const rest = list.filter((s) => !ids.includes(s.id)).map((s) => s.id);
    reorderSnippets([...ids, ...rest]);
    setDragId(null);
    setOverId(null);
  }

  async function exportFile() {
    const json = exportSnippets();
    if (HAS_TAURI) {
      // Tauri: ask WHERE to save (browser <a download> silently dumps to Downloads).
      try {
        const path = await saveFileDialog({
          defaultPath: "nexussh-snippets.json",
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!path) return; // cancelled
        await writeFile(path, new TextEncoder().encode(json));
        onToast?.(t("snippets.export_done"));
      } catch {
        /* cancelled / fs error */
      }
      return;
    }
    // Web fallback: browser download.
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "nexussh-snippets.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importTauri() {
    try {
      const path = await openFileDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      const txt = new TextDecoder().decode(await readFile(path));
      const { added, skipped } = importSnippets(txt);
      onToast?.(t("snippets.import_done", { added, skipped }));
    } catch {
      /* cancelled / fs error */
    }
  }

  function importFile(file: File) {
    file.text().then((txt) => {
      const { added, skipped } = importSnippets(txt);
      onToast?.(t("snippets.import_done", { added, skipped }));
    });
  }

  // ---- Editor view ----
  if (editing) {
    return (
      <SnippetEditor
        initial={editing === "new" ? null : editing}
        categories={categories}
        onCancel={() => setEditing(null)}
        onSaved={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="nx-scrim grid place-items-center" {...backdropProps}>
      <div
        {...contentProps}
        className="nx-modal-enter relative w-[640px] max-w-[94vw] max-h-[92vh] bg-nx-panel rounded-nx-lg shadow-elev-modal overflow-hidden flex flex-col max-md:w-full max-md:max-w-none max-md:h-full max-md:rounded-none"
      >
        <span className="nx-brackets">
          <i />
        </span>

        {/* header */}
        <div className="nx-safe-top flex items-baseline gap-3 px-[22px] pt-5 pb-4 border-b border-nx-divider shrink-0">
          <span className="text-micro uppercase tracking-[0.22em] text-nx-accent">
            // {t("snippets.kicker")}
          </span>
          <div className="text-h2 text-nx-text font-mono">
            <span className="text-nx-accent mr-2">&gt;</span>snippets
          </div>
          <span className="text-meta text-nx-muted truncate">
            {t("snippets.count_target", { n: list.length, host: activeCtx?.name ?? "—" })}
          </span>
          {onSync && (
            <button
              onClick={onSync}
              title={t("snippets.sync_now")}
              className="ml-auto p-1.5 text-nx-muted hover:text-nx-accent"
            >
              <Cloud size={14} />
            </button>
          )}
          <button
            onClick={onClose}
            className={(onSync ? "" : "ml-auto ") + "p-1.5 text-nx-muted hover:text-nx-text"}
          >
            <X size={14} />
          </button>
        </div>

        {/* search */}
        <div className="px-[22px] pt-3.5 shrink-0">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-nx-accent font-bold pointer-events-none">
              &gt;
            </span>
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("snippets.filter")}
              className="nx-focus w-full pl-7 pr-3 py-2.5 bg-nx-bg border border-nx-border rounded-nx text-body text-nx-text placeholder-nx-muted font-mono outline-none focus:border-nx-accent"
            />
          </div>
        </div>

        {/* category chips */}
        <div className="px-[22px] pt-3 flex items-center gap-1.5 flex-wrap shrink-0">
          <CatChip active={cat === "all"} count={list.length} onClick={() => setCat("all")}>
            {t("snippets.cat_all")}
          </CatChip>
          {categories.map((c) => (
            <CatChip
              key={c}
              active={cat === c}
              count={list.filter((s) => s.category === c).length}
              prefix
              onClick={() => setCat(c)}
              onDelete={async () => {
                if (await askConfirm(t("snippets.delete_category", { name: c }))) {
                  removeCategory(c);
                  if (cat === c) setCat("all");
                }
              }}
            >
              {c}
            </CatChip>
          ))}
          <button
            onClick={async () => {
              const n = await askPrompt(t("snippets.new_category"));
              if (n?.trim()) addCategory(n.trim());
            }}
            className="inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-full border border-dashed border-nx-border text-nx-soft text-meta hover:text-nx-accent hover:border-nx-accent"
          >
            + {t("snippets.add_category")}
          </button>
        </div>

        {/* grid OR empty */}
        <div className="px-[22px] py-3.5 overflow-y-auto flex-1">
          {filtered.length === 0 ? (
            <SnippetEmpty onCreate={() => setEditing("new")} hasAny={list.length > 0} />
          ) : (
            <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
              {filtered.map((s, i) => (
                <SnippetTile
                  key={s.id}
                  s={s}
                  selected={selIdx === i}
                  dragging={dragId === s.id}
                  over={overId === s.id}
                  onRun={() => run(s)}
                  onEdit={() => setEditing(s)}
                  onDelete={async () => {
                    if (await askConfirm(t("snippets.delete_confirm", { name: s.name })))
                      deleteSnippet(s.id);
                  }}
                  onDragStart={() => setDragId(s.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center gap-2.5 px-5 py-3.5 border-t border-nx-divider bg-nx-bg-2 shrink-0 flex-wrap">
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<Plus size={13} />}
            onClick={() => setEditing("new")}
          >
            {t("snippets.add")}
          </Button>
          <button
            onClick={() => (HAS_TAURI ? importTauri() : fileRef.current?.click())}
            className="inline-flex items-center gap-1.5 text-meta text-nx-muted hover:text-nx-text"
          >
            <Download size={13} /> {t("snippets.import")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
              e.target.value = "";
            }}
          />
          <button
            onClick={exportFile}
            disabled={list.length === 0}
            className="inline-flex items-center gap-1.5 text-meta text-nx-muted hover:text-nx-text disabled:opacity-40"
          >
            <Upload size={13} /> {t("snippets.export")}
          </button>
          <label className="ml-2 inline-flex items-center gap-2 cursor-pointer">
            <Toggle
              checked={syncOn}
              onChange={(v) => {
                setSyncOn(v);
                setSnippetsSyncEnabled(v);
              }}
            />
            <span className="text-meta text-nx-dim inline-flex items-center gap-1.5">
              <Cloud size={13} /> {t("snippets.sync")}
            </span>
          </label>
          <div className="ml-auto flex gap-3.5 max-md:hidden">
            <span className="text-micro uppercase tracking-[0.1em] text-nx-muted">
              <kbd className="text-nx-accent">1–9</kbd> {t("snippets.run")}
            </span>
            <span className="text-micro uppercase tracking-[0.1em] text-nx-muted">
              <kbd className="text-nx-accent">esc</kbd> {t("snippets.close")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function CatChip({
  active,
  count,
  prefix,
  children,
  onClick,
  onDelete,
}: {
  active: boolean;
  count: number;
  prefix?: boolean;
  children: React.ReactNode;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <span
      onClick={onClick}
      className={[
        "group inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-full border text-meta transition-colors duration-[80ms] cursor-pointer",
        active
          ? "border-nx-accent text-nx-accent bg-nx-elevated shadow-[0_0_12px_var(--nx-accent-glow)]"
          : "border-nx-border text-nx-muted bg-nx-bg hover:text-nx-text hover:border-nx-dim",
      ].join(" ")}
    >
      {prefix && <span className="opacity-60">//</span>}
      {children}
      <span
        className={
          "text-[9px] px-[5px] min-w-4 text-center rounded-full " +
          (active ? "bg-[rgba(0,255,149,0.15)] text-nx-accent" : "bg-nx-bg-2 text-nx-muted")
        }
      >
        {count}
      </span>
      {onDelete && (
        <span
          role="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="opacity-0 group-hover:opacity-100 -mr-0.5 ml-0.5 inline-flex text-nx-muted hover:text-nx-error transition-opacity"
        >
          <X size={11} />
        </span>
      )}
    </span>
  );
}

function SnippetTile({
  s,
  selected,
  dragging,
  over,
  onRun,
  onEdit,
  onDelete,
  onDragStart,
}: {
  s: Snippet;
  selected: boolean;
  dragging: boolean;
  over: boolean;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDragStart: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-snippet-id={s.id}
      onClick={onRun}
      className={[
        "group relative border rounded-[7px] bg-nx-bg p-[13px_14px] min-h-[104px] flex flex-col gap-2 cursor-pointer",
        "transition-[border-color,box-shadow,background,transform] duration-90",
        dragging ? "opacity-40" : "",
        over
          ? "border-dashed border-nx-accent bg-[rgba(0,255,149,0.04)]"
          : selected
            ? "border-nx-accent bg-[linear-gradient(180deg,rgba(0,255,149,0.06),transparent)] shadow-[0_0_0_1px_var(--nx-accent),0_0_24px_var(--nx-accent-glow)]"
            : "border-nx-border hover:border-nx-accent hover:shadow-[0_0_0_1px_var(--nx-accent-glow)]",
      ].join(" ")}
    >
      {/* hotkey chip */}
      <span
        className={[
          "absolute top-[11px] right-3 w-6 h-6 rounded-[5px] border flex items-center justify-center text-[13px] font-semibold",
          s.hotkey
            ? "border-nx-border bg-nx-bg-2 text-nx-soft group-hover:border-nx-accent group-hover:text-nx-accent group-hover:shadow-[0_0_10px_var(--nx-accent-glow)]"
            : "border-dashed border-nx-border text-nx-muted opacity-35",
        ].join(" ")}
      >
        {s.hotkey ?? "·"}
      </span>

      {/* hover actions */}
      <div className="absolute top-2.5 right-11 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="p-1 bg-nx-elevated rounded text-nx-muted hover:text-nx-accent"
        >
          <SquarePen size={13} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="p-1 bg-nx-elevated rounded text-nx-muted hover:text-nx-error"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="text-lead text-nx-accent font-medium flex items-center gap-1.5 pr-16">
        <GripVertical
          size={13}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            e.stopPropagation(); // don't trigger run; start a mouse-drag
            e.preventDefault();
            onDragStart();
          }}
          className="text-nx-muted opacity-40 group-hover:opacity-70 cursor-grab shrink-0 hover:text-nx-accent"
        />
        <span className="truncate">{s.name}</span>
      </div>

      <div className="text-[11.5px] text-nx-dim leading-snug line-clamp-2 bg-nx-bg-2 border border-nx-divider rounded px-2 py-1.5 font-mono">
        <span className="text-nx-muted">$ </span>
        {s.command}
      </div>

      <div className="mt-auto flex items-center gap-2">
        {s.category && (
          <span className="text-[9px] uppercase tracking-[0.06em] text-nx-soft/80">// {s.category}</span>
        )}
        {s.autoRun && (
          <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.06em] px-1.5 py-0.5 rounded-sm border text-nx-accent border-[rgba(0,255,149,0.35)]">
            ↵ {t("snippets.autorun")}
          </span>
        )}
        {s.confirm && (
          <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.06em] px-1.5 py-0.5 rounded-sm border text-nx-warning border-[rgba(245,215,110,0.35)]">
            ⚠ {t("snippets.confirm")}
          </span>
        )}
      </div>
    </div>
  );
}

function SnippetEmpty({ onCreate, hasAny }: { onCreate: () => void; hasAny: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 gap-3">
      <span className="inline-flex items-center justify-center w-[54px] h-[54px] rounded-nx border border-nx-accent text-nx-accent shadow-[0_0_24px_var(--nx-accent-glow)]">
        <Zap size={28} />
      </span>
      <div className="text-lead text-nx-text">{t("snippets.empty_title")}</div>
      <div className="text-meta text-nx-muted max-w-[340px]">{t("snippets.empty_body")}</div>
      {!hasAny && (
        <Button variant="primary" size="sm" leadingIcon={<Plus size={13} />} onClick={onCreate} className="mt-1">
          {t("snippets.empty_cta")}
        </Button>
      )}
    </div>
  );
}

function SnippetEditor({
  initial,
  categories,
  onCancel,
  onSaved,
}: {
  initial: Snippet | null;
  categories: string[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { backdropProps, contentProps } = useBackdropClose(onCancel);
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [autoRun, setAutoRun] = useState(initial?.autoRun ?? false);
  const [confirm, setConfirm] = useState(initial?.confirm ?? false);
  const [category, setCategory] = useState<string | undefined>(initial?.category);
  const [hotkey, setHotkey] = useState<number | undefined>(initial?.hotkey);
  const [cats, setCats] = useState(categories);

  function save() {
    if (!name.trim() || !command.trim()) return;
    const data = { name: name.trim(), command, autoRun, confirm, category, hotkey };
    if (initial) updateSnippet({ ...initial, ...data });
    else addSnippet(data);
    onSaved();
  }

  return (
    <div className="nx-scrim grid place-items-center" {...backdropProps}>
      <div
        {...contentProps}
        className="nx-modal-enter relative w-[640px] max-w-[94vw] bg-nx-panel rounded-nx-lg shadow-elev-modal overflow-hidden max-md:w-full max-md:max-w-none max-md:h-full max-md:rounded-none"
      >
        <span className="nx-brackets">
          <i />
        </span>
        <div className="flex items-baseline gap-3 px-[22px] pt-5 pb-4 border-b border-nx-divider">
          <span className="text-micro uppercase tracking-[0.22em] text-nx-accent">
            // {t("snippets.kicker")}
          </span>
          <div className="text-h2 text-nx-text font-mono">
            <span className="text-nx-accent mr-2">&gt;</span>
            {initial ? "edit_snippet" : "new_snippet"}
          </div>
          <button onClick={onCancel} className="ml-auto p-1.5 text-nx-muted hover:text-nx-text">
            <X size={14} />
          </button>
        </div>

        <div className="px-[22px] py-[18px] flex flex-col gap-4">
          <div>
            <RowLabel>{t("snippets.name")}</RowLabel>
            <Input value={name} onChange={setName} autoFocus />
          </div>
          <div>
            <RowLabel>{t("snippets.command")}</RowLabel>
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="nx-focus w-full mt-1.5 h-[84px] bg-nx-bg border border-nx-border rounded-nx font-mono text-body text-nx-text px-2.5 py-2 resize-none leading-relaxed outline-none focus:border-nx-accent"
              placeholder="{{user}}@{{host}}…"
            />
          </div>
          <div className="flex gap-6">
            <Checkbox
              checked={autoRun}
              onChange={setAutoRun}
              label={
                <>
                  {t("snippets.autorun_label")} <span className="text-nx-accent">(↵)</span>
                </>
              }
            />
            <Checkbox
              checked={confirm}
              onChange={setConfirm}
              label={
                <>
                  {t("snippets.confirm_label")} <span className="text-nx-warning">⚠</span>
                </>
              }
            />
          </div>
          <div>
            <RowLabel>{t("snippets.category")}</RowLabel>
            <div className="flex gap-1.5 flex-wrap mt-1.5">
              {cats.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(category === c ? undefined : c)}
                  className={[
                    "px-3 h-[30px] rounded-[5px] border text-[11px]",
                    category === c
                      ? "border-nx-accent text-nx-accent bg-nx-elevated shadow-[inset_0_0_10px_var(--nx-accent-glow)]"
                      : "border-nx-border text-nx-muted bg-nx-bg hover:text-nx-text",
                  ].join(" ")}
                >
                  {c}
                </button>
              ))}
              <button
                onClick={async () => {
                  const n = await askPrompt(t("snippets.new_category"));
                  const nn = n?.trim();
                  if (nn) {
                    addCategory(nn);
                    setCats((p) => (p.includes(nn) ? p : [...p, nn]));
                    setCategory(nn);
                  }
                }}
                className="px-3 h-[30px] rounded-[5px] border border-dashed border-nx-border text-nx-soft text-[11px] hover:border-nx-accent"
              >
                + {t("snippets.new_category")}
              </button>
            </div>
          </div>
          <div>
            <RowLabel>{t("snippets.hotkey")}</RowLabel>
            <div className="flex gap-1.5 flex-wrap mt-1.5">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <button
                  key={n}
                  onClick={() => setHotkey(hotkey === n ? undefined : n)}
                  className={[
                    "w-[30px] h-[30px] rounded-[5px] border font-mono text-[13px]",
                    hotkey === n
                      ? "border-nx-accent text-nx-accent bg-nx-elevated shadow-[inset_0_0_10px_var(--nx-accent-glow)]"
                      : "border-nx-border text-nx-muted bg-nx-bg hover:text-nx-text",
                  ].join(" ")}
                >
                  {n}
                </button>
              ))}
              <button
                onClick={() => setHotkey(undefined)}
                className={
                  "px-3 h-[30px] rounded-[5px] border text-[11px] uppercase tracking-[0.08em] " +
                  (hotkey == null
                    ? "border-nx-accent text-nx-accent bg-nx-elevated"
                    : "border-nx-border text-nx-muted")
                }
              >
                {t("snippets.no_hotkey")}
              </button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-[22px] py-3.5 border-t border-nx-divider bg-nx-bg-2">
          <Button variant="secondary" onClick={onCancel}>
            {t("snippets.cancel")}
          </Button>
          <Button variant="primary" onClick={save} disabled={!name.trim() || !command.trim()}>
            {t("snippets.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
