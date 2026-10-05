# Store listings

Texts and answers for the Chrome Web Store and Firefox Add-ons (AMO). Upload
the packages from the GitHub release of the same version
(`colitu-chrome-X.Y.Z.zip`, `colitu-firefox-X.Y.Z.zip`; AMO also asks for
`colitu-extension-X.Y.Z-source.zip`). Images are in this folder.

| Field | Value |
|---|---|
| Name | Colitu VPN |
| Category | Chrome: Privacy & Security · AMO: Privacy & Security |
| Website | https://colitu.com/download/browser |
| Support | https://colitu.com/support · support@colitu.com |
| Privacy policy | https://colitu.com/legal/privacy (extension specifics: https://github.com/colitu/colitu-extension/blob/main/PRIVACY.md) |
| Source | https://github.com/colitu/colitu-extension |
| Images | `icon-128.png`, `promo-440x280.png` (small tile), `marquee-1400x560.png`, `screenshots/<lang>-1..4.png` (1280×800) |

## Short description (≤ 132 characters, from `_locales`)

- en: Protect your browser with Colitu: one click, servers in 10+ countries, WebRTC leak protection. Free 10 GB every month.
- ru: Защитите браузер с Colitu: один клик, серверы в 10+ странах, защита от утечек WebRTC. 10 ГБ бесплатно каждый месяц.
- tr: Tarayıcınızı Colitu ile koruyun: tek tık, 10+ ülkede sunucu, WebRTC sızıntı koruması. Her ay 10 GB ücretsiz.

## Detailed description

### English

Colitu VPN protects your browser in one click — no app to install.

• One click: the big button connects your browser to the fastest Colitu server, picked by measured ping and load. If a server stops answering, the extension moves to the next one.
• Servers in more than 10 countries: Finland, Sweden, Estonia, the UK, France, Germany, Poland, Latvia, Canada, Türkiye and Russia.
• No leaks around the proxy: if the server cannot be reached, pages do not open directly. WebRTC leak protection keeps video-call sites from seeing your real IP address.
• Your rules: keep sites such as your bank outside the VPN, or send only the sites you choose through Colitu. Local network addresses always stay direct.
• Same account as the Colitu apps for Windows, Android, Linux and iOS. The free plan includes 10 GB every month; Premium has no limit.
• Open source (GPL-3.0): github.com/colitu/colitu-extension. No analytics, no ads, no access to page content.

The extension protects browser traffic only. To protect every app on your device, use the Colitu app: colitu.com/download

### Русский

Colitu VPN защищает браузер в один клик — без установки приложения.

• Один клик: большая кнопка подключает браузер к самому быстрому серверу Colitu по измеренному пингу и нагрузке. Если сервер перестал отвечать, расширение переходит на следующий.
• Серверы более чем в 10 странах: Финляндия, Швеция, Эстония, Великобритания, Франция, Германия, Польша, Латвия, Канада, Турция и Россия.
• Без утечек в обход прокси: если сервер недоступен, страницы не открываются напрямую. Защита от утечек WebRTC скрывает ваш настоящий IP от сайтов видеозвонков.
• Ваши правила: оставьте банк и другие сайты вне VPN или пускайте через Colitu только выбранные сайты. Российские сайты (.ru, .su, .рф) по умолчанию открываются напрямую, как в приложениях.
• Тот же аккаунт, что в приложениях Colitu для Windows, Android, Linux и iOS. Бесплатный тариф — 10 ГБ каждый месяц; на Premium ограничений нет.
• Открытый код (GPL-3.0): github.com/colitu/colitu-extension. Без аналитики, без рекламы, без доступа к содержимому страниц.

Расширение защищает только трафик браузера. Чтобы защитить все приложения на устройстве, установите приложение Colitu: colitu.com/download

### Türkçe

Colitu VPN, uygulama kurmadan tarayıcınızı tek tıkla korur.

• Tek tık: büyük düğme tarayıcınızı ölçülen ping ve yüke göre seçilen en hızlı Colitu sunucusuna bağlar. Bir sunucu yanıt vermezse eklenti sıradakine geçer.
• 10'dan fazla ülkede sunucu: Finlandiya, İsveç, Estonya, Birleşik Krallık, Fransa, Almanya, Polonya, Letonya, Kanada, Türkiye ve Rusya.
• Proxy dışından sızıntı yok: sunucuya ulaşılamazsa sayfalar doğrudan açılmaz. WebRTC sızıntı koruması gerçek IP adresinizi görüntülü görüşme sitelerinden gizler.
• Sizin kurallarınız: bankanız gibi siteleri VPN dışında tutun ya da yalnızca seçtiğiniz siteleri Colitu üzerinden açın. Yerel ağ adresleri her zaman doğrudan gider.
• Windows, Android, Linux ve iOS'taki Colitu uygulamalarıyla aynı hesap. Ücretsiz plan her ay 10 GB içerir; Premium'da sınır yoktur.
• Açık kaynak (GPL-3.0): github.com/colitu/colitu-extension. Analiz yok, reklam yok, sayfa içeriğine erişim yok.

Eklenti yalnızca tarayıcı trafiğini korur. Cihazdaki tüm uygulamaları korumak için Colitu uygulamasını kullanın: colitu.com/download

## Chrome Web Store: privacy practices tab

**Single purpose:** Route the browser's traffic through the user's Colitu VPN servers (an HTTPS proxy) to protect their privacy, with the account, server choice and routing settings needed for that.

**Permission justifications**

- `proxy`: sets the browser proxy (a PAC script) to the Colitu server the user connects to, and clears it on disconnect.
- `webRequest` and `webRequestAuthProvider`: answer the Colitu proxy's authentication challenge (HTTP 407) with the user's short-lived proxy ticket. No other requests are observed or modified.
- `privacy`: while connected, sets `webRTCIPHandlingPolicy` to `disable_non_proxied_udp` so WebRTC cannot reveal the real IP address; cleared on disconnect.
- `storage`: keeps the sign-in session, settings and server list on the device.
- `alarms`: refreshes the proxy ticket in the background before it expires.
- Host permission `<all_urls>`: the proxy applies to every site the user visits, the authentication challenge can come for any site, server pings are measured against the proxy hosts and the Colitu API is called at api.colitu.com.

**Remote code:** No. All code is in the package.

**Data usage** (tick): Personally identifiable information (e-mail address for sign-in), Authentication information (password / tokens, sent only to api.colitu.com), Web history is **not** collected (traffic is routed through the proxy, not recorded). Certify: not sold, not used for unrelated purposes, not used for creditworthiness.

## Firefox Add-ons

**Summary (≤ 250):** Protect your browser with Colitu VPN: one click, servers in 10+ countries, WebRTC leak protection and site lists. Same account as the Colitu apps; 10 GB free every month. Open source.

**Data collection** (declared in the manifest): authenticationInfo, personallyIdentifyingInfo, browsingActivity (traffic passes through Colitu servers while connected; it is not logged).

**Notes to reviewer:**

> The package is built from the included source (`colitu-extension-X.Y.Z-source.zip`) with Node.js 20+ and no dependencies: `npm test && node scripts/build.mjs firefox`. The output `dist/firefox` matches the uploaded package byte for byte (the zip is reproducible; compare `dist/SHA256SUMS`).
> The extension needs a Colitu account. Test account: <add a test e-mail and password before submitting>. Sign in, click the big button, then open any site; the toolbar badge shows the server's country.
> Network access: api.colitu.com (account API) and the Colitu proxy hosts returned by the API after sign-in (HTTPS proxy on port 2083).
