<!-- fork-copy: upstream translation; the authoritative description of this build is ../../README.md -->

> [!IMPORTANT]
> Esta traducción proviene de Terax upstream. Este fork eliminó las superficies de IA integradas que describe (chat, autocompletado, revisión de cambios con IA y ajustes de proveedor y claves de API). [`README.md`](../../README.md) describe la compilación que publica este repositorio.

<div align="center">
  <img src="../../public/logo.png" width="144" height="144" alt="Terax" />
  <h1>Terax</h1>

  <p><strong>Espacio de desarrollo ligero, centrado en la terminal y nativo de IA.</strong></p>

  <p>
    <a href="https://terax.app">Sitio web</a> ·
    <a href="https://terax.app/docs">Documentación</a> ·
    <a href="https://github.com/crynta/Terax-website">Código fuente del sitio web</a>
  </p>

  <p>
    <img src="https://img.shields.io/github/v/release/crynta/terax-ai?label=version&color=blue" alt="versión" />
    <img src="https://img.shields.io/github/downloads/crynta/terax-ai/total?label=downloads&color=blue" alt="descargas" />
    <img src="https://img.shields.io/badge/platform-Linux%20x86_64-lightgrey" alt="plataforma" />
    <a href="https://discord.gg/tyveTUyEp7"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
    <a href="https://www.youtube.com/@crynta"><img src="https://img.shields.io/badge/Youtube-FF0000?logo=youtube&logoColor=white" alt="YouTube" /></a>
  </p>
</div>

<p align="center">
  <a href="../../README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.pt-BR.md">Português</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.id.md">Bahasa Indonesia</a> |
  <a href="README.hi.md">हिन्दी</a>
</p>

---

Terax es un entorno de desarrollo (ADE) ligero, de código abierto, centrado en la terminal y nativo de IA, construido con Tauri 2 + Rust y React 19. Incluye un backend PTY nativo con renderizador WebGL, un panel lateral de IA con agentes que funciona con tus propias claves o modelos completamente locales, además de editor de código, explorador de archivos, control de código fuente con gráfico de Git y panel de vista previa web. Ocupa unos 7-8 MB en disco. Sin telemetría. Sin cuenta.

## Capturas de pantalla

<table>
  <tr>
    <td align="center"><img src="../web-preview.png" alt="Vista previa web" /><br/><sub>Vista previa web de servidores de desarrollo locales</sub></td>
    <td align="center"><img src="../ai-workflow.png" alt="Ventana de IA" /><br/><sub>Flujo de trabajo de IA con agentes y diferencias de edición en el editor</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="../themes.png" alt="Temas e imagen de fondo" style="margin-top: 12px;"/><br/><sub>Temas personalizados, preajustes e imágenes de fondo</sub></td>
    <td align="center"><img src="../source-control.png" alt="Control de código fuente y gráfico de Git" style="margin-top: 12px;"/><br/><sub>Panel de control de código fuente con gráfico de Git en el historial</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="../terminal.png" alt="Terminal" style="border-radius: 4px; margin-top: 12px;" /><br/><sub>Terminal WebGL por bloques con panel de entrada similar a un editor</sub></td>
  </tr>
</table>

## Funciones

### Terminal

- xterm.js con renderizador WebGL, múltiples pestañas y transmisión en segundo plano
- Terminal por bloques acelerada por GPU con entrada de comandos similar a un editor
- Backend PTY nativo mediante `portable-pty` (zsh, bash, pwsh, fish, cmd)
- Paneles divididos en horizontal y vertical
- Búsqueda integrada, detección de enlaces y color verdadero
- Arrastra archivos desde el explorador o el escritorio a una terminal como rutas entrecomilladas seguras para el shell
- Entornos de espacio de trabajo por pestaña en Windows (Local o cualquier distribución WSL instalada)
- Spaces restaura pestañas, directorios de trabajo y diseños divididos entre sesiones

### Editor de código

- CodeMirror 6 (compatible con los lenguajes más populares: TS/JS, Rust, Python, Go, C/C++, Java, HTML/CSS, JSON, Markdown, etc.)
- Autocompletado de IA integrado con soporte para modelos locales
- Diferencias de edición de IA, aceptables o rechazables bloque por bloque
- Compatibilidad opcional con servidores de lenguaje, diagnósticos, navegación, autocompletado, formato y servidores personalizados
- Markdown renderizado y visualización de imágenes, vídeo, audio y PDF
- Modo Vim
- Temas integrados como Kanagawa, Catppuccin, Rosé Pine, Everforest, Dracula, Solarized, Nord, Tokyo Night, GitHub y Xcode

### Control de código fuente

- Preparar o retirar bloques, confirmar (Cmd+Enter / Ctrl+Enter) y enviar con conocimiento de la rama remota
- Visualización de ramas, incluido el estado HEAD separado
- Panel de historial de Git con un gráfico real de commits (carriles para fusiones y ramas)
- Búsqueda y filtro de commits, con acceso a la página del commit remoto

### Explorador de archivos

- Tema de iconos Catppuccin
- Búsqueda difusa, navegación por teclado, cambio de nombre integrado y acciones contextuales
- Actualizaciones en directo cuando cambian los archivos en disco
- Adjunta archivos y selecciones directamente al panel lateral de IA

### Vista previa web

- Detecta servidores de desarrollo locales y los abre en una pestaña de vista previa
- Vista previa de URL externas mediante una vista web secundaria nativa

### Temas y personalización

- Crea temas personalizados en la aplicación y alterna entre preajustes incluidos y temas propios
- Comparte tus temas o impórtalos de la comunidad
- Imágenes de fondo con opacidad y desenfoque ajustables
- El tema del editor es independiente del tema de la aplicación

### IA

- **Proveedores con tu propia clave:** OpenAI, Anthropic, Google (Gemini), Groq, xAI (Grok), Cerebras, OpenRouter, DeepSeek, Mistral y cualquier endpoint compatible con OpenAI
- **Local / sin conexión:** LM Studio, MLX, Ollama
- **Flujo con agentes:** planes, subagentes, memoria de proyecto mediante `TERAX.md`, lectura / escritura / edición / edición múltiple / grep / glob, bash con aprobación y procesos en segundo plano
- **Orquestación de agentes de programación:** inicia Claude Code en una terminal, revisa su salida y envía trabajo adicional mediante herramientas sujetas a aprobación
- **Compositor:** fragmentos de prompt con `#handle`, archivos con `@path`, entrada de voz y adjuntos desde el explorador o una selección
- **Agentes personalizados** con su propio prompt de sistema y subconjunto de herramientas
- **Modo de planificación** que genera un plan y solicita confirmación antes de actuar

## Instalación

> **Platform support (authoritative, English):** this fork builds and distributes Linux x86-64
> only, as an RPM and a DEB. macOS, Windows/WSL and Nix build and distribution support was
> removed, and no other architecture is produced. See the
> [English README](../../README.md#platform-support).

Install the RPM (`sudo dnf install ./codr-*.x86_64.rpm`) or the DEB (`sudo apt
install ./codr_*_amd64.deb`) from the
[Releases](https://github.com/crynta/terax-ai/releases/latest) page with your package manager.
Fedora 44 KDE Plasma on Wayland is the primary validation target; Debian 13 still needs an
actual graphical WebKitGTK session, and package install/upgrade validation is ticket #44.
`packaging/arch/PKGBUILD` carries an Arch recipe that is authored but **not built**, so it is
not a validated Arch claim. The application never downloads, installs or restarts itself.

On Wayland with rendering glitches, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

## Configurar la IA

1. Abre **Ajustes -> IA**.
2. Elige un proveedor y pega tu clave API. Para inferencia local, apunta Terax a tu endpoint de LM Studio / MLX / Ollama.
3. Las claves se guardan en el llavero del sistema mediante `keyring`. Nunca se escriben en disco ni en localStorage.

## Compilar desde el código fuente

**Requisitos previos**

- Rust (stable), https://rustup.rs
- Node 22+ y [pnpm](https://pnpm.io)
- Requisitos previos de Tauri para tu plataforma, https://tauri.app/start/prerequisites/

**Ejecutar**

```bash
pnpm install
pnpm tauri dev          # desarrollo
pnpm tauri build        # paquete de producción
```

**Comprobaciones**

```bash
pnpm lint
pnpm check-types
pnpm test
cd src-tauri && cargo clippy --all-targets --locked -- -D warnings   # lint de Rust (igual que CI)
cd src-tauri && cargo nextest run --locked                           # o: cargo test --locked
```

## Tecnologías

Tauri 2, Rust, `portable-pty`, React 19, TypeScript, Vite, xterm.js, CodeMirror 6, Vercel AI SDK v6, Tailwind v4, shadcn/ui y Zustand.

## Contribuir

Se aceptan issues y PR. Puedes informar de problemas, sugerir funciones o enviar pull requests. Consulta [CONTRIBUTING.md](../../CONTRIBUTING.md) y la [documentación de arquitectura](../README.md) para obtener más información.

## Licencia

Terax se distribuye bajo la licencia Apache-2.0. Para más información sobre las dependencias, consulta [Apache License 2.0](../../LICENSE).
