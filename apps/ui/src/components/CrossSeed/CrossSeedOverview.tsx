import { RefreshIcon } from '@heroicons/react/solid'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  useCrossSeedOverview,
  useRefreshCrossSeedOverview,
} from '../../api/crossSeed'
import { useDownloadClientSettings } from '../../api/settings'
import { getApiErrorMessage } from '../../utils/ApiError'
import Alert from '../Common/Alert'
import Button from '../Common/Button'
import LoadingSpinner, { SmallLoadingSpinner } from '../Common/LoadingSpinner'
import TabbedLinks from '../Common/TabbedLinks'
import CrossSeedOrphans, { collectOrphans } from './CrossSeedOrphans'
import CrossSeedTree from './CrossSeedTree'

type CrossSeedTab = 'tree' | 'orphans'

const CrossSeedOverview = () => {
  const { t, i18n } = useLingui()
  const [tab, setTab] = useState<CrossSeedTab>('tree')
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

            <TabbedLinks
              allEnabled
              currentRoute={tab}
              onChange={(target) => setTab(target as CrossSeedTab)}
              routes={[
                {
                  text: t`Tree (${{ groupCount: data.groups.length }})`,
                  route: 'tree',
                },
                {
                  text: t`Orphans (${{ orphanCount }})`,
                  route: 'orphans',
                },
              ]}
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

            {tab === 'tree' ? (
              <CrossSeedTree groups={data.groups} />
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
