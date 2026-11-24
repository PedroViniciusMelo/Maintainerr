import z from 'zod'

export type CrossSeedArrType = 'radarr' | 'sonarr' | 'sportarr'

/** One *arr item a download backs. */
export interface CrossSeedArrLink {
  instanceType: CrossSeedArrType
  instanceId: number
  instanceName: string
  title: string
}

/**
 * Why a download counts as an orphan:
 *  - `original-missing`: a cross-seed whose original download is no longer in
 *    the download client.
 *  - `media-removed`: its group backed *arr media once (an *arr lists it
 *    without a file, or Maintainerr saw the link before) and backs none now.
 *  - `not-in-arr`: it sits in an *arr category but no *arr ever knew its group.
 */
export type CrossSeedOrphanReason =
  'original-missing' | 'media-removed' | 'not-in-arr'

/**
 * How a download was recognized as a cross-seed:
 *  - `marker`: it carries the tag or category cross-seed adds.
 *  - `inferred`: it has no marker but holds the same files as the original.
 */
export type CrossSeedDetection = 'marker' | 'inferred'

export interface CrossSeedTorrent {
  hash: string
  name: string
  contentPath: string
  size: number
  /** Share ratio; null when unbounded. */
  ratio: number | null
  /** Seconds seeded since completion. */
  seedingTime: number
  /** Unix seconds; 0 when unknown. */
  addedOn: number
  tags: string[]
  category: string
  tracker: string
  /** Whether the download-client (or fallback) seeding goal is met. */
  seedingGoalMet: boolean
  /** Null for the original of a group. */
  detection: CrossSeedDetection | null
  arrLinks: CrossSeedArrLink[]
  /**
   * The *arr item Maintainerr saw this download back before the *arr erased
   * its history; null while an *arr still lists it, or when never seen.
   */
  formerArrLink: CrossSeedArrLink | null
  orphanReason: CrossSeedOrphanReason | null
}

/**
 * A set of downloads sharing the same data: the original (the download that
 * is not a cross-seed, when it still exists) and the cross-seeds of it.
 */
export interface CrossSeedGroup {
  /** Stable for the same original, so the UI can keep a row expanded. */
  id: string
  original: CrossSeedTorrent | null
  crossSeeds: CrossSeedTorrent[]
  orphanReason: CrossSeedOrphanReason | null
  /**
   * The *arr the group belongs to: the *arr that grabbed one of its downloads,
   * else the *arr whose downloads use the same category. Null when none does.
   */
  arrType: CrossSeedArrType | null
  /**
   * Bytes the group's data takes, counted once: cross-seeds share the
   * original's files (same path or hardlinks), so this is its largest download.
   */
  dataSize: number
}

export interface CrossSeedArrStatus {
  instanceType: CrossSeedArrType
  instanceId: number
  instanceName: string
  ok: boolean
}

export interface CrossSeedOverview {
  /** False when no download client is configured; everything else is empty. */
  configured: boolean
  /** Set when the download client could not be read. */
  error: string | null
  /** The cross-seed tags / categories found in this download client. */
  markers: { tags: string[]; categories: string[] }
  /**
   * Whether every configured *arr history was read. When false, no group is
   * reported as `media-removed`: an unreadable *arr never makes media look gone.
   */
  arrIndexComplete: boolean
  arrInstances: CrossSeedArrStatus[]
  /** Download-client categories of downloads the *arrs manage. */
  arrCategories: string[]
  groups: CrossSeedGroup[]
  /** Downloads read from the client in total. */
  torrentCount: number
  generatedAt: string
}

export const crossSeedDeleteRequestSchema = z.object({
  hashes: z.array(z.string().trim().min(1)).min(1).max(1000),
  /** Remove even when the seeding goal is not met yet. */
  force: z.boolean().default(false),
})

export type CrossSeedDeleteRequest = z.infer<
  typeof crossSeedDeleteRequestSchema
>

/**
 * Why a requested download was not removed:
 *  - `not-orphan`: it is no longer an orphan (or no longer in the client).
 *  - `still-seeding`: its seeding goal is not met and `force` was not set.
 */
export type CrossSeedSkipReason = 'not-orphan' | 'still-seeding'

export interface CrossSeedDeleteResult {
  hash: string
  name: string
  outcome: 'removed' | 'skipped' | 'failed'
  /** Whether the download's data was deleted from disk with it. */
  dataDeleted: boolean
  reason: CrossSeedSkipReason | null
}

export interface CrossSeedDeleteResponse {
  results: CrossSeedDeleteResult[]
}
