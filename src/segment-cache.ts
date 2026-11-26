/**
 * In-memory HLS segment cache with time-window prefetch.
 *
 * SelfStream normally runs on a home server whose WAN link (e.g. 4G) is the bottleneck,
 * while the LAN to the TV is fast. So we download minutes ahead of the playhead in
 * parallel, retry flaky upstream fetches, and stream bytes to the player as they arrive.
 */

import { request } from 'undici';
import { isRetryableStatus, sleep } from './http';

const envInt = (name: string, fallback: number) => {
    const v = parseInt(process.env[name] || '', 10);
    return Number.isFinite(v) ? v : fallback;
};

const MAX_ENTRIES = envInt('SEGMENT_CACHE_MAX_ENTRIES', 5000);
const MAX_BYTES = envInt('SEGMENT_CACHE_MAX_MB', 2048) * 1024 * 1024;
const TTL_MS = envInt('SEGMENT_CACHE_TTL_MS', 2 * 3600 * 1000);
const PLAYLIST_TTL_MS = envInt('SEGMENT_PLAYLIST_TTL_MS', 30 * 60 * 1000);
const PREFETCH_AHEAD_SECONDS = envInt('SEGMENT_PREFETCH_AHEAD_SECONDS', 240);
const PREFETCH_CONCURRENCY = Math.max(1, envInt('SEGMENT_PREFETCH_CONCURRENCY', 4));
const GUESS_PREFETCH_COUNT = envInt('SEGMENT_CACHE_PREFETCH', 3);
const FETCH_RETRIES = envInt('SEGMENT_FETCH_RETRIES', 3);
const HEADERS_TIMEOUT_MS = envInt('SEGMENT_HEADERS_TIMEOUT_MS', 10_000);
const BODY_TIMEOUT_MS = envInt('SEGMENT_BODY_TIMEOUT_MS', 15_000);
const START_WARM_SECONDS = 30;
const NEAR_END_FRACTION = 0.9;
const NEAR_END_REMAINING_SECONDS = 180;
const RETRY_DELAYS_MS = [300, 1000, 2000];

interface CacheEntry {
    data: Buffer;
    contentType: string;
    size: number;
    expireAt: number;
}

export interface PlaylistSegment {
    url: string;
    duration: number;
}

export interface RegisterOptions {
    /** Fired once when playback passes ~90% of the playlist (or <3 min left). */
    onNearEnd?: () => void;
    /** Prefetch after all normal-priority work (next-episode warm-up). */
    lowPriority?: boolean;
    /** Seconds from the start to download right away. */
    warmSeconds?: number;
}

interface PlaylistContext {
    segments: PlaylistSegment[];
    /** cumulative[i] = start time of segment i */
    cumulative: number[];
    total: number;
    index: Map<string, number>;
    headers: Record<string, string>;
    expireAt: number;
    pending: number[];
    windowStart: number;
    windowEnd: number;
    lastTouched: number;
    lowPriority: boolean;
    onNearEnd?: () => void;
    nearEndFired: boolean;
}

interface Listener {
    onData(chunk: Buffer): void;
    onEnd(): void;
    onError(): void;
}

interface Download {
    url: string;
    chunks: Buffer[];
    contentType: string;
    state: 'running' | 'done' | 'failed';
    listeners: Set<Listener>;
    done: Promise<CacheEntry | null>;
}

const cache = new Map<string, CacheEntry>();
const downloads = new Map<string, Download>();
const playlistByKey = new Map<string, PlaylistContext>();
const playlistBySegmentUrl = new Map<string, PlaylistContext>();
const looseQueue: { url: string; headers: Record<string, string> }[] = [];

let totalBytes = 0;
let activePrefetches = 0;
let roundRobin = 0;

// ── Cache ──

function cacheDelete(key: string): void {
    const entry = cache.get(key);
    if (!entry) return;
    totalBytes -= entry.size;
    cache.delete(key);
}

function cacheGet(key: string): CacheEntry | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expireAt < Date.now()) {
        cacheDelete(key);
        return undefined;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry;
}

/** Segments inside a recently played window are evicted only as a last resort. */
function isProtected(url: string): boolean {
    const ctx = playlistBySegmentUrl.get(url);
    if (!ctx || Date.now() - ctx.lastTouched > 10 * 60 * 1000) return false;
    const idx = ctx.index.get(url)!;
    return idx >= ctx.windowStart && idx <= ctx.windowEnd;
}

function evictOne(): boolean {
    let victim: string | undefined;
    for (const key of cache.keys()) {
        if (!isProtected(key)) { victim = key; break; }
    }
    victim ??= cache.keys().next().value;
    if (!victim) return false;
    cacheDelete(victim);
    return true;
}

function cacheSet(key: string, entry: CacheEntry): void {
    if (entry.size > MAX_BYTES) return;
    cacheDelete(key);
    while (cache.size > 0 && (cache.size >= MAX_ENTRIES || totalBytes + entry.size > MAX_BYTES)) {
        if (!evictOne()) break;
    }
    cache.set(key, entry);
    totalBytes += entry.size;
}

// ── Download (retry + range resume + stream-through) ──

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TS_PACKET = 188;
// Bytes needed to tell whether a segment starts with a PNG signature.
const PNG_SIG_BYTES = PNG_SIG.length;
// How far into a PNG-disguised segment to look for the MPEG-TS start.
const PNG_MAX_SCAN_BYTES = 256 * 1024;

function isTsSyncAt(buf: Buffer, k: number): boolean {
    return buf[k] === 0x47 && buf[k + TS_PACKET] === 0x47 && buf[k + 2 * TS_PACKET] === 0x47;
}

const MP4_BOXES = new Set(['ftyp', 'styp', 'moov', 'moof', 'sidx', 'mdat']);

function isMp4BoxAt(buf: Buffer, k: number): boolean {
    return k + 8 <= buf.length && MP4_BOXES.has(buf.toString('latin1', k + 4, k + 8));
}

export interface Disguise {
    /** Leading bytes to drop. */
    offset: number;
    /** Real content type of what follows, when it was disguised. */
    contentType?: string;
}

/**
 * Some CDNs disguise media segments as PNG images: either a bare PNG signature or a whole
 * small PNG image in front of MPEG-TS or fragmented-MP4 data. Returns what to strip, or
 * null if more bytes are needed to decide.
 */
export function detectDisguise(head: Buffer, final: boolean): Disguise | null {
    if (head.length < PNG_SIG_BYTES) return final ? { offset: 0 } : null;
    if (!head.subarray(0, PNG_SIG_BYTES).equals(PNG_SIG)) return { offset: 0 };

    // A complete PNG image: the media starts right after the IEND chunk (type + CRC).
    const iend = head.indexOf('IEND', PNG_SIG_BYTES, 'latin1');
    if (iend >= 0) {
        const k = iend + 8;
        if (isMp4BoxAt(head, k)) return { offset: k, contentType: 'video/mp4' };
        if (head[k] === 0x47) return { offset: k, contentType: 'video/mp2t' };
        if (head.length < k + 8 && !final) return null;
    }
    // A bare signature (or PNG chunks we can't follow): look for the TS sync pattern.
    for (let k = PNG_SIG_BYTES; k + 2 * TS_PACKET < head.length; k++) {
        if (isTsSyncAt(head, k)) return { offset: k, contentType: 'video/mp2t' };
    }
    if (!final && head.length < PNG_MAX_SCAN_BYTES) return null;
    // Short segment: accept a single TS packet right after the signature.
    return head[PNG_SIG_BYTES] === 0x47 ? { offset: PNG_SIG_BYTES, contentType: 'video/mp2t' } : { offset: 0 };
}

class NonRetryable extends Error {}

function startDownload(url: string, headers: Record<string, string>): Download {
    const existing = downloads.get(url);
    if (existing) return existing;

    const dl: Download = {
        url,
        chunks: [],
        contentType: 'video/mp2t',
        state: 'running',
        listeners: new Set(),
        done: null as any,
    };

    let head: Buffer[] = [];
    let headLen = 0;
    let decided = false;

    const emit = (chunk: Buffer) => {
        if (chunk.length === 0) return;
        dl.chunks.push(chunk);
        for (const l of dl.listeners) l.onData(chunk);
    };
    const push = (chunk: Buffer) => {
        if (decided) return emit(chunk);
        head.push(chunk);
        headLen += chunk.length;
        flushHead(false);
    };
    const flushHead = (final: boolean) => {
        if (decided) return;
        const buf = Buffer.concat(head, headLen);
        const disguise = detectDisguise(buf, final);
        if (!disguise) {
            head = [buf];
            return;
        }
        decided = true;
        head = [];
        // The upstream labels disguised segments image/png; players need the real type.
        if (disguise.contentType) dl.contentType = disguise.contentType;
        emit(buf.subarray(disguise.offset));
    };

    dl.done = (async (): Promise<CacheEntry | null> => {
        let rawOffset = 0;
        for (let attempt = 0; ; attempt++) {
            try {
                const reqHeaders = rawOffset > 0 ? { ...headers, Range: `bytes=${rawOffset}-` } : headers;
                const { body, statusCode, headers: respHeaders } = await request(url, {
                    headers: reqHeaders,
                    // Some CDNs (e.g. VideM's XPT servers) redirect segment URLs to the real host.
                    maxRedirections: 3,
                    headersTimeout: HEADERS_TIMEOUT_MS,
                    bodyTimeout: BODY_TIMEOUT_MS,
                });
                if (statusCode !== 200 && statusCode !== 206) {
                    await body.dump();
                    if (isRetryableStatus(statusCode)) throw new Error(`status ${statusCode}`);
                    throw new NonRetryable(`status ${statusCode}`);
                }
                if (rawOffset === 0) {
                    const ct = respHeaders['content-type'];
                    const contentType = Array.isArray(ct) ? ct[0] : ct;
                    // Image types come from CDNs disguising TS segments; keep video/mp2t.
                    if (contentType && !contentType.startsWith('image/')) dl.contentType = contentType;
                }
                // A full response to a range request: skip what we already have.
                let skip = rawOffset > 0 && statusCode === 200 ? rawOffset : 0;
                for await (const part of body) {
                    let chunk = part as Buffer;
                    if (skip > 0) {
                        if (chunk.length <= skip) { skip -= chunk.length; continue; }
                        chunk = chunk.subarray(skip);
                        skip = 0;
                    }
                    rawOffset += chunk.length;
                    push(chunk);
                }
                if (skip > 0) throw new Error('short body on resume');
                break;
            } catch (err: any) {
                if (err instanceof NonRetryable || attempt >= FETCH_RETRIES) {
                    console.error(`[SegmentCache] fetch failed (${attempt + 1} attempts): ${err?.message || err} ${url.substring(0, 80)}`);
                    dl.state = 'failed';
                    downloads.delete(url);
                    for (const l of dl.listeners) l.onError();
                    dl.listeners.clear();
                    return null;
                }
                await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
            }
        }

        flushHead(true);
        const data = Buffer.concat(dl.chunks);
        const entry: CacheEntry = { data, contentType: dl.contentType, size: data.length, expireAt: Date.now() + TTL_MS };
        cacheSet(url, entry);
        dl.state = 'done';
        downloads.delete(url);
        for (const l of dl.listeners) l.onEnd();
        dl.listeners.clear();
        return entry;
    })();

    downloads.set(url, dl);
    return dl;
}

// ── Prefetch scheduling ──

function isQueuedWorkDone(url: string): boolean {
    return cache.has(url) || downloads.has(url);
}

function nextJob(): { url: string; headers: Record<string, string> } | null {
    const now = Date.now();
    const live = new Set<PlaylistContext>();
    for (const ctx of playlistByKey.values()) {
        if (ctx.expireAt >= now && ctx.pending.length > 0) live.add(ctx);
    }

    const normal = [...live].filter((c) => !c.lowPriority);
    const low = [...live].filter((c) => c.lowPriority);

    // Round-robin between normal playlists so video and audio renditions advance together.
    for (let n = 0; n < normal.length; n++) {
        const ctx = normal[(roundRobin + n) % normal.length];
        const job = takePending(ctx);
        if (job) { roundRobin = (roundRobin + n + 1) % Math.max(1, normal.length); return job; }
    }
    while (looseQueue.length > 0) {
        const job = looseQueue.shift()!;
        if (!isQueuedWorkDone(job.url)) return job;
    }
    for (const ctx of low) {
        const job = takePending(ctx);
        if (job) return job;
    }
    return null;
}

function takePending(ctx: PlaylistContext): { url: string; headers: Record<string, string> } | null {
    while (ctx.pending.length > 0) {
        const idx = ctx.pending.shift()!;
        const url = ctx.segments[idx].url;
        if (!isQueuedWorkDone(url)) return { url, headers: ctx.headers };
    }
    return null;
}

function pump(): void {
    while (activePrefetches < PREFETCH_CONCURRENCY) {
        const job = nextJob();
        if (!job) return;
        activePrefetches++;
        void startDownload(job.url, job.headers).done.finally(() => {
            activePrefetches--;
            pump();
        });
    }
}

/** Indices after `from` until `seconds` of media are covered. */
function windowFrom(ctx: PlaylistContext, from: number, seconds: number): number[] {
    const out: number[] = [];
    const startTime = ctx.cumulative[from] ?? 0;
    for (let i = from; i < ctx.segments.length; i++) {
        if (ctx.cumulative[i] - startTime >= seconds && out.length > 0) break;
        out.push(i);
    }
    return out;
}

function guessNextSegmentUrls(url: string, count: number): string[] {
    const match = url.match(/^(.*?)(\d+)(\.[^./?#]+(?:\?.*)?)$/);
    if (!match) return [];
    const [, prefix, numStr, suffix] = match;
    const num = parseInt(numStr, 10);
    const results: string[] = [];
    for (let i = 1; i <= count; i++) {
        results.push(`${prefix}${String(num + i).padStart(numStr.length, '0')}${suffix}`);
    }
    return results;
}

function getPlaylistContext(url: string): PlaylistContext | null {
    const ctx = playlistBySegmentUrl.get(url);
    if (!ctx) return null;
    if (ctx.expireAt < Date.now()) {
        dropPlaylist(ctx);
        return null;
    }
    return ctx;
}

function dropPlaylist(ctx: PlaylistContext): void {
    for (const [key, c] of playlistByKey) if (c === ctx) playlistByKey.delete(key);
    for (const s of ctx.segments) {
        if (playlistBySegmentUrl.get(s.url) === ctx) playlistBySegmentUrl.delete(s.url);
    }
}

function schedulePrefetch(url: string, headers: Record<string, string>): void {
    const ctx = getPlaylistContext(url);
    if (ctx) {
        const idx = ctx.index.get(url)!;
        // Replace (not append) pending work, so a seek moves bandwidth to the new playhead.
        const window = windowFrom(ctx, idx + 1, PREFETCH_AHEAD_SECONDS);
        ctx.pending = window;
        ctx.windowStart = idx;
        ctx.windowEnd = window.length ? window[window.length - 1] : idx;
        ctx.lastTouched = Date.now();
        ctx.lowPriority = false;
        ctx.expireAt = Date.now() + PLAYLIST_TTL_MS;

        if (!ctx.nearEndFired && ctx.onNearEnd && ctx.total > 0) {
            const position = ctx.cumulative[idx];
            if (position >= ctx.total * NEAR_END_FRACTION || ctx.total - position <= NEAR_END_REMAINING_SECONDS) {
                ctx.nearEndFired = true;
                try { ctx.onNearEnd(); } catch (err) { console.error('[SegmentCache] onNearEnd error:', err); }
            }
        }
    } else {
        for (const next of guessNextSegmentUrls(url, GUESS_PREFETCH_COUNT)) {
            if (!isQueuedWorkDone(next)) looseQueue.push({ url: next, headers });
        }
    }
    pump();
}

export function registerMediaPlaylist(
    segments: PlaylistSegment[],
    headers: Record<string, string>,
    opts: RegisterOptions = {}
): void {
    if (segments.length === 0) return;
    const key = `${segments[0].url}#${segments.length}`;

    let ctx = playlistByKey.get(key);
    if (ctx && ctx.expireAt < Date.now()) {
        dropPlaylist(ctx);
        ctx = undefined;
    }

    if (ctx) {
        ctx.headers = headers;
        ctx.expireAt = Date.now() + PLAYLIST_TTL_MS;
        if (opts.onNearEnd) ctx.onNearEnd = opts.onNearEnd;
        if (!opts.lowPriority) ctx.lowPriority = false;
    } else {
        const cumulative: number[] = [];
        let t = 0;
        for (const s of segments) {
            cumulative.push(t);
            t += s.duration > 0 ? s.duration : 0;
        }
        ctx = {
            segments,
            cumulative,
            total: t,
            index: new Map(segments.map((s, i) => [s.url, i])),
            headers,
            expireAt: Date.now() + PLAYLIST_TTL_MS,
            pending: [],
            windowStart: 0,
            windowEnd: -1,
            lastTouched: 0,
            lowPriority: Boolean(opts.lowPriority),
            onNearEnd: opts.onNearEnd,
            nearEndFired: false,
        };
        playlistByKey.set(key, ctx);
        for (const s of segments) playlistBySegmentUrl.set(s.url, ctx);
    }

    // Warm the beginning only if nothing has been played from this playlist yet.
    if (ctx.lastTouched === 0) {
        const warm = windowFrom(ctx, 0, opts.warmSeconds ?? Math.min(PREFETCH_AHEAD_SECONDS, START_WARM_SECONDS));
        ctx.pending = warm;
        ctx.windowStart = 0;
        ctx.windowEnd = warm.length ? warm[warm.length - 1] : -1;
    }
    pump();
}

export async function serveSegment(url: string, headers: Record<string, string>, res: any): Promise<void> {
    const entry = cacheGet(url);
    if (entry) {
        res.setHeader('Content-Type', entry.contentType);
        res.setHeader('Content-Length', entry.size);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('X-Segment-Cache', 'HIT');
        res.end(entry.data);
        schedulePrefetch(url, headers);
        return;
    }

    const joined = downloads.has(url);
    const dl = startDownload(url, headers);
    schedulePrefetch(url, headers);

    await new Promise<void>((resolve) => {
        let started = false;
        const begin = () => {
            if (started) return;
            started = true;
            res.setHeader('Content-Type', dl.contentType);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('X-Segment-Cache', joined ? 'INFLIGHT' : 'MISS');
        };
        const listener: Listener = {
            onData(chunk) { begin(); res.write(chunk); },
            onEnd() { begin(); res.end(); resolve(); },
            onError() {
                if (!started && !res.headersSent) res.status(502).send('Upstream error');
                else res.destroy();
                resolve();
            },
        };

        res.on('close', () => { dl.listeners.delete(listener); resolve(); });

        for (const chunk of dl.chunks) listener.onData(chunk);
        if (dl.state === 'done') listener.onEnd();
        else if (dl.state === 'failed') listener.onError();
        else dl.listeners.add(listener);
    });
}

setInterval(() => {
    const now = Date.now();
    for (const ctx of new Set(playlistByKey.values())) {
        if (ctx.expireAt < now) dropPlaylist(ctx);
    }
    for (const [key, entry] of cache) {
        if (entry.expireAt < now) cacheDelete(key);
    }
}, 5 * 60 * 1000).unref();

/** Test/diagnostic helpers. */
export function _stats() {
    return { entries: cache.size, bytes: totalBytes, downloads: downloads.size, activePrefetches };
}

export function _isCached(url: string): boolean {
    return cache.has(url);
}

export function _pendingFor(url: string): string[] {
    const ctx = playlistBySegmentUrl.get(url);
    return ctx ? ctx.pending.map((i) => ctx.segments[i].url) : [];
}
