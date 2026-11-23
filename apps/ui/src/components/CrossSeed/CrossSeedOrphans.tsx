import { TrashIcon } from '@heroicons/react/solid'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type {
  CrossSeedDeleteResult,
  CrossSeedGroup,
  CrossSeedTorrent,
} from '@maintainerr/contracts'
import { useState } from 'react'
import { useDeleteCrossSeedOrphans } from '../../api/crossSeed'
import { formatBytes } from '../../utils/formatBytes'
import Alert from '../Common/Alert'
import Badge from '../Common/Badge'
import ConfirmActionButton from '../Common/ConfirmActionButton'
import {
  ArrLinks,
  formatRatio,
  formatSeedingTime,
  OrphanReasonBadge,
  SeedingBadge,
} from './crossSeedLabels'

interface CrossSeedOrphansProps {
  groups: CrossSeedGroup[]
  deletesData: boolean
}

interface OrphanRow {
  torrent: CrossSeedTorrent
  isOriginal: boolean
}

/** Every orphaned download, original and cross-seeds alike, in group order. */
export const collectOrphans = (groups: CrossSeedGroup[]): OrphanRow[] => {
  const rows: OrphanRow[] = []
  for (const group of groups) {
    if (!group.orphanReason) {
      continue
    }
    if (group.original) {
      rows.push({ torrent: group.original, isOriginal: true })
    }
    for (const torrent of group.crossSeeds) {
      rows.push({ torrent, isOriginal: false })
    }
  }
  return rows
}

const downloadCountLabel = (count: number) =>
  plural(count, { one: '# download', other: '# downloads' })

const ResultSummary = ({ results }: { results: CrossSeedDeleteResult[] }) => {
  const removed = results.filter((r) => r.outcome === 'removed').length
  const stillSeeding = results.filter(
    (r) => r.reason === 'still-seeding',
  ).length
  const notOrphan = results.filter((r) => r.reason === 'not-orphan').length
  const failed = results.filter((r) => r.outcome === 'failed').length

  return (
    <Alert
      type={failed > 0 ? 'error' : 'success'}
      title={plural(removed, {
        one: 'Removed # download.',
        other: 'Removed # downloads.',
      })}
    >
      <ul className="list-disc pl-5">
        {stillSeeding > 0 ? (
          <li>
            {plural(stillSeeding, {
              one: '# kept: its seeding goal is not met yet.',
              other: '# kept: their seeding goal is not met yet.',
            })}
          </li>
        ) : null}
        {notOrphan > 0 ? (
          <li>
            {plural(notOrphan, {
              one: '# skipped: no longer an orphan.',
              other: '# skipped: no longer orphans.',
            })}
          </li>
        ) : null}
        {failed > 0 ? (
          <li>
            {plural(failed, {
              one: '# could not be removed. See the logs.',
              other: '# could not be removed. See the logs.',
            })}
          </li>
        ) : null}
      </ul>
    </Alert>
  )
}

const CrossSeedOrphans = ({ groups, deletesData }: CrossSeedOrphansProps) => {
  const { t } = useLingui()
  const rows = collectOrphans(groups)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [force, setForce] = useState(false)
  const [results, setResults] = useState<CrossSeedDeleteResult[] | null>(null)
  const deleteOrphans = useDeleteCrossSeedOrphans()

  // Rows can disappear after a refresh; never act on a hash no longer shown.
  const selectedRows = rows.filter((row) => selected.has(row.torrent.hash))
  const selectedSize = selectedRows.reduce(
    (sum, row) => sum + row.torrent.size,
    0,
  )
  const stillSeedingSelected = selectedRows.filter(
    (row) => !row.torrent.seedingGoalMet,
  ).length
  const allSelected = rows.length > 0 && selectedRows.length === rows.length

  const toggle = (hash: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(hash)) {
        next.delete(hash)
      } else {
        next.add(hash)
      }
      return next
    })

  const toggleAll = () =>
    setSelected(
      allSelected ? new Set() : new Set(rows.map((row) => row.torrent.hash)),
    )

  const handleDelete = async () => {
    const response = await deleteOrphans.mutateAsync({
      hashes: selectedRows.map((row) => row.torrent.hash),
      force,
    })
    setResults(response.results)
    setSelected(new Set())
    setForce(false)
  }

  if (rows.length === 0) {
    return (
      <div className="mt-4 space-y-4">
        {results ? <ResultSummary results={results} /> : null}
        <p className="text-sm text-zinc-400">
          <Trans>No orphaned cross-seeds were found.</Trans>
        </p>
      </div>
    )
  }

  return (
    <div className="mt-4 space-y-4">
      {results ? <ResultSummary results={results} /> : null}

      <div className="flex flex-wrap items-center gap-3">
        <ConfirmActionButton
          buttonLabel={t`Remove selected`}
          buttonIcon={<TrashIcon className="mr-1 h-5 w-5" />}
          buttonType="danger"
          confirmButtonType="danger"
          disabled={selectedRows.length === 0}
          modalTitle={t`Remove orphaned downloads`}
          confirmLabel={t`Remove`}
          pendingLabel={t`Removing...`}
          errorMessage={t`The downloads could not be removed.`}
          errorLogSummary="Failed to remove orphaned cross-seed downloads"
          errorContext="CrossSeedOrphans.remove"
          onConfirm={handleDelete}
        >
          <div className="space-y-3 text-sm text-zinc-300">
            <p>
              {t`Remove ${{ downloads: downloadCountLabel(selectedRows.length) }} (${{ size: formatBytes(selectedSize) }}) from the download client?`}
            </p>
            <p>
              {deletesData
                ? t`Their data is deleted with them, except files another remaining download still uses.`
                : t`Their data stays on disk: deleting downloaded data is turned off in the download client settings.`}
            </p>
            {stillSeedingSelected > 0 ? (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="checkbox mt-0.5"
                  checked={force}
                  onChange={(event) => setForce(event.target.checked)}
                />
                <span>
                  {plural(stillSeedingSelected, {
                    one: 'Also remove the # download that has not met its seeding goal yet. It is kept otherwise.',
                    other:
                      'Also remove the # downloads that have not met their seeding goal yet. They are kept otherwise.',
                  })}
                </span>
              </label>
            ) : null}
          </div>
        </ConfirmActionButton>
        <span className="text-sm text-zinc-400">
          {t`${{ selected: selectedRows.length }} of ${{ total: rows.length }} selected`}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-700">
        <table className="min-w-full divide-y divide-zinc-700 text-sm">
          <thead className="bg-zinc-800 text-left text-xs tracking-wide text-zinc-400 uppercase">
            <tr>
              <th className="px-3 py-2">
                <input
                  type="checkbox"
                  className="checkbox"
                  aria-label={t`Select all orphans`}
                  checked={allSelected}
                  onChange={toggleAll}
                />
              </th>
              <th className="px-3 py-2">{t`Download`}</th>
              <th className="px-3 py-2">{t`Reason`}</th>
              <th className="px-3 py-2">{t`Size`}</th>
              <th className="px-3 py-2">{t`Ratio`}</th>
              <th className="px-3 py-2">{t`Seeding`}</th>
              <th className="px-3 py-2">{t`Status`}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-700">
            {rows.map(({ torrent, isOriginal }) => (
              <tr key={torrent.hash} className="align-top">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    className="checkbox"
                    aria-label={t`Select ${{ name: torrent.name }}`}
                    checked={selected.has(torrent.hash)}
                    onChange={() => toggle(torrent.hash)}
                  />
                </td>
                <td className="max-w-md px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all text-zinc-100">
                      {torrent.name}
                    </span>
                    <Badge badgeType={isOriginal ? 'primary' : 'dark'}>
                      {isOriginal ? t`Original` : t`Cross-seed`}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">
                    {[torrent.tracker, torrent.category]
                      .filter(Boolean)
                      .join(' - ')}
                  </div>
                  <div className="text-xs">
                    <ArrLinks links={torrent.arrLinks} />
                  </div>
                </td>
                <td className="px-3 py-2">
                  {torrent.orphanReason ? (
                    <OrphanReasonBadge reason={torrent.orphanReason} />
                  ) : null}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {formatBytes(torrent.size)}
                </td>
                <td className="px-3 py-2">{formatRatio(torrent.ratio)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {formatSeedingTime(torrent.seedingTime)}
                </td>
                <td className="px-3 py-2">
                  <SeedingBadge torrent={torrent} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default CrossSeedOrphans
