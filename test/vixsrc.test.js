const test = require('node:test');
const assert = require('node:assert');
const { MockAgent, setGlobalDispatcher } = require('undici');
const { getVixSrcStreams } = require('../dist/vixsrc');

async function playlistUrlFor(canPlayFHD) {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const site = agent.get('https://vixsrc.to');
    site.intercept({ path: '/api/movie/1' }).reply(200, { src: '/embed/2' });
    site.intercept({ path: '/embed/2' }).reply(200, `<script>
        window.masterPlaylist = { params: { 'token': 'abc', 'expires': '123' }, url: 'https://vixsrc.to/playlist/2' }
        window.canPlayFHD = ${canPlayFHD}
    </script>`);

    const [stream] = await getVixSrcStreams('1');
    const token = new URL(stream.url, 'http://addon').searchParams.get('token');
    return new URL(JSON.parse(Buffer.from(token, 'base64url').toString()).u);
}

test('does not request FHD when the player says it cannot play it', async () => {
    const url = await playlistUrlFor(false);
    assert.strictEqual(url.searchParams.has('h'), false);
});

test('sets a per-language bingeGroup so Stremio autoplays the same source', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const site = agent.get('https://vixsrc.to');
    site.intercept({ path: '/api/tv/1/1/2' }).reply(200, { src: '/embed/2' });
    site.intercept({ path: '/embed/2' }).reply(200, `<script>
        window.masterPlaylist = { params: { 'token': 'abc', 'expires': '123' }, url: 'https://vixsrc.to/playlist/2' }
    </script>`);
    const [stream] = await getVixSrcStreams('1', '1', '2', 'it');
    assert.deepStrictEqual(stream.behaviorHints, { bingeGroup: 'selfstream-vixsrc-it' });
});

test('requests FHD when the player allows it', async () => {
    const url = await playlistUrlFor(true);
    assert.strictEqual(url.searchParams.get('h'), '1');
});
