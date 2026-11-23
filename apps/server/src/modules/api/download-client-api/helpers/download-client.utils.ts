/**
 * Normalize a client's tag list - a comma-separated string (qBittorrent) or an
 * array (Transmission labels) - to trimmed, non-empty tags.
 */
export const splitClientTags = (
  tags: string | string[] | undefined | null,
): string[] => {
  const parts = Array.isArray(tags) ? tags : (tags ?? '').split(',');
  const result: string[] = [];
  for (const part of parts) {
    const tag = typeof part === 'string' ? part.trim() : '';
    if (tag) {
      result.push(tag);
    }
  }
  return result;
};

/**
 * The host of a tracker announce URL, for display. Returns an empty string for
 * anything that is not a parseable URL (qBittorrent reports '' when no tracker
 * is working).
 */
export const trackerHost = (announce: string | undefined | null): string => {
  if (!announce) {
    return '';
  }
  try {
    return new URL(announce).hostname;
  } catch {
    return '';
  }
};
