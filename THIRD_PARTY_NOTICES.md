# Third-party notices

JARVIS source code is provided under the [MIT License](./LICENSE). Third-party software, model weights, services, content, names, and trademarks remain subject to their respective licenses and terms.

## Local AI components

The following components are installed or downloaded by the user and are not committed to this repository:

| Component | Use in JARVIS | Upstream license or terms |
| --- | --- | --- |
| Ollama | local model runtime | [MIT License](https://github.com/ollama/ollama/blob/main/LICENSE) for the open-source repository |
| Qwen 3.5 4B for Ollama | local answer generation | the installed `qwen3.5:4b` model reports the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0); verify with `ollama show qwen3.5:4b --license` |
| whisper.cpp | local speech-to-text runtime | [MIT License](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE) |
| Whisper large-v3-turbo Q5 model | local speech recognition weights | distributed by the [whisper.cpp model repository](https://huggingface.co/ggerganov/whisper.cpp); review its model card and upstream terms before redistribution |
| FFmpeg | local audio conversion used by the speech runtime | [FFmpeg legal and license information](https://ffmpeg.org/legal.html) |
| Geist Sans and Geist Mono | bundled interface fonts | [SIL Open Font License 1.1](https://github.com/vercel/geist-font/blob/main/LICENSE.txt) |

## JavaScript dependencies

The application also uses open-source npm packages. Their exact resolved versions and declared licenses are recorded in `package-lock.json` and the corresponding packages under `node_modules` after installation. Major direct dependencies include Next.js, React, TypeScript, vinext, Vite, and the Cloudflare development toolchain.

## Desktop toolchain

The macOS application uses [Tauri](https://github.com/tauri-apps/tauri) and official Tauri plugins, which are offered under Apache-2.0 and MIT terms. Rust dependency versions and license metadata are recorded in `src-tauri/Cargo.lock`. The build-only Node sidecar packager is provided by [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg); the resulting sidecar contains a Node.js runtime and remains subject to the applicable Node.js and bundled dependency licenses.

## External data and services

Notion, Open-Meteo, OpenAI News, GitHub Changelog, Techpresso, Hacker News, Hugging Face, and Ollama are independent services or projects. Their APIs, feeds, content, marks, privacy practices, and availability are governed by their own policies. Inclusion here does not imply endorsement or affiliation.

This notice is a practical overview, not an exhaustive replacement for license files shipped with installed packages or model distributions. Before redistributing a bundled application, runtime, model, or fetched content, review and satisfy the applicable upstream terms.
