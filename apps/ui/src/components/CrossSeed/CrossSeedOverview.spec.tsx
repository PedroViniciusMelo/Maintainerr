import type {
  CrossSeedGroup,
  CrossSeedOverview as CrossSeedOverviewData,
  CrossSeedTorrent,
} from '@maintainerr/contracts'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildQueryLoadingResult,
  buildQuerySuccessResult,
} from '../../test-utils/queryResults'
import { fireEvent, render, screen, waitFor } from '../../test-utils/render'
import CrossSeedOverview from './CrossSeedOverview'

const useCrossSeedOverviewMock = vi.fn()
const deleteMock = vi.fn()

vi.mock('../../api/crossSeed', () => ({
  useCrossSeedOverview: () => useCrossSeedOverviewMock(),
  useRefreshCrossSeedOverview: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useDeleteCrossSeedOrphans: () => ({ mutateAsync: deleteMock }),
}))

vi.mock('../../api/settings', () => ({
  useDownloadClientSettings: () => ({
    data: { download_client_delete_data: true },
  }),
}))

const torrent = (
  hash: string,
  overrides: Partial<CrossSeedTorrent> = {},
): CrossSeedTorrent => ({
  hash,
  name: `Sample Release ${hash}`,
  contentPath: `/downloads/${hash}`,
  size: 1024 * 1024 * 1024,
  ratio: 1.5,
  seedingTime: 3 * 86400,
  addedOn: 1,
  tags: [],
  category: 'radarr',
  tracker: 'tracker.example',
  seedingGoalMet: true,
  detection: null,
  arrLinks: [],
  orphanReason: null,
  ...overrides,
})

const linkedGroup: CrossSeedGroup = {
  id: 'aaa',
  original: torrent('aaa', {
    arrLinks: [
      {
        instanceType: 'radarr',
        instanceId: 1,
        instanceName: 'Radarr',
        title: 'Sample Movie',
      },
    ],
  }),
  crossSeeds: [torrent('bbb', { detection: 'marker', tags: ['cross-seed'] })],
  orphanReason: null,
}

const orphanGroup: CrossSeedGroup = {
  id: 'ccc',
  original: null,
  crossSeeds: [
    torrent('ccc', { detection: 'marker', orphanReason: 'original-missing' }),
    torrent('ddd', {
      detection: 'marker',
      orphanReason: 'original-missing',
      seedingGoalMet: false,
    }),
  ],
  orphanReason: 'original-missing',
}

const overview = (
  overrides: Partial<CrossSeedOverviewData> = {},
): CrossSeedOverviewData => ({
  configured: true,
  error: null,
  markers: { tags: ['cross-seed'], categories: [] },
  arrIndexComplete: true,
  arrInstances: [
    { instanceType: 'radarr', instanceId: 1, instanceName: 'Radarr', ok: true },
  ],
  arrCategories: ['radarr'],
  groups: [orphanGroup, linkedGroup],
  torrentCount: 4,
  generatedAt: new Date(0).toISOString(),
  ...overrides,
})

describe('CrossSeedOverview', () => {
  beforeEach(() => {
    useCrossSeedOverviewMock.mockReset()
    deleteMock.mockReset()
  })

  it('points to the download client setup when none is configured', () => {
    useCrossSeedOverviewMock.mockReturnValue(
      buildQuerySuccessResult(overview({ configured: false, groups: [] })),
    )

    render(
      <MemoryRouter>
        <CrossSeedOverview />
      </MemoryRouter>,
    )

    expect(
      screen.getByText('Set up a download client to see its cross-seeds.'),
    ).toBeTruthy()
  })

  it('shows each original with its cross-seeds when expanded', () => {
    useCrossSeedOverviewMock.mockReturnValue(
      buildQuerySuccessResult(overview()),
    )

    render(<CrossSeedOverview />)

    expect(screen.queryByText('Sample Release bbb')).toBeNull()
    fireEvent.click(screen.getByText('Sample Release aaa'))
    expect(screen.getByText('Sample Release bbb')).toBeTruthy()
    expect(screen.getByText('Radarr: Sample Movie')).toBeTruthy()
  })

  it('warns that nothing is reported as media removed while an *arr is unreadable', () => {
    useCrossSeedOverviewMock.mockReturnValue(
      buildQuerySuccessResult(
        overview({
          arrIndexComplete: false,
          arrInstances: [
            {
              instanceType: 'sonarr',
              instanceId: 2,
              instanceName: 'Sonarr 4K',
              ok: false,
            },
          ],
        }),
      ),
    )

    render(<CrossSeedOverview />)

    expect(
      screen.getByText('Some *arr histories could not be read: Sonarr 4K'),
    ).toBeTruthy()
  })

  it('removes the selected orphans, forcing still-seeding ones only when asked', async () => {
    useCrossSeedOverviewMock.mockReturnValue(
      buildQuerySuccessResult(overview()),
    )
    deleteMock.mockResolvedValue({
      results: [
        {
          hash: 'ccc',
          name: 'Sample Release ccc',
          outcome: 'removed',
          dataDeleted: true,
          reason: null,
        },
        {
          hash: 'ddd',
          name: 'Sample Release ddd',
          outcome: 'skipped',
          dataDeleted: false,
          reason: 'still-seeding',
        },
      ],
    })

    render(<CrossSeedOverview />)

    fireEvent.click(screen.getByText('Orphans (2)'))
    // The linked group's downloads are not orphans and are not listed.
    expect(screen.queryByLabelText('Select Sample Release aaa')).toBeNull()
    fireEvent.click(screen.getByLabelText('Select all orphans'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith({
        hashes: ['ccc', 'ddd'],
        force: false,
      })
    })
    expect(await screen.findByText('Removed 1 download.')).toBeTruthy()
    expect(
      screen.getByText('1 kept: its seeding goal is not met yet.'),
    ).toBeTruthy()
  })

  it('renders the loading state without the page body', () => {
    useCrossSeedOverviewMock.mockReturnValue(buildQueryLoadingResult())

    render(<CrossSeedOverview />)

    expect(screen.queryByText('Cross-seed')).toBeNull()
  })
})
