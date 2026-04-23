import type { MediaType, WatchlistItem } from "../../shared/types.js";

export function mergeRawPayloadGuids(
  itemGuids: Map<string, Set<string>>,
  plexItemId: string,
  rawPayload: string
): void {
  try {
    const payload = JSON.parse(rawPayload) as Partial<WatchlistItem>;
    if (!Array.isArray(payload.guids) || payload.guids.length === 0) {
      return;
    }

    const existing = itemGuids.get(plexItemId) ?? new Set<string>();
    for (const guid of payload.guids) {
      if (typeof guid === "string" && guid.length > 0) {
        existing.add(guid.toLowerCase());
      }
    }

    if (existing.size > 0) {
      itemGuids.set(plexItemId, existing);
    }
  } catch {
    // Ignore unparseable payloads. The caller still keeps the item; it simply
    // won't participate in GUID-based merging.
  }
}

export function buildGuidMergePlan(
  itemGuids: Map<string, Set<string>>,
  itemTypes: Map<string, MediaType>
): Map<string, string> {
  const guidToCanonical = new Map<string, string>();
  const mergeInto = new Map<string, string>();

  for (const [plexItemId, guids] of itemGuids) {
    const mediaType = itemTypes.get(plexItemId);
    if (!mediaType) continue;

    for (const guid of guids) {
      // Provider GUID namespaces are not globally type-scoped, so keep movie
      // and show GUID matching separate to avoid cross-type merges.
      const scopedGuid = `${mediaType}:${guid}`;
      const canonical = guidToCanonical.get(scopedGuid);
      if (canonical) {
        if (canonical !== plexItemId && !mergeInto.has(plexItemId)) {
          mergeInto.set(plexItemId, canonical);
        }
      } else {
        guidToCanonical.set(scopedGuid, plexItemId);
      }
    }
  }

  const resolving = new Set<string>();
  const resolveRoot = (plexItemId: string): string => {
    const next = mergeInto.get(plexItemId);
    if (!next) return plexItemId;
    if (resolving.has(plexItemId)) return next;

    resolving.add(plexItemId);
    const root = resolveRoot(next);
    resolving.delete(plexItemId);

    if (root !== next) {
      mergeInto.set(plexItemId, root);
    }

    return root;
  };

  for (const sourceId of Array.from(mergeInto.keys())) {
    const root = resolveRoot(sourceId);
    if (root === sourceId) {
      mergeInto.delete(sourceId);
    }
  }

  return mergeInto;
}
