process.env.SEGMENT_PREFETCH_AHEAD_SECONDS = '20';
process.env.SEGMENT_PREFETCH_CONCURRENCY = '2';
process.env.SEGMENT_FETCH_RETRIES = '2';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Agent, setGlobalDispatcher } = require('undici');
const cache = require('../dist/segment-cache');

setGlobalDispatcher(new Agent());

// ── Local upstream with per-path behaviour ──
const log = [];
let active = 0;
let maxActive = 0;
const handlers = new Map();

const server = http.createServer(async (req, res) => {
    log.push({ path: req.url, range: req.headers.range });
    active++;
    maxActive = Math.max(maxActive, active);
    res.on('close', () => { active--; });
    const handler = handlers.get(req.url) || handlers.get('*');
    if (handler) return handler(req, res);
    res.statusCode = 404;
    res.end();
});

let base;
test.before(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function fakeRes() {
    const res = new EventEmitter();
    res.headers = {};
    res.chunks = [];
    res.statusCode = 200;
    res.headersSent = false;
    res.firstWriteAt = 0;
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.write = (c) => { res.headersSent = true; if (!res.firstWriteAt) res.firstWriteAt = Date.now(); res.chunks.push(Buffer.from(c)); };
    res.end = (c) => { if (c) res.write(c); res.finished = true; };
    res.status = (s) => { res.statusCode = s; return res; };
    res.send = (b) => { res.end(Buffer.from(String(b))); };
    res.destroy = () => { res.destroyed = true; };
    res.body = () => Buffer.concat(res.chunks);
    return res;
}

async function idle() {
    for (let i = 0; i < 200; i++) {
        const s = cache._stats();
        if (s.downloads === 0 && s.activePrefetches === 0) return;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('prefetcher never went idle');
}

const requested = (prefix) => log.filter((l) => l.path.startsWith(prefix)).map((l) => l.path);

test('retries a 503 and then serves the segment', async () => {
    let calls = 0;
    handlers.set('/retry/1.ts', (req, res) => {
        calls++;
        if (calls === 1) { res.statusCode = 503; return res.end(); }
        res.end('hello');
    });
    const res = fakeRes();
    await cache.serveSegment(`${base}/retry/1.ts`, {}, res);
    assert.strictEqual(res.body().toString(), 'hello');
    assert.strictEqual(calls, 2);
    assert.strictEqual(res.headers['x-segment-cache'], 'MISS');

    const again = fakeRes();
    await cache.serveSegment(`${base}/retry/1.ts`, {}, again);
    assert.strictEqual(again.headers['x-segment-cache'], 'HIT');
    assert.strictEqual(calls, 2);
});

test('gives up with 502 on a non-retryable status', async () => {
    let calls = 0;
    handlers.set('/gone/1.ts', (req, res) => { calls++; res.statusCode = 404; res.end(); });
    const res = fakeRes();
    await cache.serveSegment(`${base}/gone/1.ts`, {}, res);
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(calls, 1);
});

test('resumes with a Range request after the connection drops mid-body', async () => {
    const full = Buffer.alloc(4000, 7);
    for (let i = 0; i < full.length; i++) full[i] = i % 251;
    handlers.set('/resume/1.ts', (req, res) => {
        if (!req.headers.range) {
            res.writeHead(200, { 'Content-Length': full.length });
            res.write(full.subarray(0, 1000));
            setTimeout(() => res.socket.destroy(), 20);
            return;
        }
        const start = parseInt(req.headers.range.match(/bytes=(\d+)-/)[1], 10);
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${full.length - 1}/${full.length}` });
        res.end(full.subarray(start));
    });
    const res = fakeRes();
    await cache.serveSegment(`${base}/resume/1.ts`, {}, res);
    assert.ok(res.body().equals(full));
    const ranges = log.filter((l) => l.path === '/resume/1.ts').map((l) => l.range);
    assert.deepStrictEqual(ranges, [undefined, 'bytes=1000-']);
});

test('strips a fake PNG header in front of MPEG-TS data', async () => {
    const ts = Buffer.alloc(188 * 3);
    ts[0] = 0x47; ts[188] = 0x47; ts[376] = 0x47;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    handlers.set('/png/1.ts', (req, res) => res.end(Buffer.concat([png, ts])));
    const res = fakeRes();
    await cache.serveSegment(`${base}/png/1.ts`, {}, res);
    assert.ok(res.body().equals(ts));
});

test('strips a whole PNG image in front of MPEG-TS data and serves it as video/mp2t', async () => {
    const ts = Buffer.alloc(188 * 4);
    for (let i = 0; i < 4; i++) ts[i * 188] = 0x47;
    // A real-looking PNG: signature + IHDR + IDAT containing stray 0x47 bytes + IEND.
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('0000000d49484452', 'hex'), Buffer.alloc(17, 0x47),
        Buffer.alloc(870, 0x11),
        Buffer.from('0000000049454e44ae426082', 'hex'),
    ]);
    handlers.set('/disguised/a.ts', (req, res) => {
        res.setHeader('Content-Type', 'image/png');
        res.write(png.subarray(0, 300));
        setTimeout(() => res.end(Buffer.concat([png.subarray(300), ts])), 20);
    });
    const res = fakeRes();
    await cache.serveSegment(`${base}/disguised/a.ts`, {}, res);
    const b = res.body();
    assert.ok(b.equals(ts));
    assert.strictEqual(res.headers['content-type'], 'video/mp2t');
});

test('strips a 1x1 PNG in front of fragmented-MP4 data and serves it as video/mp4', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
        '1f15c4890000000d49444154789c63f8cfc0f01f0005000201a1a7e3c10000000049454e44ae426082', 'hex');
    const mp4 = Buffer.concat([Buffer.from('00000018737479706d736468000000006d7364686d736978', 'hex'), Buffer.alloc(500, 0x47)]);
    handlers.set('/disguised/b.m4s', (req, res) => {
        res.setHeader('Content-Type', 'image/png');
        res.end(Buffer.concat([png, mp4]));
    });
    const res = fakeRes();
    await cache.serveSegment(`${base}/disguised/b.m4s`, {}, res);
    assert.ok(res.body().equals(mp4));
    assert.strictEqual(res.headers['content-type'], 'video/mp4');
});

test('passes through segments that are not disguised', async () => {
    const data = Buffer.alloc(1000, 0x33);
    handlers.set('/plain/1.ts', (req, res) => res.end(data));
    const res = fakeRes();
    await cache.serveSegment(`${base}/plain/1.ts`, {}, res);
    assert.ok(res.body().equals(data));
});

test('streams bytes to the player before the upstream download finishes', async () => {
    let finishedAt = 0;
    handlers.set('/slow/1.ts', (req, res) => {
        res.write(Buffer.alloc(500, 1));
        setTimeout(() => { finishedAt = Date.now(); res.end(Buffer.alloc(500, 2)); }, 300);
    });
    const res = fakeRes();
    await cache.serveSegment(`${base}/slow/1.ts`, {}, res);
    assert.strictEqual(res.body().length, 1000);
    assert.ok(res.firstWriteAt > 0 && res.firstWriteAt < finishedAt, 'first bytes should arrive before upstream ends');
});

function playlist(prefix, count, duration = 4) {
    return Array.from({ length: count }, (_, i) => ({ url: `${base}${prefix}${i}.ts`, duration }));
}

test('prefetches a time window ahead, then refocuses after a seek, within the concurrency limit', async () => {
    handlers.set('*', (req, res) => setTimeout(() => res.end('x'), 30));
    const segs = playlist('/win/', 40);
    maxActive = 0;
    cache.registerMediaPlaylist(segs, {});
    const res = fakeRes();
    await cache.serveSegment(segs[0].url, {}, res);
    await idle();

    // 20s window of 4s segments after segment 0 → segments 1..5
    const first = new Set(requested('/win/'));
    for (let i = 0; i <= 5; i++) assert.ok(first.has(`/win/${i}.ts`), `segment ${i} should be fetched`);
    assert.ok(!first.has('/win/6.ts'), 'segment 6 is outside the window');

    // Seek to segment 20 → segments 21..25 fetched, nothing beyond
    const seek = fakeRes();
    await cache.serveSegment(segs[20].url, {}, seek);
    await idle();
    const after = new Set(requested('/win/'));
    for (let i = 21; i <= 25; i++) assert.ok(after.has(`/win/${i}.ts`), `segment ${i} should be fetched after seek`);
    assert.ok(!after.has('/win/26.ts'));
    assert.ok(!after.has('/win/10.ts'), 'old window should not keep downloading');

    // 2 prefetches + 1 player-driven request at most
    assert.ok(maxActive <= 3, `max concurrent upstream requests was ${maxActive}`);
});

test('fires onNearEnd once when playback reaches the end of the playlist', async () => {
    handlers.set('*', (req, res) => res.end('x'));
    const segs = playlist('/end/', 100, 4);
    let fired = 0;
    cache.registerMediaPlaylist(segs, {}, { onNearEnd: () => fired++ });
    await cache.serveSegment(segs[10].url, {}, fakeRes());
    assert.strictEqual(fired, 0);
    await cache.serveSegment(segs[92].url, {}, fakeRes());
    await cache.serveSegment(segs[93].url, {}, fakeRes());
    assert.strictEqual(fired, 1);
    await idle();
});
