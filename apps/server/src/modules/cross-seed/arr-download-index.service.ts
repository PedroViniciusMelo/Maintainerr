import {
  CrossSeedArrLink,
  CrossSeedArrStatus,
  CrossSeedArrType,
} from '@maintainerr/contracts';
import { Injectable } from '@nestjs/common';
import { ServarrService } from '../api/servarr-api/servarr.service';
import { ArrDownloadLink } from '../api/servarr-api/interfaces/servarr.interface';
import { MaintainerrLogger } from '../logging/logs.service';
import { SettingsDataService } from '../settings/settings-data.service';

/** A download's link to *arr media, plus whether that media still has a file. */
export interface IndexedArrLink extends CrossSeedArrLink {
  hasFile: boolean;
}

export interface ArrDownloadIndex {
  /** Torrent hash (lowercase) to every *arr item it backs. */
  links: Map<string, IndexedArrLink[]>;
  instances: CrossSeedArrStatus[];
  /** True only when every configured *arr answered in full. */
  complete: boolean;
}

/**
 * Reading every history is the slow part of the cross-seed view, and the
 * answer barely moves between two page loads, so it is reused briefly.
 */
const INDEX_TTL_MS = 2 * 60 * 1000;

interface ArrInstance {
  id: number;
  serverName: string;
}

/**
 * Maps download-client hashes to the Radarr / Sonarr / Sportarr media they
 * back, from each instance's download history. The *arrs purge an item's
 * history when the item is removed, so a hash absent from the index backs no
 * media any more.
 */
@Injectable()
export class ArrDownloadIndexService {
  private cached?: { index: ArrDownloadIndex; expiresAt: number };
  private pending?: Promise<ArrDownloadIndex>;

  constructor(
    private readonly settings: SettingsDataService,
    private readonly servarr: ServarrService,
    private readonly logger: MaintainerrLogger,
  ) {
    logger.setContext(ArrDownloadIndexService.name);
  }

  public async getIndex(refresh = false): Promise<ArrDownloadIndex> {
    if (!refresh && this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.index;
    }
    // Concurrent callers share one walk of the histories.
    this.pending ??= this.build().finally(() => {
      this.pending = undefined;
    });
    const index = await this.pending;
    this.cached = { index, expiresAt: Date.now() + INDEX_TTL_MS };
    return index;
  }

  private async build(): Promise<ArrDownloadIndex> {
    const links = new Map<string, IndexedArrLink[]>();
    const instances: CrossSeedArrStatus[] = [];
    let complete = true;

    const sources: {
      type: CrossSeedArrType;
      list: () => Promise<unknown>;
      read: (id: number) => Promise<ArrDownloadLink[] | undefined>;
    }[] = [
      {
        type: 'radarr',
        list: () => this.settings.getRadarrSettings(),
        read: async (id) =>
          (await this.servarr.getRadarrApiClient(id)).getDownloadLinks(),
      },
      {
        type: 'sonarr',
        list: () => this.settings.getSonarrSettings(),
        read: async (id) =>
          (await this.servarr.getSonarrApiClient(id)).getDownloadLinks(),
      },
      {
        type: 'sportarr',
        list: () => this.settings.getSportarrSettings(),
        read: (id) => this.readSportarr(id),
      },
    ];

    for (const source of sources) {
      const configured = await source.list();
      if (!Array.isArray(configured)) {
        // The settings themselves could not be read: we cannot know which
        // instances exist, so nothing may be judged as removed.
        complete = false;
        continue;
      }

      await Promise.all(
        (configured as ArrInstance[]).map(async (instance) => {
          let read: ArrDownloadLink[] | undefined;
          try {
            read = await source.read(instance.id);
          } catch (error) {
            this.logger.debug(error);
            read = undefined;
          }

          instances.push({
            instanceType: source.type,
            instanceId: instance.id,
            instanceName: instance.serverName,
            ok: read !== undefined,
          });

          if (read === undefined) {
            complete = false;
            this.logger.warn(
              `Could not read the download history of ${source.type} '${instance.serverName}'; downloads it may back are not reported as orphaned`,
            );
            return;
          }

          for (const link of read) {
            const entry: IndexedArrLink = {
              instanceType: source.type,
              instanceId: instance.id,
              instanceName: instance.serverName,
              title: link.title,
              hasFile: link.hasFile,
            };
            const existing = links.get(link.hash) ?? [];
            const same = existing.find(
              (other) =>
                other.instanceType === entry.instanceType &&
                other.instanceId === entry.instanceId &&
                other.title === entry.title,
            );
            if (same) {
              // Grab and import of the same item: any record that still sees
              // the file wins.
              same.hasFile ||= entry.hasFile;
            } else {
              existing.push(entry);
            }
            links.set(link.hash, existing);
          }
        }),
      );
    }

    instances.sort(
      (a, b) =>
        a.instanceType.localeCompare(b.instanceType) ||
        a.instanceName.localeCompare(b.instanceName),
    );

    return { links, instances, complete };
  }

  /**
   * Sportarr has no global history endpoint: walk each league's grab history
   * and mark a link as having a file when its event still has one.
   */
  private async readSportarr(
    id: number,
  ): Promise<ArrDownloadLink[] | undefined> {
    const client = await this.servarr.getSportarrApiClient(id);
    const leagues = await client.getLeagues();
    if (!leagues) {
      return undefined;
    }

    const links: ArrDownloadLink[] = [];
    for (const league of leagues) {
      const [history, events] = await Promise.all([
        client.findLeagueDownloadHistory(league.id),
        client.getLeagueEvents(league.id),
      ]);
      if (history === undefined || events === undefined) {
        return undefined;
      }

      const eventsById = new Map(events.map((event) => [event.id, event]));
      for (const item of history) {
        const hash = (item.torrentInfoHash || item.downloadId)
          ?.trim()
          .toLowerCase();
        if (!hash) {
          continue;
        }
        const event = eventsById.get(item.eventId);
        links.push({
          hash,
          title: event?.title ?? league.name,
          hasFile: event?.hasFile ?? true,
        });
      }
    }
    return links;
  }
}
