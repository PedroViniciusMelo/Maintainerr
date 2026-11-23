import { BasicResponseDto } from '@maintainerr/contracts';
import { Injectable } from '@nestjs/common';
import { connectionTestConfig } from '../lib/connectionTest';
import { SettingsDataService } from '../../../modules/settings/settings-data.service';
import {
  formatConnectionFailureMessage,
  logConnectionTestError,
} from '../../../utils/connection-error';
import {
  MaintainerrLogger,
  MaintainerrLoggerFactory,
} from '../../logging/logs.service';
import {
  createDownloadClient,
  DownloadClientConnection,
} from './download-client.factory';
import { detectCrossSeedMarkers, groupCrossSeeds } from './cross-seed.grouping';
import {
  DownloadClient,
  DownloadClientTorrent,
} from './download-client.interface';

/**
 * Seed-time floor for a download the client does not limit. The fallback ratio
 * alone lets a tracker's seed-time rule be broken the moment the ratio is met,
 * so both must hold before such a download is removed.
 */
const FALLBACK_SEEDING_HOURS = 23;

/**
 * Seed time after which such a download is removed at any ratio, so one that
 * nobody downloads does not seed forever. 14 days is the seed-time rule
 * trackers have reported (#3678, https://features.maintainerr.info/posts/259).
 */
const FALLBACK_MAX_SEEDING_DAYS = 14;

/**
 * How many downloads use each content path, so data shared by another
 * download is never deleted out from under it.
 */
const countContentPaths = (
  torrents: DownloadClientTorrent[],
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const torrent of torrents) {
    const path = torrent.content_path?.trim();
    if (path) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return counts;
};

/**
 * Talks to the configured download client to clean up completed downloads for
 * media Radarr/Sonarr removes. Client-specific behavior lives behind the
 * DownloadClient contract.
 */
@Injectable()
export class DownloadClientApiService {
  api: DownloadClient | undefined;

  constructor(
    private readonly settings: SettingsDataService,
    private readonly logger: MaintainerrLogger,
    private readonly loggerFactory: MaintainerrLoggerFactory,
  ) {
    logger.setContext(DownloadClientApiService.name);
  }

  public init() {
    // Clear the cached client on every settings change so we never act against
    // a stale URL or stale credentials.
    this.api = undefined;

    if (!this.settings.download_client_url) {
      return;
    }

    this.api = createDownloadClient(
      {
        type: this.settings.download_client_type,
        url: this.settings.download_client_url,
        username: this.settings.download_client_username,
        password: this.settings.download_client_password,
      },
      this.loggerFactory.createLogger(),
    );
  }

  public async testConnection(
    params: DownloadClientConnection,
  ): Promise<BasicResponseDto> {
    const api = createDownloadClient(params, this.loggerFactory.createLogger());

    try {
      const version = await api.getVersion(connectionTestConfig());

      if (!version) {
        throw new Error(
          'Unexpected response from the download client. Verify the URL points to the selected client API.',
        );
      }

      return { status: 'OK', code: 1, message: version };
    } catch (error) {
      logConnectionTestError(this.logger, 'Download client', error);

      return {
        status: 'NOK',
        code: 0,
        message: formatConnectionFailureMessage(
          error,
          'Failed to connect to the download client. Verify URL and credentials.',
        ),
      };
    }
  }

  /**
   * Remove the completed downloads identified by the given download-client ids
   * (Radarr/Sonarr `downloadId`s - for a torrent client these are infohashes).
   * No-op when no download client is configured. Best-effort: each download is
   * handled independently and a failure never throws into the caller - the
   * media has already been deleted from the *arr at this point, so this cleanup
   * is a side effect.
   *
   * Whether a download has finished seeding is decided by the download client's
   * own ratio / seed-time limits. Only when the client enforces no limit do
   * Maintainerr's fallbacks apply.
   *
   * Cross-seed protection (inspired by qbit_manage): when deleting data, a
   * download whose content path is shared by another download is removed
   * entry-only (data kept), so cross-seeded downloads keep working.
   *
   * With "remove cross-seeds" on, the cross-seeds of each removed download go
   * with it, each under the same seeding-goal and delete-data rules; they are
   * removed first, so the last download of a shared path takes the data.
   */
  public async removeDownloads(downloadIds: string[]): Promise<void> {
    if (!this.api || downloadIds.length === 0) {
      return;
    }

    const fallbackRatio = this.settings.download_client_fallback_ratio ?? 0.5;
    const deleteData = this.settings.download_client_delete_data ?? true;
    const removeCrossSeeds =
      this.settings.download_client_remove_cross_seeds === true;

    const hashes = [
      ...new Set(
        downloadIds
          .map((downloadId) => downloadId?.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];

    // One list read, reused for every hash. Only needed to protect shared
    // data, or to find the cross-seeds to remove along with each download.
    const torrents =
      deleteData || removeCrossSeeds ? await this.readAllTorrents() : [];
    const contentPathCounts = countContentPaths(torrents);
    const crossSeedsByOriginal = removeCrossSeeds
      ? await this.findCrossSeeds(torrents, new Set(hashes))
      : new Map<string, DownloadClientTorrent[]>();

    for (const hash of hashes) {
      try {
        const torrent = await this.api.getTorrentByHash(hash);
        if (!torrent) {
          // Not in the download client (already removed, a different client, or
          // a manual import that never had a download) - nothing to clean up.
          continue;
        }

        if (!this.shouldRemove(torrent, fallbackRatio)) {
          // Its cross-seeds stay too: they still share data with it.
          this.logKeep(torrent, fallbackRatio);
          continue;
        }

        for (const crossSeed of crossSeedsByOriginal.get(hash) ?? []) {
          await this.removeCrossSeed(
            crossSeed,
            torrent,
            hashes,
            fallbackRatio,
            deleteData,
            contentPathCounts,
          );
        }

        await this.removeOne(hash, torrent, deleteData, contentPathCounts);
      } catch (error) {
        this.logger.warn(
          `Failed to remove download with hash ${hash} from the download client`,
        );
        this.logger.debug(error);
      }
    }
  }

  private async removeCrossSeed(
    crossSeed: DownloadClientTorrent,
    original: DownloadClientTorrent,
    requested: string[],
    fallbackRatio: number,
    deleteData: boolean,
    contentPathCounts: Map<string, number>,
  ): Promise<void> {
    const hash = crossSeed.hash.toLowerCase();
    // A cross-seed an *arr asked to remove as well is handled on its own turn.
    if (requested.includes(hash)) {
      return;
    }
    if (!this.shouldRemove(crossSeed, fallbackRatio)) {
      this.logger.log(
        `Keeping cross-seed '${crossSeed.name}' of '${original.name}' seeding: its seeding goal isn't met yet`,
      );
      return;
    }
    try {
      await this.removeOne(
        hash,
        crossSeed,
        deleteData,
        contentPathCounts,
        `cross-seed '${crossSeed.name}' of '${original.name}'`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to remove cross-seed '${crossSeed.name}' of '${original.name}' from the download client`,
      );
      this.logger.debug(error);
    }
  }

  /**
   * Remove one download. Its data is deleted only with the delete-data setting
   * and only when no other download still uses the same content path; the
   * count is lowered afterwards, so the last download of a path takes the data.
   */
  private async removeOne(
    hash: string,
    torrent: DownloadClientTorrent,
    deleteData: boolean,
    contentPathCounts: Map<string, number>,
    label = `download '${torrent.name}'`,
  ): Promise<void> {
    const path = torrent.content_path?.trim();
    const isCrossSeeded =
      deleteData && !!path && (contentPathCounts.get(path) ?? 0) > 1;
    const deleteDataForThis = deleteData && !isCrossSeeded;

    await this.api.deleteTorrents([hash], deleteDataForThis);

    if (path && contentPathCounts.has(path)) {
      contentPathCounts.set(path, contentPathCounts.get(path) - 1);
    }

    if (isCrossSeeded) {
      this.logger.log(
        `Removed ${label} but kept its data: another download is cross-seeding the same files (${torrent.content_path})`,
      );
    } else {
      this.logger.log(
        `Removed ${label} from the download client${
          deleteDataForThis ? ' (including downloaded data)' : ''
        }`,
      );
    }
  }

  private logKeep(torrent: DownloadClientTorrent, fallbackRatio: number) {
    this.logger.log(
      torrent.reachedSeedingGoal === false
        ? `Keeping download '${torrent.name}' seeding: its download-client seeding goal isn't met yet`
        : `Keeping download '${torrent.name}' seeding: the download client enforces no limit, and at ratio ${torrent.ratio} after ${(torrent.seedingTime / 3600).toFixed(1)}h it meets neither fallback (ratio ${fallbackRatio} after ${FALLBACK_SEEDING_HOURS}h, or ${FALLBACK_MAX_SEEDING_DAYS} days at any ratio). This check only runs when media is deleted.`,
    );
  }

  /**
   * Every download in the client, for cross-seed detection. Best-effort: on
   * failure we return an empty list and fall back to the user's delete-data
   * setting (and remove no cross-seeds).
   */
  private async readAllTorrents(): Promise<DownloadClientTorrent[]> {
    try {
      return (await this.api?.getTorrents()) ?? [];
    } catch (error) {
      this.logger.warn(
        'Could not read the download list for cross-seed detection; proceeding with the configured delete-data setting',
      );
      this.logger.debug(error);
      return [];
    }
  }

  /**
   * The cross-seeds of each download about to be removed, found the same way
   * as the cross-seed view: by the installation's cross-seed tag/category,
   * shared path, name and size, or files.
   */
  private async findCrossSeeds(
    torrents: DownloadClientTorrent[],
    originals: Set<string>,
  ): Promise<Map<string, DownloadClientTorrent[]>> {
    const result = new Map<string, DownloadClientTorrent[]>();
    if (torrents.length === 0) {
      return result;
    }
    try {
      const isOriginal = (torrent: DownloadClientTorrent) =>
        originals.has(torrent.hash.toLowerCase());
      const groups = await groupCrossSeeds({
        torrents,
        isMarked: detectCrossSeedMarkers(torrents).isMarked,
        isArrLinked: isOriginal,
        loadFiles: (hash) => this.api.getTorrentFiles(hash),
        // Only the downloads being removed matter here; skip file reads for
        // unrelated groups.
        isRelevant: isOriginal,
      });
      for (const group of groups) {
        if (group.original && isOriginal(group.original)) {
          result.set(
            group.original.hash.toLowerCase(),
            group.crossSeeds.map(({ torrent }) => torrent),
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        'Could not work out the cross-seeds of the removed downloads; removing only the downloads themselves',
      );
      this.logger.debug(error);
    }
    return result;
  }

  /**
   * Whether a download has finished seeding, by the same rule the media-delete
   * cleanup uses: the client's own goal, else Maintainerr's fallbacks.
   */
  public isDoneSeeding(torrent: DownloadClientTorrent): boolean {
    return this.shouldRemove(
      torrent,
      this.settings.download_client_fallback_ratio ?? 0.5,
    );
  }

  /** Whether removing a download should also delete its data (the user setting). */
  public deletesData(): boolean {
    return this.settings.download_client_delete_data ?? true;
  }

  /**
   * Defer to the download client's own seeding goal; only when it enforces no
   * limit (`reachedSeedingGoal === null`) apply Maintainerr's fallbacks: the
   * fallback ratio after the seed-time floor, or any ratio after the maximum
   * seed time. The client normalizes an unbounded ratio to Infinity, so a
   * plain `>=` covers that case too.
   */
  private shouldRemove(
    torrent: DownloadClientTorrent,
    fallbackRatio: number,
  ): boolean {
    if (torrent.reachedSeedingGoal !== null) {
      return torrent.reachedSeedingGoal;
    }
    return (
      torrent.seedingTime >= FALLBACK_MAX_SEEDING_DAYS * 86400 ||
      (torrent.ratio >= fallbackRatio &&
        torrent.seedingTime >= FALLBACK_SEEDING_HOURS * 3600)
    );
  }
}
