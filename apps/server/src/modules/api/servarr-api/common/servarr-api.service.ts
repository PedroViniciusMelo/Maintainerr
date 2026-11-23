import { normalizeDiskPath, QualityProfile } from '@maintainerr/contracts';
import { ExternalApiService } from '../../../../modules/api/external-api/external-api.service';
import { DVRSettings } from '../../../../modules/settings/interfaces/dvr-settings.interface';
import { MaintainerrLogger } from '../../../logging/logs.service';
import cacheManager from '../../lib/cache';
import { NO_TIMEOUT, SLOW_INSTANCE_TIMEOUT_MS } from '../../lib/httpTimeouts';
import {
  ArrDownloadLink,
  DiskSpaceResource,
  HistoryPage,
  HistoryRecord,
  QueueItem,
  QueueResponse,
  RootFolder,
  SystemStatus,
  Tag,
} from '../interfaces/servarr.interface';

/** Page size for walking the full history; the *arr APIs accept large pages. */
const HISTORY_PAGE_SIZE = 1000;
/** Stop after this many pages rather than walk an unbounded history forever. */
const HISTORY_MAX_PAGES = 500;
/**
 * Radarr and Sonarr share these numeric history event types:
 * 1 = grabbed, 3 = downloadFolderImported.
 */
const DOWNLOAD_EVENT_TYPES = [1, 3];

export abstract class ServarrApi<QueueItemAppendT> extends ExternalApiService {
  static buildUrl(settings: DVRSettings, path?: string): string {
    return `${settings.useSsl ? 'https' : 'http'}://${settings.hostname}:${settings.port}${settings.baseUrl ?? ''}${path}`;
  }

  protected apiName: string;

  constructor(
    {
      url,
      apiKey,
      cacheName,
    }: {
      url: string;
      apiKey: string;
      cacheName?: string;
    },
    protected readonly logger: MaintainerrLogger,
  ) {
    super(
      url,
      {
        apikey: apiKey,
      },
      logger,
      cacheName
        ? { nodeCache: cacheManager.getCache(cacheName).data }
        : undefined,
    );
  }

  public getSystemStatus = async (): Promise<SystemStatus> => {
    try {
      const response = await this.axios.get<SystemStatus>('/system/status');

      return response.data;
    } catch (error) {
      this.logger.warn('Failed to retrieve system status');
      this.logger.debug(error);
    }
  };

  public getProfiles = async (): Promise<QualityProfile[]> => {
    try {
      const data = await this.getRolling<QualityProfile[]>(
        `/qualityProfile`,
        undefined,
        3600,
      );

      return data;
    } catch (error) {
      this.logger.warn('Failed to retrieve profiles');
      this.logger.debug(error);
    }
  };

  /**
   * The *arr's root folders. Cached for an hour by default - they change
   * rarely and rule evaluation reads them often. Pass `fresh` where they fence
   * a destructive operation: the leftover-folder cleanup only deletes inside a
   * root, and a stale fence is not a fence.
   */
  public getRootFolders = async (options?: {
    fresh?: boolean;
  }): Promise<RootFolder[]> => {
    try {
      const data = options?.fresh
        ? await this.getWithoutCache<RootFolder[]>(`/rootfolder`, {
            timeout: SLOW_INSTANCE_TIMEOUT_MS,
          })
        : await this.getRolling<RootFolder[]>(`/rootfolder`, undefined, 3600);

      return data;
    } catch (error) {
      this.logger.warn('Failed to retrieve root folders');
      this.logger.debug(error);
    }
  };

  public getDiskspace = async (): Promise<DiskSpaceResource[]> => {
    try {
      const data = await this.getRolling<DiskSpaceResource[]>(
        `/diskspace`,
        undefined,
        3600,
      );

      return data;
    } catch (error) {
      this.logger.warn('Failed to retrieve disk space');
      this.logger.debug(error);
    }
  };

  /**
   * Returns disk space entries merged with root folder data.
   *
   * Sonarr's /diskspace only includes DriveType.Fixed mounts, which excludes
   * NFS/CIFS network mounts commonly used in Docker setups. Radarr includes
   * DriveType.Network too, so it usually works already. We supplement both
   * with /rootfolder entries to cover missing media mount paths.
   *
   * Note: The /rootfolder API only returns freeSpace, not a trustworthy
   * totalSpace value. Fallback entries sourced from root folders therefore
   * set totalSpace = 0 and hasAccurateTotalSpace = false.
   *
   * These merged entries are safe for remaining-space calculations and for the
   * UI path picker. Total-space rule evaluation must use raw /diskspace data.
   */
  public getDiskspaceAndRootFolders = async (): Promise<{
    mounts: DiskSpaceResource[];
    rootFolderPaths: Set<string>;
  }> => {
    const [diskspace, rootFolders] = await Promise.all([
      this.getDiskspace(),
      this.getRootFolders(),
    ]);

    // Either read answering undefined means it failed, and merging that in
    // fabricates a mount list rather than losing one: measured against a real
    // Radarr, dropping `/diskspace` and keeping the root folder reported 3.9 GB
    // free where the instance had 15.4, which is enough to fire a "delete when
    // space runs low" rule on a server with plenty of room. A partial merge is
    // no safer than an empty one - the missing side only ever understates free
    // space - so throw and let callers decide, as the media-server reads do
    // (#3248).
    if (diskspace === undefined || rootFolders === undefined) {
      throw new Error('Failed to read disk space');
    }

    const mounts: DiskSpaceResource[] = [...diskspace];
    const existingPaths = new Set(
      mounts.filter((d) => d.path).map((d) => normalizeDiskPath(d.path!)),
    );
    const rootFolderPaths = new Set<string>();

    for (const folder of rootFolders ?? []) {
      if (!folder.path) continue;

      const normalized = normalizeDiskPath(folder.path);
      rootFolderPaths.add(normalized);
      if (!existingPaths.has(normalized)) {
        existingPaths.add(normalized);
        mounts.push({
          id: folder.id,
          path: folder.path,
          label: null,
          freeSpace: folder.freeSpace ?? 0,
          totalSpace: folder.totalSpace ?? 0,
          hasAccurateTotalSpace: folder.totalSpace != null,
        });
      }
    }

    return { mounts, rootFolderPaths };
  };

  public getDiskspaceWithRootFolders = async (): Promise<
    DiskSpaceResource[]
  > => {
    const { mounts } = await this.getDiskspaceAndRootFolders();
    return mounts;
  };

  public getQueue = async (): Promise<(QueueItem & QueueItemAppendT)[]> => {
    try {
      const response =
        await this.axios.get<QueueResponse<QueueItemAppendT>>(`/queue`);

      return response.data.records;
    } catch (error) {
      this.logger.warn('Failed to retrieve queue');
      this.logger.debug(error);
    }
  };

  /**
   * Fetch raw history records from a history endpoint. The *arr per-movie and
   * per-series history endpoints return a plain array (only the base /history
   * endpoint is paged), so a non-array response is treated as "no records".
   * Never throws (returns [] on failure) so callers can treat history-driven
   * work as best-effort.
   */
  protected async getHistoryRecords(path: string): Promise<HistoryRecord[]> {
    try {
      const records = await this.getWithoutCache<HistoryRecord[]>(path);

      return Array.isArray(records) ? records : [];
    } catch (error) {
      this.logger.warn('Failed to retrieve download history');
      this.logger.debug(error);
      return [];
    }
  }

  /**
   * The download-client torrent hash a history record points to, or undefined
   * if the event didn't produce a file. Only `grabbed` / `downloadFolderImported`
   * events identify a torrent that actually backs media (the strings are shared
   * by Radarr and Sonarr); failed/ignored/rename/delete events are skipped.
   * Falls back to `data.torrentInfoHash` when `downloadId` is absent, normalized
   * to a trimmed lowercase hash.
   */
  protected downloadProducingHash(record: HistoryRecord): string | undefined {
    const eventType = record?.eventType?.toLowerCase();
    if (eventType !== 'grabbed' && eventType !== 'downloadfolderimported') {
      return undefined;
    }

    return (
      record.downloadId?.trim() || record.data?.torrentInfoHash?.trim()
    )?.toLowerCase();
  }

  /**
   * Walk the whole paged /history for download-producing events and describe
   * the media behind each hash. Returns undefined when any page fails, so a
   * partial read is never mistaken for "these downloads back nothing".
   * The *arr purges a movie's / series' history when it is removed, so a
   * hash missing from this list no longer backs media in this instance.
   */
  protected async collectDownloadLinks<RecordT extends HistoryRecord>(
    includeQuery: string,
    describe: (record: RecordT) => Omit<ArrDownloadLink, 'hash'>,
  ): Promise<ArrDownloadLink[] | undefined> {
    const eventTypes = DOWNLOAD_EVENT_TYPES.map(
      (type) => `&eventType=${type}`,
    ).join('');
    const links: ArrDownloadLink[] = [];

    for (let page = 1; page <= HISTORY_MAX_PAGES; page += 1) {
      // Newest first: records added while paging push older ones down a page,
      // which re-reads a record rather than skipping one.
      const response = await this.getWithoutCache<HistoryPage<RecordT>>(
        `/history?page=${page}&pageSize=${HISTORY_PAGE_SIZE}&sortKey=date&sortDirection=descending${eventTypes}${includeQuery}`,
        { timeout: SLOW_INSTANCE_TIMEOUT_MS },
      );
      if (!response || !Array.isArray(response.records)) {
        this.logger.warn('Failed to read the download history');
        return undefined;
      }

      for (const record of response.records) {
        const hash = this.downloadProducingHash(record);
        if (hash) {
          links.push({ hash, ...describe(record) });
        }
      }

      if (
        response.records.length < HISTORY_PAGE_SIZE ||
        page * HISTORY_PAGE_SIZE >= (response.totalRecords ?? 0)
      ) {
        return links;
      }
    }

    this.logger.warn(
      `The download history is longer than ${HISTORY_MAX_PAGES * HISTORY_PAGE_SIZE} records; not reading further`,
    );
    return undefined;
  }

  /**
   * Fetch the distinct download-client item ids (torrent infohashes) that
   * produced files from a history endpoint. Never throws (returns [] on failure)
   * so callers can treat torrent cleanup as best-effort.
   */
  protected async getDownloadIdsFromHistory(path: string): Promise<string[]> {
    const records = await this.getHistoryRecords(path);

    const ids = new Set<string>();
    for (const record of records) {
      const hash = this.downloadProducingHash(record);
      if (hash) {
        ids.add(hash);
      }
    }

    return [...ids];
  }

  public getTags = async (): Promise<Tag[] | undefined> => {
    try {
      const response = await this.axios.get<Tag[]>(`/tag`);

      return response.data;
    } catch (error) {
      this.logger.warn('Failed to retrieve tags');
      this.logger.debug(error);
      // Unknown, not empty: an empty list would let a tagged item match a
      // "not contains" tag rule (#3886).
      return undefined;
    }
  };

  public createTag = async ({ label }: { label: string }): Promise<Tag> => {
    try {
      const response = await this.axios.post<Tag>(`/tag`, {
        label,
      });

      return response.data;
    } catch (error) {
      this.logger.warn('Failed to create tag');
      this.logger.debug(error);
    }
  };

  /**
   * Resolve a tag id for `label`, creating the tag if it doesn't exist yet.
   * Matching is case-insensitive - *arr stores labels verbatim but treats them
   * case-insensitively, so we never create a duplicate that differs only in case.
   *
   * Race-tolerant: if the create fails (another caller created the same label in
   * between, or the POST errored) we re-read the tag list once and return the id
   * if it now exists. Returns undefined when the id still can't be resolved, so
   * tag application stays best-effort and never throws.
   */
  public ensureTag = async (label: string): Promise<number | undefined> => {
    const target = label.toLowerCase();
    const match = (tags: Tag[] | undefined): number | undefined =>
      (tags ?? []).find((tag) => tag.label?.toLowerCase() === target)?.id;

    const existing = match(await this.getTags());
    if (existing !== undefined) {
      return existing;
    }

    const created = await this.createTag({ label });
    if (created?.id !== undefined) {
      return created.id;
    }

    // Create failed (already exists from a concurrent caller, or errored) -
    // re-read and return the id if the label is now present.
    return match(await this.getTags());
  };

  public async runCommand(
    commandName: string,
    options: Record<string, unknown>,
    wait = false,
  ): Promise<any> {
    try {
      const resp = await this.axios.post(`/command`, {
        name: commandName,
        ...options,
      });
      if (wait && resp.data) {
        while (resp.data.status !== 'failed' && resp.data.status !== 'finished')
          resp.data = await this.get('/command/' + resp.data.id);
      }
      return resp ? resp.data : undefined;
    } catch (error) {
      this.logger.warn('Failed to run command');
      this.logger.debug(error);
    }
  }

  protected async runDelete(command: string): Promise<boolean> {
    try {
      const result = await this.delete(`/${command}`, {
        timeout: NO_TIMEOUT,
      });

      if (result === undefined) {
        this.logger.warn(`Failed to run DELETE: /${command}`);
        return false;
      }

      return true;
    } catch (error) {
      this.logger.warn(`Failed to run DELETE: /${command}`);
      this.logger.debug(error);
      return false;
    }
  }

  protected async runPut(command: string, body: string): Promise<boolean> {
    try {
      const result = await this.put(`/${command}`, body);

      if (result === undefined) {
        this.logger.warn(`Failed to run PUT: /${command}`);
        return false;
      }

      return true;
    } catch (error) {
      this.logger.warn(`Failed to run PUT: /${command}`);
      this.logger.debug(error);
      return false;
    }
  }
}
