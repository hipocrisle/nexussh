<div align="center">

# 🛰️ NexuSSH

**Быстрый нативный кроссплатформенный SSH-клиент эпохи AI-CLI.**

*Больше никогда не теряйте вывод Claude Code / vim / htop при прокрутке назад.*

[![Release](https://img.shields.io/github/v/release/hipocrisle/nexussh?include_prereleases&label=release&color=2ea043)](https://github.com/hipocrisle/nexussh/releases/latest)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20Android-444)](#-установка)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db)](https://tauri.app)
[![SSH](https://img.shields.io/badge/SSH-pure%20Rust%20(russh)-dea584)](https://github.com/Eugeny/russh)

[English](README.md) · **Русский**

</div>

---

## ✨ Зачем NexuSSH

Termius — платный. Tabby — раздутый Electron+Angular. NexuSSH — это **нативный бинарник ~15 МБ** (Tauri 2, не Electron) с собственным UI в стиле Matrix, end-to-end шифрованной синхронизацией, опциональным встроенным VPN-транспортом и убойной фишкой, которой нет ни у кого: **он сохраняет каждый байт, прошедший по соединению** — включая полноэкранные приложения вроде Claude Code, vim и htop — так что можно прокрутить назад, найти и выгрузить всю сессию.

## 🚀 Возможности

### Терминал и сессии
- 🖥️ **История сессий с полным захватом байтов** — пишет *весь* вывод терминала, включая alternate-screen приложения (Claude Code, vim, htop). Прокрутка по всему, поиск, экспорт. Шифруется на диске. *Такого нет ни у одного клиента.*
- 🗂️ **Вкладки как надо** — скруглённые вкладки, сплит-вью, восстановление последней закрытой (`Ctrl+Shift+T`), сохранение раскладки.
- 📊 **Статус-строка** — состояние соединения с одного взгляда.
- 🎨 **Тёмный UI в стиле Matrix** — зелёно-циановые акценты, моноширинный шрифт, скруглённое окно. Без замашек на Material/iOS.

### Подключение
- ⚡ **Быстрое подключение** — пишешь `user@host` и ты внутри.
- 🩺 **Проверка доступности хоста** — TCP-проверка `host:port` *до* запроса пароля (как в PuTTY), чтобы выключенный хост не путали с неверным паролем.
- 🔑 **Проверка ключа хоста (TOFU)** — `known_hosts.json`, защита от MITM; SFTP тоже проверяет ключи.
- 🧩 **Поддержка legacy-алгоритмов** — подключается к старому железу Cisco IOS / ESXi, от которого современные клиенты отказываются.
- 📁 **SFTP** — просмотр и передача файлов по тому же соединению.

### Безопасность и секреты
- 🔐 **Шифрованный vault** для учёток (на базе age), с **авто-блокировкой по простою**.
- 🛡️ **Envelope-шифрование сохранённых хостов**, **шифруемый список хостов**, ограниченный доступ к ФС и строгий CSP.

### Синхронизация и много устройств
- ☁️ **Self-hosted синк аккаунта** — хосты и настройки между машинами, end-to-end шифрование.
- 🔁 **Ключ восстановления** + **самовосстанавливающийся force-resync** — не заблокируешься и не словишь рассинхрон.
- 📦 **Массовый импорт** (100+ хостов), экспорт/импорт между ПК, transfer-бандлы.

### Встроенный VPN-транспорт
- 🌐 **«Через встроенный VPN» для каждого хоста** — достучаться до SSH-хостов из сетей, где они заблокированы, **без установки VPN-клиента и прав администратора**.
- 🧅 Внутри [xray-core](https://github.com/XTLS/Xray-core): вставь **свою** подписку (любая ссылка VLESS / Reality / VMess / Trojan / Shadowsocks или `…/sub/…`) в **Настройки → VPN**, отметь хост и выбери выход. Соединение этого хоста идёт через локальный SOCKS-прокси с выходом через выбранную ноду.
- 🔒 **Только userspace** (локальный SOCKS, без системного TUN) — выглядит как обычный HTTPS, работает на залоченных рабочих машинах. Подписки хранятся **локально**, не пишутся в `hosts.json` и не уходят в синк.

### Платформы и обновления
- 🪟🐧🤖 **Windows, Linux (.deb + .rpm), Android** (подписанный APK).
- 🔄 **Self-hosted автообновление** — в приложении *Установить и перезапустить*, с собственного зеркала (доступно из ограниченных сетей).
- 🌍 **Двуязычный интерфейс** — русский и английский.

## 📸 Скриншоты

> _Положи картинки в `docs/screenshots/` — они отобразятся здесь._

<div align="center">
<img src="docs/screenshots/main.png" alt="Терминал NexuSSH" width="80%">
<br><em>Главный терминал — UI в стиле Matrix</em>
<br><br>
<img src="docs/screenshots/history.png" alt="История сессий" width="80%">
<br><em>История сессий с полным захватом байтов — поиск и экспорт</em>
</div>

## 📥 Установка

Свежую сборку бери на **[странице релизов](https://github.com/hipocrisle/nexussh/releases/latest)**:

| ОС | Файл | Как |
|----|------|-----|
| **Windows** | `NexuSSH_*_x64-setup.exe` | двойной клик |
| **Linux (Debian/Ubuntu)** | `NexuSSH_*_amd64.deb` | `sudo apt install ./NexuSSH_*_amd64.deb` |
| **Linux (Fedora/RHEL)** | `NexuSSH_*.x86_64.rpm` | `sudo dnf install ./NexuSSH_*.x86_64.rpm` |
| **Android** | `NexuSSH_*.apk` | установить подписанный APK |

Linux-сборки используют системный WebKit (`.deb`/`.rpm`), а не AppImage — никакого белого экрана на свежих дистрибутивах. Встроенное **Установить и перезапустить** держит версию актуальной.

## 🛠️ Сборка из исходников

```bash
git clone https://github.com/hipocrisle/nexussh.git
cd nexussh/desktop
npm install
npm run tauri dev      # запуск в dev
npm run tauri build    # собрать инсталляторы
```

**Требования:** Rust (stable), Node 18+ и [пререквизиты Tauri 2](https://tauri.app/start/prerequisites/) для вашей ОС.

## 🧱 Стек

- **[Tauri 2](https://tauri.app)** — Rust-бэкенд + системный WebView (~15 МБ против ~150 МБ у Electron)
- **React 19 + Vite + Tailwind** — UI
- **[xterm.js](https://xtermjs.org)** — рендер терминала с кастомным захватом байтов
- **[russh](https://github.com/Eugeny/russh)** — SSH-протокол на чистом Rust
- **age** — шифрование vault и истории
- **[xray-core](https://github.com/XTLS/Xray-core)** — встроенный VPN-транспорт

## 📄 Лицензия

См. [LICENSE](LICENSE).

---

<div align="center">
<sub>Сделано на ☕ и Rust · Issues и PR приветствуются</sub>
</div>
