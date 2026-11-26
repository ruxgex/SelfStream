/**
 * HLS playlist loading, parsing and rewriting for the proxy.
 */

import { request } from 'undici';
import { makeProxyToken, resolveUrl, StreamCtx } from './proxy';
import { isRetryableStatus, sleep } from './http';

const PLAYLIST_TTL_MS = parseInt(process.env.SEGMENT_PLAYLIST_TTL_MS || String(30 * 60 * 1000), 10);
const PLAYLIST_RETRIES = parseInt(process.env.SEGMENT_FETCH_RETRIES || '3', 10);
const RETRY_DELAYS_MS = [300, 1000, 2000];

export class PlaylistError extends Error {
    constructor(public status: number) {
        super(`Upstream playlist error ${status}`);
    }
}

const playlistCache = new Map<string, { text: string; expireAt: number }>();

setInterval(() => {
    const now = Date.now();
    for (const [url, entry] of playlistCache) {
        if (entry.expireAt < now) playlistCache.delete(url);
    }
}, 10 * 60 * 1000).unref();

export function isMasterPlaylist(text: string): boolean {
    return text.includes('#EXT-X-STREAM-INF:');
}

/**
 * Fetch a playlist, retrying transient failures. Master and finished (VOD) playlists
 * are cached so segment URLs stay stable between the player and the prefetcher.
 */
export async function loadPlaylist(upstream: string, headers: Record<string, string>): Promise<string> {
    const cached = playlistCache.get(upstream);
    if (cached && cached.expireAt > Date.now()) return cached.text;

    let lastStatus = 0;
    for (let attempt = 0; attempt <= PLAYLIST_RETRIES; attempt++) {
        if (attempt > 0) await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
        try {
            const { body, statusCode } = await request(upstream, {
                headers,
                headersTimeout: 10_000,
                bodyTimeout: 15_000,
            });
            if (statusCode !== 200) {
                await body.dump();
                lastStatus = statusCode;
                if (isRetryableStatus(statusCode)) continue;
                throw new PlaylistError(statusCode);
            }
            const text = await body.text();
            if (isMasterPlaylist(text) || text.includes('#EXT-X-ENDLIST')) {
                playlistCache.set(upstream, { text, expireAt: Date.now() + PLAYLIST_TTL_MS });
            }
            return text;
        } catch (err) {
            if (err instanceof PlaylistError) throw err;
            lastStatus = 0;
            if (attempt === PLAYLIST_RETRIES) throw err;
        }
    }
    throw new PlaylistError(lastStatus || 502);
}

export interface Variant {
    info: string;
    url: string;
    height: number;
    bandwidth: number;
}

export interface MasterPlaylist {
    best: Variant;
    mediaLines: string[];
    otherTags: string[];
}

/** Pick the highest-resolution (then highest-bandwidth) variant; null if none. */
export function pickBestVariant(text: string, upstream: string): MasterPlaylist | null {
    const lines = text.split(/\r?\n/);
    const variants: Variant[] = [];
    const mediaLines: string[] = [];
    const otherTags: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXT-X-MEDIA:')) {
            mediaLines.push(line);
        } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const nextLine = lines[i + 1];
            if (nextLine && !nextLine.startsWith('#')) {
                const hMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
                const bMatch = line.match(/BANDWIDTH=(\d+)/i);
                variants.push({
                    info: line,
                    url: resolveUrl(upstream, nextLine.trim()),
                    height: hMatch ? parseInt(hMatch[1], 10) : 0,
                    bandwidth: bMatch ? parseInt(bMatch[1], 10) : 0,
                });
                i++;
            }
        } else if (line.startsWith('#') && !line.startsWith('#EXTINF') && line !== '#EXTM3U') {
            otherTags.push(line);
        }
    }

    if (variants.length === 0) return null;
    variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    return { best: variants[0], mediaLines, otherTags };
}

export interface Rendition {
    type: string;
    uri: string;
    isDefault: boolean;
}

export function parseRenditions(mediaLines: string[], upstream: string): Rendition[] {
    const out: Rendition[] = [];
    for (const line of mediaLines) {
        const uri = line.match(/URI="([^"]+)"/)?.[1];
        if (!uri) continue;
        out.push({
            type: line.match(/TYPE=([A-Z-]+)/)?.[1] || '',
            uri: resolveUrl(upstream, uri),
            isDefault: /DEFAULT=YES/i.test(line),
        });
    }
    return out;
}

export function rewriteMaster(
    master: MasterPlaylist,
    upstream: string,
    headers: Record<string, string>,
    addonBase: string,
    ctx?: StreamCtx
): string {
    const manifestUrl = (url: string) =>
        `${addonBase}/proxy/hls/manifest.m3u8?token=${makeProxyToken(url, headers, undefined, ctx)}`;

    const result = ['#EXTM3U', ...master.otherTags];
    for (const ml of master.mediaLines) {
        result.push(ml.replace(/URI="([^"]+)"/, (_m: string, uri: string) => `URI="${manifestUrl(resolveUrl(upstream, uri))}"`));
    }
    result.push(master.best.info);
    result.push(manifestUrl(master.best.url));
    return result.join('\n');
}

export interface MediaSegment {
    url: string;
    duration: number;
}

/** Segment URLs (absolute) with their #EXTINF durations. */
export function parseMediaPlaylist(text: string, upstream: string): MediaSegment[] {
    const segments: MediaSegment[] = [];
    let duration = 0;
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('#EXTINF:')) {
            duration = parseFloat(line.substring(8)) || 0;
        } else if (!line.startsWith('#') && line.trim()) {
            segments.push({ url: resolveUrl(upstream, line.trim()), duration });
            duration = 0;
        }
    }
    return segments;
}

export function rewriteMedia(text: string, upstream: string, headers: Record<string, string>, addonBase: string): string {
    const segmentUrl = (url: string) => `${addonBase}/proxy/hls/segment.ts?token=${makeProxyToken(url, headers)}`;
    const result: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        if ((line.includes('#EXT-X-KEY:') || line.includes('#EXT-X-MAP:')) && line.includes('URI=')) {
            result.push(line.replace(/URI="([^"]+)"/g, (_m: string, uri: string) => `URI="${segmentUrl(resolveUrl(upstream, uri))}"`));
        } else if (!line.startsWith('#') && line.trim()) {
            result.push(segmentUrl(resolveUrl(upstream, line.trim())));
        } else {
            result.push(line);
        }
    }
    return result.join('\n');
}
