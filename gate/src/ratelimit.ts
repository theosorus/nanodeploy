// Slows down password guessing, per client address and per account name. Five
// mistakes are free (typos happen), then each one doubles the wait, up to five
// minutes. In memory on purpose: gate is one process, and a restart forgetting
// the counters costs an attacker a reboot of someone else's server.
type Entry = { fails: number; until: number; seen: number };
const entries = new Map<string, Entry>();
const FREE = 5;
const MAX_WAIT = 300_000;
const MAX_ENTRIES = 10_000;

function boundedSet<T>(map: Map<string, T>, key: string, value: T) {
  if (!map.has(key) && map.size >= MAX_ENTRIES) map.delete(map.keys().next().value!);
  map.set(key, value);
}

const windows = new Map<string, { count: number; until: number }>();
// Reserve before doing work: concurrent attempts cannot all pass a counter
// which was previously incremented only after a password check finished.
export function take(key: string, maximum: number, windowMs: number): number {
  const now = Date.now();
  const bucket = windows.get(key);
  if (!bucket || bucket.until <= now) {
    boundedSet(windows, key, { count: 1, until: now + windowMs });
    return 0;
  }
  if (bucket.count >= maximum) return Math.max(1, Math.ceil((bucket.until - now) / 1000));
  bucket.count++;
  return 0;
}

export function waitSeconds(keys: string[]): number {
  const now = Date.now();
  let wait = 0;
  for (const k of keys) {
    const e = entries.get(k);
    if (e && e.until > now) wait = Math.max(wait, Math.ceil((e.until - now) / 1000));
  }
  return wait;
}

export function failed(keys: string[]) {
  const now = Date.now();
  for (const k of keys) {
    const e = entries.get(k) ?? { fails: 0, until: 0, seen: now };
    e.fails += 1;
    e.seen = now;
    if (e.fails > FREE) e.until = now + Math.min(1000 * 2 ** (e.fails - FREE), MAX_WAIT);
    boundedSet(entries, k, e);
  }
}

export function succeeded(keys: string[]) {
  for (const k of keys) entries.delete(k);
}

// forget addresses that went quiet, so the map cannot grow without bound
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [k, e] of entries) if (e.seen < cutoff && e.until < Date.now()) entries.delete(k);
  for (const [k, e] of windows) if (e.until < Date.now()) windows.delete(k);
}, 600_000).unref();
