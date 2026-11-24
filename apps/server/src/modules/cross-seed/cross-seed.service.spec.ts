import { Mocked, TestBed } from '@suites/unit';
import { DownloadClientApiService } from '../api/download-client-api/download-client-api.service';
import {
  DownloadClient,
  DownloadClientTorrent,
} from '../api/download-client-api/download-client.interface';
import {
  ArrDownloadIndex,
  ArrDownloadIndexService,
  IndexedArrLink,
} from './arr-download-index.service';
import { isCrossSeedMarker } from '../api/download-client-api/cross-seed.grouping';
import { CrossSeedService } from './cross-seed.service';

const GB = 1024 * 1024 * 1024;

const torrent = (
  hash: string,
  overrides: Partial<DownloadClientTorrent> = {},
): DownloadClientTorrent => ({
  hash,
  name: `Release ${hash}`,
  content_path: `/downloads/radarr/Release ${hash}`,
  ratio: 2,
  seedingTime: 30 * 86400,
  reachedSeedingGoal: true,
  tags: [],
  category: 'radarr',
  size: 4 * GB,
  addedOn: 100,
  ...overrides,
});

/** A hardlinked cross-seed of `original` (same name and size, own path). */
const crossSeedOf = (
  original: DownloadClientTorrent,
  hash: string,
  overrides: Partial<DownloadClientTorrent> = {},
) =>
  torrent(hash, {
    name: original.name,
    size: original.size,
    content_path: `/downloads/links/${hash}/${original.name}`,
    tags: ['cross-seed'],
    category: `${original.category}.cross-seed`,
    addedOn: 200,
    ...overrides,
  });

const link = (hasFile = true): IndexedArrLink => ({
  instanceType: 'radarr',
  instanceId: 1,
  instanceName: 'Radarr',
  title: 'Sample Movie',
  hasFile,
});

describe('CrossSeedService', () => {
  let service: CrossSeedService;
  let downloadClient: Mocked<DownloadClientApiService>;
  let arrIndex: Mocked<ArrDownloadIndexService>;
  let api: jest.Mocked<DownloadClient>;

  const setup = (
    torrents: DownloadClientTorrent[],
    links: Record<string, IndexedArrLink[]> = {},
    complete = true,
  ) => {
    api.getTorrents.mockResolvedValue(torrents);
    const index: ArrDownloadIndex = {
      links: new Map(Object.entries(links)),
      instances: [],
      complete,
    };
    arrIndex.getIndex.mockResolvedValue(index);
  };

  beforeEach(async () => {
    const { unit, unitRef } =
      await TestBed.solitary(CrossSeedService).compile();
    service = unit;
    downloadClient = unitRef.get(
      DownloadClientApiService,
    ) as unknown as Mocked<DownloadClientApiService>;
    arrIndex = unitRef.get(
      ArrDownloadIndexService,
    ) as unknown as Mocked<ArrDownloadIndexService>;

    api = {
      getVersion: jest.fn(),
      getTorrents: jest.fn(),
      getTorrentByHash: jest.fn(),
      getTorrentFiles: jest.fn().mockResolvedValue([]),
      deleteTorrents: jest.fn().mockResolvedValue(undefined),
    };
    Object.assign(downloadClient, { api });
    downloadClient.isDoneSeeding.mockImplementation(
      (t: DownloadClientTorrent) => t.reachedSeedingGoal !== false,
    );
    downloadClient.deletesData.mockReturnValue(true);
  });

  describe('getOverview', () => {
    it('reports an unconfigured download client without reading anything', async () => {
      Object.assign(downloadClient, { api: undefined });

      const overview = await service.getOverview();

      expect(overview.configured).toBe(false);
      expect(overview.groups).toEqual([]);
      expect(arrIndex.getIndex).not.toHaveBeenCalled();
    });

    it('detects the cross-seed tag and category the installation uses', async () => {
      const original = torrent('a');
      setup(
        [
          original,
          crossSeedOf(original, 'b', { tags: ['Cross_Seed'], category: 'x' }),
        ],
        { a: [link()] },
      );

      const overview = await service.getOverview();

      expect(overview.markers).toEqual({
        tags: ['Cross_Seed'],
        categories: [],
      });
      expect(overview.groups).toHaveLength(1);
      expect(overview.groups[0].original?.hash).toBe('a');
      expect(overview.groups[0].crossSeeds[0]).toMatchObject({
        hash: 'b',
        detection: 'marker',
      });
    });

    it('places each group under its *arr and counts shared data once', async () => {
      const movie = torrent('a', { size: 4 * GB });
      const show = torrent('s', { category: 'tv-sonarr', size: 2 * GB });
      // No *arr history names this one; its category is Sonarr's.
      const oldShow = torrent('o', { category: 'tv-sonarr', size: GB });
      const music = torrent('m', { category: 'music', size: GB });
      setup(
        [
          movie,
          crossSeedOf(movie, 'b'),
          show,
          crossSeedOf(show, 't'),
          oldShow,
          crossSeedOf(oldShow, 'p'),
          music,
          crossSeedOf(music, 'n'),
        ],
        {
          a: [link()],
          s: [{ ...link(), instanceType: 'sonarr', instanceName: 'Sonarr' }],
        },
      );

      const groups = (await service.getOverview()).groups;
      const byOriginal = (hash: string) =>
        groups.find((group) => group.original?.hash === hash);

      expect(byOriginal('a')).toMatchObject({
        arrType: 'radarr',
        dataSize: 4 * GB,
      });
      expect(byOriginal('s')).toMatchObject({
        arrType: 'sonarr',
        dataSize: 2 * GB,
      });
      expect(byOriginal('o')?.arrType).toBe('sonarr');
      expect(byOriginal('m')?.arrType).toBeNull();
    });

    it('is not an orphan while the original backs media with a file', async () => {
      const original = torrent('a');
      setup([original, crossSeedOf(original, 'b')], { a: [link()] });

      const [group] = (await service.getOverview()).groups;

      expect(group.orphanReason).toBeNull();
      expect(group.original?.arrLinks).toEqual([
        {
          instanceType: 'radarr',
          instanceId: 1,
          instanceName: 'Radarr',
          title: 'Sample Movie',
        },
      ]);
    });

    it.each([
      ['no *arr knows the download any more', {}],
      ['the media lost its file', { a: [link(false)] }],
    ])('reports the whole group as media-removed when %s', async (_, links) => {
      const original = torrent('a');
      // Another download keeps "radarr" known as an *arr category.
      setup([original, crossSeedOf(original, 'b'), torrent('other')], {
        other: [link()],
        ...links,
      });

      const [group] = (await service.getOverview()).groups;

      expect(group.orphanReason).toBe('media-removed');
      expect(group.original?.orphanReason).toBe('media-removed');
      expect(group.crossSeeds[0].orphanReason).toBe('media-removed');
    });

    it('never reports media-removed while an *arr history could not be read', async () => {
      const original = torrent('a');
      setup(
        [original, crossSeedOf(original, 'b'), torrent('other')],
        { other: [link()] },
        false,
      );

      const [group] = (await service.getOverview()).groups;

      expect(group.orphanReason).toBeNull();
    });

    it('leaves groups outside the *arr categories alone', async () => {
      const original = torrent('a', { category: 'music' });
      setup([original, crossSeedOf(original, 'b'), torrent('other')], {
        other: [link()],
      });

      const [group] = (await service.getOverview()).groups;

      expect(group.orphanReason).toBeNull();
    });

    it('reports a cross-seed whose original is gone as original-missing', async () => {
      setup([crossSeedOf(torrent('gone'), 'b')], {});

      const [group] = (await service.getOverview()).groups;

      expect(group.original).toBeNull();
      expect(group.orphanReason).toBe('original-missing');
    });

    it('returns the read error instead of throwing', async () => {
      api.getTorrents.mockRejectedValue(new Error('connection refused'));
      arrIndex.getIndex.mockResolvedValue({
        links: new Map(),
        instances: [],
        complete: true,
      });

      const overview = await service.getOverview();

      expect(overview.error).toBe('connection refused');
      expect(overview.groups).toEqual([]);
    });
  });

  describe('deleteOrphans', () => {
    it('refuses downloads that are not orphans', async () => {
      const original = torrent('a');
      setup([original, crossSeedOf(original, 'b')], { a: [link()] });

      const { results } = await service.deleteOrphans({
        hashes: ['B'],
        force: false,
      });

      expect(results).toEqual([
        expect.objectContaining({
          hash: 'b',
          outcome: 'skipped',
          reason: 'not-orphan',
        }),
      ]);
      expect(api.deleteTorrents).not.toHaveBeenCalled();
    });

    it('keeps an orphan seeding until its goal is met, unless forced', async () => {
      const orphan = crossSeedOf(torrent('gone'), 'b', {
        reachedSeedingGoal: false,
      });
      setup([orphan]);

      const kept = await service.deleteOrphans({ hashes: ['b'], force: false });
      expect(kept.results[0]).toMatchObject({
        outcome: 'skipped',
        reason: 'still-seeding',
      });
      expect(api.deleteTorrents).not.toHaveBeenCalled();

      const forced = await service.deleteOrphans({
        hashes: ['b'],
        force: true,
      });
      expect(forced.results[0]).toMatchObject({
        outcome: 'removed',
        dataDeleted: true,
      });
      expect(api.deleteTorrents).toHaveBeenCalledWith(['b'], true);
    });

    it('deletes shared data only with the last download that uses it', async () => {
      const path = '/downloads/radarr/Shared';
      const original = torrent('a', { content_path: path });
      const sameData = crossSeedOf(original, 'b', { content_path: path });
      setup([original, sameData, torrent('other')], { other: [link()] });

      const { results } = await service.deleteOrphans({
        hashes: ['a', 'b'],
        force: false,
      });

      expect(api.deleteTorrents.mock.calls).toEqual([
        [['a'], false],
        [['b'], true],
      ]);
      expect(results.map((r) => r.dataDeleted)).toEqual([false, true]);
    });

    it('keeps data another remaining download still uses', async () => {
      const path = '/downloads/radarr/Shared';
      const original = torrent('a', { content_path: path });
      setup([
        crossSeedOf(original, 'b', { content_path: path, size: 1 * GB }),
        // Same path, unrelated size: a remaining download that is no orphan.
        torrent('keeper', { content_path: path, size: 9 * GB, tags: [] }),
      ]);

      await service.deleteOrphans({ hashes: ['b'], force: false });

      expect(api.deleteTorrents).toHaveBeenCalledWith(['b'], false);
    });

    it('never deletes data when the delete-data setting is off', async () => {
      downloadClient.deletesData.mockReturnValue(false);
      setup([crossSeedOf(torrent('gone'), 'b')]);

      await service.deleteOrphans({ hashes: ['b'], force: false });

      expect(api.deleteTorrents).toHaveBeenCalledWith(['b'], false);
    });

    it('carries on after one removal fails', async () => {
      setup([
        crossSeedOf(torrent('gone1'), 'b'),
        crossSeedOf(torrent('gone2', { size: 7 * GB }), 'c'),
      ]);
      api.deleteTorrents
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined);

      const { results } = await service.deleteOrphans({
        hashes: ['b', 'c'],
        force: false,
      });

      expect(results.map((r) => r.outcome)).toEqual(['failed', 'removed']);
    });
  });
});

describe('isCrossSeedMarker', () => {
  it.each(['cross-seed', 'radarr.cross-seed', 'CrossSeed', 'cross_seed'])(
    'recognizes %s',
    (value) => {
      expect(isCrossSeedMarker(value)).toBe(true);
    },
  );

  it.each(['radarr', 'seed', 'cross'])('ignores %s', (value) => {
    expect(isCrossSeedMarker(value)).toBe(false);
  });
});
