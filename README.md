# Narrata

Narrata reads text aloud with a natural voice that runs on your device. Open a PDF, an EPUB, a saved web page, a Markdown or text file, or paste some text, press play, and follow along as each word is highlighted.

It is a web app. After a one-time download of the voice model it works offline, and nothing you read leaves your computer.

## Why

- **Free.** No subscription, no word limits, no trial.
- **Private.** Documents and the voice stay in your browser. There is no account, no server and no analytics.
- **Unlimited.** Read whole books. The only limit is your device.
- **Offline.** Once loaded, Narrata works without a network connection and can be installed as an app.

## Using it

1. Open the app and download the voice (326 MB on computers with WebGPU, 178 MB otherwise; you can also pick the smaller one). This happens once.
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
- Pick one of 28 English voices (American and British) and preview them. On slower computers, three lighter voices read several times faster than real time (see [Slower computers](#slower-computers)).
- Read PDFs on the original page, with the highlight on the rendered text, or switch to a reflowed text view.
- Jump between EPUB chapters.
- Change the theme, font (including OpenDyslexic), text size and line spacing.
- Pick up where you left off: the library remembers your place in every document.
- Export a document as an audio file (.m4a, or .wav where AAC encoding is not available).
- Use the media keys or lock screen controls.

## How it works

- **Voice.** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), an open text-to-speech model (Apache-2.0), in the [ONNX export with timestamps](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped). It runs through [ONNX Runtime Web](https://onnxruntime.ai/) in a Web Worker, on the GPU with WebGPU when it produces correct audio, and on the CPU with multi-threaded WebAssembly otherwise. The CPU path uses an 8-bit version of the model (uint8, statically quantized), which runs about twice as fast there as the dynamically quantized one. Every generated chunk is checked (NaN samples, clipping, audio that stops early) and the app switches to the CPU if the GPU output is wrong.
- **Storage.** The model is saved in the browser's Origin Private File System, so the second visit loads it from disk in about a second. The app itself is cached by a service worker.
- **Pronunciation.** Kokoro reads phonemes, not letters. Narrata converts English text with a TypeScript port of [misaki](https://github.com/hexgrad/misaki), the converter Kokoro was trained with: misaki's American and British dictionaries, its rules for capitals, possessives and -s, -ed and -ing endings, and its number reading. A small part-of-speech tagger picks between words spelled alike ("I read" and "I will read"), and misaki's tiny neural network guesses words that are not in the dictionaries. Narrata also reads clock times, common abbreviations, units and web addresses. The dictionaries and models (6 MB in all) are bundled and loaded on first use.
- **Word highlighting.** The model predicts how long each phoneme lasts (25 ms units). The converter knows which word of the text each phoneme came from, so the highlight follows the voice word by word.
- **Fast start.** Playback begins with a short first phrase (3 to 8 words), then continues sentence by sentence, generating ahead of the voice. The player measures how fast this device generates speech and adapts: on a fast device it starts at once; on a slow one it shortens the next chunks to build a lead, or waits a few seconds ("Preparing audio") so that playback does not keep stopping.
- **Speed without chipmunks.** Audio is generated at normal speed and played through [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/), a time-stretcher that keeps the pitch. All chunks go into one continuous buffer, so there are no gaps between sentences.
- **Documents.** [pdf.js](https://mozilla.github.io/pdf.js/) for PDFs, [Readability](https://github.com/mozilla/readability) for web pages, and a small EPUB reader built on [fflate](https://github.com/101arrowz/fflate).

## Privacy

Narrata downloads the voice model and the voices from Hugging Face the first time you use them (the faster voices only if you choose one). After that it makes no network requests of its own. Your documents, reading positions and settings are stored in your browser (IndexedDB and local storage) and never uploaded. Removing the site data in your browser deletes everything.

## Browser support

| Browser | Status |
| --- | --- |
| Chrome, Edge 113+ (desktop) | Works. Uses the GPU through WebGPU. |
| Chrome, Edge without WebGPU | Works on the CPU. See [Slower computers](#slower-computers). |
| Chrome on Android | Should work on recent phones; older phones are best with a faster voice. |
| Safari 26+, Firefox 141+ | WebGPU is new there and not yet tested with this model. If the GPU output fails the check, the CPU path is used. |
| Older browsers | The CPU path needs WebAssembly with SIMD; multi-threading needs cross-origin isolation, which the service worker provides. |

### Slower computers

Generation speed depends on your hardware. On an Apple M5 laptop the GPU path generates about 7 seconds of speech per second and the CPU path about 2 seconds per second with 4 threads.

Measured with `scripts/bench/cpu-bench.mjs` on the same laptop, with the browser slowed down by the operating system to emulate slower computers. Reading the three-paragraph sample (about a minute of speech) at 1x with the CPU path, 4 threads:

| Emulated computer | Natural voice speed | Wait before audio | Pauses | Faster voice speed |
| --- | --- | --- | --- | --- |
| This laptop | 2.1x real time | 3.5 s | none | 29x real time |
| 2 times slower | 1.0x | 7.6 s | none | 14x |
| 5 times slower | 0.44x | 10 s | 5 (76 s in all) | 5.1x |
| 6 times slower | 0.34x | 10 s | 7 (111 s in all) | 3.7x |
| 17 times slower | 0.12x | 15 s | 7 (401 s in all) | 1.2x |

Below about 1x real time the natural voice cannot keep up with playback, no matter how much audio is buffered. That is when the faster voice helps. The emulation slows every core equally, so a real computer with more, slower cores may do better than the table suggests.

What happens on a slow device:

- If generation is a little faster than playback, the first chunks are kept short to build a lead.
- If it is slower than playback, the player waits until it has enough audio to play to the end of the next minute without stopping, up to 10 seconds, and shows "Preparing audio" with an estimate. Chunks are joined into longer ones, which generate faster.
- After about 15 seconds of audio, if the natural voice cannot keep up, Narrata offers once to switch to a faster voice. You can also pick one yourself under **Faster voices** in the voice menu.
- The faster voices are three [Piper](https://github.com/rhasspy/piper) voices (Kristin and John, American; Cori, British; 64 MB each). They sound less natural than Kokoro but generate speech many times faster than real time on the same hardware. Word highlighting, speed control and export work the same. They are downloaded only if you choose one.
- Chrome slows down hidden tabs. While audio is playing this does not apply; when playback is waiting for audio in a hidden tab (or exporting), the player plays a tone far below hearing (20 Hz at -60 dB) so that generation keeps running at full speed.

## Browser extension

The extension reads web pages aloud where they are, with the word being spoken highlighted on the page. It uses the same voice engine as the web app, running locally in the browser.

It is not in the Chrome Web Store yet. To try it:

1. `pnpm install && pnpm build:ext`
2. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the `dist-ext` folder.
3. On an article, press Alt+Shift+R or click the Narrata button and choose **Read this page**. The first time, the player offers to download the voice (326 MB with a graphics chip, or a 178 MB version that runs on the processor) and shows the size before anything is downloaded.

What it does:

- **Read this page** finds the article (with Readability, on a copy of the page) and reads it, highlighting each word and tinting the sentence on the original page. The page itself is not modified: the highlight is painted with the CSS Custom Highlight API.
- **Read selection** (Alt+Shift+S, or right-click) reads only the selected text.
- **Start reading from here** (right-click on a paragraph) starts at that point.
- Click any word on the page while reading to jump there.
- The page scrolls gently to follow the voice. Scroll yourself and it stops following; **Back to current** returns to the word being read.
- The floating player has play and pause, previous and next sentence, speed from 0.5x to 3x, the voice list and a close button. With the player focused, Space plays or pauses and the arrow keys move by sentence. Alt+Shift+P plays or pauses from anywhere. Shortcuts can be changed at `chrome://extensions/shortcuts`.
- When a page has no clear article, it reads the selection or the largest block of text. On single-page apps, choose **Read this page** again after the content changes. Only the top frame is highlighted; text selected inside a frame is read without highlighting.
- Chrome does not let extensions read its own pages (`chrome://`), the Web Store, or PDFs in its built-in viewer. The popup says so; for PDFs and EPUBs, use the web app.

![Reading an article with the extension](docs/screenshots/ext-reading.png)

### Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the page you are on, only after you click the button, use a shortcut or the right-click menu. Narrata has no access to any site until then. |
| `scripting` | Add the player and the highlight to that page. |
| `offscreen` | Run the voice model and play audio in a hidden extension page, so reading continues while you use the page. |
| `storage` | Remember your speed, voice and model choice. |
| `contextMenus` | The right-click entries. |

There are no host permissions. The model download from Hugging Face works without them because Hugging Face allows cross-origin requests.

### Privacy

The extension makes one kind of network request: downloading the voice model and voices from Hugging Face, once. The extension's Content Security Policy only allows connections to Hugging Face, so it cannot send anything elsewhere. The text of the pages you read never leaves your browser, and there is no account, analytics or server. The model is stored in the extension's own storage; removing the extension deletes it.

### How it is built

- **Service worker**: context menus, shortcuts, injecting the content script on demand and passing messages between the page and the engine. It keeps no state, so Chrome can stop it at any time.
- **Offscreen document**: hosts the TTS worker and the audio player from the web app (`src/engine`, `src/audio`). The manifest sets cross-origin isolation for extension pages, so the WebAssembly fallback runs with several threads.
- **Content script** (`extension/src/content`): extracts the text, aligns it with the page's own text nodes (`textmap.ts`) and draws the player in a shadow root so page styles cannot affect it.

## License

Narrata is free software under the [MIT License](LICENSE).

It includes work under other permissive licences, listed in [NOTICE](NOTICE): the misaki port, dictionaries and fallback network (Apache-2.0) and spaCy's tokenizer rules (MIT). The faster voices are MIT-licensed Piper models trained on public-domain recordings; Narrata feeds them its own phonemes, so eSpeak NG (GPL) is not used. `pnpm audit:licenses` builds the app and the extension and lists the licence of every package they contain; it fails if any of them is GPL, LGPL or AGPL.

## Development

Requires Node.js 20+ and pnpm.

```sh
pnpm install
pnpm dev              # http://localhost:5330
pnpm test             # unit tests (Vitest)
pnpm typecheck        # tsc --noEmit
pnpm build            # production build in dist/
pnpm preview          # serve dist/ on http://localhost:5331
pnpm build:ext        # browser extension in dist-ext/
pnpm build:ext:test   # extension with the hooks for automated checks, in dist-ext-test/
pnpm audit:licenses   # licences of everything the builds contain
```

`node tests/e2e/verify-ext.mjs` loads `dist-ext-test/` (build it with `pnpm build:ext:test`) into Playwright's Chromium (`pnpm exec playwright install chromium` once), serves the pages in `tests/pages/` and checks reading, highlighting, speed, controls, selections, frames and restricted pages. The first run downloads the voice model into `.e2e-profile/`.

`node scripts/bench/cpu-bench.mjs` measures the CPU path on a production build: real-time factor, time to first audio and how long playback would pause, at several emulated CPU speeds (`--levels`, see the comment at the top of the script) and for several configurations (`--configs`). Chrome's CPU throttling does not slow down Web Workers, so the script slows the browser's processes with the operating system instead (macOS). `node scripts/bench/background-check.mjs` compares generation speed in a visible and a hidden tab.

The G2P data in `src/engine/g2p/data/` is generated by the scripts in `scripts/g2p/` (from misaki's dictionaries, the fallback network weights and a tagger trained on Project Gutenberg books tagged by spaCy); each script explains its inputs at the top. `tests/g2p-accuracy.test.ts` compares the G2P with misaki's own output on 1,385 words and sentences in `tests/g2p-eval/`.

`pnpm dev` and `pnpm build` copy the ONNX Runtime and pdf.js runtime files into `public/` so the app never loads code from a CDN. `node scripts/make-fixtures.mjs` regenerates the sample PDF and EPUB in `tests/fixtures/`.

The dev server sends the cross-origin isolation headers itself. The production build does not need them from the host: the service worker adds them, which is how it runs multi-threaded on static hosting such as GitHub Pages.

Project layout:

```
src/core/      text model, sentence splitting and chunking, word alignment, timeline math
src/docs/      readers for text, Markdown, HTML, EPUB and PDF
src/engine/    TTS worker, model storage (OPFS), text to phonemes (g2p/), voices, audio export
src/audio/     playback engine and audio cache
src/ui/        reading views, player bar, menus and dialogs
src/store/     library (IndexedDB) and settings
src/pwa/       service worker and registration
extension/     browser extension: manifest, service worker, offscreen document, content script, popup
tests/         unit tests and fixtures
```

## Credits

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) and [misaki](https://github.com/hexgrad/misaki) by hexgrad
- misaki's fallback networks by [Peter Reid](https://huggingface.co/PeterReid/graphemes_to_phonemes_en_us)
- [spaCy](https://spacy.io/) by Explosion, whose English tokenizer rules and tags Narrata's G2P reproduces
- [Project Gutenberg](https://www.gutenberg.org/), whose public-domain books trained the part-of-speech tagger
- [ONNX Runtime Web](https://onnxruntime.ai/) by Microsoft
- [Piper](https://github.com/rhasspy/piper) by Michael Hansen, and the Kristin, John and Cori voices by Bryce Beattie, trained on public-domain [LibriVox](https://librivox.org/) recordings
- [pdf.js](https://github.com/mozilla/pdf.js) and [Readability](https://github.com/mozilla/readability) by Mozilla
- [fflate](https://github.com/101arrowz/fflate) for reading EPUB files
- [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) by Geraint Luff
- [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) by Vanilagy
- [OpenDyslexic](https://opendyslexic.org/) by Abbie Gonzalez (SIL Open Font License)
