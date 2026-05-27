# NexuSSH — Design System

> Этот документ описывает текущую визуальную систему NexuSSH для интеграции с **Claude Design**.
> При генерации новых экранов Claude Design **должен опираться на эти токены и существующие компоненты**.

## Brand

- **Name**: NexuSSH
- **Identity**: матричный терминал нового поколения. Cross-platform SSH client с акцентом на мощный history + self-hosted sync + clean keyboard-driven UX.
- **Vibe**: тёмный, монохромный фундамент + ярко-зелёные / cyan акценты. Минимализм + technical confidence. Подмигивает фильму Matrix без перебора.
- **Не-цели**: skeuomorphism, излишний шум, glassmorphism, ярко-цветной gradients. Не "Termius с матричным скином" — а собственная identity.

## Color tokens

```
--bg-base       #0a0e0e   тёмный фундамент окна
--bg-secondary  #080b0b   sidebar/tab-bar/header strip
--bg-panel      #0e1414   модальные панели, inputs, hover
--bg-elevated   #1f3a3a   active row, button hover, selection

--border-base   #1f3a3a   стандартные границы
--border-soft   #1f3a3a/0.6   тонкие разделители между rows

--text-primary  #c9d1d9   основной текст
--text-muted    #4a5560   subtitle, hints, secondary
--text-soft     #7fd7ff   подписи и accent-text (cyan-tinted)

--accent-green  #00ff95   primary action, success, "connected"
--accent-cyan   #00d4ff   secondary accent, "NexuSSH" wordmark
--accent-yellow #f5d76e   warning, "locked"
--accent-red    #ff6b6b   error, destructive

--terminal-* (xterm theme)  см. Terminal.tsx::MATRIX_THEME
```

## Typography

- **Mono**: `"JetBrains Mono", "Fira Code", monospace` — для **всего UI** включая labels, кнопки, content
- **Размеры**:
  - `xs` 10-11px — uppercase labels, hints
  - `sm` 12-13px — список хостов, inputs
  - `base` 14px — terminal body
  - `lg` 16-18px — modal titles
- **Letter-spacing**: `tracking-wider` (0.05em) для uppercase labels
- Заголовки секций — uppercase + cyan-tinted color `#7fd7ff`
- Названия в шапке (`NexuSSH`) — bold + bright green

## Component patterns

### Buttons
- **Primary action**: `bg-[#00ff95] text-[#0a0e0e]` font-bold, hover lighter
- **Secondary action**: `bg-[#0e1414] border border-[#1f3a3a] text-[#7fd7ff]`
- **Destructive**: `text-[#ff8e8e]` hover bright red
- **Icon-only**: `text-[#7fd7ff]` hover green, transparent bg

### Inputs
```jsx
className="bg-[#0e1414] border border-[#1f3a3a] rounded px-3 py-2
           text-[#c9d1d9] placeholder-[#4a5560]
           focus:outline-none focus:border-[#00ff95]
           font-mono text-sm"
```
- Labels above inputs in uppercase cyan: `text-[#7fd7ff] text-xs uppercase tracking-wider`
- Hints below in muted small: `text-[#4a5560] text-xs`

### Modals
- Black/60 backdrop with blur-sm
- Panel: `bg-[#0a0e0e] border border-[#1f3a3a] rounded-lg shadow-2xl`
- Header strip with title `> name` prefix in green
- Close X button top-right

### Sidebar
- Width: `w-64` expanded, `w-10` collapsed (rail)
- Hover row: `hover:bg-[#0e1414]`
- Active/selected: `bg-[#0e1414]`
- Group headers: 10px uppercase muted with chevron + count chip
- Action buttons hidden until hover: `opacity-0 group-hover:opacity-100`

### Tabs
- Status icons left: Loader2 (connecting), Wifi (connected), WifiOff (closed)
- Active tab: matrix-green text + base bg
- Inactive: muted text + secondary bg

### Cards / panels in sidebar
- 3-pane modal layout (header + cross-search + 2-pane: list / viewer)

### Animation / motion
- Минимально: только spinners на async, fade-in для new content
- Без bounce/elastic/glass

## Layout primitives

- Container: `flex flex-col h-full`
- Header bar: `h-9` fixed
- Sidebar: `w-64` (or rail `w-10`)
- Tab bar: `h-9`
- Terminal: fills remaining space, `flex-1 min-h-0`
- Modals: `max-w-md` / `max-w-lg` / `max-w-6xl` (history) / `max-w-7xl` (extended history)

## i18n

- Все strings через `t("key.path")` из `react-i18next`
- Inline RU + EN в `src/i18n.ts`
- Новые экраны = добавлять оба языка

## Tech stack to design FOR

- React 19 + Vite 7
- Tailwind CSS 4 (CSS-first config, no `tailwind.config.js`)
- xterm.js 5.5 for terminal
- Lucide-react icons (preferred over font-icon libraries)
- Tauri 2 backend (Rust commands via `invoke()`)

## Existing screens / components

Если Claude Design проектирует новый экран — он должен **сосуществовать** с этими:

- `App.tsx` — main shell (header + sidebar + tab area + modals)
- `Sidebar.tsx` — host list with groups
- `TabBar.tsx` + `TabPicker.tsx` — tabs + Ctrl+T quick picker
- `Terminal.tsx` — xterm wrapper
- `HostDialog.tsx` — add/edit host modal (3 auth tabs: password/key/vault)
- `HistoryPanel.tsx` — session history with xterm replay
- `SyncPanel.tsx` — encrypted sync config (Argon2id + AES-256-GCM)
- `VaultPanel.tsx` — age-encrypted credential store (Advanced toggle)
- `UpdatePanel.tsx` — auto-update modal
- `LanguageSwitcher.tsx` — RU/EN toggle

## Open design needs (ask Claude Design to tackle)

These screens / patterns are **missing or weak** and should be priority for redesign:

1. **Settings panel** — currently a tiny popover dropdown with just 3 toggles. Need a full Settings screen:
   - Themes (Matrix dark, Solarized dark, Dracula, Light)
   - Fonts (JetBrains Mono, Fira Code, Cascadia Code, system mono) + size slider
   - **Matrix Rain background** toggle (canvas effect)
   - Auto-update toggle (already exists)
   - Show advanced features toggle (already exists)
   - SSH defaults section (default port, default user, etc.)
   - About section (version, github link, license)

2. **Host info detail view** — currently single click on sidebar = immediate connect. Needs to become: single click = SELECT (highlight) + show info panel in main area with everything about the host. Double click = connect.

3. **Right-click context menus** — currently no custom right-click anywhere. Need consistent menu style for:
   - Sidebar empty area → "New folder", "Add host", "Import hosts"
   - Sidebar folder → "Rename folder", "Delete folder", "New host in this folder"
   - Sidebar host → "Connect", "Connect in new window", "Edit", "Duplicate", "Move to folder ▶", "Delete", "Copy SSH command"
   - Tab → "Rename", "Restart session" (reconnect), "Duplicate tab", "Close", "Close other tabs"

4. **Folder management UX** — currently you go INTO each host's edit dialog and type group name manually. Needs:
   - Right-click on sidebar → "+ New folder"
   - Inline rename via double-click
   - Drag-and-drop hosts between folders
   - Drag-and-drop to reorder folders
   - "Move to..." submenu

5. **SFTP browser** (future) — split panel: local fs left, remote fs right, drag-drop transfer, progress bar.

6. **Port forwarding manager** (future) — list of forwards (local:port → remote:port), toggle on/off, edit.
