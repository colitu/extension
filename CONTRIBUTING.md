# Contributing to the Colitu VPN extension

Thanks for helping. Bug reports, translation fixes and focused pull requests
are welcome.

## Before you start

- **Security problems:** do not open an issue; follow [SECURITY.md](SECURITY.md).
- **Account, payment or connection problems:** these are handled by support at
  <https://colitu.com/support>, not in this repository.
- For larger changes, open an issue first so we can agree on the approach.

## Building

```
npm test
npm run build
```

Node.js 20 or newer; there are no npm dependencies, and new ones need a very
good reason (the stores review every line that ships).

## Pull requests

- Keep each pull request to one change, and describe what it fixes and how you
  tested it (which browser and version).
- Follow the style of the surrounding code; do not reformat unrelated files.
- Add or update tests for routing or decision changes (`tests/`).
- Never insert network data into the page as HTML; use `textContent`.
- Do not commit secrets, server addresses or personal configuration. Server
  hosts come from the API at run time.
- The UI speaks Russian, English and Turkish; a new string needs all three
  (`src/lib/i18n.js`, checked by the tests).
- CI must pass.

## Licence and trademarks

The code is licensed under GPL-3.0; by contributing you agree that your
contribution is published under the same licence. The Colitu name and logo
are not covered by the GPL: if you publish your own build, use your own name
and logo.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
