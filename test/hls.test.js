const test = require('node:test');
const assert = require('node:assert');
const { MockAgent, setGlobalDispatcher } = require('undici');
const hls = require('../dist/hls');
const { decodeProxyToken } = require('../dist/proxy');

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=NO,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="it",DEFAULT=YES,URI="audio/it.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="a"
v720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="a"
v1080.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:6.000,
seg0.ts
#EXTINF:4.5,
seg1.ts
#EXT-X-ENDLIST
`;

test('picks the 1080p variant and parses audio renditions', () => {
    const master = hls.pickBestVariant(MASTER, 'https://cdn.example/p/master.m3u8');
    assert.strictEqual(master.best.url, 'https://cdn.example/p/v1080.m3u8');
    const audio = hls.parseRenditions(master.mediaLines, 'https://cdn.example/p/master.m3u8');
    assert.deepStrictEqual(audio.map((a) => [a.uri, a.isDefault]), [
        ['https://cdn.example/p/audio/en.m3u8', false],
        ['https://cdn.example/p/audio/it.m3u8', true],
    ]);
});

test('rewritten master keeps only the best variant and carries the stream context', () => {
    const ctx = { t: 'series', i: 'tt1:1:1', c: 'cfg' };
    const master = hls.pickBestVariant(MASTER, 'https://cdn.example/p/master.m3u8');
    const out = hls.rewriteMaster(master, 'https://cdn.example/p/master.m3u8', {}, 'http://addon', ctx);
    const urls = out.split('\n').filter((l) => l.startsWith('http://addon'));
    assert.strictEqual(urls.length, 1);
    assert.strictEqual(out.match(/RESOLUTION=1920x1080/g).length, 1);
    assert.doesNotMatch(out, /1280x720/);
    const token = new URL(urls[0]).searchParams.get('token');
    assert.deepStrictEqual(decodeProxyToken(token).c, ctx);
});

test('parses segment durations from #EXTINF', () => {
    const segs = hls.parseMediaPlaylist(MEDIA, 'https://cdn.example/p/v1080.m3u8');
    assert.deepStrictEqual(segs, [
        { url: 'https://cdn.example/p/seg0.ts', duration: 6 },
        { url: 'https://cdn.example/p/seg1.ts', duration: 4.5 },
    ]);
});

test('rewritten media playlist proxies segments and keys', () => {
    const out = hls.rewriteMedia(MEDIA, 'https://cdn.example/p/v1080.m3u8', {}, 'http://addon');
    assert.strictEqual(out.match(/http:\/\/addon\/proxy\/hls\/segment\.ts\?token=/g).length, 3);
    assert.match(out, /#EXTINF:6.000,/);
});

test('fMP4 playlists get .mp4 segment URLs, including the init segment', () => {
    const fmp4 = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg0.m4s\n#EXTINF:6,\nseg1.m4s\n#EXT-X-ENDLIST\n';
    const out = hls.rewriteMedia(fmp4, 'https://cdn.example/p/v.m3u8', {}, 'http://addon');
    assert.strictEqual(out.match(/http:\/\/addon\/proxy\/hls\/segment\.mp4\?token=/g).length, 3);
    assert.doesNotMatch(out, /segment\.ts/);
});

test('VOD playlists are cached, retried on 5xx, live ones are not cached', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const cdn = agent.get('https://cdn.example');
    cdn.intercept({ path: '/vod.m3u8' }).reply(502, '');
    cdn.intercept({ path: '/vod.m3u8' }).reply(200, MEDIA);
    cdn.intercept({ path: '/live.m3u8' }).reply(200, '#EXTM3U\n#EXTINF:4,\na.ts\n').times(2);

    assert.strictEqual(await hls.loadPlaylist('https://cdn.example/vod.m3u8', {}), MEDIA);
    // Second call served from cache (no interceptor left; would throw if it hit the network)
    assert.strictEqual(await hls.loadPlaylist('https://cdn.example/vod.m3u8', {}), MEDIA);

    await hls.loadPlaylist('https://cdn.example/live.m3u8', {});
    await hls.loadPlaylist('https://cdn.example/live.m3u8', {});
    agent.assertNoPendingInterceptors();
});
