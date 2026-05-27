// i18n setup — RU + EN, default RU (browser-language detected).
// Strings organized flat: keys are dot-separated paths.

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

const ru = {
  app: {
    version_label: "v",
    tagline: "терминал нового поколения",
  },
  sidebar: {
    filter_placeholder: "поиск...",
    add_host: "добавить хост",
    empty_state: "пока нет хостов",
    add_first: "+ добавить первый",
    edit: "Изменить",
    delete: "Удалить",
    no_group: "—",
  },
  dialog: {
    new_host: "новый хост",
    edit_host: "редактирование хоста",
    display_name: "Название",
    display_name_ph: "мой сервер",
    host: "Хост",
    host_ph: "example.com",
    port: "Порт",
    user: "Пользователь",
    user_ph: "root",
    group: "Группа (опц.)",
    group_ph: "prod / staging / personal",
    auth_password: "пароль",
    auth_key: "ключ",
    auth_vault: "vault",
    password: "Пароль",
    key_path: "Путь к ключу",
    key_path_ph: "/home/user/.ssh/id_ed25519",
    passphrase: "Пассфраза (опц.)",
    vault_key: "Ключ в vault",
    vault_key_ph: "myserver.password",
    vault_unavailable: "Vault не разблокирован — открой vault-панель в шапке",
    note: "Заметка (опц.)",
    cancel: "отмена",
    save: "сохранить",
    delete_confirm: "Удалить {{name}}?",
    err_host_required: "Укажите хост",
    err_user_required: "Укажите пользователя",
  },
  terminal: {
    select_host: "выберите хост слева, чтобы подключиться",
    connecting_to: "подключение к {{user}}@{{host}}:{{port}}...",
    session_closed: "сессия закрыта: {{reason}}",
  },
  vault: {
    title: "vault",
    subtitle: "age-encrypted credential store (свой файл + ключ)",
    vault_file: "Файл vault (.age)",
    key_file: "Файл ключа (private)",
    browse: "выбрать",
    hint: "Подсказка: ключ — это X25519-identity (как `age-keygen` создаёт). На каждом устройстве укажи путь к одной и той же паре, синкая её через Syncthing.",
    unlock: "разблокировать",
    lock: "заблокировать",
    open_panel: "vault",
  },
  errors: {
    auth_failed: "Ошибка аутентификации",
    connection_failed: "Не удалось подключиться",
  },
};

const en = {
  app: {
    version_label: "v",
    tagline: "next-gen terminal",
  },
  sidebar: {
    filter_placeholder: "filter...",
    add_host: "add host",
    empty_state: "no hosts yet",
    add_first: "+ add the first one",
    edit: "Edit",
    delete: "Delete",
    no_group: "—",
  },
  dialog: {
    new_host: "new_host",
    edit_host: "edit_host",
    display_name: "Display name",
    display_name_ph: "my-server",
    host: "Host",
    host_ph: "example.com",
    port: "Port",
    user: "User",
    user_ph: "root",
    group: "Group (optional)",
    group_ph: "prod / staging / personal",
    auth_password: "password",
    auth_key: "key",
    auth_vault: "vault",
    password: "Password",
    key_path: "Key file path",
    key_path_ph: "/home/user/.ssh/id_ed25519",
    passphrase: "Passphrase (optional)",
    vault_key: "Vault key",
    vault_key_ph: "myserver.password",
    vault_unavailable: "Vault is locked — open the vault panel in header",
    note: "Note (optional)",
    cancel: "cancel",
    save: "save",
    delete_confirm: "Delete {{name}}?",
    err_host_required: "Host is required",
    err_user_required: "User is required",
  },
  terminal: {
    select_host: "select a host on the left to connect",
    connecting_to: "connecting to {{user}}@{{host}}:{{port}}...",
    session_closed: "session closed: {{reason}}",
  },
  vault: {
    title: "vault",
    subtitle: "age-encrypted credential store (your file + key)",
    vault_file: "Vault file (.age)",
    key_file: "Key file (private)",
    browse: "browse",
    hint: "Hint: key is an X25519 identity (as produced by `age-keygen`). On each device point to the same pair, synced via Syncthing.",
    unlock: "unlock",
    lock: "lock",
    open_panel: "vault",
  },
  errors: {
    auth_failed: "Authentication failed",
    connection_failed: "Connection failed",
  },
};

function detectInitialLang(): "ru" | "en" {
  const stored = localStorage.getItem("nexussh.lang");
  if (stored === "ru" || stored === "en") return stored;
  const nav = (navigator.language || "en").toLowerCase();
  return nav.startsWith("ru") ? "ru" : "en";
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      ru: { translation: ru },
      en: { translation: en },
    },
    lng: detectInitialLang(),
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });

export function setLang(lang: "ru" | "en") {
  localStorage.setItem("nexussh.lang", lang);
  i18n.changeLanguage(lang);
}

export default i18n;
