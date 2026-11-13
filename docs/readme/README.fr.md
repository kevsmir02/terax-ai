<!-- fork-copy: upstream translation; the authoritative description of this build is ../../README.md -->

> [!IMPORTANT]
> Cette traduction provient de Terax amont. Ce fork a supprimé les surfaces d'IA intégrées qu'elle décrit (chat, autocomplétion, revue des modifications par IA et réglages de fournisseur et de clés d'API). [`README.md`](../../README.md) décrit la version publiée par ce dépôt.

<div align="center">
  <img src="../../public/logo.png" width="144" height="144" alt="Terax" />
  <h1>Terax</h1>
  <p><strong>Espace de développement léger, axé sur le terminal et natif pour l'IA.</strong></p>
  <p><a href="https://terax.app">Site web</a> · <a href="https://terax.app/docs">Documentation</a> · <a href="https://github.com/crynta/Terax-website">Code source du site</a></p>

  <p>
    <img src="https://img.shields.io/github/v/release/crynta/terax-ai?label=version&color=blue" alt="version" />
    <img src="https://img.shields.io/github/downloads/crynta/terax-ai/total?label=downloads&color=blue" alt="téléchargements" />
    <img src="https://img.shields.io/badge/platform-Linux%20x86_64-lightgrey" alt="plateforme" />
    <a href="https://discord.gg/tyveTUyEp7"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
    <a href="https://www.youtube.com/@crynta"><img src="https://img.shields.io/badge/Youtube-FF0000?logo=youtube&logoColor=white" alt="YouTube" /></a>
  </p>
</div>

<p align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.es.md">Español</a> | <a href="README.de.md">Deutsch</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.pl.md">Polski</a> | <a href="README.ru.md">Русский</a> | <a href="README.id.md">Bahasa Indonesia</a> | <a href="README.hi.md">हिन्दी</a>
</p>

---

Terax est un environnement de développement (ADE) léger, open source, axé sur le terminal et natif pour l'IA, construit avec Tauri 2 + Rust et React 19. Il réunit un backend PTY natif avec moteur de rendu WebGL, un panneau latéral d'IA agentique fonctionnant avec vos propres clés ou des modèles entièrement locaux, un éditeur de code, un explorateur de fichiers, une gestion de sources avec graphe Git et un panneau d'aperçu web. Environ 7-8 Mo sur le disque. Aucune télémétrie. Aucun compte.

## Captures d'écran

<table>
  <tr><td align="center"><img src="../web-preview.png" alt="Aperçu web" /><br/><sub>Aperçu web des serveurs de développement locaux</sub></td><td align="center"><img src="../ai-workflow.png" alt="Fenêtre IA" /><br/><sub>Flux de travail d'IA agentique avec diffs dans l'éditeur de code</sub></td></tr>
  <tr><td align="center"><img src="../themes.png" alt="Thèmes et image de fond" style="margin-top: 12px;"/><br/><sub>Thèmes personnalisés, préréglages et images de fond</sub></td><td align="center"><img src="../source-control.png" alt="Gestion de sources et graphe Git" style="margin-top: 12px;"/><br/><sub>Panneau de gestion de sources avec graphe Git dans l'historique</sub></td></tr>
  <tr><td colspan="2" align="center"><img src="../terminal.png" alt="Terminal" style="border-radius: 4px; margin-top: 12px;" /><br/><sub>Terminal WebGL par blocs avec panneau de saisie proche d'un éditeur</sub></td></tr>
</table>

## Fonctionnalités

### Terminal

- xterm.js avec moteur WebGL, plusieurs onglets et flux en arrière-plan
- Terminal par blocs accéléré par GPU avec saisie de commandes proche d'un éditeur
- Backend PTY natif via `portable-pty` (zsh, bash, pwsh, fish, cmd)
- Panneaux divisés horizontalement et verticalement
- Recherche intégrée, détection des liens et couleurs vraies
- Glissez des fichiers depuis l'explorateur ou le bureau sous forme de chemins protégés pour le shell
- Environnements par onglet sous Windows (Local ou toute distribution WSL installée)
- Spaces restaure onglets, répertoires de travail et dispositions entre les lancements

### Éditeur de code

- CodeMirror 6, compatible avec les langages courants comme TS/JS, Rust, Python, Go, C/C++, Java, HTML/CSS, JSON et Markdown
- Autocomplétion IA intégrée avec modèles locaux
- Diffs de modifications IA à accepter ou refuser bloc par bloc
- Serveurs de langage facultatifs avec diagnostics, navigation, complétion, formatage et serveurs personnalisés
- Markdown rendu et affichage des images, vidéos, fichiers audio et PDF
- Mode Vim
- Thèmes intégrés dont Kanagawa, Catppuccin, Rosé Pine, Everforest, Dracula, Solarized, Nord, Tokyo Night, GitHub et Xcode

### Gestion de sources

- Indexer ou désindexer des blocs, valider (Cmd+Enter / Ctrl+Enter) et pousser avec gestion de l'amont
- Affichage des branches, y compris l'état HEAD détaché
- Historique Git avec véritable graphe de commits et couloirs pour les fusions et branches
- Recherche et filtrage des commits avec accès à leur page distante

### Explorateur de fichiers

- Thème d'icônes Catppuccin
- Recherche approximative, navigation au clavier, renommage intégré et actions contextuelles
- Mise à jour en direct lorsque les fichiers changent sur le disque
- Ajout direct de fichiers et sélections au panneau latéral IA

### Aperçu web

- Détecte les serveurs locaux et les ouvre dans un onglet d'aperçu
- Aperçu d'URL externes via une vue web enfant native

### Thèmes et personnalisation

- Créez des thèmes dans l'application et alternez entre les préréglages et les vôtres
- Partagez vos thèmes ou importez ceux de la communauté
- Images de fond avec opacité et flou réglables
- Le thème de l'éditeur est indépendant de celui de l'application

### IA

- **Fournisseurs avec vos propres clés :** OpenAI, Anthropic, Google (Gemini), Groq, xAI (Grok), Cerebras, OpenRouter, DeepSeek, Mistral et tout endpoint compatible OpenAI
- **Local / hors ligne :** LM Studio, MLX, Ollama
- **Flux agentique :** plans, sous-agents, mémoire du projet via `TERAX.md`, lecture / écriture / modification / modifications multiples / grep / glob, bash soumis à approbation et processus en arrière-plan
- **Orchestration d'agents de programmation :** lancez Claude Code dans un terminal, inspectez sa sortie et envoyez des tâches de suivi via des outils soumis à approbation
- **Zone de saisie :** extraits de prompt avec `#handle`, fichiers avec `@path`, saisie vocale et pièces jointes depuis l'explorateur ou une sélection
- **Agents personnalisés** avec leur propre prompt système et sous-ensemble d'outils
- **Mode plan** qui génère un plan et demande confirmation avant d'agir

## Installation

> **Platform support (authoritative, English):** this fork builds and distributes Linux x86-64
> only, as an RPM and a DEB. macOS, Windows/WSL and Nix build and distribution support was
> removed, and no other architecture is produced. See the
> [English README](../../README.md#platform-support).

Install the RPM (`sudo dnf install ./terax-workspace-*.x86_64.rpm`) or the DEB (`sudo apt
install ./terax-workspace_*_amd64.deb`) from the
[Releases](https://github.com/crynta/terax-ai/releases/latest) page with your package manager.
Fedora 44 KDE Plasma on Wayland is the primary validation target; Debian 13 still needs an
actual graphical WebKitGTK session, and package install/upgrade validation is ticket #43.
`packaging/arch/PKGBUILD` carries an Arch recipe that is authored but **not built**, so it is
not a validated Arch claim. The application never downloads, installs or restarts itself.

On Wayland with rendering glitches, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

## Configurer l'IA

1. Ouvrez **Paramètres -> IA**.
2. Choisissez un fournisseur et collez votre clé API. Pour une inférence locale, indiquez votre endpoint LM Studio / MLX / Ollama.
3. Les clés sont enregistrées dans le trousseau du système via `keyring`. Elles ne sont jamais écrites sur le disque ni dans localStorage.

## Compiler depuis les sources

**Prérequis**

- Rust (stable), https://rustup.rs
- Node 22+ et [pnpm](https://pnpm.io)
- Prérequis Tauri pour votre plateforme, https://tauri.app/start/prerequisites/

**Exécution**

```bash
pnpm install
pnpm tauri dev          # développement
pnpm tauri build        # paquet de production
```

**Vérifications**

```bash
pnpm lint
pnpm check-types
pnpm test
cd src-tauri && cargo clippy --all-targets --locked -- -D warnings   # lint Rust identique à la CI
cd src-tauri && cargo nextest run --locked                           # ou : cargo test --locked
```

## Technologies

Tauri 2, Rust, `portable-pty`, React 19, TypeScript, Vite, xterm.js, CodeMirror 6, Vercel AI SDK v6, Tailwind v4, shadcn/ui et Zustand.

## Contribuer

Les issues et PR sont les bienvenues. Signalez des problèmes, proposez des fonctionnalités ou envoyez une pull request. Consultez [CONTRIBUTING.md](../../CONTRIBUTING.md) et la [documentation d'architecture](../README.md).

## Licence

Terax est distribué sous licence Apache-2.0. Pour plus d'informations sur les dépendances, consultez l'[Apache License 2.0](../../LICENSE).
