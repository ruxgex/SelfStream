import { Agent, setGlobalDispatcher } from 'undici';

/**
 * Tuned dispatcher for upstream requests. Segment prefetch runs several downloads in
 * parallel per CDN host, so allow more pooled keep-alive connections than the default
 * and keep them open between segments to avoid repeated TCP/TLS handshakes over 4G.
 */
export function installHttpDispatcher(): void {
    setGlobalDispatcher(new Agent({
        connections: 16,
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 120_000,
        connect: { timeout: 10_000 },
    }));
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

export function isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
}
