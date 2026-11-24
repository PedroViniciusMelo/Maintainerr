import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/solid'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { CrossSeedGroup, CrossSeedTorrent } from '@maintainerr/contracts'
import { useState } from 'react'
import { formatBytes } from '../../utils/formatBytes'
import Badge from '../Common/Badge'
import {
  ArrLinks,
  formatRatio,
  formatSeedingTime,
  OrphanReasonBadge,
} from './crossSeedLabels'

interface CrossSeedTreeProps {
  groups: CrossSeedGroup[]
}

const crossSeedCountLabel = (count: number) =>
  plural(count, { one: '# cross-seed', other: '# cross-seeds' })

const matchesSearch = (group: CrossSeedGroup, search: string) => {
  if (!search) {
    return true
  }
  const needle = search.toLowerCase()
  const torrents = [
    ...(group.original ? [group.original] : []),
    ...group.crossSeeds,
  ]
  return torrents.some(
    (torrent) =>
      torrent.name.toLowerCase().includes(needle) ||
      torrent.tracker.toLowerCase().includes(needle) ||
      torrent.category.toLowerCase().includes(needle) ||
      torrent.arrLinks.some((link) =>
        link.title.toLowerCase().includes(needle),
      ),
  )
}

const TorrentDetails = ({ torrent }: { torrent: CrossSeedTorrent }) => {
  const { t } = useLingui()
  return (
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
      <span>{formatBytes(torrent.size)}</span>
      <span>
        {t`Ratio`} {formatRatio(torrent.ratio)}
      </span>
      <span>
        {t`Seeding`} {formatSeedingTime(torrent.seedingTime)}
      </span>
      {torrent.tracker ? <span>{torrent.tracker}</span> : null}
      {torrent.category ? <span>{torrent.category}</span> : null}
      <ArrLinks links={torrent.arrLinks} former={torrent.formerArrLink} />
    </div>
  )
}

const CrossSeedTreeGroup = ({ group }: { group: CrossSeedGroup }) => {
  const { t } = useLingui()
  const [expanded, setExpanded] = useState(false)
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon

  return (
    <li className="rounded-lg border border-zinc-700 bg-zinc-800/60">
      <button
        type="button"
        className="flex w-full items-start gap-2 p-3 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Chevron className="mt-0.5 h-5 w-5 flex-shrink-0 text-zinc-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold break-all text-white">
              {group.original?.name ?? group.crossSeeds[0]?.name}
            </span>
            <Badge badgeType="default">
              {crossSeedCountLabel(group.crossSeeds.length)}
            </Badge>
            {group.orphanReason ? (
              <OrphanReasonBadge reason={group.orphanReason} />
            ) : null}
          </div>
          {group.original ? (
            <TorrentDetails torrent={group.original} />
          ) : (
            <p className="mt-1 text-xs text-zinc-400">
              <Trans>
                The original download is no longer in the download client.
              </Trans>
            </p>
          )}
        </div>
      </button>
      {expanded ? (
        <ul className="border-t border-zinc-700 py-2 pr-3 pl-10">
          {group.crossSeeds.map((torrent) => (
            <li
              key={torrent.hash}
              className="border-l-2 border-zinc-600 py-2 pl-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all text-zinc-200">{torrent.name}</span>
                {torrent.detection === 'inferred' ? (
                  <Badge badgeType="dark">{t`Matched by files`}</Badge>
                ) : null}
              </div>
              <TorrentDetails torrent={torrent} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

const CrossSeedTree = ({ groups }: CrossSeedTreeProps) => {
  const { t } = useLingui()
  const [search, setSearch] = useState('')
  const visible = groups.filter((group) => matchesSearch(group, search))

  return (
    <div className="mt-4">
      <input
        type="search"
        aria-label={t`Search cross-seeds`}
        placeholder={t`Search by name, tracker, category or title`}
        className="mb-4 w-full max-w-md"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {visible.length === 0 ? (
        <p className="text-sm text-zinc-400">
          {groups.length === 0
            ? t`No cross-seeded downloads were found in the download client.`
            : t`No cross-seeds match the search.`}
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((group) => (
            <CrossSeedTreeGroup key={group.id} group={group} />
          ))}
        </ul>
      )}
    </div>
  )
}

export default CrossSeedTree
