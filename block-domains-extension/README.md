# Block Domains — Chrome Extension

A minimal Manifest V3 Chrome extension that blocks **all** network requests
(XHR/`fetch`, scripts, images, stylesheets, fonts, media, WebSocket, frame
navigations, etc.) to a configurable set of domains. Blocking is done with the
[`declarativeNetRequest`](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
API, so requests are dropped by the network stack before they ever leave the
browser — no page script runs to make them.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3). Registers the static ruleset. |
| `rules.json` | The list of block rules — one entry per domain. |

## Configuring the blocked domains

Edit `rules.json`. Each rule blocks one domain (and all of its subdomains).
To add a domain, copy an existing entry, give it a **unique** `id`, and change
the `urlFilter`:

```json
{
  "id": 3,
  "priority": 1,
  "action": { "type": "block" },
  "condition": {
    "urlFilter": "||doubleclick.net^",
    "resourceTypes": [
      "main_frame", "sub_frame", "stylesheet", "script", "image",
      "font", "object", "xmlhttprequest", "ping", "csp_report",
      "media", "websocket", "other"
    ]
  }
}
```

`urlFilter` notes:
- `||doubleclick.net^` matches `doubleclick.net` and any subdomain
  (`ads.doubleclick.net`), on any scheme or path. This is the form you want for
  "block this domain everywhere."
- The `^` anchors the end of the domain so `||example.com^` does **not** also
  match `example.com.evil.net`.
- Listing every `resourceType` ensures XHR/`fetch` (`xmlhttprequest`),
  `WebSocket`, and even the top-level navigation (`main_frame`) are all blocked.
  If you only care about XHR/fetch, keep just `"xmlhttprequest"`.

After editing `rules.json`, reload the extension (see below) for changes to
take effect.

## Loading the extension

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this `block-domains-extension/` folder.
4. To pick up changes to `rules.json` or `manifest.json`, click the **reload**
   (↻) icon on the extension card.

## Verifying it works

1. Open a page that calls one of the blocked domains and check the **Network**
   tab in DevTools — blocked requests show status `(blocked:declarative net
   request)`.
2. Or run in the DevTools console on any page:
   ```js
   fetch("https://example.com/api").catch(e => console.log("blocked:", e));
   ```
   With the default `rules.json`, the request to `example.com` is blocked.

## Notes / limits

- The default `rules.json` ships with placeholder domains (`example.com`,
  `tracker.example.org`) — replace them with your own.
- Rule `id`s must be unique positive integers.
- A static ruleset supports up to ~30,000 rules. For very large or
  user-editable blocklists, switch to dynamic rules via
  `chrome.declarativeNetRequest.updateDynamicRules` in a service worker.
