/**
 * Serving concerns: caching and rate limiting.
 *
 * Both are in-process, which is the honest shape for this deployment rather
 * than a compromise hidden behind an abstraction. On serverless each instance
 * keeps its own copy, so the cache hit rate is lower than a shared Redis would
 * give and the rate limit is per-instance rather than global. That is fine for
 * what this defends against — one browser hammering the quote endpoint on every
 * keystroke, and public RPC endpoints throttling us in response. It is not a
 * defence against a distributed attacker, and pretending otherwise would be
 * worse than saying so.
 */

type Entry<T> = { value: T; expires: number };

/**
 * Cache with request coalescing.
 *
 * Coalescing matters more than the caching here: three browsers asking for the
 * same pair within the same block should produce one set of RPC calls, not
 * three. Without it, a cache only helps the *second* caller, and the thundering
 * herd on a cold key is exactly when the upstream rate limit bites.
 */
export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();

  constructor(
    private ttlMs: number,
    private maxEntries = 500,
  ) {}

  /**
   * `ttlFor` lets an answer choose how long it deserves to be kept.
   *
   * Not every result is worth the same. A quote that came back complete can
   * sit for the full window; one carrying failures should expire quickly, or a
   * single cold start serves its own failures to everyone behind it for a
   * minute — which is exactly how a page came to tell visitors that assets it
   * trades were not listed.
   */
  async get(
    key: string,
    produce: () => Promise<T>,
    ttlFor?: (value: T) => number,
  ): Promise<{ value: T; hit: boolean }> {
    const now = Date.now();
    const cached = this.store.get(key);
    if (cached && cached.expires > now) return { value: cached.value, hit: true };

    const pending = this.inflight.get(key);
    if (pending) return { value: await pending, hit: true };

    const promise = produce()
      .then((value) => {
        this.store.set(key, { value, expires: Date.now() + (ttlFor?.(value) ?? this.ttlMs) });
        this.evict();
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return { value: await promise, hit: false };
  }

  /** Oldest-expiry-first eviction. Not LRU, but bounded, which is the point. */
  private evict() {
    if (this.store.size <= this.maxEntries) return;
    const sorted = [...this.store.entries()].sort((a, b) => a[1].expires - b[1].expires);
    for (const [k] of sorted.slice(0, this.store.size - this.maxEntries)) this.store.delete(k);
  }

  get size() {
    return this.store.size;
  }
}

/**
 * Fixed-window rate limit.
 *
 * A sliding window would be smoother, but a fixed window is a dozen lines and
 * its worst case — twice the quota across a window boundary — is irrelevant at
 * these limits.
 */
export class RateLimit {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  check(key: string): { ok: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || entry.resetAt <= now) {
      const resetAt = now + this.windowMs;
      this.hits.set(key, { count: 1, resetAt });
      if (this.hits.size > 5_000) this.sweep(now);
      return { ok: true, remaining: this.limit - 1, resetAt };
    }

    entry.count++;
    return {
      ok: entry.count <= this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      resetAt: entry.resetAt,
    };
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

/**
 * Best-effort client identity.
 *
 * `x-forwarded-for` is trivially spoofed by anyone who wants to; it is used
 * here to separate ordinary users from each other, not to keep an adversary
 * out. The first entry is the client as seen by the outermost proxy.
 */
export function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'anonymous';
}

/**
 * How long a quote may sit on screen before the UI refuses to sign it.
 *
 * Base blocks are two seconds, so thirty is already many blocks stale — this is
 * a backstop against a tab left open over lunch, not a freshness guarantee.
 * What actually protects the fill is the on-chain minimum-output floor.
 */
export const QUOTE_TTL_MS = 30_000;

/** Shared instances. Module scope, so they live as long as the instance does. */
export const quoteCache = new TtlCache<unknown>(3_000);
export const venueCache = new TtlCache<unknown>(30_000);
export const quoteLimit = new RateLimit(120, 60_000);
