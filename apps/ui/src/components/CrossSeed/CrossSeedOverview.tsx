import { RefreshIcon } from '@heroicons/react/solid'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { CrossSeedGroup } from '@maintainerr/contracts'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  useCrossSeedOverview,
  useRefreshCrossSeedOverview,
} from '../../api/crossSeed'
import { useDownloadClientSettings } from '../../api/settings'
import { getApiErrorMessage } from '../../utils/ApiError'
import { formatBytes } from '../../utils/formatBytes'
import Alert from '../Common/Alert'
import Button from '../Common/Button'
import LoadingSpinner, { SmallLoadingSpinner } from '../Common/LoadingSpinner'
import TabbedLinks from '../Common/TabbedLinks'
import CrossSeedOrphans, { collectOrphans } from './CrossSeedOrphans'
import CrossSeedTree from './CrossSeedTree'

type CrossSeedTab = 'radarr' | 'sonarr' | 'orphans' | 'other'

interface TabSummary {
  tab: CrossSeedTab
  label: string
  groups: CrossSeedGroup[]
  /** Downloads the tab lists. */
  count: number
}

const dataSizeOf = (groups: CrossSeedGroup[]) =>
  groups.reduce((sum, group) => sum + group.dataSize, 0)

/** One size per tab, above the tabs; clicking one opens that tab. */
const TabSizes = ({
  summaries,
  current,
  onSelect,
}: {
  summaries: TabSummary[]
  current: CrossSeedTab
  onSelect: (tab: CrossSeedTab) => void
}) => (
  <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
    {summaries.map((summary) => (
      <button
        key={summary.tab}
        type="button"
        onClick={() => onSelect(summary.tab)}
        aria-pressed={summary.tab === current}
        className={`rounded-lg border p-3 text-left transition ${
          summary.tab === current
            ? 'border-maintainerr-600 bg-zinc-800'
            : 'border-zinc-700 bg-zinc-800/60 hover:border-zinc-500'
        }`}
      >
        <div className="text-xs text-zinc-400">{summary.label}</div>
        <div className="text-lg font-semibold text-white">
          {formatBytes(dataSizeOf(summary.groups))}
        </div>
        <div className="text-xs text-zinc-400">
          {plural(summary.count, {
            one: '# download',
            other: '# downloads',
          })}
        </div>
      </button>
    ))}
  </div>
)

const CrossSeedOverview = () => {
  const { t, i18n } = useLingui()
  const [tab, setTab] = useState<CrossSeedTab>('radarr')
  const overview = useCrossSeedOverview()
  const refresh = useRefreshCrossSeedOverview()
  const downloadClientSettings = useDownloadClientSettings()

  const title = <title>{t`Cross-seed - Maintainerr`}</title>
  const data = overview.data

  if (overview.isLoading) {
    return (
      <>
        {title}
        <div className="min-h-80">
          <LoadingSpinner />
        </div>
      </>
    )
  }

  if (overview.isError || !data) {
    return (
      <>
        {title}
        <div className="mt-4">
          <Alert
            type="error"
            title={getApiErrorMessage(
              overview.error,
              t`The cross-seed overview could not be loaded.`,
            )}
          />
        </div>
      </>
    )
  }

  const orphanCount = collectOrphans(data.groups).length
  const downloadsIn = (groups: CrossSeedGroup[]) =>
    groups.reduce(
      (sum, group) => sum + group.crossSeeds.length + (group.original ? 1 : 0),
      0,
    )
  const ofArr = (type: CrossSeedGroup['arrType']) =>
    data.groups.filter((group) => group.arrType === type)
  const radarrGroups = ofArr('radarr')
  const sonarrGroups = ofArr('sonarr')
  const otherGroups = data.groups.filter(
    (group) => group.arrType !== 'radarr' && group.arrType !== 'sonarr',
  )
  const orphanGroups = data.groups.filter((group) => group.orphanReason)
  const summaries: TabSummary[] = [
    {
      tab: 'radarr',
      label: t`Radarr`,
      groups: radarrGroups,
      count: downloadsIn(radarrGroups),
    },
    {
      tab: 'sonarr',
      label: t`Sonarr`,
      groups: sonarrGroups,
      count: downloadsIn(sonarrGroups),
    },
    {
      tab: 'orphans',
      label: t`Orphans`,
      groups: orphanGroups,
      count: orphanCount,
    },
    ...(otherGroups.length > 0
      ? [
          {
            tab: 'other' as const,
            label: t`Other`,
            groups: otherGroups,
            count: downloadsIn(otherGroups),
          },
        ]
      : []),
  ]
  const currentTab = summaries.some((summary) => summary.tab === tab)
    ? tab
    : 'radarr'
  const groupsOf = (target: CrossSeedTab) =>
    summaries.find((summary) => summary.tab === target)?.groups ?? []
  const torrentCount = data.torrentCount
  const failedInstances = data.arrInstances.filter((instance) => !instance.ok)
  const generatedAt = new Date(data.generatedAt).toLocaleString(i18n.locale)

  return (
    <>
      {title}
      <div className="w-full px-0 pb-8">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-white">
              <Trans>Cross-seed</Trans>
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              <Trans>
                Downloads that share data, each original with its cross-seeds,
                and the ones left orphaned once their original or their media is
                gone.
              </Trans>
            </p>
          </div>
          {data.configured ? (
            <Button
              buttonType="default"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              {refresh.isPending ? (
                <SmallLoadingSpinner className="mr-1 h-5 w-5" />
              ) : (
                <RefreshIcon className="mr-1 h-5 w-5" />
              )}
              {t`Refresh`}
            </Button>
          ) : null}
        </div>

        {!data.configured ? (
          <Alert type="info" title={t`No download client is configured.`}>
            <Link
              to="/services/download-client"
              className="underline hover:text-white"
            >
              <Trans>Set up a download client to see its cross-seeds.</Trans>
            </Link>
          </Alert>
        ) : data.error ? (
          <Alert type="error" title={t`The download client could not be read.`}>
            {data.error}
          </Alert>
        ) : (
          <>
            <div className="mb-4 space-y-2">
              {failedInstances.length > 0 ? (
                <Alert
                  type="warning"
                  title={t`Some *arr histories could not be read: ${{ instances: failedInstances.map((instance) => instance.instanceName).join(', ') }}`}
                >
                  <Trans>
                    Until every *arr can be read, no download is reported as
                    media removed.
                  </Trans>
                </Alert>
              ) : null}
              <p className="text-xs text-zinc-400">
                {data.markers.tags.length > 0 ||
                data.markers.categories.length > 0
                  ? t`Cross-seeds recognized by tag ${{ tags: data.markers.tags.join(', ') || '-' }} and category ${{ categories: data.markers.categories.join(', ') || '-' }}, or by matching files.`
                  : t`No cross-seed tag or category was found; cross-seeds are recognized by matching files.`}{' '}
                {plural(torrentCount, {
                  one: '# download read.',
                  other: '# downloads read.',
                })}{' '}
                {t`Updated ${{ generatedAt }}.`}
              </p>
            </div>

            <TabSizes
              summaries={summaries}
              current={currentTab}
              onSelect={setTab}
            />
            <p className="mb-2 text-xs text-zinc-500">
              <Trans>
                Sizes count each group's data once: cross-seeds share the
                original's files.
              </Trans>
            </p>
            <TabbedLinks
              allEnabled
              currentRoute={currentTab}
              onChange={(target) => setTab(target as CrossSeedTab)}
              routes={summaries.map((summary) => ({
                text: `${summary.label} (${summary.groups.length})`,
                route: summary.tab,
              }))}
            />

            {refresh.isError ? (
              <div className="mt-4">
                <Alert
                  type="error"
                  title={getApiErrorMessage(
                    refresh.error,
                    t`The cross-seed overview could not be refreshed.`,
                  )}
                />
              </div>
            ) : null}

            {currentTab !== 'orphans' ? (
              <CrossSeedTree key={currentTab} groups={groupsOf(currentTab)} />
            ) : (
              <CrossSeedOrphans
                groups={data.groups}
                deletesData={
                  downloadClientSettings.data?.download_client_delete_data ??
                  true
                }
              />
            )}
          </>
        )}
      </div>
    </>
  )
}

export default CrossSeedOverview
