// Лёгкий fuzzy-матчер для Command palette. Подпоследовательность с бонусами за
// последовательные совпадения и начала слов. Без внешних либ.

export interface FuzzyResult {
  score: number;
  /** Индексы совпавших символов в target (для подсветки). */
  positions: number[];
}

/** Возвращает результат или null, если не все символы запроса нашлись по порядку. */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const positions: number[] = [];
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      positions.push(i);
      score += prev === i - 1 ? 6 : 1; // последовательные — дороже
      const before = i === 0 ? " " : t[i - 1];
      if (/[\s\-_@./:]/.test(before)) score += 4; // начало слова
      if (i === 0) score += 3;
      prev = i;
      qi++;
    }
  }
  if (qi < q.length) return null; // не всё совпало
  score -= t.length * 0.05; // короткие цели чуть выше
  score -= positions[0] * 0.15; // раннее первое совпадение выше
  return { score, positions };
}
