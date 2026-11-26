process.env.PORT = '0';

const test = require('node:test');
const assert = require('node:assert');
const { MockAgent, setGlobalDispatcher } = require('undici');
const { handleStream } = require('../dist/addon');
const { decodeProxyToken } = require('../dist/proxy');

function mockVixSrc(tvPath, times) {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const site = agent.get('https://vixsrc.to');
    site.intercept({ path: tvPath }).reply(200, { src: '/embed/9' }).times(times);
    site.intercept({ path: '/embed/9' }).reply(200, `<script>
        window.masterPlaylist = { params: { 'token': 'abc', 'expires': '123' }, url: 'https://vixsrc.to/playlist/9' }
    </script>`).times(times);
    return agent;
}

const cfg = { vixEnabled: true, vixLang: 'en', animeunityEnabled: false };

test('identical stream requests are served from cache and carry the episode context', async () => {
    const agent = mockVixSrc('/api/tv/tt77/1/3', 1);
    const first = await handleStream('series', 'tt77:1:3', cfg);
    // Only one interceptor set: a second upstream lookup would fail and return [].
    const second = await handleStream('series', 'tt77:1:3', cfg);
    assert.strictEqual(first.length, 1);
    assert.deepStrictEqual(second, first);
    agent.assertNoPendingInterceptors();

    const token = new URL(first[0].url, 'http://x').searchParams.get('token');
    const ctx = decodeProxyToken(token).c;
    assert.strictEqual(ctx.t, 'series');
    assert.strictEqual(ctx.i, 'tt77:1:3');
});

test('empty results are not cached', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent.get('https://vixsrc.to').intercept({ path: '/api/tv/tt88/1/1' }).reply(404, '');
    assert.deepStrictEqual(await handleStream('series', 'tt88:1:1', cfg), []);

    mockVixSrc('/api/tv/tt88/1/1', 1);
    assert.strictEqual((await handleStream('series', 'tt88:1:1', cfg)).length, 1);
});
