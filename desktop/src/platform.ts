/**
 * Какая это система — по строке браузера вебвью.
 *
 * ⛔ Рамку окна на macOS рисует система, и отнимать её нельзя: вместе с
 * ней пропадают и кнопки управления — закрыть окно станет нечем. На
 * остальных системах рамка своя, чтобы titlebar был частью интерфейса.
 */
export const isWindows = /Windows/i.test(navigator.userAgent);
export const isMac = /Mac OS X|Macintosh/i.test(navigator.userAgent);

/** Рисует ли рамку система, а не мы. На macOS — всегда. */
export function nativeFrame(настройка: boolean | undefined): boolean {
  return isMac || !!настройка;
}
