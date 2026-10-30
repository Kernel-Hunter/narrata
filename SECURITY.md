# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private reporting instead: on the repository page, go to **Security**, then **Report a vulnerability**.

Include what you found, how to reproduce it, and what an attacker could do with it. You should get a first answer within a week.

## Scope

Narrata is a static web app and a browser extension. It has no server and no accounts. Things worth reporting include:

- A way for a web page to read text, settings or files from Narrata, or to drive the extension without the user asking.
- Anything that makes the app or the extension send document text or other data off the device.
- Script injection through opened files (PDF, EPUB, HTML, Markdown) or through pages the extension reads.
- Problems with how model files are downloaded and stored (for example loading a file that was not the expected one).

## Supported versions

Only the latest version on the `main` branch and the latest published build are supported.
