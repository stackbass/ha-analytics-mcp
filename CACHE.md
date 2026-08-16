# Cache design

This document describes the current cache, the limitation it has near "now" and the
redesign planned to fix it. It exists so the limitation is documented rather than
discovered.

## Current behavior

The cache is a process-level in-memory map with LRU eviction (capacity set by
`CACHE_MAX_ENTRIES`, default 500) and per-entry TTLs:

- Entity list and HA config: 1 hour.
- Tool results derived from statistics or history: no expiry when the requested
  `end_time` is more than 48 hours in the past, 5 minutes otherwise.

The 48-hour rule rests on a property of the HA recorder: it never backfills or amends
statistics older than about 48 hours, so data entirely behind that horizon is immutable
and safe to cache forever. Nothing is persisted; the cache clears on restart.

An important detail: the tools mostly cache the final rendered answer string, keyed by
the request parameters and exact resolved timestamps, not the raw fetched data.

## The limitation

Because the cache stores rendered answers under exact keys, it does not know what
source window has already been fetched, how fresh that data is near now, or how to
fetch only the missing tail of a newer request. It is therefore good at exact replay of
a past request and poor at incremental refresh, in two ways.

First, the mutable boundary. Recent history and recent statistics are not stable yet:
raw state history keeps growing until now, hourly statistics can lag, and the newest
day/week/month bucket is still incomplete. A cached answer from a few minutes ago can
omit events that have arrived since. The 5-minute TTL bounds this staleness; it does
not remove it.

Second, no incremental fetch. If data for `[start, cached_end]` is already held and
the next request asks for `[start, newer_end]`, the current design cannot reuse the
cached prefix and fetch only the tail; it either replays the stale answer or refetches
the whole range. Requests that default `end_time` to now get a new timestamp each
time, so they miss the exact-key cache anyway: the worst of both.

## Planned redesign: raw coverage plus incremental tail fetch

The fix is not TTL tuning; it is changing the cache model from exact answer replay to
two layers: a raw source cache (fetched HA rows plus metadata about coverage and
freshness) and a derived result cache (rendered answers, disposable and short-lived).
The raw layer is the important one: once the server knows what source window it
already holds, it can decide to reuse it, extend it or bypass it.

The working rules for that design:

1. Historical windows are reusable; recent windows are extendable, not final. Data
   ending before the mutable horizon (the 48-hour rule for statistics) is permanently
   reusable.
2. Cache raw rows with coverage metadata (`covered_start`, `covered_end`,
   `complete_through`, `fetched_at`), not only rendered answers. `complete_through` is
   the latest timestamp trusted as complete; anything beyond it must be fetched.
3. When a request extends beyond `complete_through`, fetch only the missing tail, plus
   a small overlap before the previous boundary (one source bucket for statistics, a
   few minutes for raw history), because boundary buckets can be updated late.
4. Merge fetched rows into the cached window, de-duplicating by timestamp or bucket
   start, and recompute the derived answer from the merged data.
5. Invalidate derived answers by source freshness, not by answer age: a rendered
   answer is stale as soon as its source window can be extended.
6. Treat the two sides of a comparison independently. The reference period is
   almost always historical and stable; only the current period needs top-up fetching.
7. Surface incompleteness instead of hiding it: when the freshest bucket is known to
   be incomplete, the response says so ("latest hour may still be incomplete") rather
   than presenting it as final.

A smaller intermediate step would be to stop caching answers for windows that touch
now and cache only clearly historical windows. That is simpler and safe, but gives up
the follow-up-question reuse that motivates caching in the first place, so the
two-layer design is the intended direction.

## Status

The current single-layer cache is what ships. It is correct for historical periods and
bounded-stale (up to 5 minutes) for windows touching now. The two-layer redesign is
planned but not implemented.
