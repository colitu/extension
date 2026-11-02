# Changelog

All notable changes to the Colitu VPN browser extension. Release notes in
Russian, English and Turkish are also at
<https://docs.colitu.com/changelog/browser>.

## 1.5.0

- **Adaptive Connect 4, smarter automatic choice:** the automatic server is picked with a small decision model that runs in the extension. The history of your own network stays in the browser and is never sent; anonymous results from other devices in your city are updated every hour. Without the model the extension keeps the earlier rules.
- **An honest server list:** servers that fail twice in a row from your network are hidden (never the connected or selected one, and nothing is hidden when most servers fail). Pings are shown while connected too.
- **Recommended servers** come first in their country, with a badge.
- **Whitelist detection:** if your operator only lets approved sites through, the extension notices and switches to a server that works.
- A server you choose yourself is never changed.
- The server list is refreshed every 30 minutes, so servers that were removed leave the list sooner.
- Device registration sends the extension's installation key, so one installation keeps one free account.

## 1.4.5

- **Store and package texts:** the description now states the current free plan, 1 GB a month (it said 10 GB). No change to how the extension works.

## 1.4.4

- **Connect from the server map on colitu.com:** the "Connect to this server" button on a server's card connects the extension to that country. The extension reacts only to a real click on colitu.com (a page script cannot trigger it), checks the sender again in the background and answers the page with the result only (no account data or tickets). Without the extension the button opens the download page.

## 1.4.3

- **Company seats:** the account screen shows the company name when the account uses a Colitu Business seat.

## 1.4.2

- **Sign-in tokens in session memory:** the access and refresh tokens are no longer written to disk; they live in the browser's session storage (emptied when the browser closes), so a copied profile or backup holds no token that can be refreshed. After a browser restart you sign in again, unless you turn on the new setting "Stay signed in after the browser restarts", which keeps the refresh token (not the access token) on disk as before. Tokens from older versions move over by themselves.

## 1.4.1

- **Proxy ticket in session memory only:** the short-lived proxy ticket is no longer stored on disk. After a browser restart or an extension update, traffic is held back (as with the kill switch: only local addresses and the Colitu API go direct) until a new ticket arrives, then the connection comes back by itself. Nothing goes out directly in between.
- **Kill switch:** while it holds traffic back, the browser is pointed at an HTTPS proxy that never answers, so a program listening on that local port can see neither requests nor site names.
- **Server list checks:** servers on local, private or reserved addresses (localhost, 192.168.x.x, 10.x, link-local and the like, also in short or hex forms) are refused.
- **Server names in your language:** cities and node names from the panel (sent in Turkish) are shown in the extension's language.
- **Waiting for the ticket:** while traffic is held back, the toolbar badge shows "…" and the popup "Connecting…" instead of the server's country; a new ticket is asked for after 15 s, 30 s, 1 min, 2 min, then every 5 min (and when the popup opens), not only every 30 minutes.
- **"Usage statistics":** the setting is no longer called "anonymous". In Firefox it asks for the network-location data permission as well (the network's country and provider), next to the technical-data one; it works only when both are allowed.
- **Reproducible packages:** text files go into the packages with LF line ends on every system, so a package built from the git tag has the same checksum.
- **Statistics text:** the setting now says exactly what is sent: connection events (server, success or failure, times) with your network's country and provider as a signed code, in a signed-in request; the server keeps only daily totals, not linked to your account or device, and never records IP addresses or visited sites.

## 1.4.0

- **Automatic (fastest) server:** the server list starts with "Automatic", which measures every server directly (not through the proxy) and picks the fastest; servers in Russia are never picked automatically, and a remembered server gives way to one at least 40% and 60 ms faster.
- **Invite a friend:** a compact invite card with your link, copy button and results.
- **Anonymous connection statistics:** connection results, failure kinds, drops, server latency and automatic choices, kept by the server as day totals not linked to your account or device (no IP or visited site; see 1.4.1 for the exact wording). On by default in Chrome; in Firefox it is an optional data-collection permission and stays off until you allow it. Turning it off deletes queued data.
- **Short survey:** at most once a month a one-line 0-10 recommendation question in the popup.
- Sign-up links are labelled extension:chrome / extension:firefox.

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
