# Changelog

All notable changes to the Colitu VPN browser extension. Release notes in
Russian, English and Turkish are also at
<https://docs.colitu.com/changelog/browser>.

## 1.3.0

- New setting "Block traffic if the connection drops" (kill switch, off by
  default). When Colitu stops without your action (plan ended, signed out,
  device limit), browser traffic is blocked instead of going out with your
  real IP address, until Colitu is connected again or you allow traffic.
- A token refresh running at the same time as another request no longer signs
  you out (the refresh token was sent twice).
- A split-tunneling list that is too long is refused with a message instead of
  being cut silently.
- Firefox: an internal error while routing a request now blocks the request
  instead of letting it connect directly.
- The server list from the API is checked (host name, port); API answers are
  read with a 1 MB limit while streaming; the device-link poll interval has
  an upper limit; setting values are type-checked.

## 1.2.0

- In-app messages in the popup for quota warnings and announcements.

## 1.1.2

- Signing in from an unusual location can ask for a 6-digit code sent to
  your e-mail; the popup shows a code step for it.
- Clearer messages when a sign-up is refused: temporary e-mail addresses,
  passwords found in known data breaches, too many sign-ups from one network.

## 1.1.1

- Protection no longer goes off silently: when the plan ends, the session
  expires or the device limit pauses this browser while Colitu is on, the
  Colitu status page opens in a new tab (the badge alone was easy to miss).
- "Russian sites directly" (.ru, .su, .рф without the VPN) is now off by
  default for new installations, so those sites do not see the real IP
  address unless the user turns it on.
- Links handed out by the API (device linking) open only when they are https
  addresses on colitu.com.

## 1.1.0 — unreleased

- Two-step verification at sign-in: accounts with 2FA (set up on colitu.com)
  are asked for the 6-digit code from the authenticator app after the
  password, or for a recovery code. The sign-in challenge is kept only in the
  browser's session memory, never on disk.
- Plan ending soon: when a trial or plan ends within 3 days, the popup says
  when, which plan comes next (traffic and device limit, when the API sends
  them) and, if the account has more devices than the next plan allows, that
  only the most recently used device stays active.
- Split tunneling (replaces the two site lists of 1.0.0, which are carried
  over): Off, “Selected sites bypass the proxy” or “Only selected sites use
  the proxy”, with one validated list of domains (subdomains included), IPv4
  and IPv6 addresses and CIDR ranges. Applied through the existing PAC script
  (Chrome) and `proxy.onRequest` (Firefox); the popup shows “Split tunneling
  on: N sites”. In “only” mode a listed `.ru` site now uses the proxy even
  with *Russian sites directly* on.
- Paused by the device limit: when the plan's device limit pauses this
  browser (`DEVICE_OVER_LIMIT`), the proxy is turned off and the popup shows
  the active device, with "Use this browser instead" (moves the active slot
  here and reconnects) and "Get Premium".

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
