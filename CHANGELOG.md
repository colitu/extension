# Changelog

All notable changes to the Colitu VPN browser extension. Release notes in
Russian, English and Turkish are also at
<https://docs.colitu.com/changelog/browser>.

## 1.0.0 — 2026-10-05

First release, for Chrome (and Chromium browsers: Edge, Brave, Opera, Yandex
Browser) and Firefox 128+.

- Sign in with colitu.com (device code) or with e-mail and password; e-mail
  verification in the extension when needed. The extension is one device on
  your account; signing out removes it.
- One-click connection through an HTTPS proxy (TLS, HTTP/2) on Colitu servers
  in 11 countries; short-lived signed tickets as proxy credentials.
- Fastest server picked by measured ping and load, with automatic failover to
  the next server; manual choice from the list with live pings.
- No direct fallback for websites: if the server cannot be reached, traffic
  does not leave around it.
- WebRTC leak protection while connected.
- Site lists: sites that never use Colitu, or only selected sites through
  Colitu. Local network addresses always go direct.
- Russian sites (.ru, .su, .рф) directly, as in the apps, except on Russian
  servers.
- Reconnect when the browser starts; country code on the toolbar icon.
- Plan and traffic usage in the popup; Russian, English and Turkish UI.
- Reproducible store packages with SHA-256 checksums.
