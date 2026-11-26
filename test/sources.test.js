const test = require('node:test');
const assert = require('node:assert');
const { decodeConfig, DEFAULT_CONFIG } = require('../dist/config');
const { generateLandingPage } = require('../dist/landing');

test('old manifest URLs with CinemaCity settings still decode, without them', () => {
    const old = { vixEnabled: true, vixLang: 'it', cinemacityEnabled: true, cinemacityLang: 'it', animeunityEnabled: false };
    const decoded = decodeConfig(Buffer.from(JSON.stringify(old)).toString('base64url'));
    assert.deepStrictEqual(decoded, { vixEnabled: true, vixLang: 'it', videmEnabled: true, animeunityEnabled: false });
    assert.ok(!('cinemacityEnabled' in DEFAULT_CONFIG));
});

test('landing page offers no CinemaCity source', () => {
    const html = generateLandingPage({ name: 'x', logo: '', version: '1', description: '' }, 'http://addon');
    assert.doesNotMatch(html, /cinemacity/i);
});

test('VideM can be switched off and stays off', () => {
    const cfg = { vixEnabled: true, vixLang: 'en', videmEnabled: false, animeunityEnabled: false };
    assert.strictEqual(decodeConfig(Buffer.from(JSON.stringify(cfg)).toString('base64url')).videmEnabled, false);
});

test('landing page offers a VideM toggle', () => {
    const html = generateLandingPage({ name: 'x', logo: '', version: '1', description: '' }, 'http://addon');
    assert.match(html, /id="videmEnabled"/);
});
