# Launch drafts

Drafts for announcing Narrata. Nothing here has been posted. Where a draft needs a personal reason for building it, there is a note in brackets: write that part yourself, in your own words, rather than posting a made-up motivation. Replace `<URL>` with the GitHub Pages address and `<REPO>` with the repository link once they exist. Numbers come from the README and the benchmarks in `scripts/bench/`; check them again before posting if the code changed.

## Show HN

Title (80 characters max):

> Show HN: Narrata, a read-aloud app where the voice model runs in your browser

Text:

> Narrata reads PDFs, EPUBs, web pages and pasted text aloud and highlights each word as it is spoken. The voice runs on your device: Kokoro-82M through ONNX Runtime Web, on the GPU with WebGPU or on the CPU with multi-threaded WebAssembly. There is no server, no account and no analytics. After a one-time download of the voice (178 MB, or 326 MB for the GPU version), it works offline.
>
> [One or two sentences on why you built it.]
>
> Some details that took the most work:
>
> - Kokoro reads phonemes, so I ported misaki (Kokoro's own English G2P) to TypeScript, with its dictionaries, a small part-of-speech tagger trained on Project Gutenberg text tagged by spaCy, and its fallback network for unknown words. The tests compare its output with misaki's on 1,385 words and sentences.
> - Word highlighting comes from the model's predicted phoneme durations, mapped back to the words of the original text.
> - Speed changes from 0.5x to 3x go through a time-stretcher, so the pitch stays natural.
> - Not every computer can run Kokoro faster than real time. On first run, Narrata runs a 0.2 second WebAssembly benchmark and suggests either the natural voice or a fast one (Piper, 64 MB). The Piper voices normally need eSpeak NG, which is GPL; Narrata feeds them its own phonemes instead, so the whole app stays MIT.
> - GitHub Pages cannot send the COOP/COEP headers that multi-threaded WebAssembly needs, so a service worker adds them.
>
> There is also a Chrome extension that reads the page you are on and highlights it in place. It is not in the Web Store yet; it can be loaded unpacked from the repository.
>
> Known limits: English only for now. Chrome and Edge are what I tested most; Safari and Firefox are listed in the README with what I checked. On older laptops the natural voice may pause, which is what the fast voice is for.
>
> App: <URL>
> Code: <REPO>

## X (each post 280 characters or fewer; X counts a link as 23)

Main post (242 characters with the link):

> Narrata reads PDFs, EPUBs and web pages aloud and highlights each word. The voice model runs in your browser, so nothing you read leaves your computer. Free, open source (MIT), works offline after a one-time download.
>
> <URL>

Follow-up (229 characters):

> How it works: Kokoro-82M on ONNX Runtime Web (WebGPU or WebAssembly), a TypeScript port of the misaki phonemizer, and word timings from the model's phoneme durations. On slower computers it suggests a lighter Piper voice instead.

Follow-up (181 characters with the link):

> There is also a Chrome extension that reads the page you are on and highlights the words in place. Not in the Web Store yet; load it unpacked from the repo.
>
> <REPO>

## Bluesky (300 characters max)

> Narrata reads PDFs, EPUBs and web pages aloud with word-by-word highlighting. The voice model runs in your browser: no server, no account, nothing uploaded. Works offline after a one-time download. MIT licensed.
>
> <URL>

Follow-up:

> The natural voice is Kokoro-82M. Not every laptop can run it in real time, so on first run Narrata does a short speed test and suggests a lighter Piper voice (64 MB) when it would pause. You can switch any time.

## Reddit

What I checked: I tried to read the rules of r/dyslexia, r/ADHD and r/students from this machine on 30 October 2026, through reddit.com's rules page and its JSON endpoint. Reddit blocked both (HTTP 403), so I could not confirm the current rules. The drafts below follow the norms that most support and study subreddits share and Reddit's own self-promotion guidance: say plainly that you made it, post it as a question or a contribution rather than an ad, no affiliate or tracking links, nothing paid, and answer comments. Before posting, read each subreddit's sidebar and pinned posts. If self-promotion is limited to a weekly thread or needs moderator approval, use that thread or message the moderators first with the draft.

### r/dyslexia

Title:

> I made a free text-to-speech reader that highlights each word as it reads. Looking for feedback from people who use TTS daily

Text:

> I'm the developer, so take this as a disclosure: I made this and I'm not selling anything. It's free and open source, with no account and no ads.
>
> Narrata reads PDFs, EPUBs, web pages and pasted text aloud and highlights the word being spoken. You can change the speed (the pitch stays natural), switch to the OpenDyslexic font, make the text bigger and change the line spacing. The voice runs on your own computer, so your documents are not uploaded anywhere.
>
> What I would like to know from people who rely on text-to-speech:
>
> - Is the highlighting easy to follow, or would you rather see the whole sentence highlighted?
> - Does it read your kind of documents well (school PDFs, scanned pages, ebooks)?
> - What is missing compared to what you use now?
>
> It works best in Chrome or Edge on a computer. The first time, it downloads a voice (64 or 178 MB) and then works offline.
>
> <URL>

### r/ADHD

Check first: r/ADHD has historically been strict about self-promotion. If the sidebar does not allow it, ask the moderators or skip this one.

Title:

> Free tool I built: reads articles and PDFs aloud while highlighting each word. Feedback welcome

Text:

> Disclosure: I made this. It is free and open source, with no account, no ads and no tracking.
>
> [One sentence on why you built it, if it is true for you.] Narrata reads PDFs, EPUBs, web pages and pasted text, highlights the current word, and lets you speed it up to 3x without the chipmunk voice. It remembers where you stopped in each document.
>
> The voice runs on your computer, so nothing you read is uploaded. It works best in Chrome or Edge on a laptop or desktop.
>
> If you try it, I would like to hear what gets in the way: too many settings, the voice, the speed, anything.
>
> <URL>

### r/students

Title:

> Made a free app that reads your PDFs and readings aloud with word highlighting (runs offline, no account)

Text:

> I made this, so to be clear up front: it's my project. It's free and open source. No sign-up, no ads, no limits on how much you can listen to.
>
> Narrata reads PDFs, EPUBs, web pages and pasted text aloud and highlights each word. You can listen at up to 3x, click any word to jump there, and export a chapter as an audio file to listen to on the bus. The voice runs in your browser, so your readings are not uploaded anywhere, and it works offline after the first download.
>
> There is also a Chrome extension for reading articles in place.
>
> Feedback on what breaks with your course PDFs is the most useful thing for me right now.
>
> <URL>

## Product Hunt

Name: Narrata

Tagline (60 characters max, this one is 58):

> Read-aloud with word highlighting that runs on your device

Description (260 characters max):

> Narrata reads PDFs, EPUBs, web pages and text aloud and highlights each word. The voice model runs in your browser, so nothing is uploaded and it works offline. Speed up to 3x with natural pitch, OpenDyslexic font, audio export. Free and open source.

Topics: Productivity, Education, Open Source, Accessibility.

First comment (from the maker):

> [Why you made it, in a sentence.] Narrata runs Kokoro, an open voice model, directly in the browser. On older computers a short speed test suggests a lighter voice instead, so it works on most machines. It is MIT licensed and the code is on GitHub. I would like to hear which documents it reads badly.

## Chrome Web Store listing

Name: Narrata: read web pages aloud

Short description (132 characters max, this one is 126):

> Reads web pages aloud with a voice that runs on your computer and highlights each word. No account, nothing uploaded, offline.

Category: Accessibility (alternative: Productivity).

Language: English.

Long description:

> Narrata reads the article on the page you are on aloud and highlights each word as it is spoken, on the page itself.
>
> How to use it
> - Click the Narrata button and choose Read this page, or press Alt+Shift+R.
> - Select text and press Alt+Shift+S, or right-click and choose Read selection.
> - Right-click a paragraph and choose Start reading from here.
> - Click any word while it reads to jump there. Alt+Shift+P plays or pauses.
>
> The player has speed from 0.5x to 3x (the pitch stays natural), previous and next sentence, and a choice of voices. The page scrolls to follow the voice; scroll yourself and it stops following until you press Back to current.
>
> Privacy
> The voice model runs inside the extension, on your computer. The text of the pages you read never leaves your browser. There is no account, no analytics and no server. The only network requests are the one-time voice download from Hugging Face. The extension's content security policy only allows connections to Hugging Face.
>
> Voices
> On first use, Narrata checks how fast your computer is and suggests one of two voices: the natural voice (Kokoro-82M, 178 MB, or 326 MB to run on the graphics chip) or the fast voice (Piper, 64 MB), which works on older computers. You can change voices at any time.
>
> Limits
> English only. Chrome does not let extensions read its own pages, the Web Store, or PDFs in its built-in viewer; for PDFs and ebooks, use the Narrata web app.
>
> Narrata is free and open source under the MIT License: <REPO>

### Privacy practices tab

Answers based on the code in `extension/` as of this branch.

Single purpose:

> Reads the text of the current web page or selection aloud with a speech model that runs locally, and highlights the words being spoken.

Permission justifications:

| Permission | Justification |
| --- | --- |
| `activeTab` | Read the text of the current tab only after the user clicks the toolbar button, uses a keyboard shortcut or the context menu. |
| `scripting` | Inject the content script that extracts the article text, shows the player and draws the word highlight on that tab. |
| `offscreen` | Run the speech model in a worker and play the audio in an offscreen document, so reading continues while the user uses the page. |
| `storage` | Remember the user's reading speed, voice and model choice (`chrome.storage.local`), and the last error per tab (`chrome.storage.session`). |
| `contextMenus` | Add the Read selection, Read this page and Start reading from here menu entries. |
| Host permissions | None requested. |

Remote code:

> No, I am not using remote code. All JavaScript and WebAssembly (including ONNX Runtime Web) is packaged with the extension. The extension downloads model weights (ONNX files and voice data from huggingface.co) on first use; these are data files read by the packaged runtime, not code.

Data usage (what to tick): none of the categories. The extension does not collect or transmit personally identifiable information, health, financial, authentication, personal communications, location, web history, user activity or website content. Page text is processed in the browser and is not sent anywhere.

Certifications (all three apply):

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Privacy policy URL: the store requires one even when no data is collected. Point it at the Privacy section of the README (`<REPO>#privacy`) or publish a short page that says the same.
