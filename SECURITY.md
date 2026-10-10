# Security policy

## Supported versions

Only the latest version of the Colitu VPN extension receives security fixes.
The stores update the extension automatically; the current version is listed
under [Releases](../../releases).

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Send the details to **security@colitu.com**. The full disclosure policy is at
<https://colitu.com/security#disclosure>. Please include:

- the affected version and browser,
- steps to reproduce or a proof of concept,
- the impact you expect (what an attacker could do).

What to expect:

- an acknowledgement within 3 working days,
- an assessment and a planned fix date within 10 working days,
- credit in the release notes if you want it.

Please keep the details private until a fixed version is released. We will
not take legal action against research done in good faith that respects user
privacy, does not degrade the service and stays within the scope below.

## Scope

In scope: this repository's code and the store packages built from it
(`colitu-chrome-<version>.zip`, `colitu-firefox-<version>.zip`), the proxy
ticket and its use, routing decisions (traffic that should go through the
proxy but does not, or the reverse), WebRTC protection and the extension's
communication with the Colitu API.

Out of scope: denial of service, social engineering, physical attacks and
problems in the browsers themselves (report those to the browser vendor).

Also out of scope: access to the extension's local storage. Like every
browser extension, Colitu keeps its access and refresh tokens, the proxy
ticket, the e-mail address and the last exit IP in the browser's
`storage.local`, as plain text inside the browser profile. An attacker who can
already read the profile folder or run code as the signed-in operating system
user (malware, an unlocked device) is outside the extension's threat model;
the browsers offer no safer storage for extensions. Signing out, or removing
the device in your account, revokes the tokens. The two-step verification
challenge is the exception: it is held in `storage.session` (memory only) and
never written to disk.

The machine-readable contact is at
<https://colitu.com/.well-known/security.txt>. The Colitu Security Whitepaper
(architecture, threat model, logging, known limitations) is at
<https://colitu.com/security>.

## Verifying a release

Every release is tagged (`vX.Y.Z`) and the release page lists the store zips
and their SHA-256 checksums (`SHA256SUMS`). The build is reproducible:

```
git checkout vX.Y.Z
npm run build
sha256sum -c dist/SHA256SUMS
```

---

## Сообщить об уязвимости

Пожалуйста, не открывайте публичный issue. Напишите на **security@colitu.com**,
приложив версию, браузер, шаги воспроизведения и ожидаемое влияние. Правила
раскрытия: <https://colitu.com/ru/security#disclosure>. Мы ответим в течение
3 рабочих дней и просим не раскрывать детали до выхода исправленной версии.
