import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "./fuzzy";

export interface PaletteItem {
  id: string;
  /** Заголовок секции: "Хосты" | "Сниппеты" | "Вкладки" | "Действия" | "Настройки". */
  section: string;
  icon: string; // эмодзи/короткий значок
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

// Порядок секций в выдаче.
const SECTION_ORDER = ["Хосты", "Сниппеты", "Вкладки", "Действия", "Настройки"];
// Префиксы-фильтры (как VS Code): ограничить одной секцией.
const PREFIX: Record<string, string> = {
  "@": "Хосты",
  "#": "Сниппеты",
  ">": "Действия",
  "/": "Настройки",
};
const EMPTY_SECTION_CAP = 6; // при пустом запросе — не вываливать всё

type Row =
  | { kind: "header"; section: string }
  | { kind: "item"; item: PaletteItem; positions: number[] };

export default function CommandPalette({ open, onClose, items, onAskAi }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [open]);

  // Разбор префикса-фильтра.
  const { sectionFilter, needle } = useMemo(() => {
    const first = query[0];
    if (first && PREFIX[first]) {
      return { sectionFilter: PREFIX[first], needle: query.slice(1).trim() };
    }
    return { sectionFilter: null as string | null, needle: query.trim() };
  }, [query]);

  // Отфильтрованные + отсортированные записи по секциям.
  const grouped = useMemo(() => {
    const bySection = new Map<string, { item: PaletteItem; positions: number[]; score: number }[]>();
    for (const it of items) {
      if (sectionFilter && it.section !== sectionFilter) continue;
      let positions: number[] = [];
      let score = 0;
      if (needle) {
        const hay = it.label + " " + (it.keywords ?? "");
        const m = fuzzyMatch(needle, hay);
        if (!m) continue;
        score = m.score;
        // подсветка только по label
        positions = m.positions.filter((p) => p < it.label.length);
      }
      const arr = bySection.get(it.section) ?? [];
      arr.push({ item: it, positions, score });
      bySection.set(it.section, arr);
    }
    // сортировка внутри секции + кап при пустом запросе
    for (const [sec, arr] of bySection) {
      arr.sort((a, b) => b.score - a.score);
      if (!needle && arr.length > EMPTY_SECTION_CAP)
        bySection.set(sec, arr.slice(0, EMPTY_SECTION_CAP));
    }
    return bySection;
  }, [items, sectionFilter, needle]);

  // Плоский список строк (заголовки + записи) в порядке секций.
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

  // Индексы выбираемых строк (пропускаем заголовки).
  const itemIdx = useMemo(() => rows.map((r, i) => (r.kind === "item" ? i : -1)).filter((i) => i >= 0), [rows]);
  // Показывать «Спросить AI», когда есть текст.
  const showAskAi = !!onAskAi && needle.length > 0;
  const totalSelectable = itemIdx.length + (showAskAi ? 1 : 0);

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, totalSelectable - 1)));
  }, [totalSelectable]);

  // Автоскролл к выбранному.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-sel="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  function runSel() {
    if (showAskAi && sel === totalSelectable - 1) {
      onAskAi?.(needle);
      onClose();
      return;
    }
    const rowI = itemIdx[sel];
    const row = rows[rowI];
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
      // Прыжок к первой записи следующей секции.
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      const curRow = itemIdx[sel];
      const curSec = curRow != null && rows[curRow]?.kind === "item" ? (rows[curRow] as { item: PaletteItem }).item.section : null;
      // найти следующий item другой секции
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
    return (
      <>
        {label.split("").map((ch, i) =>
          set.has(i) ? (
            <span key={i} className="text-nx-accent font-semibold">
              {ch}
            </span>
          ) : (
            <span key={i}>{ch}</span>
          ),
        )}
      </>
    );
  }

  // Плоский счётчик выбираемых для data-sel.
  let selCounter = -1;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center pt-24 transition-opacity duration-150 ${
        open ? "bg-black/50 opacity-100" : "bg-transparent opacity-0 pointer-events-none"
      }`}
      onClick={onClose}
      aria-hidden={!open}
    >
      <div
        className={`w-[min(640px,94vw)] max-h-[70vh] flex flex-col rounded-xl bg-nx-elevated shadow-2xl border border-nx-border overflow-hidden transition-all duration-150 ${
          open ? "scale-100 opacity-100 translate-y-0" : "scale-95 opacity-0 -translate-y-4"
        }`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-nx-border shrink-0">
          <span className="text-nx-muted">🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            placeholder="Поиск: хосты, сниппеты, вкладки, действия…  (@ # > /)"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-nx-muted"
          />
          <kbd className="text-[10px] text-nx-muted border border-nx-border rounded px-1">Esc</kbd>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {rows.length === 0 && !showAskAi && (
            <div className="px-4 py-6 text-center text-sm text-nx-muted">Ничего не найдено</div>
          )}
          {rows.map((row) => {
            if (row.kind === "header") {
              return (
                <div
                  key={`h-${row.section}`}
                  className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-nx-muted"
                >
                  {row.section}
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
                data-sel={active ? sel : undefined}
                onMouseEnter={() => setSel(mySel)}
                onClick={runSel}
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left ${
                  active ? "bg-nx-accent/15" : "hover:bg-nx-bg"
                }`}
              >
                <span className="w-5 text-center shrink-0">{row.item.icon}</span>
                <span className="flex-1 text-sm truncate">
                  {highlight(row.item.label, row.positions)}
                </span>
                {row.item.hint && (
                  <span className="text-xs text-nx-muted shrink-0 truncate max-w-[45%]">
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
                  <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-nx-muted">
                    AI
                  </div>
                  <button
                    type="button"
                    data-sel={active ? sel : undefined}
                    onMouseEnter={() => setSel(mySel)}
                    onClick={runSel}
                    className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left ${
                      active ? "bg-nx-accent/15" : "hover:bg-nx-bg"
                    }`}
                  >
                    <span className="w-5 text-center shrink-0">🤖</span>
                    <span className="flex-1 text-sm truncate">
                      Спросить AI про «{needle}»
                    </span>
                  </button>
                </>
              );
            })()}
        </div>

        <div className="px-3 py-1.5 border-t border-nx-border text-[10px] text-nx-muted shrink-0 flex gap-3">
          <span>↑↓ выбор</span>
          <span>↵ выполнить</span>
          <span>Tab — секция</span>
          <span>@ # &gt; / — фильтр</span>
        </div>
      </div>
    </div>
  );
}
