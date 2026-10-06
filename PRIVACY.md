# Privacy: Colitu VPN browser extension

This page describes what the extension itself does with data. The Colitu
service as a whole is covered by the privacy policy at
<https://colitu.com/legal/privacy>.

## What the extension stores in your browser

- your session (access and refresh token), the e-mail address of the account
  and the id of this browser as a device on your account;
- a random device key generated at installation (it identifies this browser
  installation to your account, nothing else);
- the server list, the current proxy ticket, measured pings, your plan
  details (when it ends, the next plan, the number of devices);
- your settings (WebRTC protection, Russian sites, site lists, language).

Nothing is synchronised to other browsers. Signing out removes the session,
the ticket and the server list, and removes this browser from your account's
devices.

## What is sent to Colitu

- **Sign-in:** your e-mail and password (or the device-link code you confirm
  on colitu.com) go to `api.colitu.com` over HTTPS; with two-step
  verification on, so does the code from your authenticator app or a
  recovery code.
- **Device registration:** a device name such as “Chrome · Windows”, the
  platform (`chrome` or `firefox`), the extension version and the operating
  system name.
- **Browsing traffic:** while connected, the browser's traffic goes through the
  Colitu server you chose. HTTPS sites stay encrypted end to end; the server
  sees which host names you connect to, as any VPN or proxy does. Servers keep
  no activity logs. The traffic volume per device is counted for the plan
  limit (the free plan has 10 GB a month).

## What the extension does not do

- no analytics, crash reporting, advertising or third-party SDKs;
- no access to page content: no content scripts, no reading or changing pages;
- no browsing history: requests are routed, not recorded;
- no remote code: everything the extension runs is in the package.

## Contact

privacy@colitu.com
