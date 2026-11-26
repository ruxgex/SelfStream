# SelfStream 🤌

A lightweight, self-hosted Stremio addon with **2 configurable sources**, built-in HLS proxy and multi-language support (40 languages).

> **All sources are disabled by default.** Enable only the ones you need from the configuration page.

---

## Features

| Feature | Description |
|---|---|
| **2 Sources** | **VixSrc** (movies & series), **AnimeUnity** (anime via Kitsu) |
| **Per-source configuration** | Enable/disable each source independently from the landing page |
| **40 Languages** | Select preferred audio language |
| **HLS Proxy** | All streams are proxied through the addon — bypasses geo/IP restrictions |
| **Synthetic FHD** | Proxy rewrites manifests to serve only the best available quality (1080p) |
| **Audio Selection** | Preferred language → English fallback → first available |
| **Localized Titles** | Stream titles show the localized TMDB title in your language |
| **ID Agnostic** | Works with TMDB (`786892`), IMDB (`tt30144839`), and Kitsu (`kitsu:12:1`) IDs |

### Stream Labels
- **VixSrc**: `VixSrc 🤌` — `🎬 Localized Title`
- **AnimeUnity**: `AU 🤌` — `VIX 1080 🤌`

---

## Deployment

> For the local Docker stack below, use the included `Dockerfile` as-is.
> Update `Dockerfile.hf` only if you deploy through Hugging Face with your own fork.
>
> [📺 Video Guide](https://www.youtube.com/watch?v=nnhwo0C5x3I)

### Local Docker

```bash
docker compose up -d --build
```

Local manifest:

```text
http://127.0.0.1:7000/manifest.json
```

To expose it over HTTPS (required by Stremio for non-local addons), use Tailscale:

```bash
tailscale serve --bg 7000      # private, tailnet only
tailscale funnel --bg 7000     # public
```

Change the host port with `SELFSTREAM_LOCAL_PORT` in `.env`.

#### Buffering & cache tuning

The proxy is built for a home server whose internet link is the bottleneck: it downloads ahead of the playhead in parallel, retries flaky segment fetches (resuming partial downloads), streams segments to the player as they arrive, and near the end of an episode pre-downloads the start of the next one. Tune it in `.env`:

| Variable | Default | Meaning |
|---|---|---|
| `SEGMENT_PREFETCH_AHEAD_SECONDS` | `240` | How far ahead of the playhead to download. A very large value downloads the whole episode. |
| `SEGMENT_PREFETCH_CONCURRENCY` | `4` | Parallel prefetch downloads. |
| `SEGMENT_CACHE_MAX_MB` | `2048` | RAM used for cached segments. |
| `SEGMENT_FETCH_RETRIES` | `3` | Retries per segment/playlist on errors and timeouts. |
| `SEGMENT_NEXT_EPISODE_SECONDS` | `60` | How much of the next episode to pre-download. |
| `STREAM_CACHE_TTL_MS` | `1200000` | How long stream lists are cached (reopening a title is instant). |

See `.env.example` for the full list.

#### Optional: route traffic through ProtonVPN (Gluetun)

1. In your [Proton account](https://account.proton.me/u/0/vpn/OpenVpnIKEv2), copy the **OpenVPN / IKEv2 username and password** (not your Proton login).
2. Add it to `.env`:

   ```bash
   PROTONVPN_OPENVPN_USER=your_openvpn_username
   PROTONVPN_OPENVPN_PASSWORD=your_openvpn_password
   PROTONVPN_SERVER_COUNTRIES=Netherlands   # optional
   PROTONVPN_FREE_ONLY=on                    # only if you use a free Proton plan
   ```

3. Start the stack with the VPN override:

   ```bash
   docker compose -f compose.yaml -f compose.vpn.yaml up -d --build
   ```

All SelfStream outbound traffic goes through the tunnel. If the VPN drops, Gluetun's kill switch blocks traffic instead of leaking your IP. The manifest stays at `http://127.0.0.1:7000/manifest.json`.

### Recommended: VPS / Raspberry Pi (Best compatibility)

A persistent server is the most reliable option — it keeps the in-memory proxy cache alive and avoids cloud IP blocks.

```bash
git clone https://github.com/YOUR_USER/SelfStream.git
cd SelfStream
npm install
npm run build
PORT=7020 node dist/addon.js
```

The addon will be available at `http://your-ip:7020/manifest.json`.

### Koyeb (Recommended cloud — stable, no sleep, AnimeUnity may not work)

[📺 Video Guide](https://www.youtube.com/watch?v=IXEi81ONdNo)

1. Create an account on [Koyeb.com](https://www.koyeb.com/).
2. Click **"Create Service"** → select **GitHub**.
3. Connect your forked repository.
4. Configuration:
   - **Builder**: `Docker`
   - **Dockerfile Path**: `Dockerfile.hf`
   - **Port**: `7000`
5. Click **Deploy**.

### Hugging Face Spaces (Free, AnimeUnity may not work)

[📺 Video Guide](https://www.youtube.com/watch?v=Ti2BNDjm0ns)

1. Create a new **Space** on [Hugging Face](https://huggingface.co/spaces).
2. Choose **Docker** as SDK, **Blank** template.
3. Upload the Dockerfile (fork the project first and rename `Dockerfile.hf` with your GitHub username).
4. Copy the embed link.
5. The Space runs on port `7860`.

> **Note**: AnimeUnity/VixCloud may not work on HuggingFace due to cloud IP blocking.

### Vercel (Serverless — fast, limited, AnimeUnity may not work)

[📺 Video Guide](https://www.youtube.com/watch?v=TP3_sbt94Ag)

The project includes `vercel.json` and `api/index.ts` for serverless deployment.

1. Go to [Vercel.com](https://vercel.com/) and import your GitHub repo.
2. Vercel auto-detects the configuration.
3. Click **Deploy**.
4. Access at `https://your-app.vercel.app/manifest.json`.

> **Limitations**: Vercel free plan has a 10s function timeout. Multi-step scraping (AnimeUnity) may exceed this. The in-memory proxy header cache resets between invocations (a fallback is in place, but VPS is more reliable).

---

## Local Development

```bash
npm install
npm run build
npm start
# Or with ts-node:
npm run dev
```

The addon runs on `http://localhost:7000` by default.

---

## Technical Notes

- **Proxy architecture**: Stream URLs point to `/proxy/hls/manifest.m3u8` which rewrites all segment/audio/subtitle URIs to also go through the proxy, ensuring playback works from any network.
- **AnimeMapping**: Kitsu IDs are converted to AnimeUnity paths via the AnimeMapping API, then resolved through VixCloud.
- **Header cache fallback**: On serverless platforms where the in-memory cache is empty, the proxy infers the correct headers from the URL pattern (VixSrc, VixCloud, or generic).
