# Launching SpeedMeter

Getting the site live, then getting it into Google Search and AdSense.

---

## 1. Pick hosting — bandwidth decides this

SpeedMeter is a Node server, not a static site: it has to generate and
absorb the test traffic. That rules out static-only hosts, and it makes
**bandwidth pricing the single most important factor** in where you put it.

One test moves roughly **250 MB** at 100 Mbps, and over **2 GB** at 1 Gbps.
A thousand tests a day is somewhere between 250 GB and 2 TB.

### Hosts that work

| Host | Included traffic | Rough cost |
| --- | --- | --- |
| Hetzner Cloud CX22 | 20 TB | ~€4/mo |
| Netcup VPS | unmetered (fair use) | ~€5/mo |
| Contabo VPS | unmetered (fair use) | ~€6/mo |
| OVH VPS | unmetered | ~€6/mo |

Any of these will run this comfortably. 20 TB is roughly 80,000 tests a month.

### Hosts to avoid for this particular app

| Host | Why not |
| --- | --- |
| **Google Cloud Run / Compute Engine** | Egress is billed per GB (roughly $0.05–0.12 depending on tier and region — check current pricing). At those rates a single test can cost several times what its ad impressions earn. |
| **AWS EC2 / Lambda** | Same problem, same reason. |
| **Firebase Hosting** | Static only. The test endpoints cannot run there at all. |
| **Vercel / Netlify** | Metered bandwidth plus function time limits. A 10-second streaming response is the wrong shape for their runtime. |
| **GitHub Pages** | Static only, and explicitly not for this kind of traffic. |

> If you want to be on Google Cloud for other reasons, do the arithmetic
> first with your own expected traffic. The app will run fine there; the
> bill is the problem, and it scales with your success.

### Cloudflare

You can use Cloudflare for DNS, but **do not proxy the site through it**
(keep the cloud icon grey, not orange):

- Proxied traffic would measure the distance to Cloudflare's edge, not to
  your server, so your results would be wrong.
- Pushing large volumes of non-HTML data through their CDN is against the
  terms of the free plan.


---

## Deploying to Vercel

The repo supports Vercel out of the box: `vercel.json` builds the static pages
and the `api/` folder becomes four serverless functions.

### Setup

1. Import the repo in Vercel. Framework preset **Other** — `vercel.json`
   overrides the build command and output directory anyway.
2. Add environment variables under *Settings → Environment Variables*:

   | Variable | Value |
   | --- | --- |
   | `SITE_URL` | `https://your-domain.com` (optional — falls back to your Vercel production domain) |
   | `CONTACT_EMAIL` | the address shown on the legal pages |
   | `SITE_NAME`, `ADSENSE_CLIENT` | optional overrides |

3. Deploy. `node build.js` renders `public/` into `dist/`, and `/api/ping`,
   `/api/download`, `/api/upload` and `/api/info` are deployed as functions.

### What is different from self-hosting

`server.js` substitutes the page placeholders at request time. A static host
cannot, so **`build.js` does it ahead of time** — this is why a Vercel
deployment that just serves `public/` shows raw `{{SITE_NAME}}` text and has no
working API. Both paths share `lib/site.js`, and a test asserts they produce
byte-identical output.

The functions are also capped far below the self-hosted server:

| | Self-hosted | Vercel |
| --- | --- | --- |
| Download per request | 1 GiB | 4 MiB |
| Upload per request | 256 MiB | 3 MiB |
| Download connections | 4 | 8 |
| Upload connections | 3 | 6 |

Vercel's serverless request body limit is 4.5 MB, and a buffered response is
subject to a similar cap. Rather than hardcoding this, `/api/info` reports the
limits and the client sizes its requests from them — so the same frontend runs
against either backend. Because each request is small, the client opens more
connections in parallel to keep the link saturated between request boundaries.

### The cost warning, concretely

**Vercel Hobby includes 100 GB of bandwidth a month.** One test moves roughly
250 MB at 100 Mbps. That is about **400 tests a month** before you are over the
limit — and a speed test that nobody runs earns nothing.

A test also costs roughly 85 function invocations on a 100 Mbps line, and
several hundred on a fast one, because each request is only a few megabytes.

Vercel is fine for **verifying the site works and getting through AdSense
review**. It is the wrong shape for a speed test with real traffic. When you
have visitors, move the backend to a VPS with flat-rate bandwidth (see the
table at the top of this guide) — you can keep the frontend on Vercel and point
it at that server with `?api=https://api.your-domain.com`, or move the whole
thing.

### Accuracy on Vercel

Results will read lower than the same connection measured against a dedicated
server: cold starts, per-request caps and the gaps between many small requests
all cost throughput. Treat Vercel numbers as indicative.

---

## 2. Get the server running

On a fresh Ubuntu/Debian box:

```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# A dedicated unprivileged user
sudo useradd --system --home /opt/speedmeter --shell /usr/sbin/nologin speedmeter

# The code
sudo git clone https://github.com/reallumarcheema-broos/speedmeter.git /opt/speedmeter
sudo chown -R speedmeter:speedmeter /opt/speedmeter
```

Edit `/opt/speedmeter/site.config.json` — see step 4, and do it before you
let Google see the site.

```bash
sudo cp /opt/speedmeter/deploy/speedmeter.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now speedmeter
systemctl status speedmeter
```

It now listens on `127.0.0.1:3000`. Nothing is public yet.

---

## 3. Domain, TLS and the reverse proxy

Point an A record at your server's IP, then put a proxy in front to
terminate TLS. **Caddy is the easier option** — it gets certificates on its
own:

```bash
sudo apt-get install -y caddy
sudo cp /opt/speedmeter/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # change the domain
sudo systemctl reload caddy
```

`deploy/nginx.conf` is there if you prefer nginx; pair it with certbot.

**Whichever you use, the `/api/` settings in those files are not optional.**
Response buffering makes the browser measure your proxy instead of the
network, and nginx's default 1 MB request body limit rejects the upload
chunks outright. Both configs already handle this — do not simplify them
into a plain `proxy_pass`.

### Check it worked

```bash
curl -I https://your-domain.com/
curl -s https://your-domain.com/api/info
curl -s https://your-domain.com/robots.txt
```

`/api/info` should show your own IP, not `127.0.0.1`. If it shows the
loopback address, the proxy is not forwarding `X-Forwarded-For`.

Then open the site and run a real test.

---

## 4. Fill in the config

`site.config.json` is the source of truth for the canonical URLs, the
sitemap, and the contact and operator details printed on the legal pages:

```json
{
  "siteName": "SpeedMeter",
  "siteUrl": "https://your-real-domain.com",
  "contactEmail": "you@your-real-domain.com",
  "operator": "Your name or company",
  "serverName": "SpeedMeter — London",
  "adsense": { "client": "", "slots": {} }
}
```

`sudo systemctl restart speedmeter` after editing.

Get `siteUrl` right before Google crawls you: it is what goes in every
canonical tag and every sitemap entry. A sitemap full of `example.com`
URLs is worse than no sitemap.

---

## 5. Get into Google Search

Indexing is not automatic, and AdSense will not approve a site Google
cannot see.

1. **Google Search Console** — <https://search.google.com/search-console>.
   Add your domain as a property.
2. **Verify ownership.** A DNS TXT record verifies the whole domain and is
   the most durable option. Alternatively, drop the `googleXXXX.html` file
   Google gives you into `public/` — the server will serve it at the root
   automatically.
3. **Submit the sitemap.** Under *Sitemaps*, enter `sitemap.xml`. It is
   generated live from the pages on disk, so it stays current by itself.
4. **Request indexing** for the home page via *URL Inspection* to prompt a
   first crawl.
5. **Wait.** Indexing takes days to a few weeks for a new domain. Check
   progress under *Pages*.

Also worth doing: [Bing Webmaster Tools](https://www.bing.com/webmasters)
takes about two minutes and can import everything from Search Console.

### Being findable at all

A new speed test site has no chance against the incumbents on the term
"speed test". Your realistic traffic is the long tail — the specific
questions the guides answer, like "why is my wifi slow in one room" or
"how much upload speed do I need for zoom". That is exactly why the guides
are there. Expect months, not days, and keep adding guides.

---

## 6. Apply to AdSense

Only once the site is live, indexed, and the legal pages carry your real
details.

1. Sign up at <https://adsense.google.com>.
2. Add your domain and place the verification snippet. Set `ADSENSE_CLIENT`
   or `adsense.client` in the config and restart — the server emits the
   loader in `<head>` on every page, which is what Google checks for.
3. Wait for review. Days to a few weeks.
4. Once approved, create ad units and put their slot ids in
   `site.config.json`:

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

5. Restart. `/ads.txt` starts serving, the slots start filling, and the
   consent banner appears.
6. **Enable Privacy & messaging** in the AdSense dashboard. Google's own
   CMP is certified and free; the built-in banner is a baseline, not a
   certified CMP, and EEA/UK traffic requires a certified one.

See the README for how ads are held back during measurement, and why
`ads.txt` stays absent until the publisher id is set.

---

## Keeping it running

```bash
# Update
cd /opt/speedmeter && sudo git pull && sudo systemctl restart speedmeter

# Logs
journalctl -u speedmeter -f
```

Watch your bandwidth graph in the first month. It is the number that
decides whether this is profitable, and it is the one that will surprise
you.
