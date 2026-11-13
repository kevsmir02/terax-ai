<!-- fork-copy: upstream translation; the authoritative description of this build is ../../README.md -->

> [!IMPORTANT]
> यह अनुवाद अपस्ट्रीम Terax से लिया गया है। इस फ़ोर्क ने इसमें वर्णित अंतर्निहित AI सुविधाएँ हटा दी हैं (चैट, ऑटो-पूर्णता, AI द्वारा बदलाव समीक्षा, और प्रोवाइडर/API कुंजी सेटिंग्स)। [`README.md`](../../README.md) उस बिल्ड का वर्णन करता है जो यह रिपॉज़िटरी प्रकाशित करता है।

<div align="center">
  <img src="../../public/logo.png" width="144" height="144" alt="Terax" />
  <h1>Terax</h1>
  <p><strong>हल्का, टर्मिनल-केंद्रित और AI-नेटिव डेवलपमेंट वर्कस्पेस।</strong></p>
  <p><a href="https://terax.app">वेबसाइट</a> · <a href="https://terax.app/docs">दस्तावेज़</a> · <a href="https://github.com/crynta/Terax-website">वेबसाइट का सोर्स कोड</a></p>

  <p>
    <img src="https://img.shields.io/github/v/release/crynta/terax-ai?label=version&color=blue" alt="संस्करण" />
    <img src="https://img.shields.io/github/downloads/crynta/terax-ai/total?label=downloads&color=blue" alt="डाउनलोड" />
    <img src="https://img.shields.io/badge/platform-Linux%20x86_64-lightgrey" alt="प्लेटफ़ॉर्म" />
    <a href="https://discord.gg/tyveTUyEp7"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
    <a href="https://www.youtube.com/@crynta"><img src="https://img.shields.io/badge/Youtube-FF0000?logo=youtube&logoColor=white" alt="YouTube" /></a>
  </p>
</div>

<p align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.es.md">Español</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.pl.md">Polski</a> | <a href="README.ru.md">Русский</a> | <a href="README.id.md">Bahasa Indonesia</a>
</p>

---

Terax एक हल्का, ओपन-सोर्स, टर्मिनल-केंद्रित और AI-नेटिव डेवलपमेंट एनवायरनमेंट (ADE) है, जिसे Tauri 2 + Rust और React 19 पर बनाया गया है। इसमें WebGL रेंडरर वाला नेटिव PTY बैकएंड, आपकी अपनी कुंजियों या पूरी तरह स्थानीय मॉडल पर चलने वाला एजेंटिक AI साइड पैनल, कोड एडिटर, फ़ाइल एक्सप्लोरर, Git ग्राफ़ के साथ सोर्स कंट्रोल और वेब प्रीव्यू पैनल शामिल हैं। डिस्क पर लगभग 7-8 MB। कोई टेलीमेट्री नहीं। कोई खाता नहीं।

## स्क्रीनशॉट

<table>
  <tr><td align="center"><img src="../web-preview.png" alt="वेब प्रीव्यू" /><br/><sub>स्थानीय डेवलपमेंट सर्वर का वेब प्रीव्यू</sub></td><td align="center"><img src="../ai-workflow.png" alt="AI विंडो" /><br/><sub>कोड एडिटर में एडिट डिफ़ के साथ एजेंटिक AI वर्कफ़्लो</sub></td></tr>
  <tr><td align="center"><img src="../themes.png" alt="थीम और बैकग्राउंड" style="margin-top: 12px;"/><br/><sub>कस्टम थीम, प्रीसेट और बैकग्राउंड इमेज</sub></td><td align="center"><img src="../source-control.png" alt="सोर्स कंट्रोल और Git ग्राफ़" style="margin-top: 12px;"/><br/><sub>इतिहास में Git ग्राफ़ वाला सोर्स कंट्रोल पैनल</sub></td></tr>
  <tr><td colspan="2" align="center"><img src="../terminal.png" alt="टर्मिनल" style="border-radius: 4px; margin-top: 12px;" /><br/><sub>एडिटर जैसे इनपुट पैनल वाला ब्लॉक-आधारित WebGL टर्मिनल</sub></td></tr>
</table>

## सुविधाएँ

### टर्मिनल

- WebGL रेंडरर, मल्टी-टैब और बैकग्राउंड स्ट्रीमिंग के साथ xterm.js
- एडिटर जैसे कमांड इनपुट वाला GPU-त्वरित ब्लॉक-आधारित टर्मिनल
- `portable-pty` के माध्यम से नेटिव PTY बैकएंड (zsh, bash, pwsh, fish, cmd)
- क्षैतिज और लंबवत स्प्लिट पैनल
- इनलाइन खोज, लिंक पहचान और ट्रू कलर
- एक्सप्लोरर या डेस्कटॉप से फ़ाइलों को शेल-सुरक्षित उद्धृत पाथ के रूप में टर्मिनल में खींचें
- Windows पर प्रति-टैब वर्कस्पेस एनवायरनमेंट (Local या कोई स्थापित WSL डिस्ट्रो)
- Spaces अगली बार शुरू होने पर टैब, कार्य निर्देशिका और स्प्लिट लेआउट पुनर्स्थापित करता है

### कोड एडिटर

- CodeMirror 6, जो TS/JS, Rust, Python, Go, C/C++, Java, HTML/CSS, JSON और Markdown जैसी लोकप्रिय भाषाओं का समर्थन करता है
- स्थानीय मॉडल समर्थन के साथ इनलाइन AI ऑटोकम्प्लीट
- AI एडिट डिफ़, जिन्हें हर हंक पर स्वीकार या अस्वीकार किया जा सकता है
- डायग्नोस्टिक्स, नेविगेशन, कम्प्लीशन, फ़ॉर्मेटिंग और कस्टम सर्वर के साथ वैकल्पिक लैंग्वेज सर्वर समर्थन
- रेंडर्ड Markdown और इमेज, वीडियो, ऑडियो तथा PDF देखना
- Vim मोड
- Kanagawa, Catppuccin, Rosé Pine, Everforest, Dracula, Solarized, Nord, Tokyo Night, GitHub और Xcode सहित बिल्ट-इन थीम

### सोर्स कंट्रोल

- हंक को stage / unstage करें, commit (Cmd+Enter / Ctrl+Enter) करें और upstream की जानकारी के साथ push करें
- detached HEAD स्थिति सहित ब्रांच प्रदर्शन
- मर्ज और ब्रांच के लिए लेन वाले वास्तविक commit ग्राफ़ के साथ Git इतिहास
- commit खोजें और फ़िल्टर करें, फिर remote commit पेज खोलें

### फ़ाइल एक्सप्लोरर

- Catppuccin आइकन थीम
- फ़ज़ी खोज, कीबोर्ड नेविगेशन, इनलाइन नाम बदलना और संदर्भ क्रियाएँ
- डिस्क पर फ़ाइल बदलने पर लाइव अपडेट
- फ़ाइलों और चयन को सीधे AI साइड पैनल में संलग्न करें

### वेब प्रीव्यू

- स्थानीय डेवलपमेंट सर्वर अपने आप पहचानकर प्रीव्यू टैब में खोलता है
- नेटिव चाइल्ड WebView के माध्यम से बाहरी URL का प्रीव्यू

### थीम और कस्टमाइज़ेशन

- ऐप में कस्टम थीम बनाएँ और बिल्ट-इन प्रीसेट तथा अपनी थीम के बीच बदलें
- थीम साझा करें या समुदाय से आयात करें
- समायोज्य अपारदर्शिता और ब्लर वाली बैकग्राउंड इमेज
- एडिटर थीम ऐप थीम से स्वतंत्र है

### AI

- **अपनी कुंजी वाले प्रदाता:** OpenAI, Anthropic, Google (Gemini), Groq, xAI (Grok), Cerebras, OpenRouter, DeepSeek, Mistral और कोई भी OpenAI-संगत endpoint
- **स्थानीय / ऑफ़लाइन:** LM Studio, MLX, Ollama
- **एजेंटिक वर्कफ़्लो:** योजनाएँ, सब-एजेंट, `TERAX.md` के माध्यम से प्रोजेक्ट मेमोरी, फ़ाइल पढ़ना / लिखना / एडिट / मल्टी-एडिट / grep / glob, अनुमोदन वाला bash और बैकग्राउंड प्रोसेस
- **कोडिंग एजेंट ऑर्केस्ट्रेशन:** टर्मिनल में Claude Code शुरू करें, उसका आउटपुट देखें और अनुमोदन वाले टूल से अगला काम भेजें
- **कम्पोज़र:** `#handle` से प्रॉम्प्ट स्निपेट, `@path` से फ़ाइलें, वॉइस इनपुट और एक्सप्लोरर या चयन से अटैचमेंट
- अपने सिस्टम प्रॉम्प्ट और टूल सबसेट वाले **कस्टम एजेंट**
- **प्लान मोड**, जो कार्य से पहले योजना बनाता है और पुष्टि माँगता है

## इंस्टॉल करें

> **Platform support (authoritative, English):** this fork builds and distributes Linux x86-64
> only, as an RPM and a DEB. macOS, Windows/WSL and Nix build and distribution support was
> removed, and no other architecture is produced. See the
> [English README](../../README.md#platform-support).

Install the RPM (`sudo dnf install ./codr-*.x86_64.rpm`) or the DEB (`sudo apt
install ./codr_*_amd64.deb`) from the
[Releases](https://github.com/kevsmir02/terax-ai/releases/latest) page with your package manager.
Fedora 45 KDE Plasma on Wayland is the validated target (#44); Debian 13 graphical WebKitGTK
validation was waived for personal-tool scope and `packaging/arch/PKGBUILD` is authored and signed
but **not built** (`makepkg` has not been run). The application never downloads, installs or
restarts itself.

On Wayland with rendering glitches, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

## AI कॉन्फ़िगर करें

1. **सेटिंग्स -> AI** खोलें।
2. प्रदाता चुनें और API कुंजी पेस्ट करें। स्थानीय इन्फ़रेंस के लिए Terax को LM Studio / MLX / Ollama endpoint पर निर्देशित करें।
3. कुंजियाँ `keyring` के माध्यम से OS कीचेन में लिखी जाती हैं। वे कभी भी डिस्क या localStorage में नहीं लिखी जातीं।

## सोर्स से बिल्ड करें

**आवश्यकताएँ**

- Rust (stable), https://rustup.rs
- Node 22+ और [pnpm](https://pnpm.io)
- आपके प्लेटफ़ॉर्म के लिए Tauri आवश्यकताएँ, https://tauri.app/start/prerequisites/

**चलाएँ**

```bash
pnpm install
pnpm tauri dev          # डेवलपमेंट
pnpm tauri build        # प्रोडक्शन बंडल
```

**जाँच**

```bash
pnpm lint
pnpm check-types
pnpm test
cd src-tauri && cargo clippy --all-targets --locked -- -D warnings   # CI के समान Rust lint
cd src-tauri && cargo nextest run --locked                           # या cargo test --locked
```

## टेक स्टैक

Tauri 2, Rust, `portable-pty`, React 19, TypeScript, Vite, xterm.js, CodeMirror 6, Vercel AI SDK v6, Tailwind v4, shadcn/ui और Zustand।

## योगदान

Issues और PR का स्वागत है। समस्याएँ रिपोर्ट करें, सुविधाएँ सुझाएँ या pull request भेजें। अधिक जानकारी के लिए [CONTRIBUTING.md](../../CONTRIBUTING.md) और [आर्किटेक्चर दस्तावेज़](../README.md) देखें।

## लाइसेंस

Terax Apache-2.0 लाइसेंस के अंतर्गत है। निर्भरताओं की जानकारी के लिए [Apache License 2.0](../../LICENSE) देखें।
