import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fuzzyMatch } from "./fuzzy";

export interface PaletteItem {
  id: string;
  /** Заголовок секции: "Хосты" | "Сниппеты" | "Вкладки" | "Действия" | "Настройки". */
  section: string;
  icon: ReactNode; // lucide-иконка 14px
  label: string;
  /** Приглушённо справа — что произойдёт. */
  hint?: string;
  /** Доп. текст для поиска (не показывается), напр. user@host. */
  keywords?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  items: PaletteItem[];
  /** Вызов «Спросить AI про <query>» — показывается когда есть текст. */
  onAskAi?: (query: string) => void;
}

const SECTION_ORDER = ["Хосты", "Сниппеты", "Вкладки", "Действия", "Настройки"];
// Префиксы-фильтры (как VS Code): ограничить одной секцией.
const PREFIX: Record<string, string> = {
  "@": "Хосты",
  "#": "Сниппеты",
  ">": "Действия",
  "/": "Настройки",
};
// Скоуп-чипы: подпись + префикс (для @#>/) либо прямой section (вкладки).
const CHIPS: { label: string; scope: string | null; prefix?: string }[] = [
  { label: "все", scope: null },
  { label: "хосты @", scope: "Хосты", prefix: "@" },
  { label: "сниппеты #", scope: "Сниппеты", prefix: "#" },
  { label: "вкладки", scope: "Вкладки" },
  { label: "действия >", scope: "Действия", prefix: ">" },
];
const EMPTY_SECTION_CAP = 6;

type Row =
  | { kind: "header"; section: string }
  | { kind: "item"; item: PaletteItem; positions: number[] };

export default function CommandPalette({ open, onClose, items, onAskAi }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string | null>(null); // от чипа «вкладки» и т.п.
  const [sel, setSel] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setScope(null);
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [open]);

  // Разбор префикса-фильтра из строки.
  const { prefixScope, needle } = useMemo(() => {
    const first = query[0];
    if (first && PREFIX[first]) return { prefixScope: PREFIX[first], needle: query.slice(1).trim() };
    return { prefixScope: null as string | null, needle: query.trim() };
  }, [query]);
  const sectionFilter = prefixScope ?? scope;

  const grouped = useMemo(() => {
    const bySection = new Map<string, { item: PaletteItem; positions: number[]; score: number }[]>();
    for (const it of items) {
      if (sectionFilter && it.section !== sectionFilter) continue;
      let positions: number[] = [];
      let score = 0;
      if (needle) {
        const m = fuzzyMatch(needle, it.label + " " + (it.keywords ?? ""));
        if (!m) continue;
        score = m.score;
        positions = m.positions.filter((p) => p < it.label.length);
      }
      const arr = bySection.get(it.section) ?? [];
      arr.push({ item: it, positions, score });
      bySection.set(it.section, arr);
    }
    for (const [sec, arr] of bySection) {
      arr.sort((a, b) => b.score - a.score);
      if (!needle && arr.length > EMPTY_SECTION_CAP) bySection.set(sec, arr.slice(0, EMPTY_SECTION_CAP));
    }
    return bySection;
  }, [items, sectionFilter, needle]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const sec of SECTION_ORDER) {
      const arr = grouped.get(sec);
      if (!arr || !arr.length) continue;
      out.push({ kind: "header", section: sec });
      for (const e of arr) out.push({ kind: "item", item: e.item, positions: e.positions });
    }
    return out;
  }, [grouped]);

  const itemIdx = useMemo(() => rows.map((r, i) => (r.kind === "item" ? i : -1)).filter((i) => i >= 0), [rows]);
  const showAskAi = !!onAskAi && needle.length > 0;
  const totalSelectable = itemIdx.length + (showAskAi ? 1 : 0);

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, totalSelectable - 1)));
  }, [totalSelectable]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-sel="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  function runSel() {
    if (showAskAi && sel === totalSelectable - 1) {
      onAskAi?.(needle);
      onClose();
      return;
    }
    const row = rows[itemIdx[sel]];
    if (row && row.kind === "item") {
      row.item.run();
      onClose();
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, totalSelectable - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Tab") {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      const curRow = itemIdx[sel];
      const curSec = curRow != null && rows[curRow]?.kind === "item" ? (rows[curRow] as { item: PaletteItem }).item.section : null;
      let target = sel;
      for (let step = 1; step <= itemIdx.length; step++) {
        const cand = (sel + dir * step + totalSelectable) % Math.max(1, itemIdx.length);
        const r = rows[itemIdx[cand]];
        if (r && r.kind === "item" && r.item.section !== curSec) {
          target = cand;
          break;
        }
      }
      setSel(target);
    } else if (e.key === "Enter") {
      e.preventDefault();
      runSel();
    }
  }

  function highlight(label: string, positions: number[]) {
    if (!positions.length) return label;
    const set = new Set(positions);
    return label.split("").map((ch, i) =>
      set.has(i) ? (
        <span key={i} className="text-nx-accent font-semibold">
          {ch}
        </span>
      ) : (
        <span key={i}>{ch}</span>
      ),
    );
  }

  function pickChip(c: (typeof CHIPS)[number]) {
    if (c.prefix) {
      setQuery(c.prefix);
      setScope(null);
    } else {
      setQuery("");
      setScope(c.scope);
    }
    setSel(0);
    inputRef.current?.focus();
  }

  const activeScope = sectionFilter;
  let selCounter = -1;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center pt-24 transition-opacity duration-150 ${
        open ? "bg-black/60 backdrop-blur-sm opacity-100" : "bg-transparent opacity-0 pointer-events-none"
      }`}
      onClick={onClose}
      aria-hidden={!open}
    >
      <div
        className={`nx-modal-enter relative w-[640px] max-w-[94vw] max-h-[70vh] flex flex-col bg-nx-panel rounded-nx-lg border border-nx-border shadow-glow-lg overflow-hidden transition-all duration-150 ${
          open ? "scale-100 opacity-100 translate-y-0" : "scale-95 opacity-0 -translate-y-4"
        }`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <span className="nx-brackets">
          <i />
        </span>

        {/* Строка ввода */}
        <div className="flex items-center gap-2.5 px-[18px] py-3 border-b border-nx-divider shrink-0">
          <span className="nx-orb" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            placeholder="Поиск: хосты, сниппеты, вкладки, действия…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-nx-muted font-mono"
          />
          <span className="text-micro text-nx-muted tracking-widest select-none max-md:hidden">@ # &gt; /</span>
          <kbd className="text-[10px] text-nx-muted border border-nx-border rounded px-1 py-0.5">Esc</kbd>
        </div>

        {/* Скоуп-чипы */}
        <div className="flex items-center gap-1.5 px-[18px] py-2 border-b border-nx-divider shrink-0 overflow-x-auto">
          {CHIPS.map((c) => {
            const on = c.scope === activeScope || (c.scope === null && activeScope === null);
            return (
              <button
                key={c.label}
                type="button"
                onClick={() => pickChip(c)}
                className={`text-micro px-2 py-0.5 rounded-full border whitespace-nowrap transition ${
                  on
                    ? "border-nx-accent text-nx-accent shadow-glow-sm"
                    : "border-nx-border text-nx-muted hover:text-nx-text"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        {/* Результаты */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {rows.length === 0 && !showAskAi && (
            <div className="px-4 py-6 text-center text-sm text-nx-muted">Ничего не найдено</div>
          )}
          {rows.map((row) => {
            if (row.kind === "header") {
              return (
                <div
                  key={`h-${row.section}`}
                  className="px-[18px] pt-2.5 pb-1 text-micro uppercase tracking-[0.22em] text-nx-soft"
                >
                  // {row.section}
                </div>
              );
            }
            selCounter++;
            const mySel = selCounter;
            const active = mySel === sel;
            return (
              <button
                key={row.item.id}
                type="button"
                data-active={active}
                data-sel={active ? sel : undefined}
                onMouseEnter={() => setSel(mySel)}
                onClick={runSel}
                className="nx-row w-full flex items-center gap-2.5 pl-[18px] pr-3 py-1.5 text-left"
              >
                <span className={`w-[22px] flex justify-center shrink-0 ${active ? "text-nx-accent" : "text-nx-soft"}`}>
                  {row.item.icon}
                </span>
                <span className={`flex-1 text-sm truncate font-mono ${active ? "text-nx-accent" : "text-nx-text"}`}>
                  {highlight(row.item.label, row.positions)}
                </span>
                {row.item.hint && (
                  <span className={`text-xs shrink-0 truncate max-w-[45%] ${active ? "text-nx-accent" : "text-nx-muted"}`}>
                    {row.item.hint}
                  </span>
                )}
              </button>
            );
          })}

          {showAskAi &&
            (() => {
              selCounter++;
              const mySel = selCounter;
              const active = mySel === sel;
              return (
                <>
                  <div className="px-[18px] pt-2.5 pb-1 text-micro uppercase tracking-[0.22em] text-nx-soft">
                    // AI
                  </div>
                  <button
                    type="button"
                    data-active={active}
                    data-sel={active ? sel : undefined}
                    onMouseEnter={() => setSel(mySel)}
                    onClick={runSel}
                    className="nx-row w-full flex items-center gap-2.5 pl-[18px] pr-3 py-1.5 text-left"
                  >
                    <span className={`w-[22px] flex justify-center shrink-0 ${active ? "text-nx-accent2" : "text-nx-accent2/70"}`}>
                      ✦
                    </span>
                    <span className="flex-1 text-sm truncate font-mono text-nx-text">
                      Спросить AI про «{needle}»
                    </span>
                  </button>
                </>
              );
            })()}
        </div>

        {/* Футер */}
        <div className="px-[18px] py-1.5 border-t border-nx-divider text-micro text-nx-muted shrink-0 flex gap-3 flex-wrap">
          <span>↑↓ выбор</span>
          <span>↵ выполнить</span>
          <span>Tab секция</span>
          <span>@ # &gt; / фильтр</span>
        </div>
      </div>
    </div>
  );
}
