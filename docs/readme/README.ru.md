<!-- fork-copy: upstream translation; the authoritative description of this build is ../../README.md -->

> [!IMPORTANT]
> Этот перевод взят из вышестоящего Terax. Этот форк удалил описанные здесь встроенные функции ИИ (чат, автодополнение, проверку изменений с помощью ИИ, а также настройки провайдера и ключей API). [`README.md`](../../README.md) описывает сборку, которую поставляет этот репозиторий.

<div align="center">
  <img src="../../public/logo.png" width="144" height="144" alt="Terax" />
  <h1>Terax</h1>
  <p><strong>Легковесная среда разработки с упором на терминал и встроенным ИИ.</strong></p>
  <p><a href="https://terax.app">Сайт</a> · <a href="https://terax.app/docs">Документация</a> · <a href="https://github.com/crynta/Terax-website">Исходный код сайта</a></p>

  <p>
    <img src="https://img.shields.io/github/v/release/crynta/terax-ai?label=version&color=blue" alt="версия" />
    <img src="https://img.shields.io/github/downloads/crynta/terax-ai/total?label=downloads&color=blue" alt="загрузки" />
    <img src="https://img.shields.io/badge/platform-Linux%20x86_64-lightgrey" alt="платформа" />
    <a href="https://discord.gg/tyveTUyEp7"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
    <a href="https://www.youtube.com/@crynta"><img src="https://img.shields.io/badge/Youtube-FF0000?logo=youtube&logoColor=white" alt="YouTube" /></a>
  </p>
</div>

<p align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.es.md">Español</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.pl.md">Polski</a> | <a href="README.id.md">Bahasa Indonesia</a> | <a href="README.hi.md">हिन्दी</a>
</p>

---

Terax представляет собой легковесную среду разработки (ADE) с открытым исходным кодом, ориентированную на терминал и ИИ. Она построена на Tauri 2 + Rust и React 19. В состав входят нативный PTY-бэкенд с WebGL-рендерером, боковая панель агентного ИИ, работающая с вашими ключами или полностью локальными моделями, редактор кода, файловый проводник, управление исходным кодом с графом Git и панель веб-предпросмотра. Около 7-8 МБ на диске. Без телеметрии. Без учётной записи.

## Снимки экрана

<table>
  <tr><td align="center"><img src="../web-preview.png" alt="Веб-предпросмотр" /><br/><sub>Предпросмотр локальных серверов разработки</sub></td><td align="center"><img src="../ai-workflow.png" alt="Окно ИИ" /><br/><sub>Рабочий процесс агентного ИИ с различиями правок в редакторе</sub></td></tr>
  <tr><td align="center"><img src="../themes.png" alt="Темы и фон" style="margin-top: 12px;"/><br/><sub>Пользовательские темы, пресеты и фоновые изображения</sub></td><td align="center"><img src="../source-control.png" alt="Управление кодом и граф Git" style="margin-top: 12px;"/><br/><sub>Панель управления кодом с графом Git в истории</sub></td></tr>
  <tr><td colspan="2" align="center"><img src="../terminal.png" alt="Терминал" style="border-radius: 4px; margin-top: 12px;" /><br/><sub>Блочный WebGL-терминал с панелью ввода как в редакторе</sub></td></tr>
</table>

## Возможности

### Терминал

- xterm.js с WebGL-рендерером, несколькими вкладками и фоновой передачей данных
- Блочный терминал с ускорением GPU и вводом команд как в редакторе
- Нативный PTY-бэкенд через `portable-pty` (zsh, bash, pwsh, fish, cmd)
- Горизонтальное и вертикальное разделение панелей
- Встроенный поиск, распознавание ссылок и True Color
- Перетаскивание файлов из проводника или с рабочего стола как безопасно заключённых в кавычки путей
- Отдельная среда для каждой вкладки в Windows (Local или установленный дистрибутив WSL)
- Spaces восстанавливает вкладки, рабочие каталоги и раскладку панелей между запусками

### Редактор кода

- CodeMirror 6 с поддержкой популярных языков, включая TS/JS, Rust, Python, Go, C/C++, Java, HTML/CSS, JSON и Markdown
- Встроенное автодополнение ИИ с поддержкой локальных моделей
- Различия правок ИИ с принятием или отклонением по отдельным блокам
- Опциональные языковые серверы с диагностикой, навигацией, дополнением, форматированием и пользовательскими серверами
- Рендеринг Markdown и просмотр изображений, видео, аудио и PDF
- Режим Vim
- Встроенные темы Kanagawa, Catppuccin, Rosé Pine, Everforest, Dracula, Solarized, Nord, Tokyo Night, GitHub, Xcode и другие

### Управление исходным кодом

- Индексация и снятие индексации блоков, commit (Cmd+Enter / Ctrl+Enter) и push с учётом upstream
- Отображение веток, включая состояние detached HEAD
- История Git с настоящим графом коммитов и дорожками слияний и веток
- Поиск и фильтрация коммитов с переходом на удалённую страницу

### Файловый проводник

- Тема значков Catppuccin
- Нечёткий поиск, навигация с клавиатуры, переименование на месте и контекстные действия
- Обновление в реальном времени при изменении файлов на диске
- Прикрепление файлов и выделений прямо к панели ИИ

### Веб-предпросмотр

- Автоматически находит локальные серверы и открывает их во вкладке предпросмотра
- Показывает внешние URL через нативный дочерний WebView

### Темы и настройка

- Создание собственных тем в приложении и переключение между пресетами и своими темами
- Обмен темами и импорт из сообщества
- Фоновые изображения с регулируемой прозрачностью и размытием
- Тема редактора не зависит от темы приложения

### ИИ

- **Провайдеры с собственным ключом:** OpenAI, Anthropic, Google (Gemini), Groq, xAI (Grok), Cerebras, OpenRouter, DeepSeek, Mistral и любой OpenAI-совместимый endpoint
- **Локально / офлайн:** LM Studio, MLX, Ollama
- **Агентный процесс:** планы, субагенты, память проекта через `TERAX.md`, чтение / запись / правка / множественная правка / grep / glob, bash с подтверждением и фоновые процессы
- **Оркестрация агентов программирования:** запуск Claude Code в терминале, просмотр его вывода и отправка последующих задач через инструменты с подтверждением
- **Поле ввода:** фрагменты промптов через `#handle`, файлы через `@path`, голосовой ввод и вложения из проводника или выделения
- **Пользовательские агенты** со своим системным промптом и набором инструментов
- **Режим планирования**, который создаёт план и просит подтверждение перед выполнением

## Установка

> **Platform support (authoritative, English):** this fork builds and distributes Linux x86-64
> only, as an RPM and a DEB. macOS, Windows/WSL and Nix build and distribution support was
> removed, and no other architecture is produced. See the
> [English README](../../README.md#platform-support).

Install the RPM (`sudo dnf install ./terax-workspace-*.x86_64.rpm`) or the DEB (`sudo apt
install ./terax-workspace_*_amd64.deb`) from the
[Releases](https://github.com/crynta/terax-ai/releases/latest) page with your package manager.
Fedora 44 KDE Plasma on Wayland is the primary validation target; Debian 13 still needs an
actual graphical WebKitGTK session, and package install/upgrade validation is ticket #44.
`packaging/arch/PKGBUILD` carries an Arch recipe that is authored but **not built**, so it is
not a validated Arch claim. The application never downloads, installs or restarts itself.

On Wayland with rendering glitches, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

## Настройка ИИ

1. Откройте **Настройки -> ИИ**.
2. Выберите провайдера и вставьте ключ API. Для локального инференса укажите endpoint LM Studio / MLX / Ollama.
3. Ключи записываются в системное хранилище через `keyring`. Они никогда не сохраняются на диск или в localStorage.

## Сборка из исходного кода

**Требования**

- Rust (stable), https://rustup.rs
- Node 22+ и [pnpm](https://pnpm.io)
- Требования Tauri для вашей платформы, https://tauri.app/start/prerequisites/

**Запуск**

```bash
pnpm install
pnpm tauri dev          # разработка
pnpm tauri build        # производственный пакет
```

**Проверки**

```bash
pnpm lint
pnpm check-types
pnpm test
cd src-tauri && cargo clippy --all-targets --locked -- -D warnings   # Rust lint как в CI
cd src-tauri && cargo nextest run --locked                           # или cargo test --locked
```

## Стек технологий

Tauri 2, Rust, `portable-pty`, React 19, TypeScript, Vite, xterm.js, CodeMirror 6, Vercel AI SDK v6, Tailwind v4, shadcn/ui и Zustand.

## Участие в разработке

Issues и PR приветствуются. Сообщайте о проблемах, предлагайте возможности или отправляйте pull request. Подробности находятся в [CONTRIBUTING.md](../../CONTRIBUTING.md) и [документации по архитектуре](../README.md).

## Лицензия

Terax распространяется по лицензии Apache-2.0. Информацию о зависимостях см. в [Apache License 2.0](../../LICENSE).
