// Инлайн-агент: перехват "/agent " в начале строки терминала и захват запроса
// ИНЛАЙН (символы не уходят в PTY), с зеркалированием в AI-панель. Чистая
// стейт-машина — без xterm/DOM, поэтому юнит-проверяется в node (15 кейсов,
// вкл. DA-reply-перед-вводом, /etc/hosts, cd /var, Esc, backspace, alt-screen).
//
// Ключевой урок: на десктопе ввод идёт через term.onData, но ТУДА ЖЕ приходят
// авто-ответы терминала (DA/DSR-реплаи `\x1b[...`, всегда мульти-символьные).
// Их нельзя учитывать в гейте «начало строки» — иначе перехват «разоружается»
// до ввода пользователя. Поэтому atLineStart меняют ТОЛЬКО одиночные символы.

const TRIG = "/agent ";

export type AgentPhase = "update" | "submit" | "cancel";

export interface AgentDeps {
  /** Отправить байты в PTY (то, что не перехвачено). */
  send: (data: string) => void;
  /** В alt-screen (vim/htop) не вмешиваемся. */
  isAltScreen: () => boolean;
  /** Сообщить UI: открыть/обновить (update), спросить (submit), отменить (cancel). */
  emit: (phase: AgentPhase, query: string) => void;
}

/** Возвращает feed(data): прогоняет каждый чанк из term.onData. */
export function makeAgentInterceptor(deps: AgentDeps): (data: string) => void {
  const { send, isAltScreen, emit } = deps;
  let hold = ""; // держим префикс "/agent " по мере набора
  let capturing = false; // после "/agent " — копим запрос
  let query = "";
  let atLineStart = true; // старт — у свежего промпта

  function reset() {
    hold = "";
    capturing = false;
    query = "";
  }

  return function feed(data: string) {
    if (isAltScreen()) {
      send(data);
      return;
    }

    // ── Режим захвата запроса ────────────────────────────────────────────
    if (capturing) {
      if (data === "\r" || data === "\n") {
        emit("submit", query);
        reset();
        atLineStart = true;
        return;
      }
      if (data === "\x03" || data === "\x1b") {
        // Ctrl-C или Esc — отмена.
        emit("cancel", "");
        reset();
        atLineStart = true;
        return;
      }
      if (data === "\x7f" || data === "\b") {
        query = query.slice(0, -1);
        emit("update", query);
        return;
      }
      // ESC-последовательности (стрелки, авто-ответы) — глотаем, но не в запрос.
      if (data.charCodeAt(0) === 0x1b) return;
      // Управляющие одиночные — игнор.
      if (data.length === 1 && data.charCodeAt(0) < 0x20) return;
      query += data;
      emit("update", query);
      return;
    }

    // ── Мульти-символьные данные (авто-ответы терминала, вставка) ─────────
    // НЕ трогают atLineStart. Если что-то держали — отдаём в шелл.
    if (data.length !== 1) {
      if (hold) {
        send(hold);
        hold = "";
      }
      send(data);
      return;
    }

    const ch = data;

    // ── Держим префикс "/agent " ─────────────────────────────────────────
    if (hold) {
      if (ch === "\x7f" || ch === "\b") {
        hold = hold.slice(0, -1);
        return; // редактируем удержанное
      }
      const next = hold + ch;
      if (TRIG.startsWith(next)) {
        hold = next;
        if (next === TRIG) {
          // Полный триггер → входим в захват, открываем панель (пустой запрос).
          hold = "";
          capturing = true;
          query = "";
          emit("update", "");
        }
        return; // глотаем
      }
      // Расхождение — отдаём удержанное + текущий символ шеллу.
      send(hold + ch);
      hold = "";
      atLineStart = ch === "\r";
      return;
    }

    // ── Обычный режим ────────────────────────────────────────────────────
    if (atLineStart && ch === "/") {
      hold = "/";
      return; // начинаем держать
    }
    send(ch);
    if (ch === "\r" || ch === "\x03" || ch === "\x15") atLineStart = true;
    else if (ch.charCodeAt(0) >= 0x20) atLineStart = false;
    // прочие control (напр. \x7f) — atLineStart не трогаем
  };
}
