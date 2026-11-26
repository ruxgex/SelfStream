/**
 * Next-episode warm-up: near the end of an episode, resolve the next one and download
 * its playlists and first minute of segments, so autoplay starts instantly.
 */

import { decodeConfig, UserConfig } from './config';
import { decodeProxyToken, StreamCtx } from './proxy';
import { isMasterPlaylist, loadPlaylist, parseMediaPlaylist, parseRenditions, pickBestVariant } from './hls';
import { registerMediaPlaylist } from './segment-cache';

const NEXT_EPISODE_SECONDS = parseInt(process.env.SEGMENT_NEXT_EPISODE_SECONDS || '60', 10);

/** Candidate ids for the episode after `id`, most likely first. */
export function nextEpisodeIds(type: string, id: string): string[] {
    const parts = id.split(':');
    if (parts[0] === 'kitsu') {
        if (parts.length < 3) return [];
        const ep = parseInt(parts[2], 10);
        return Number.isFinite(ep) ? [`kitsu:${parts[1]}:${ep + 1}`] : [];
    }
    if (type !== 'series') return [];

    let prefix: string;
    let season: number;
    let episode: number;
    if (parts[0] === 'tmdb' && parts.length >= 4) {
        prefix = `tmdb:${parts[1]}`;
        season = parseInt(parts[2], 10);
        episode = parseInt(parts[3], 10);
    } else if (parts[0].startsWith('tt') && parts.length >= 3) {
        prefix = parts[0];
        season = parseInt(parts[1], 10);
        episode = parseInt(parts[2], 10);
    } else {
        return [];
    }
    if (!Number.isFinite(season) || !Number.isFinite(episode)) return [];
    return [`${prefix}:${season}:${episode + 1}`, `${prefix}:${season + 1}:1`];
}

type ResolveStreams = (type: string, id: string, cfg: UserConfig) => Promise<{ url: string }[]>;

async function warmStreamUrl(streamUrl: string, warmSeconds: number): Promise<void> {
    const token = new URL(streamUrl, 'http://local').searchParams.get('token');
    const decoded = token ? decodeProxyToken(token) : null;
    if (!decoded?.u) return;
    const headers = decoded.h || {};

    const text = await loadPlaylist(decoded.u, headers);
    const mediaUrls: string[] = [];
    if (isMasterPlaylist(text)) {
        const master = pickBestVariant(text, decoded.u);
        if (!master) return;
        mediaUrls.push(master.best.url);
        const audio = parseRenditions(master.mediaLines, decoded.u).filter((r) => r.type === 'AUDIO');
        const chosen = audio.find((r) => r.isDefault) || audio[0];
        if (chosen) mediaUrls.push(chosen.uri);
    } else {
        registerMediaPlaylist(parseMediaPlaylist(text, decoded.u), headers, { lowPriority: true, warmSeconds });
        return;
    }

    for (const url of mediaUrls) {
        const media = await loadPlaylist(url, headers);
        registerMediaPlaylist(parseMediaPlaylist(media, url), headers, { lowPriority: true, warmSeconds });
    }
}

export function createNextEpisodeWarmer(resolveStreams: ResolveStreams, warmSeconds: number = NEXT_EPISODE_SECONDS) {
    const started = new Set<string>();

    return async function warmNextEpisode(ctx: StreamCtx): Promise<void> {
        const key = `${ctx.t}|${ctx.i}|${ctx.c}`;
        if (started.has(key)) return;
        if (started.size > 1000) started.clear();
        started.add(key);

        const cfg = decodeConfig(ctx.c);
        try {
            for (const nextId of nextEpisodeIds(ctx.t, ctx.i)) {
                const streams = await resolveStreams(ctx.t, nextId, cfg);
                if (streams.length === 0) continue;
                console.log(`[NextEpisode] Warming ${ctx.t} ${nextId}`);
                await warmStreamUrl(streams[0].url, warmSeconds);
                return;
            }
        } catch (err: any) {
            console.error('[NextEpisode] warm-up failed:', err?.message || err);
        }
    };
}
