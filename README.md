# SpeedMeter

A self-hosted internet speed test. Open the page, press **Start test**, and it
measures download throughput, upload throughput, ping and jitter directly
between the browser and your own server.

![Download, upload, ping and jitter on one dial](public/favicon.svg)

## Features

- **Four metrics** — download and upload in Mbps, plus ping (best round trip)
  and jitter (average variation between round trips).
- **Parallel streams** — 4 download and 3 upload connections, the way a real
  workload saturates a link, so a single-stream bottleneck doesn't understate
  the result.
- **Warm-up trimming** — the first seconds of each stage are discarded so TCP
  slow start and connection setup don't drag the average down.
- **Real upload progress** — the upload stage samples `XMLHttpRequest` upload
  progress rather than timing whole requests.
- **Live gauge** — a logarithmic dial so 5 Mbps and 500 Mbps are both readable.
- **Local history** — the last 10 results, stored only in your browser.
- **Light and dark themes**, responsive down to phone widths, keyboard
  accessible.
- **No dependencies** — Node's standard library only, no npm install needed.
- **No tracking** — the server generates random bytes, counts what it receives,
  and stores nothing.
- **Content and SEO** — five in-depth guides, canonical URLs, Open Graph tags,
  JSON-LD structured data, a generated sitemap and a real 404 page.
- **AdSense-ready** — ad slots, consent banner and `ads.txt`, all inactive until
  you supply a publisher id, and never loaded during a measurement.

## Before you go live

`site.config.json` holds everything deployment-specific. **Edit it first** — the
defaults point at `example.com`, and the legal pages, canonical URLs and
sitemap are all generated from it.

```json
{
  "siteName": "SpeedMeter",
  "siteUrl": "https://your-real-domain.com",
  "contactEmail": "you@your-real-domain.com",
  "operator": "Your name or company",
  "adsense": { "client": "", "slots": { ... } }
}
```

`siteUrl`, `contactEmail` and `operator` appear in the privacy policy, the
terms and the footer. A privacy policy that still says `example.com` is the
fastest way to fail an AdSense review.

## Run it

```bash
node server.js
# → http://localhost:3000
```

Or with npm:

```bash
npm start
```

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `SPEEDMETER_SERVER_NAME` | `SpeedMeter (self-hosted)` | Name shown under the results |
| `SITE_CONFIG` | `./site.config.json` | Path to the config file |
| `SITE_URL` | from config | Canonical origin, e.g. `https://example.com` |
| `SITE_NAME` | from config | Site name |
| `CONTACT_EMAIL` | from config | Contact address used on the legal pages |
| `ADSENSE_CLIENT` | from config | Publisher id, e.g. `ca-pub-…` |

Environment variables override `site.config.json`, so one image can serve
staging and production.

### Tests

```bash
npm test
```

## Monetisation

The site ships AdSense-ready but **switched off**. Nothing ad-related is
emitted until you configure a publisher id, so development stays clean.

### Turning ads on

1. Get your site approved in AdSense and note your publisher id (`ca-pub-…`).
2. Create ad units in the AdSense dashboard and note each unit's slot id.
3. Put both in `site.config.json`:

```json
"adsense": {
  "client": "ca-pub-0000000000000000",
  "slots": {
    "resultsBanner": "1234567890",
    "guideTop": "2345678901",
    "guideBottom": "3456789012"
  }
}
```

Restart, and `/ads.txt`, the loader script and the ad slots all activate.

### How ads are handled

- **Never during a measurement.** `ads.js` holds pending ad loads while a test
  runs and releases them when it finishes. An ad fetching a creative mid-test
  would compete for the very bandwidth being measured — those bytes are not
  counted by the meter, so the reported speed would come out low. There is also
  a short settle delay on the home page so a visitor who clicks *Start*
  immediately never races an in-flight ad request.
- **One load per pageview.** Slots are never refreshed. Refreshing ads on a
  page people re-trigger repeatedly is a good way to be flagged for invalid
  traffic.
- **Labelled.** Each filled slot is captioned *Advertisement*, so ads stay
  distinguishable from the interface.
- **Collapsed when empty.** An unconfigured slot renders nothing rather than
  leaving a blank box.
- **`ads.txt` is withheld until configured.** Serving a placeholder id would
  mark every legitimate buyer as unauthorised and stop the ads earning
  anything, so no file is the safe default.
- **No ads on the legal pages**, 404 or contact page.

### Consent

Google Consent Mode v2 defaults are set to **denied** for every visitor before
the AdSense loader runs, and a banner lets people accept. Declining still shows
ads, just non-personalised. The choice is revisitable via *Cookie settings* in
the footer.

> **This banner is not a certified CMP.** For EEA/UK traffic Google requires a
> certified consent management platform. Enable **Privacy & messaging** in the
> AdSense dashboard — Google's own CMP is certified and free — and it will take
> over from the built-in banner.

### Before applying

- Fill in `site.config.json` completely, especially `contactEmail` and
  `operator`.
- Deploy on a real domain with HTTPS and let it be indexed.
- Submit `/sitemap.xml` in Google Search Console and confirm pages are indexed.
- Read through the generated `/privacy` and `/terms` pages and adapt them to
  your circumstances. They are a solid starting point, not legal advice — if
  you have specific obligations, have them reviewed.

### A word on the economics

A speed test is unusually expensive to host. One test at 100 Mbps moves roughly
250 MB; at 1 Gbps it is over 2 GB. On metered cloud egress (~$0.05/GB) the
bandwidth for a single test can cost several times what its ad impressions
earn. On a flat-rate VPS with, say, 20 TB included, the same test costs nothing
marginal and the model works — roughly 80,000 tests a month before you hit the
cap.

**Host this on unmetered or generously-capped bandwidth.** Per-GB billing will
lose money on every visitor.

## Pages

| URL | What it is |
| --- | --- |
| `/` | The speed test |
| `/guides/` | Guide index |
| `/guides/how-much-internet-speed-do-i-need` | Sizing a plan by activity |
| `/guides/why-is-my-wifi-slow` | Ordered Wi-Fi diagnostics |
| `/guides/ping-jitter-packet-loss` | Latency, jitter, loss, bufferbloat |
| `/guides/mbps-vs-megabytes` | Units and overhead |
| `/guides/how-to-test-your-speed-accurately` | Method and caveats |
| `/about`, `/contact` | Who runs the site and how to reach them |
| `/privacy`, `/terms` | Policy pages |
| `/robots.txt`, `/sitemap.xml`, `/ads.txt` | Generated from the config |

Pages are plain static HTML in `public/`. The server substitutes a handful of
deployment-specific placeholders (`{{CANONICAL}}`, `{{SITE_NAME}}`,
`{{ADSENSE_HEAD}}` and a few others) as it serves them, so there is no build
step and no duplicated configuration.

Clean URLs work automatically: `/privacy` serves `privacy.html`, `/guides/`
serves `guides/index.html`.

## API

The browser client uses four endpoints, which are also usable on their own:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/ping` | `204 No Content` — timed for latency and jitter |
| `GET /api/download?bytes=N` | Streams `N` bytes of random payload (max 1 GiB) |
| `POST /api/upload` | Drains the body, replies with the byte count (max 256 MiB) |
| `GET /api/info` | Client IP, server name, HTTP version, limits |

All of them send CORS and `no-store` headers, so you can host the static page
somewhere else and point it at this server:

```
https://your-static-host/?api=https://speedmeter.example.com
```

## Deploying

**[DEPLOY.md](DEPLOY.md) is the full walkthrough** — hosting choice, systemd,
TLS, Google Search Console and the AdSense application. Ready-made configs are
in `deploy/`.

The server is a plain Node HTTP server, so anything that runs Node works.
Behind a reverse proxy, two things matter:

- **Disable response buffering and compression** for `/api/download` and
  `/api/upload`. Buffering makes the browser measure the proxy rather than the
  network. The payload is random, so compression cannot help anyway.
- **Forward the client address** as `X-Forwarded-For` if you want `/api/info`
  to report the real IP.

The test is only as fast as the link between the browser and this server, so
host it close to the people testing.

## Accuracy notes

Speeds are reported in megabits per second (Mbps, 1,000,000 bits/s) — the unit
internet plans are sold in. Divide by 8 for MB/s.

A browser tab is bound by JavaScript, HTTP overhead and a limited number of
connections, so multi-gigabit links typically read lower here than they do from
a native client. Wi-Fi, VPNs and other traffic on the same connection all
reduce the result; test over a wired connection with everything else idle for
the closest match to your plan.

## Licence

MIT
