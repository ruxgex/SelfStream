const test = require('node:test');
const assert = require('node:assert');
const { MockAgent, setGlobalDispatcher } = require('undici');
const { getVideMStreams, rankServers, parseVideMPage, formatTitle } = require('../dist/videm');

function page(q) {
    return `<html><body><script>
(function(){
  var Q = ${JSON.stringify(q)};
  var qs='type='+Q.type;
})();
</script></body></html>`;
}

function decodeUpstream(streamUrl) {
    const token = new URL(streamUrl, 'http://addon').searchParams.get('token');
    return JSON.parse(Buffer.from(token, 'base64url').toString()).u;
}

const servers = [
    { ref: 'r-hi', name: 'Server VRS1-Hindi', lang: 'Hindi' },
    { ref: 'r-en', name: 'Server VRS2-English', lang: 'English' },
    { ref: 'r-x', name: 'Server XPT1', lang: null },
    { ref: 'r-mp4', name: 'Server VNZ-English · MP4', lang: 'English' },
];

test('parses the player data blob from the embed page', () => {
    const q = parseVideMPage(page({ type: 'movie', id: 'tt1', s: 0, e: 0, t: 'tok', ssr: { servers } }));
    assert.strictEqual(q.t, 'tok');
    assert.strictEqual(q.ssr.servers.length, 4);
    assert.strictEqual(parseVideMPage('<html>nothing</html>'), null);
});

test('ranks preferred-language servers first, then unlabelled, dropping other languages', () => {
    const names = rankServers(servers, 'en').map((s) => s.name);
    assert.deepStrictEqual(names, ['Server VRS2-English', 'Server VNZ-English · MP4', 'Server XPT1']);
    assert.deepStrictEqual(rankServers(servers, 'it').map((s) => s.name), ['Server XPT1']);
});

test('resolves servers into proxied HLS and direct MP4 streams, labelled with quality', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const site = agent.get('https://videm.buzz');
    site.intercept({ path: '/embed/tv/tt36885662/2/7' }).reply(200, page({
        type: 'tv', id: 'tt36885662', s: 2, e: 7, t: 'tok',
        ssr: { status: 'ok', title: 'Best Medicine Season 2 Episode 7', servers },
    }));
    site.intercept({ path: '/api.php?a=play&ref=r-en&t=tok' }).reply(200, { url: '/_stream?id=abc', type: 'hls' });
    site.intercept({ path: '/api.php?a=play&ref=r-x&t=tok' }).reply(200, { url: '/_stream?id=def', type: 'hls' });
    site.intercept({ path: '/api.php?a=play&ref=r-mp4&t=tok' }).reply(200, { url: 'https://cdn.example/ep.mkv', type: 'mp4' });
    site.intercept({ path: '/_stream?id=abc' }).reply(200,
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x640,CODECS="avc1.64001f,mp4a.40.2"\nv720.m3u8\n');
    site.intercept({ path: '/_stream?id=def' }).reply(200,
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\nlo.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="hvc1.1.6.L120.b0,mp4a.40.2"\nhi.m3u8\n');

    const streams = await getVideMStreams('series', 'tt36885662', '2', '7', 'en');
    assert.deepStrictEqual(streams.map((s) => s.title), [
        '🎬 Best Medicine S2E7\n720p · English · VRS2',
        '🎬 Best Medicine S2E7\nDirect file · English · VNZ',
        '🎬 Best Medicine S2E7\n1080p · HEVC · XPT1',
    ]);
    assert.strictEqual(decodeUpstream(streams[0].url), 'https://videm.buzz/_stream?id=abc');
    assert.strictEqual(streams[1].url, 'https://cdn.example/ep.mkv');
    assert.strictEqual(streams[1].behaviorHints.notWebReady, true);
    assert.ok(streams.every((s) => s.name === 'VideM 🤌'));
});

test('formats titles without a media title or quality', () => {
    assert.strictEqual(formatTitle('', {}, '', null, 'XPT1'), 'XPT1');
    assert.strictEqual(formatTitle('Fight Club', { height: 2160 }, '', 'English', 'SWM1'), '🎬 Fight Club\n4K · English · SWM1');
});

test('falls back to the sources API when the page has no server list, skipping failed plays', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const site = agent.get('https://videm.buzz');
    site.intercept({ path: '/embed/movie/550' }).reply(200, page({ type: 'movie', id: '550', s: 0, e: 0, t: 'tok', ssr: null }));
    site.intercept({ path: '/api.php?a=sources&type=movie&id=550&s=0&e=0&t=tok' })
        .reply(200, { status: 'ok', servers: [servers[1], servers[2]] });
    site.intercept({ path: '/api.php?a=play&ref=r-en&t=tok' }).reply(500, 'oops');
    site.intercept({ path: '/api.php?a=play&ref=r-x&t=tok' }).reply(200, { url: '/_stream?id=x', type: 'hls' });

    const streams = await getVideMStreams('movie', '550', undefined, undefined, 'en');
    assert.deepStrictEqual(streams.map((s) => s.title), ['XPT1']);  // quality probe fails offline → plain label
});

test('returns nothing when the embed page is missing', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent.get('https://videm.buzz').intercept({ path: '/embed/movie/1' }).reply(404, 'nope');
    assert.deepStrictEqual(await getVideMStreams('movie', '1'), []);
});
