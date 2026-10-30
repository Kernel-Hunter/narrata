# Contributing to Narrata

Thanks for taking the time. Bug reports, fixes and small improvements are all welcome.

## Before you start

- For a bug, open an issue with the steps to reproduce it, your browser and version, and the operating system. The "About and storage" dialog in the app shows which voice engine runs and on what (graphics chip or processor), which helps.
- For a new feature, open an issue first so we can agree on the approach before you write code.
- Narrata runs entirely in the browser. Changes that send documents, text or usage data anywhere will not be accepted.

## Setup

You need Node.js 22 or newer and pnpm.

```sh
pnpm install
pnpm dev              # web app on http://localhost:5330
pnpm build:ext        # browser extension in dist-ext/ (load it with "Load unpacked")
```

## Before you open a pull request

Run the same checks as CI:

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm build:ext
pnpm audit:licenses
```

`pnpm audit:licenses` fails if a dependency is GPL, LGPL or AGPL. Narrata is MIT, and the bundled app has to stay compatible with that, so please do not add such dependencies.

## Guidelines

- Keep pull requests small and focused on one change.
- Add or update tests in `tests/` for logic changes. Pure functions (text handling, chunking, timing, device decisions) are easy to test with Vitest.
- If you change how the voice is generated or played, say how you checked it: which browser, which voice, graphics chip or processor.
- Third-party code or data needs a compatible licence and an entry in `NOTICE`.

## Licence

By contributing, you agree that your contribution is licensed under the MIT License, like the rest of the project.
