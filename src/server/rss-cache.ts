/**
 * RSS feed item parsed from the Plex friends watchlist RSS feed.
 * The `author` field contains the Plex user ID of the friend who added the item.
 */
export interface RssFeedItem {
  title: string;
  type: "movie" | "show";
  guids: string[]; // normalized (lowercase, trimmed)
  author: string; // Plex user ID (UUID or numeric — depends on Plex)
  thumb: string | null;
  year: number | null;
  pubDate: string | null;
}

/**
 * Generate a stable deduplication key from a set of GUIDs and an optional author.
 * Including the author means two different friends watchlisting the same item
 * produce distinct cache entries, so both are treated as new and processed.
 * Normalized, sorted, deduplicated, and joined so the key is stable
 * regardless of GUID ordering in the feed.
 */
function stableKey(guids: string[], author?: string): string {
  const guidPart = Array.from(new Set(guids.map((g) => g.toLowerCase().trim()).filter(Boolean)))
    .sort()
    .join("|");
  return author ? `${author}::${guidPart}` : guidPart;
}

/**
 * In-memory RSS feed cache for change detection.
 *
 * Usage:
 * - Call `prime()` once on startup with the current feed items.
 *   This establishes the baseline without reporting anything as new.
 * - Call `diff()` on each subsequent poll.
 *   It returns only items that were not in the previous snapshot,
 *   then updates the internal cache to the new snapshot.
 */
export class RssCache {
  private items = new Map<string, RssFeedItem>();

  prime(items: RssFeedItem[]): void {
    this.items = new Map(items.map((item) => [stableKey(item.guids, item.author || undefined), item]));
  }

  diff(items: RssFeedItem[]): Array<RssFeedItem & { stableKey: string }> {
    const newItems: Array<RssFeedItem & { stableKey: string }> = [];
    const next = new Map<string, RssFeedItem>();

    for (const item of items) {
      const key = stableKey(item.guids, item.author || undefined);
      next.set(key, item);
      if (!this.items.has(key)) {
        newItems.push({ ...item, stableKey: key });
      }
    }

    this.items = next;
    return newItems;
  }

  get size(): number {
    return this.items.size;
  }
}
