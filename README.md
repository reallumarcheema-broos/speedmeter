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

### Tests

```bash
npm test
```

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
