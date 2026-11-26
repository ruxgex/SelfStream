import * as net from 'net';
import * as dns from 'dns';

// Node's happy-eyeballs gives each address only 250ms to connect. Upstream hosts
// (Cloudflare) resolve to IPv6 too, which is unreachable in most Docker setups, and
// IPv4 connects routinely take 500ms+ at peak hours, so every attempt failed with
// ETIMEDOUT. Prefer IPv4 and let a single connect use the full OS timeout.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

import { installHttpDispatcher, withTimeout } from './http';
installHttpDispatcher();

const { addonBuilder } = require('stremio-addon-sdk');
import { getVixSrcStreams } from './vixsrc';
import { getVixCloudStreams } from './vixcloud';
import { decodeProxyToken, getAddonBase, withTokenContext, StreamCtx } from './proxy';
import { decodeConfig, encodeConfig, UserConfig, DEFAULT_CONFIG } from './config';
import { registerMediaPlaylist, serveSegment } from './segment-cache';
import { isMasterPlaylist, loadPlaylist, parseMediaPlaylist, pickBestVariant, PlaylistError, rewriteMaster, rewriteMedia } from './hls';
import { createNextEpisodeWarmer } from './next-episode';
const express = require('express');
import { generateLandingPage } from './landing';

const manifest = {
    id: 'org.selfstream.addon',
    version: '1.1.0',
    name: 'SelfStream🤌',
    description: 'SelfStream - Multi-source streaming addon',
    logo: 'https://icv.stremio.dpdns.org/prisonmike.png',
    background: 'https://blog.stremio.com/wp-content/uploads/2022/08/shino-1024x632.png',
    resources: ['stream'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tmdb:', 'tt', 'kitsu:'],
    catalogs: []
};

const VIXSRC_TIMEOUT_MS = 8000;
const ANIMEUNITY_TIMEOUT_MS = 12000;
const TMDB_TIMEOUT_MS = 4000;
const STREAM_CACHE_TTL_MS = parseInt(process.env.STREAM_CACHE_TTL_MS || String(20 * 60 * 1000), 10);

const builder = new addonBuilder(manifest as any);

async function fetchMediaTitle(type: string, tmdbId: string, lang: string): Promise<string> {
    try {
        const TMDB_KEY = Buffer.from('MTg2NWY0M2EwNTQ5Y2E1MGQzNDFkZDlhYjhiMjlmNDk=', 'base64').toString();
        const tmdbType = type === 'series' ? 'tv' : 'movie';
        const signal = AbortSignal.timeout(TMDB_TIMEOUT_MS);
        if (tmdbId.startsWith('tt')) {
            const resp = await fetch(`https://api.themoviedb.org/3/find/${tmdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=${lang}`, { signal });
            const data = await resp.json() as any;
            const r = data?.movie_results?.[0] || data?.tv_results?.[0];
            return r?.title || r?.name || '';
        }
        const resp = await fetch(`https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${TMDB_KEY}&language=${lang}`, { signal });
        const data = await resp.json() as any;
        return data?.title || data?.name || '';
    } catch {
        return '';
    }
}

/** Attach what is being played to each proxied stream URL (used for next-episode warm-up). */
function attachContext(streams: any[], ctx: StreamCtx): any[] {
    return streams.map((s) => {
        if (typeof s.url !== 'string' || !s.url.startsWith('/proxy/')) return s;
        const u = new URL(s.url, 'http://local');
        const token = u.searchParams.get('token');
        if (!token) return s;
        u.searchParams.set('token', withTokenContext(token, ctx));
        return { ...s, url: `${u.pathname}${u.search}` };
    });
}

// Resolve streams from the sources enabled in the user config
async function resolveStreams(type: string, id: string, userConfig: UserConfig): Promise<any[]> {
    const allStreams: any[] = [];

    try {
        // ── Kitsu (AnimeUnity/VixCloud) ──
        if (id && id.startsWith('kitsu:')) {
            if (userConfig.animeunityEnabled) {
                const parts = id.split(':');
                const kitsuId = parts[1];
                const episodeNum = parts[2] || '1';
                try {
                    allStreams.push(...await withTimeout(getVixCloudStreams(kitsuId, episodeNum), ANIMEUNITY_TIMEOUT_MS, 'AnimeUnity'));
                } catch (err) {
                    console.error('[AnimeUnity] error:', err);
                }
            }
            return allStreams;
        }

        if (type === 'movie' || type === 'series') {
            let tmdbId = id;
            let season: string | undefined;
            let episode: string | undefined;

            if (type === 'movie') {
                if (id.startsWith('tmdb:')) {
                    tmdbId = id.split(':')[1];
                }
            } else if (type === 'series') {
                const parts = id.split(':');
                if (parts[0] === 'tmdb') {
                    tmdbId = parts[1];
                    season = parts[2];
                    episode = parts[3];
                } else if (parts[0].startsWith('tt')) {
                    tmdbId = parts[0];
                    season = parts[1];
                    episode = parts[2];
                }
            }

            if (userConfig.vixEnabled) {
                // Title lookup and stream resolution run in parallel; the title is cosmetic.
                const titlePromise = fetchMediaTitle(type, tmdbId, userConfig.vixLang);
                const streamsPromise = withTimeout(getVixSrcStreams(tmdbId, season, episode, userConfig.vixLang), VIXSRC_TIMEOUT_MS, 'VixSrc')
                    .catch((err) => {
                        console.error('[VixSrc] error:', err);
                        return [] as any[];
                    });
                const [mediaTitle, streams] = await Promise.all([titlePromise, streamsPromise]);
                for (const s of streams) {
                    s.name = 'VixSrc 🤌';
                    s.title = `🎬 ${mediaTitle || 'Stream'}`;
                }
                allStreams.push(...streams);
            }
        }
    } catch (err) {
        console.error("Handler error:", err);
    }

    return allStreams;
}

// ── Stream result cache: reopening a title (or autoplaying a warmed episode) is instant ──
const streamCache = new Map<string, { streams: any[]; expireAt: number }>();
const streamInflight = new Map<string, Promise<any[]>>();

async function handleStream(type: string, id: string, userConfig: UserConfig): Promise<any[]> {
    const key = `${type}|${id}|${JSON.stringify(userConfig)}`;
    const cached = streamCache.get(key);
    if (cached && cached.expireAt > Date.now()) return cached.streams;

    const existing = streamInflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
        const ctx: StreamCtx = { t: type, i: id, c: encodeConfig(userConfig) };
        const streams = attachContext(await resolveStreams(type, id, userConfig), ctx);
        if (streams.length > 0) {
            streamCache.set(key, { streams, expireAt: Date.now() + STREAM_CACHE_TTL_MS });
        }
        return streams;
    })().finally(() => streamInflight.delete(key));

    streamInflight.set(key, promise);
    return promise;
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of streamCache) {
        if (entry.expireAt < now) streamCache.delete(key);
    }
}, 10 * 60 * 1000).unref();

const warmNextEpisode = createNextEpisodeWarmer(handleStream);

builder.defineStreamHandler(async (args: any) => {
    let type = args.type;
    let id = args.id;

    if (typeof type === 'object' && type.id) {
        id = type.id;
        type = type.type;
    }

    console.log("Stream request (default config):", { type, id });
    const streams = await handleStream(type, id, DEFAULT_CONFIG);
    return { streams };
});

const addonInterface = builder.getInterface();

const app = express();
app.set('trust proxy', true);
app.use((req: any, res: any, next: any) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    next();
});

// ── Landing Page ──
app.get('/', (req: any, res: any) => {
    const addonBase = getAddonBase(req);
    res.send(generateLandingPage(manifest, addonBase));
});

// ── Manifest (default config) ──
app.get('/manifest.json', (req: any, res: any) => {
    res.json(manifest);
});

// ── Manifest (with user config) ──
app.get('/:config/manifest.json', (req: any, res: any) => {
    res.json(manifest);
});

function absolutize(streams: any[], addonBase: string): any[] {
    // Copy: cached stream objects must keep their relative URLs.
    return streams.map((s: any) => (s.url && s.url.startsWith('/') ? { ...s, url: `${addonBase}${s.url}` } : s));
}

// ── Stream Endpoint: with user config ──
app.get('/:config/stream/:type/:id.json', async (req: any, res: any) => {
    const { config: configToken, type, id } = req.params;
    const addonBase = getAddonBase(req);
    const userConfig = decodeConfig(configToken);

    console.log("Stream request (configured):", { type, id, userConfig });

    try {
        const streams = await handleStream(type, id, userConfig);
        res.json({ streams: absolutize(streams, addonBase) });
    } catch (err: any) {
        res.status(500).json({ error: err?.message || 'Internal Error' });
    }
});

// ── Stream Endpoint: default config (backward compat) ──
app.get('/stream/:type/:id.json', async (req: any, res: any) => {
    const { type, id } = req.params;
    const addonBase = getAddonBase(req);

    try {
        const streams = await handleStream(type, id, DEFAULT_CONFIG);
        res.json({ streams: absolutize(streams, addonBase) });
    } catch (err: any) {
        res.status(500).json({ error: err?.message || 'Internal Error' });
    }
});

// ── HLS Proxy: playlist rewriter (master → best variant only; media → proxied segments) ──
app.get('/proxy/hls/manifest.m3u8', async (req: any, res: any) => {
    try {
        const token = req.query.token;
        if (!token) return res.status(400).send('#EXTM3U\n# Missing token');

        const decoded = decodeProxyToken(token);
        if (!decoded) return res.status(400).send('#EXTM3U\n# Invalid token');

        const upstream = decoded.u;
        const headers = decoded.h || {};
        const expire = decoded.e || 0;

        if (!upstream) return res.status(400).send('#EXTM3U\n# Missing upstream URL');
        if (expire && Date.now() > expire) return res.status(410).send('#EXTM3U\n# Token expired');

        console.log(`[HLS Proxy] Fetching: ${upstream.substring(0, 100)}...`);

        let text: string;
        try {
            text = await loadPlaylist(upstream, headers);
        } catch (err: any) {
            const status = err instanceof PlaylistError ? err.status : 'network';
            return res.status(502).send(`#EXTM3U\n# Upstream error ${status}`);
        }

        const addonBase = getAddonBase(req);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');

        if (isMasterPlaylist(text)) {
            const master = pickBestVariant(text, upstream);
            if (master) return res.send(rewriteMaster(master, upstream, headers, addonBase, decoded.c));
        }

        const ctx = decoded.c;
        registerMediaPlaylist(parseMediaPlaylist(text, upstream), headers, {
            onNearEnd: ctx ? () => { void warmNextEpisode(ctx); } : undefined,
        });
        return res.send(rewriteMedia(text, upstream, headers, addonBase));
    } catch (e: any) {
        console.error('[HLS Proxy] error:', e?.message || e);
        if (!res.headersSent) res.status(500).send('#EXTM3U\n# Internal error');
    }
});

// ── HLS Proxy: segment proxy (cached + prefetch) ──
app.get('/proxy/hls/segment.ts', async (req: any, res: any) => {
    try {
        const token = req.query.token;
        if (!token) return res.status(400).send('Missing token');

        const decoded = decodeProxyToken(token);
        if (!decoded) return res.status(400).send('Invalid token');

        const upstream = decoded.u;
        const headers = decoded.h || {};

        if (!upstream) return res.status(400).send('Missing upstream URL');

        await serveSegment(upstream, headers, res);
    } catch (e: any) {
        if (e?.code === 'ERR_STREAM_PREMATURE_CLOSE' || e?.name === 'AbortError') return;
        console.error('[HLS Segment Proxy] error:', e?.message || e);
        if (!res.headersSent) {
            res.status(500).send('Internal error');
        }
    }
});

export default app;
export { handleStream };

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    const port = process.env.PORT || 7000;
    const server = app.listen(port, () => {
        console.log(`SelfStream running at http://127.0.0.1:${port}`);
        console.log(`Manifest: http://127.0.0.1:${port}/manifest.json`);
    });
    // Players reuse connections between segment requests; don't drop them after 5s idle.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
}
