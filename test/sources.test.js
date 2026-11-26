const test = require('node:test');
const assert = require('node:assert');
const { decodeConfig, DEFAULT_CONFIG } = require('../dist/config');
const { generateLandingPage } = require('../dist/landing');

test('old manifest URLs with CinemaCity settings still decode, without them', () => {
    const old = { vixEnabled: true, vixLang: 'it', cinemacityEnabled: true, cinemacityLang: 'it', animeunityEnabled: false };
    const decoded = decodeConfig(Buffer.from(JSON.stringify(old)).toString('base64url'));
    assert.deepStrictEqual(decoded, { vixEnabled: true, vixLang: 'it', animeunityEnabled: false });
    assert.ok(!('cinemacityEnabled' in DEFAULT_CONFIG));
});

test('landing page offers no CinemaCity source', () => {
    const html = generateLandingPage({ name: 'x', logo: '', version: '1', description: '' }, 'http://addon');
    assert.doesNotMatch(html, /cinemacity/i);
});
