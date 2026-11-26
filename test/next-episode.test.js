const test = require('node:test');
const assert = require('node:assert');
const { nextEpisodeIds, createNextEpisodeWarmer } = require('../dist/next-episode');

test('next episode ids for IMDb, TMDB and Kitsu', () => {
    assert.deepStrictEqual(nextEpisodeIds('series', 'tt0903747:1:7'), ['tt0903747:1:8', 'tt0903747:2:1']);
    assert.deepStrictEqual(nextEpisodeIds('series', 'tmdb:1396:3:2'), ['tmdb:1396:3:3', 'tmdb:1396:4:1']);
    assert.deepStrictEqual(nextEpisodeIds('series', 'kitsu:42:12'), ['kitsu:42:13']);
    assert.deepStrictEqual(nextEpisodeIds('anime', 'kitsu:42:12'), ['kitsu:42:13']);
});

test('no next episode for movies or malformed ids', () => {
    assert.deepStrictEqual(nextEpisodeIds('movie', 'tt0111161'), []);
    assert.deepStrictEqual(nextEpisodeIds('movie', 'kitsu:42'), []);
    assert.deepStrictEqual(nextEpisodeIds('series', 'tt0903747'), []);
});

test('falls back to the next season and warms only once per episode', async () => {
    const calls = [];
    const warm = createNextEpisodeWarmer(async (type, id) => {
        calls.push(id);
        return [];
    });
    const ctx = { t: 'series', i: 'tt1:1:10', c: '' };
    await warm(ctx);
    await warm(ctx);
    assert.deepStrictEqual(calls, ['tt1:1:11', 'tt1:2:1']);
});
