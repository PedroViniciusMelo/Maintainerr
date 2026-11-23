import { CrossSeedDetection } from '@maintainerr/contracts';
import {
  DownloadClientFile,
  DownloadClientTorrent,
} from './download-client.interface';

/**
 * Two downloads of the same release differ by at most this share of their
 * size: cross-seed's partial matching skips small extras (nfo, sample, srr).
 */
const PARTIAL_SIZE_TOLERANCE = 0.05;
/** Files smaller than this (nfo, srr, txt) are ignored when matching. */
const SIGNIFICANT_FILE_BYTES = 1024 * 1024;
/** Only this many nearest-size candidates have their files compared. */
const MAX_FILE_CANDIDATES = 8;
/**
 * Unmarked downloads of identical size are only compared by their files above
 * this size; small downloads collide by size too often to be worth the calls.
 */
const INFERRED_MIN_BYTES = 100 * 1024 * 1024;
/** A same-size bucket larger than this is too ambiguous to infer from. */
const INFERRED_MAX_BUCKET = 5;

export interface CrossSeedGroupingInput {
  torrents: DownloadClientTorrent[];
  /** Whether the download carries a cross-seed tag / category. */
  isMarked: (torrent: DownloadClientTorrent) => boolean;
  /** Whether any *arr ever grabbed / imported this download. */
  isArrLinked: (torrent: DownloadClientTorrent) => boolean;
  /** The download's files, or undefined when they could not be read. */
  loadFiles: (hash: string) => Promise<DownloadClientFile[] | undefined>;
  /**
   * When set, files are only compared to match a download against one this
   * returns true for. Callers that care about a few downloads use it to skip
   * file reads for every unrelated group.
   */
  isRelevant?: (torrent: DownloadClientTorrent) => boolean;
}

export interface GroupedCrossSeed {
  torrent: DownloadClientTorrent;
  detection: CrossSeedDetection;
}

export interface TorrentGroup {
  original: DownloadClientTorrent | null;
  crossSeeds: GroupedCrossSeed[];
}

/**
 * Whether a tag or category is one cross-seed sets. cross-seed's default tag
 * is `cross-seed` and its duplicated categories end in `.cross-seed`; matching
 * on the letters alone also accepts `crossseed`, `cross_seed`, `Cross-Seed`...
 */
export const isCrossSeedMarker = (value: string): boolean => {
  let letters = '';
  for (const char of value.toLowerCase()) {
    const code = char.charCodeAt(0);
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      letters += char;
    }
  }
  return letters.includes('crossseed');
};

export interface CrossSeedMarkers {
  tags: string[];
  categories: string[];
  isMarked: (torrent: DownloadClientTorrent) => boolean;
}

/**
 * The cross-seed tags and categories this installation actually uses, read
 * from the downloads themselves, so no tag has to be configured.
 */
export const detectCrossSeedMarkers = (
  torrents: DownloadClientTorrent[],
): CrossSeedMarkers => {
  const tags = new Set<string>();
  const categories = new Set<string>();
  for (const torrent of torrents) {
    for (const tag of torrent.tags ?? []) {
      if (isCrossSeedMarker(tag)) {
        tags.add(tag);
      }
    }
    if (torrent.category && isCrossSeedMarker(torrent.category)) {
      categories.add(torrent.category);
    }
  }
  return {
    tags: [...tags].sort(),
    categories: [...categories].sort(),
    isMarked: (torrent) =>
      (torrent.tags ?? []).some((tag) => tags.has(tag)) ||
      (!!torrent.category && categories.has(torrent.category)),
  };
};

/** Trailing separators would make the same folder look like two paths. */
export const normalizeContentPath = (path: string | undefined): string => {
  const trimmed = (path ?? '').trim();
  let end = trimmed.length;
  while (end > 1) {
    const code = trimmed.charCodeAt(end - 1);
    // '/' or '\'
    if (code !== 47 && code !== 92) {
      break;
    }
    end -= 1;
  }
  return trimmed.slice(0, end);
};

const sizeOf = (torrent: DownloadClientTorrent) => torrent.size ?? 0;

const sizesClose = (a: number, b: number): boolean => {
  if (a <= 0 || b <= 0) {
    return a === b;
  }
  return Math.abs(a - b) <= Math.max(a, b) * PARTIAL_SIZE_TOLERANCE;
};

/**
 * Whether two file lists hold the same data: every significant file of the
 * smaller download has a same-size counterpart in the larger one, and those
 * files make up nearly all of the smaller download. Names are ignored because
 * a cross-seed may name its folder or files differently.
 */
export const filesMatch = (
  a: DownloadClientFile[],
  b: DownloadClientFile[],
): boolean => {
  const significant = (files: DownloadClientFile[]) =>
    files.filter((file) => file.size >= SIGNIFICANT_FILE_BYTES);
  const total = (files: DownloadClientFile[]) =>
    files.reduce((sum, file) => sum + file.size, 0);

  const [small, large] = total(a) <= total(b) ? [a, b] : [b, a];
  const smallSignificant = significant(small);
  if (smallSignificant.length === 0) {
    return false;
  }

  const available = new Map<number, number>();
  for (const file of significant(large)) {
    available.set(file.size, (available.get(file.size) ?? 0) + 1);
  }

  let matchedBytes = 0;
  for (const file of smallSignificant) {
    const count = available.get(file.size) ?? 0;
    if (count === 0) {
      return false;
    }
    available.set(file.size, count - 1);
    matchedBytes += file.size;
  }

  return matchedBytes >= total(small) * (1 - PARTIAL_SIZE_TOLERANCE);
};

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) {
      root = this.parent[root];
    }
    // Path compression.
    let node = index;
    while (this.parent[node] !== root) {
      const next = this.parent[node];
      this.parent[node] = root;
      node = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      this.parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
    }
  }
}

/**
 * Group downloads that hold the same data, and within each group tell the
 * original from its cross-seeds.
 *
 * Downloads are joined when they share a content path (cross-seed's data-dir
 * mode), share name and size (the usual linked / hardlinked cross-seed), or -
 * for a tagged cross-seed with neither - when their files match. Untagged
 * downloads of the same large size are joined by their files too, so a
 * cross-seed added without a tag is still found.
 *
 * Within a group, the original is the untagged download an *arr grabbed, else
 * the oldest untagged one. A group of tagged downloads only has no original:
 * the download they were cross-seeded from is gone.
 */
export const groupCrossSeeds = async ({
  torrents,
  isMarked,
  isArrLinked,
  loadFiles,
  isRelevant = () => true,
}: CrossSeedGroupingInput): Promise<TorrentGroup[]> => {
  const sets = new UnionFind(torrents.length);
  const marked = torrents.map((torrent) => isMarked(torrent));

  // Same content path and close in size. The size check keeps apart
  // unrelated multi-file downloads without a root folder, whose content path
  // is the shared save path.
  const joinWhere = (key: (torrent: DownloadClientTorrent) => string) => {
    const firstByKey = new Map<string, number>();
    torrents.forEach((torrent, index) => {
      const value = key(torrent);
      if (!value) {
        return;
      }
      const first = firstByKey.get(value);
      if (first === undefined) {
        firstByKey.set(value, index);
      } else if (sizesClose(sizeOf(torrents[first]), sizeOf(torrent))) {
        sets.union(first, index);
      }
    });
  };
  joinWhere((torrent) => normalizeContentPath(torrent.content_path));
  joinWhere((torrent) =>
    sizeOf(torrent) > 0 ? `${torrent.name}\u0000${sizeOf(torrent)}` : '',
  );

  const filesCache = new Map<
    string,
    Promise<DownloadClientFile[] | undefined>
  >();
  const files = (torrent: DownloadClientTorrent) => {
    if (!filesCache.has(torrent.hash)) {
      filesCache.set(
        torrent.hash,
        loadFiles(torrent.hash).catch(() => undefined),
      );
    }
    return filesCache.get(torrent.hash);
  };
  const sameFiles = async (
    a: DownloadClientTorrent,
    b: DownloadClientTorrent,
  ): Promise<boolean> => {
    const [filesA, filesB] = await Promise.all([files(a), files(b)]);
    return !!filesA && !!filesB && filesMatch(filesA, filesB);
  };

  const hasUnmarkedPeer = (index: number) => {
    const root = sets.find(index);
    return torrents.some(
      (_, other) =>
        other !== index && !marked[other] && sets.find(other) === root,
    );
  };

  // Tagged cross-seeds still without an original: compare files with the
  // nearest-size untagged downloads.
  const unmarkedIndexes = torrents
    .map((_, index) => index)
    .filter((index) => !marked[index]);
  for (let index = 0; index < torrents.length; index += 1) {
    if (!marked[index] || hasUnmarkedPeer(index)) {
      continue;
    }
    const size = sizeOf(torrents[index]);
    const candidates = unmarkedIndexes
      .filter(
        (other) =>
          isRelevant(torrents[other]) &&
          sizesClose(size, sizeOf(torrents[other])),
      )
      .sort(
        (a, b) =>
          Math.abs(sizeOf(torrents[a]) - size) -
          Math.abs(sizeOf(torrents[b]) - size),
      )
      .slice(0, MAX_FILE_CANDIDATES);
    for (const candidate of candidates) {
      if (await sameFiles(torrents[index], torrents[candidate])) {
        sets.union(index, candidate);
        break;
      }
    }
  }

  // Untagged downloads of identical, large size: likely cross-seeds added
  // without a tag. Confirm by files.
  const bySize = new Map<number, number[]>();
  for (const index of unmarkedIndexes) {
    const size = sizeOf(torrents[index]);
    if (size >= INFERRED_MIN_BYTES) {
      bySize.set(size, [...(bySize.get(size) ?? []), index]);
    }
  }
  for (const bucket of bySize.values()) {
    if (
      bucket.length < 2 ||
      bucket.length > INFERRED_MAX_BUCKET ||
      !bucket.some((index) => isRelevant(torrents[index]))
    ) {
      continue;
    }
    for (let a = 0; a < bucket.length; a += 1) {
      for (let b = a + 1; b < bucket.length; b += 1) {
        if (sets.find(bucket[a]) === sets.find(bucket[b])) {
          continue;
        }
        if (await sameFiles(torrents[bucket[a]], torrents[bucket[b]])) {
          sets.union(bucket[a], bucket[b]);
        }
      }
    }
  }

  const components = new Map<number, number[]>();
  torrents.forEach((_, index) => {
    const root = sets.find(index);
    components.set(root, [...(components.get(root) ?? []), index]);
  });

  const groups: TorrentGroup[] = [];
  for (const members of components.values()) {
    // A lone untagged download is not part of any cross-seed.
    if (members.length === 1 && !marked[members[0]]) {
      continue;
    }

    const originals = members
      .filter((index) => !marked[index])
      .sort((a, b) => {
        const linkedA = isArrLinked(torrents[a]) ? 0 : 1;
        const linkedB = isArrLinked(torrents[b]) ? 0 : 1;
        const addedA = torrents[a].addedOn || Number.MAX_SAFE_INTEGER;
        const addedB = torrents[b].addedOn || Number.MAX_SAFE_INTEGER;
        return (
          linkedA - linkedB ||
          addedA - addedB ||
          torrents[a].hash.localeCompare(torrents[b].hash)
        );
      });
    const originalIndex = originals[0];

    groups.push({
      original: originalIndex === undefined ? null : torrents[originalIndex],
      crossSeeds: members
        .filter((index) => index !== originalIndex)
        .map((index) => ({
          torrent: torrents[index],
          detection: marked[index] ? 'marker' : 'inferred',
        })),
    });
  }

  return groups;
};
