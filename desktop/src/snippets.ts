// Snippets — saved commands the user can fire into the terminal with one tap
// (from the SmartKeyBar ⚡ panel on mobile). Stored locally; not secrets, so
// plain localStorage. (Cloud-sync of snippets is a possible follow-up.)

export interface Snippet {
  id: string;
  name: string;
  command: string;
  /** Append a newline (run immediately) vs. just type the command. */
  enter: boolean;
}

const LS = "nexussh.snippets.v1";
const EVT = "nx:snippets-changed";

export function listSnippets(): Snippet[] {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Snippet[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function persist(all: Snippet[]) {
  localStorage.setItem(LS, JSON.stringify(all));
  window.dispatchEvent(new Event(EVT));
}

export function addSnippet(s: Omit<Snippet, "id">): Snippet {
  const ns: Snippet = { ...s, id: crypto.randomUUID() };
  persist([...listSnippets(), ns]);
  return ns;
}

export function updateSnippet(s: Snippet) {
  persist(listSnippets().map((x) => (x.id === s.id ? s : x)));
}

export function deleteSnippet(id: string) {
  persist(listSnippets().filter((x) => x.id !== id));
}

/** Subscribe to snippet-list changes (add/edit/delete). Returns an unsubscribe. */
export function onSnippetsChanged(cb: () => void): () => void {
  window.addEventListener(EVT, cb);
  return () => window.removeEventListener(EVT, cb);
}
