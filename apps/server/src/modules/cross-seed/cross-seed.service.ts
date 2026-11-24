import {
  CrossSeedArrLink,
  CrossSeedArrType,
  CrossSeedDeleteRequest,
  CrossSeedDeleteResponse,
  CrossSeedDeleteResult,
  CrossSeedDetection,
  CrossSeedGroup,
  CrossSeedOrphanReason,
  CrossSeedOverview,
  CrossSeedTorrent,
} from '@maintainerr/contracts';
import { Injectable } from '@nestjs/common';
import { DownloadClientApiService } from '../api/download-client-api/download-client-api.service';
import {
  DownloadClientFile,
  DownloadClientTorrent,
} from '../api/download-client-api/download-client.interface';
import { MaintainerrLogger } from '../logging/logs.service';
import { getErrorMessage } from '../../utils/connection-error';
import {
  ArrDownloadIndex,
  ArrDownloadIndexService,
} from './arr-download-index.service';
import {
  detectCrossSeedMarkers,
  groupCrossSeeds,
  normalizeContentPath,
  TorrentGroup,
} from '../api/download-client-api/cross-seed.grouping';

/** File lists never change for a hash; keep this many between page loads. */
const FILES_CACHE_LIMIT = 5000;

/**
 * The category a download would have without cross-seed's suffix, so a
 * `radarr.cross-seed` child counts as belonging to the `radarr` category.
 */
const baseCategory = (category: string): string => {
  const suffix = '.cross-seed';
  return category.toLowerCase().endsWith(suffix)
    ? category.slice(0, -suffix.length)
    : category;
};

interface AnalyzedGroup {
  group: TorrentGroup;
  orphanReason: CrossSeedOrphanReason | null;
  arrType: CrossSeedArrType | null;
}

interface Analysis {
  torrents: DownloadClientTorrent[];
  index: ArrDownloadIndex;
  groups: AnalyzedGroup[];
  markers: { tags: string[]; categories: string[] };
  arrCategories: string[];
}

/**
 * The cross-seed view: which downloads are cross-seeds of which original, and
 * which have become orphans, plus removing orphans with the same rules the
 * media-delete cleanup follows.
 */
@Injectable()
export class CrossSeedService {
  private readonly filesCache = new Map<string, DownloadClientFile[]>();

  constructor(
    private readonly downloadClient: DownloadClientApiService,
    private readonly arrIndex: ArrDownloadIndexService,
    private readonly logger: MaintainerrLogger,
  ) {
    logger.setContext(CrossSeedService.name);
  }

  public async getOverview(refresh = false): Promise<CrossSeedOverview> {
    const empty: CrossSeedOverview = {
      configured: !!this.downloadClient.api,
      error: null,
      markers: { tags: [], categories: [] },
      arrIndexComplete: false,
      arrInstances: [],
      arrCategories: [],
      groups: [],
      torrentCount: 0,
      generatedAt: new Date().toISOString(),
    };
    if (!this.downloadClient.api) {
      return empty;
    }

    let analysis: Analysis;
    try {
      analysis = await this.analyze(refresh);
    } catch (error) {
      this.logger.warn('Could not read the download client for cross-seeds');
      this.logger.debug(error);
      return {
        ...empty,
        error: getErrorMessage(error, 'Could not read the download client'),
      };
    }

    const { index, groups, torrents, markers, arrCategories } = analysis;
    return {
      ...empty,
      markers,
      arrIndexComplete: index.complete,
      arrInstances: index.instances,
      arrCategories,
      torrentCount: torrents.length,
      groups: groups
        .map(({ group, orphanReason, arrType }) =>
          this.toGroup(group, orphanReason, arrType, index),
        )
        .sort(
          (a, b) =>
            Number(b.orphanReason !== null) - Number(a.orphanReason !== null) ||
            groupName(a).localeCompare(groupName(b)),
        ),
    };
  }

  /**
   * Remove orphaned downloads. Every hash is re-checked against a fresh read
   * of the client first, so only downloads that are orphans right now are
   * touched. Like the media-delete cleanup, a download whose seeding goal is
   * not met is kept (unless forced), data is deleted only when the user's
   * delete-data setting says so, and never while another download still uses
   * the same content path. Each download is handled on its own; one failure
   * does not stop the rest.
   */
  public async deleteOrphans({
    hashes,
    force,
  }: CrossSeedDeleteRequest): Promise<CrossSeedDeleteResponse> {
    const api = this.downloadClient.api;
    if (!api) {
      return { results: [] };
    }

    const { torrents, groups } = await this.analyze(true);

    const orphans = new Map<string, DownloadClientTorrent>();
    for (const { group, orphanReason } of groups) {
      if (!orphanReason) {
        continue;
      }
      for (const torrent of membersOf(group)) {
        orphans.set(torrent.hash.toLowerCase(), torrent);
      }
    }

    const results: CrossSeedDeleteResult[] = [];
    const toRemove: DownloadClientTorrent[] = [];
    const requested = new Set(hashes.map((hash) => hash.trim().toLowerCase()));
    for (const hash of requested) {
      const torrent = orphans.get(hash);
      if (!torrent) {
        results.push({
          hash,
          name:
            torrents.find((t) => t.hash.toLowerCase() === hash)?.name ?? hash,
          outcome: 'skipped',
          dataDeleted: false,
          reason: 'not-orphan',
        });
        continue;
      }
      if (!force && !this.downloadClient.isDoneSeeding(torrent)) {
        this.logger.log(
          `Keeping orphaned download '${torrent.name}' seeding: its seeding goal isn't met yet`,
        );
        results.push({
          hash,
          name: torrent.name,
          outcome: 'skipped',
          dataDeleted: false,
          reason: 'still-seeding',
        });
        continue;
      }
      toRemove.push(torrent);
    }

    // Downloads that stay in the client after this removal. Data is only
    // deleted with the last removed download of a content path, and only when
    // none of these still uses it.
    const removing = new Set(toRemove.map((torrent) => torrent.hash));
    const keptPaths = new Set(
      torrents
        .filter((torrent) => !removing.has(torrent.hash))
        .map((torrent) => normalizeContentPath(torrent.content_path))
        .filter(Boolean),
    );
    const remainingByPath = new Map<string, number>();
    for (const torrent of toRemove) {
      const path = normalizeContentPath(torrent.content_path);
      remainingByPath.set(path, (remainingByPath.get(path) ?? 0) + 1);
    }

    const deleteData = this.downloadClient.deletesData();
    for (const torrent of toRemove) {
      const path = normalizeContentPath(torrent.content_path);
      const left = (remainingByPath.get(path) ?? 1) - 1;
      remainingByPath.set(path, left);
      const withData =
        deleteData && !!path && left === 0 && !keptPaths.has(path);

      try {
        await api.deleteTorrents([torrent.hash], withData);
        this.logger.log(
          withData
            ? `Removed orphaned cross-seed download '${torrent.name}' (including downloaded data)`
            : deleteData
              ? `Removed orphaned cross-seed download '${torrent.name}' but kept its data: another download uses the same files (${torrent.content_path})`
              : `Removed orphaned cross-seed download '${torrent.name}' from the download client`,
        );
        results.push({
          hash: torrent.hash.toLowerCase(),
          name: torrent.name,
          outcome: 'removed',
          dataDeleted: withData,
          reason: null,
        });
      } catch (error) {
        this.logger.warn(
          `Failed to remove orphaned download '${torrent.name}' from the download client`,
        );
        this.logger.debug(error);
        results.push({
          hash: torrent.hash.toLowerCase(),
          name: torrent.name,
          outcome: 'failed',
          dataDeleted: false,
          reason: null,
        });
      }
    }

    return { results };
  }

  private async analyze(refresh: boolean): Promise<Analysis> {
    const api = this.downloadClient.api;
    const [torrents, index] = await Promise.all([
      api.getTorrents(),
      this.arrIndex.getIndex(refresh),
    ]);

    const markers = detectCrossSeedMarkers(torrents);
    const linksOf = (torrent: DownloadClientTorrent) =>
      index.links.get(torrent.hash.toLowerCase()) ?? [];

    // The categories the *arrs download into, learned from the downloads
    // they grabbed. A group outside them (music, manual downloads, another
    // tool) was never *arr media, so it is not judged by *arr history.
    // Which *arr downloads into each of those categories, by how many of its
    // downloads use it, so a group no *arr history names still gets a home.
    const arrCategories = new Set<string>();
    const categoryVotes = new Map<string, Map<CrossSeedArrType, number>>();
    for (const torrent of torrents) {
      const links = linksOf(torrent);
      if (links.length === 0) {
        continue;
      }
      const category = baseCategory(torrent.category ?? '');
      arrCategories.add(category);
      const votes = categoryVotes.get(category) ?? new Map();
      for (const type of new Set(links.map((link) => link.instanceType))) {
        votes.set(type, (votes.get(type) ?? 0) + 1);
      }
      categoryVotes.set(category, votes);
    }
    const categoryArrType = (category: string): CrossSeedArrType | null => {
      let best: CrossSeedArrType | null = null;
      let bestCount = 0;
      for (const [type, count] of categoryVotes.get(category) ?? []) {
        if (count > bestCount) {
          best = type;
          bestCount = count;
        }
      }
      return best;
    };
    const arrTypeOf = (group: TorrentGroup): CrossSeedArrType | null => {
      const members = membersOf(group);
      const linked = members
        .flatMap((torrent) => linksOf(torrent))
        .find(Boolean);
      return (
        linked?.instanceType ??
        categoryArrType(baseCategory(members[0]?.category ?? ''))
      );
    };

    const groups = await groupCrossSeeds({
      torrents,
      isMarked: markers.isMarked,
      isArrLinked: (torrent) => linksOf(torrent).length > 0,
      loadFiles: (hash) => this.loadFiles(hash),
    });

    const analyzed = groups.map((group) => ({
      group,
      orphanReason: this.orphanReason(group, index, arrCategories, linksOf),
      arrType: arrTypeOf(group),
    }));

    return {
      torrents,
      index,
      groups: analyzed,
      markers: { tags: markers.tags, categories: markers.categories },
      arrCategories: [...arrCategories].sort(),
    };
  }

  private orphanReason(
    group: TorrentGroup,
    index: ArrDownloadIndex,
    arrCategories: Set<string>,
    linksOf: (torrent: DownloadClientTorrent) => { hasFile: boolean }[],
  ): CrossSeedOrphanReason | null {
    if (!group.original) {
      return 'original-missing';
    }
    // Only a complete index can show that media is gone; a failed *arr read
    // must never make its downloads look abandoned.
    if (!index.complete) {
      return null;
    }
    if (!arrCategories.has(baseCategory(group.original.category ?? ''))) {
      return null;
    }
    const backsMedia = membersOf(group).some((torrent) =>
      linksOf(torrent).some((link) => link.hasFile),
    );
    return backsMedia ? null : 'media-removed';
  }

  private async loadFiles(
    hash: string,
  ): Promise<DownloadClientFile[] | undefined> {
    const cached = this.filesCache.get(hash);
    if (cached) {
      return cached;
    }
    try {
      const files = await this.downloadClient.api.getTorrentFiles(hash);
      if (this.filesCache.size >= FILES_CACHE_LIMIT) {
        this.filesCache.clear();
      }
      this.filesCache.set(hash, files);
      return files;
    } catch (error) {
      this.logger.debug(error);
      return undefined;
    }
  }

  private toGroup(
    group: TorrentGroup,
    orphanReason: CrossSeedOrphanReason | null,
    arrType: CrossSeedArrType | null,
    index: ArrDownloadIndex,
  ): CrossSeedGroup {
    const toTorrent = (
      torrent: DownloadClientTorrent,
      detection: CrossSeedDetection | null,
    ): CrossSeedTorrent => ({
      hash: torrent.hash.toLowerCase(),
      name: torrent.name,
      contentPath: torrent.content_path,
      size: torrent.size ?? 0,
      ratio: Number.isFinite(torrent.ratio) ? torrent.ratio : null,
      seedingTime: torrent.seedingTime,
      addedOn: torrent.addedOn ?? 0,
      tags: torrent.tags ?? [],
      category: torrent.category ?? '',
      tracker: torrent.tracker ?? '',
      seedingGoalMet: this.downloadClient.isDoneSeeding(torrent),
      detection,
      arrLinks: (index.links.get(torrent.hash.toLowerCase()) ?? []).map(
        ({
          instanceType,
          instanceId,
          instanceName,
          title,
        }): CrossSeedArrLink => ({
          instanceType,
          instanceId,
          instanceName,
          title,
        }),
      ),
      orphanReason,
    });

    const first = group.original ?? group.crossSeeds[0]?.torrent;
    return {
      id: first.hash.toLowerCase(),
      original: group.original ? toTorrent(group.original, null) : null,
      crossSeeds: group.crossSeeds
        .map(({ torrent, detection }) => toTorrent(torrent, detection))
        .sort((a, b) => a.addedOn - b.addedOn || a.name.localeCompare(b.name)),
      orphanReason,
      arrType,
      dataSize: Math.max(
        0,
        ...membersOf(group).map((torrent) => torrent.size ?? 0),
      ),
    };
  }
}

const membersOf = (group: TorrentGroup): DownloadClientTorrent[] => [
  ...(group.original ? [group.original] : []),
  ...group.crossSeeds.map(({ torrent }) => torrent),
];

const groupName = (group: CrossSeedGroup): string =>
  group.original?.name ?? group.crossSeeds[0]?.name ?? '';
