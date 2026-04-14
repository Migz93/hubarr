type ClassValue = string | undefined | null | false | Record<string, boolean>;

function clsx(...inputs: ClassValue[]): string {
  const classes: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === "string") {
      classes.push(input);
    } else if (typeof input === "object") {
      for (const [key, value] of Object.entries(input)) {
        if (value) classes.push(key);
      }
    }
  }
  return classes.join(" ");
}

export function cn(...inputs: ClassValue[]): string {
  return clsx(...inputs);
}

export const WATCHLIST_DATE_UNKNOWN_SENTINEL = "2001-01-01T00:00:00.000Z";

export function formatWatchlistDate(isoString: string): string {
  if (isoString === WATCHLIST_DATE_UNKNOWN_SENTINEL) return "Unknown";
  return formatRelativeTime(isoString);
}

export function formatWatchlistDateShort(isoString: string): string {
  if (isoString === WATCHLIST_DATE_UNKNOWN_SENTINEL) return "Unknown";
  return new Date(isoString).toLocaleDateString("en-GB");
}

export function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffSecs = Math.floor(Math.abs(diffMs) / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return "Just now";

  if (diffMs > 0) {
    if (diffMins < 60) return `in ${diffMins}m`;
    if (diffHours < 24) return `in ${diffHours}h`;
    if (diffDays < 7) return `in ${diffDays}d`;
    return date.toLocaleDateString();
  }

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function formatDateTime(isoString: string): string {
  return new Date(isoString).toLocaleString();
}
