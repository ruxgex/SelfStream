import { request } from 'undici';
import { config } from './config';
import { makeProxyToken } from './proxy';
import { withTimeout } from './http';
import { isMasterPlaylist, loadPlaylist, pickBestVariant } from './hls';

/**
 * VideM (videm.buzz, the backend behind 2embed). The embed page carries a plain JSON
 * blob (`var Q = {...}`) with a signed token and the server list; `api.php?a=play`
 * then returns a direct HLS or MP4 URL for one server.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAX_SERVERS = parseInt(process.env.VIDEM_MAX_SERVERS || '4', 10);
const PLAY_TIMEOUT_MS = 5000;
const QUALITY_TIMEOUT_MS = 3000;

type VideMStream = { name: string; title: string; url: string; behaviorHints?: any };

interface Quality {
    height?: number;
    codec?: string;
}

interface VideMServer {
    ref: string;
    name: string;
    lang: string | null;
}

interface VideMPage {
    type: string;
    id: string;
    s: number;
    e: number;
    t: string;
    ssr?: { status?: string; title?: string; servers?: VideMServer[] } | null;
}

function origin(): string {
    return `https://${config.videmDomain}`;
}

function siteHeaders(referer: string): Record<string, string> {
    return { 'User-Agent': UA, 'Accept': '*/*', 'Referer': referer };
}

async function getText(url: string, referer: string): Promise<string | null> {
    const { body, statusCode } = await request(url, { headers: siteHeaders(referer), headersTimeout: 8000, bodyTimeout: 8000 });
    if (statusCode !== 200) {
        await body.dump();
        console.log(`[VideM] ${url.substring(0, 80)} responded ${statusCode}`);
        return null;
    }
    return body.text();
}

export function parseVideMPage(html: string): VideMPage | null {
    const m = html.match(/var Q\s*=\s*(\{.*?\});\s*\n/s);
    if (!m) return null;
    try {
        const q = JSON.parse(m[1]);
        return typeof q?.t === 'string' ? q : null;
    } catch {
        return null;
    }
}

/** English language name for a config code, e.g. 'pt-br' → 'portuguese'. */
function languageName(code: string): string {
    try {
        return (new Intl.DisplayNames(['en'], { type: 'language' }).of(code.split('-')[0]) || '').toLowerCase();
    } catch {
        return '';
    }
}

/**
 * Servers in the preferred language first, then those with no language label (usually
 * the original audio), dropping servers labelled with some other language.
 */
export function rankServers(servers: VideMServer[], preferredLang: string): VideMServer[] {
    const wanted = languageName(preferredLang);
    const matches = (s: VideMServer) => !!wanted && !!s.lang && s.lang.toLowerCase().includes(wanted);
    return [
        ...servers.filter(matches),
        ...servers.filter((s) => !s.lang),
    ];
}

/**
 * Read the stream's resolution and video codec from its master playlist. Goes through
 * loadPlaylist, so the proxy reuses the cached copy when the player opens the stream.
 */
async function probeQuality(url: string, headers: Record<string, string>): Promise<Quality> {
    const text = await loadPlaylist(url, headers);
    if (!isMasterPlaylist(text)) return {};
    const master = pickBestVariant(text, url);
    if (!master) return {};
    const codecs = master.best.info.match(/CODECS="([^"]+)"/i)?.[1] || '';
    const codec = /hvc1|hev1/i.test(codecs) ? 'HEVC' : /av01/i.test(codecs) ? 'AV1' : '';
    return { height: master.best.height || undefined, codec: codec || undefined };
}

function qualityLabel(height?: number): string {
    if (!height) return '';
    if (height >= 2000) return '4K';
    // Cinema crops (e.g. 1280x640) still count as their nominal tier.
    for (const tier of [1080, 720, 480, 360]) if (height >= tier * 0.85) return `${tier}p`;
    return `${height}p`;
}

/** e.g. "🎬 Best Medicine S2E7\n1080p · HEVC · XPT2" */
export function formatTitle(mediaTitle: string, q: Quality, kind: string, lang: string | null, server: string): string {
    const title = mediaTitle.replace(/\s+Season\s+(\d+)\s+Episode\s+(\d+)$/i, ' S$1E$2');
    const details = [qualityLabel(q.height), q.codec, kind, lang, server].filter(Boolean).join(' · ');
    return title ? `🎬 ${title}\n${details}` : details;
}

async function resolvePlay(server: VideMServer, token: string, referer: string): Promise<{ url: string; type: string } | null> {
    const url = `${origin()}/api.php?a=play&ref=${encodeURIComponent(server.ref)}&t=${encodeURIComponent(token)}`;
    const text = await getText(url, referer);
    if (!text) return null;
    try {
        const data = JSON.parse(text);
        if (typeof data?.url !== 'string' || !data.url) return null;
        return { url: new URL(data.url, `${origin()}/`).toString(), type: String(data.type || '') };
    } catch {
        return null;
    }
}

export async function getVideMStreams(
    type: 'movie' | 'series',
    id: string,
    season?: string,
    episode?: string,
    preferredLang: string = 'en'
): Promise<VideMStream[]> {
    const path = type === 'series'
        ? `/embed/tv/${encodeURIComponent(id)}/${season || 1}/${episode || 1}`
        : `/embed/movie/${encodeURIComponent(id)}`;
    const pageUrl = `${origin()}${path}`;
    console.log(`[VideM] Fetching ${pageUrl}`);

    const html = await getText(pageUrl, `${origin()}/`);
    if (!html) return [];
    const page = parseVideMPage(html);
    if (!page) {
        console.log('[VideM] Player data not found in embed page');
        return [];
    }

    let servers = page.ssr?.servers || [];
    if (servers.length === 0) {
        const qs = `type=${page.type}&id=${encodeURIComponent(page.id)}&s=${page.s}&e=${page.e}&t=${encodeURIComponent(page.t)}`;
        const text = await getText(`${origin()}/api.php?a=sources&${qs}`, pageUrl);
        try {
            servers = (text && JSON.parse(text)?.servers) || [];
        } catch {
            servers = [];
        }
    }

    const ranked = rankServers(servers, preferredLang).slice(0, MAX_SERVERS);
    if (ranked.length === 0) {
        console.log(`[VideM] No servers (${servers.length} found, none in '${preferredLang}' or unlabelled)`);
        return [];
    }

    const played = await Promise.all(ranked.map((s) =>
        withTimeout(resolvePlay(s, page.t, pageUrl), PLAY_TIMEOUT_MS, `VideM ${s.name}`).catch(() => null)
    ));

    const headers = siteHeaders(`${origin()}/`);
    const qualities = await Promise.all(ranked.map((_, i) => {
        const p = played[i];
        if (!p || p.type !== 'hls') return Promise.resolve({} as Quality);
        return withTimeout(probeQuality(p.url, headers), QUALITY_TIMEOUT_MS, 'VideM quality').catch(() => ({} as Quality));
    }));

    const wanted = languageName(preferredLang);
    const mediaTitle = page.ssr?.title || '';
    const resolved: { stream: VideMStream; inLang: boolean; proxied: boolean; height: number }[] = [];
    ranked.forEach((server, i) => {
        const p = played[i];
        if (!p) return;
        const label = server.name.replace(/^Server\s+/i, '');
        const q = qualities[i];
        const proxied = p.type === 'hls';
        // "VRS2-English" / "VNZ-English · MP4" → "VRS2" / "VNZ": language and kind are shown separately.
        const shortName = label.split(/\s*[-·]\s*/)[0] || label;
        const title = formatTitle(mediaTitle, q, proxied ? '' : 'Direct file', server.lang, shortName);
        const bingeGroup = `selfstream-videm-${preferredLang}-${label}`;
        const stream: VideMStream = proxied
            ? {
                name: 'VideM 🤌',
                title,
                url: `/proxy/hls/manifest.m3u8?token=${makeProxyToken(p.url, headers)}`,
                behaviorHints: { bingeGroup },
            }
            : {
                name: 'VideM 🤌',
                title,
                url: p.url,
                behaviorHints: { bingeGroup, notWebReady: true, proxyHeaders: { request: headers } },
            };
        const inLang = !!wanted && !!server.lang && server.lang.toLowerCase().includes(wanted);
        resolved.push({ stream, inLang, proxied, height: q.height || 0 });
    });

    // Your language first; then HLS (buffered by our proxy) before direct files; then best quality.
    resolved.sort((a, b) =>
        Number(b.inLang) - Number(a.inLang) ||
        Number(b.proxied) - Number(a.proxied) ||
        b.height - a.height
    );
    const streams = resolved.map((r) => r.stream);
    console.log(`[VideM] ${streams.length}/${ranked.length} servers resolved`);
    return streams;
}
