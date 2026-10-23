# Narrata

Narrata reads text aloud with a natural voice that runs on your device. Open a PDF, an EPUB, a saved web page, a Markdown or text file, or paste some text, press play, and follow along as each word is highlighted.

It is a web app. After a one-time download of the voice model it works offline, and nothing you read leaves your computer.

## Why

- **Free.** No subscription, no word limits, no trial.
- **Private.** Documents and the voice stay in your browser. There is no account, no server and no analytics.
- **Unlimited.** Read whole books. The only limit is your device.
- **Offline.** Once loaded, Narrata works without a network connection and can be installed as an app.

## Using it

1. Open the app and download the voice (326 MB on computers with WebGPU, 93 MB otherwise; you can also pick the smaller one). This happens once.
2. Open a file with the + button, drop it anywhere on the page, or paste text with Ctrl+V (Cmd+V on a Mac).
3. Press play. Click any word to start reading from there.

| Key | Action |
| --- | --- |
| Space | Play or pause |
| Left / Right arrow | Previous or next sentence |
| `[` / `]` | Slower or faster |
| Ctrl+O | Open a file |
| `?` | Show shortcuts |

Other things you can do:

- Change the speed from 0.5x to 3x. The pitch stays natural.
- Pick one of 28 English voices (American and British) and preview them.
- Read PDFs on the original page, with the highlight on the rendered text, or switch to a reflowed text view.
- Jump between EPUB chapters.
- Change the theme, font (including OpenDyslexic), text size and line spacing.
- Pick up where you left off: the library remembers your place in every document.
- Export a document as an audio file (.m4a, or .wav where AAC encoding is not available).
- Use the media keys or lock screen controls.

## How it works

- **Voice.** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), an open text-to-speech model (Apache-2.0), in the [ONNX export with timestamps](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped). It runs through [transformers.js](https://github.com/huggingface/transformers.js) and ONNX Runtime Web in a Web Worker, on the GPU with WebGPU when it produces correct audio, and on the CPU with multi-threaded WebAssembly otherwise. Every generated chunk is checked (NaN samples, clipping, audio that stops early) and the app switches to the CPU if the GPU output is wrong.
- **Storage.** The model is saved in the browser's Origin Private File System, so the second visit loads it from disk in about a second. The app itself is cached by a service worker.
- **Word highlighting.** The model predicts how long each phoneme lasts (25 ms units). Narrata groups phonemes into words and aligns them with the words on the page, so the highlight follows the voice.
- **Fast start.** Playback begins with a short first phrase (3 to 8 words), then continues sentence by sentence, generating a few sentences ahead.
- **Speed without chipmunks.** Audio is generated at normal speed and played through [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/), a time-stretcher that keeps the pitch. All chunks go into one continuous buffer, so there are no gaps between sentences.
- **Documents.** [pdf.js](https://mozilla.github.io/pdf.js/) for PDFs, [Readability](https://github.com/mozilla/readability) for web pages, and a small EPUB reader built on [fflate](https://github.com/101arrowz/fflate).

## Privacy

Narrata downloads the voice model and the voices from Hugging Face the first time you use them. After that it makes no network requests of its own. Your documents, reading positions and settings are stored in your browser (IndexedDB and local storage) and never uploaded. Removing the site data in your browser deletes everything.

## Browser support

| Browser | Status |
| --- | --- |
| Chrome, Edge 113+ (desktop) | Works. Uses the GPU through WebGPU. |
| Chrome on Android | Should work on recent phones; the CPU path is slow on older devices. |
| Safari 26+, Firefox 141+ | WebGPU is new there and not yet tested with this model. If the GPU output fails the check, the CPU path is used. |
| Older browsers | The CPU path needs WebAssembly with SIMD; multi-threading needs cross-origin isolation, which the service worker provides. |

Generation speed depends on your hardware. On an Apple M5 laptop the GPU path generates about 7 seconds of speech per second and the CPU path (the smaller model, 4 threads) about 1.3 seconds per second. On the CPU path playback can pause briefly at the start and at speeds above 1x while the voice catches up.

## License

Narrata is free software under the [GNU General Public License, version 3 or later](LICENSE).

Kokoro needs phonemes, not letters. Narrata converts English text to phonemes with [eSpeak NG](https://github.com/espeak-ng/espeak-ng) (GPL-3.0-or-later), compiled to WebAssembly in the `phonemizer` package, and that is why the app as a whole is GPL. The phonemizer sits behind a small interface (`src/engine/g2p/`) so a permissively licensed one can replace it.

## Development

Requires Node.js 20+ and pnpm.

```sh
pnpm install
pnpm dev          # http://localhost:5330
pnpm test         # unit tests (Vitest)
pnpm typecheck    # tsc --noEmit
pnpm build        # production build in dist/
pnpm preview      # serve dist/ on http://localhost:5331
```

`pnpm dev` and `pnpm build` copy the ONNX Runtime and pdf.js runtime files into `public/` so the app never loads code from a CDN. `node scripts/make-fixtures.mjs` regenerates the sample PDF and EPUB in `tests/fixtures/`.

The dev server sends the cross-origin isolation headers itself. The production build does not need them from the host: the service worker adds them, which is how it runs multi-threaded on static hosting such as GitHub Pages.

Project layout:

```
src/core/      text model, sentence splitting and chunking, word alignment, timeline math
src/docs/      readers for text, Markdown, HTML, EPUB and PDF
src/engine/    TTS worker, model storage (OPFS), phonemizer, voices, audio export
src/audio/     playback engine and audio cache
src/ui/        reading views, player bar, menus and dialogs
src/store/     library (IndexedDB) and settings
src/pwa/       service worker and registration
tests/         unit tests and fixtures
```

## Credits

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad, and [kokoro-js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js), whose text normalisation Narrata adapts
- [transformers.js](https://github.com/huggingface/transformers.js) and [ONNX Runtime Web](https://onnxruntime.ai/)
- [eSpeak NG](https://github.com/espeak-ng/espeak-ng) through [phonemizer](https://www.npmjs.com/package/phonemizer)
- [pdf.js](https://github.com/mozilla/pdf.js) and [Readability](https://github.com/mozilla/readability) by Mozilla
- [fflate](https://github.com/101arrowz/fflate) for reading EPUB files
- [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) by Geraint Luff
- [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) by Vanilagy
- [OpenDyslexic](https://opendyslexic.org/) by Abbie Gonzalez (SIL Open Font License)
