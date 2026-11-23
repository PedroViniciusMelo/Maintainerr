import {
  DownloadClientFile,
  DownloadClientTorrent,
} from '../api/download-client-api/download-client.interface';
import { filesMatch, groupCrossSeeds } from './cross-seed.grouping';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

const torrent = (
  hash: string,
  overrides: Partial<DownloadClientTorrent> = {},
): DownloadClientTorrent => ({
  hash,
  name: 'Sample Movie 2020 1080p',
  content_path: `/downloads/${hash}/Sample Movie 2020 1080p`,
  ratio: 1,
  seedingTime: 0,
  reachedSeedingGoal: null,
  tags: [],
  category: 'radarr',
  size: 4 * GB,
  addedOn: 100,
  ...overrides,
});

const crossSeed = (
  hash: string,
  overrides: Partial<DownloadClientTorrent> = {},
) =>
  torrent(hash, {
    tags: ['cross-seed'],
    category: 'radarr.cross-seed',
    addedOn: 200,
    ...overrides,
  });

const group = async (
  torrents: DownloadClientTorrent[],
  {
    files = {},
    linked = [],
  }: { files?: Record<string, DownloadClientFile[]>; linked?: string[] } = {},
) => {
  const loadFiles = jest.fn(async (hash: string) => files[hash]);
  const groups = await groupCrossSeeds({
    torrents,
    isMarked: (t) => (t.tags ?? []).includes('cross-seed'),
    isArrLinked: (t) => linked.includes(t.hash),
    loadFiles,
  });
  const summary = groups.map((g) => ({
    original: g.original?.hash ?? null,
    crossSeeds: g.crossSeeds.map((c) => `${c.torrent.hash}:${c.detection}`),
  }));
  return { summary, loadFiles };
};

describe('groupCrossSeeds', () => {
  it('pairs a hardlinked cross-seed with its original by name and size, without reading files', async () => {
    const { summary, loadFiles } = await group([
      torrent('orig'),
      crossSeed('child', {
        content_path: '/links/tracker-b/Sample Movie 2020 1080p',
      }),
    ]);

    expect(summary).toEqual([
      { original: 'orig', crossSeeds: ['child:marker'] },
    ]);
    expect(loadFiles).not.toHaveBeenCalled();
  });

  it('pairs a cross-seed that shares the original content path', async () => {
    const { summary } = await group([
      torrent('orig', { content_path: '/downloads/Sample' }),
      crossSeed('child', { content_path: '/downloads/Sample/', name: 'Other' }),
    ]);

    expect(summary).toEqual([
      { original: 'orig', crossSeeds: ['child:marker'] },
    ]);
  });

  it('matches a renamed partial cross-seed by its files', async () => {
    const video = { name: 'a/movie.mkv', size: 4 * GB - 10 * MB };
    const { summary } = await group(
      [
        torrent('orig'),
        torrent('unrelated', { name: 'Another', size: 4 * GB + MB }),
        crossSeed('child', { name: 'Renamed Release', size: 4 * GB - 9 * MB }),
      ],
      {
        files: {
          orig: [video, { name: 'a/movie.nfo', size: 2048 }],
          unrelated: [{ name: 'b.mkv', size: 4 * GB + MB }],
          child: [{ name: 'Renamed/movie.mkv', size: video.size }],
        },
      },
    );

    expect(summary).toEqual([
      { original: 'orig', crossSeeds: ['child:marker'] },
    ]);
  });

  it('reports a tagged cross-seed whose original is gone as a group without an original', async () => {
    const { summary } = await group([crossSeed('child')], { files: {} });

    expect(summary).toEqual([{ original: null, crossSeeds: ['child:marker'] }]);
  });

  it('infers an untagged cross-seed from identical files', async () => {
    const files = [{ name: 'movie.mkv', size: 4 * GB }];
    const { summary } = await group(
      [
        torrent('first', { addedOn: 10 }),
        torrent('second', { name: 'Same Data Other Name', addedOn: 20 }),
      ],
      { files: { first: files, second: files } },
    );

    expect(summary).toEqual([
      { original: 'first', crossSeeds: ['second:inferred'] },
    ]);
  });

  it('keeps apart unrelated downloads that share a save path as content path', async () => {
    const { summary } = await group([
      torrent('a', { content_path: '/downloads', name: 'A', size: 2 * GB }),
      torrent('b', { content_path: '/downloads', name: 'B', size: 5 * GB }),
    ]);

    expect(summary).toEqual([]);
  });

  it('prefers the download an *arr grabbed as the original over an older one', async () => {
    const { summary } = await group(
      [
        torrent('older', { addedOn: 1, content_path: '/d/x' }),
        torrent('grabbed', { addedOn: 5, content_path: '/d/x' }),
      ],
      { linked: ['grabbed'] },
    );

    expect(summary).toEqual([
      { original: 'grabbed', crossSeeds: ['older:inferred'] },
    ]);
  });
});

describe('filesMatch', () => {
  it('rejects lists whose significant files differ', () => {
    expect(
      filesMatch(
        [{ name: 'a.mkv', size: 700 * MB }],
        [{ name: 'a.mkv', size: 701 * MB }],
      ),
    ).toBe(false);
  });

  it('ignores small extras on either side', () => {
    expect(
      filesMatch(
        [
          { name: 'a.mkv', size: 700 * MB },
          { name: 'a.nfo', size: 3000 },
        ],
        [{ name: 'renamed.mkv', size: 700 * MB }],
      ),
    ).toBe(true);
  });
});
