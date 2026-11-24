import { useLingui } from '@lingui/react/macro'
import type {
  CrossSeedArrLink,
  CrossSeedOrphanReason,
  CrossSeedTorrent,
} from '@maintainerr/contracts'
import Badge from '../Common/Badge'

/** Seeding time as days and hours; units stay untranslated, like MB/GB. */
export const formatSeedingTime = (seconds: number): string => {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`
}

export const formatRatio = (ratio: number | null): string =>
  ratio === null ? '∞' : ratio.toFixed(2)

export const OrphanReasonBadge = ({
  reason,
}: {
  reason: CrossSeedOrphanReason
}) => {
  const { t } = useLingui()
  if (reason === 'not-in-arr') {
    return (
      <Badge badgeType="warning">
        <span
          title={t`It sits in an *arr category, but no *arr has ever known it.`}
        >
          {t`Not in any *arr`}
        </span>
      </Badge>
    )
  }
  return (
    <Badge badgeType="danger">
      {reason === 'original-missing' ? t`Original missing` : t`Media removed`}
    </Badge>
  )
}

export const SeedingBadge = ({ torrent }: { torrent: CrossSeedTorrent }) => {
  const { t } = useLingui()
  return torrent.seedingGoalMet ? (
    <Badge badgeType="success">{t`Seeding goal met`}</Badge>
  ) : (
    <Badge badgeType="warning">{t`Still seeding`}</Badge>
  )
}

const arrLinkLabel = (link: CrossSeedArrLink) =>
  link.title ? `${link.instanceName}: ${link.title}` : link.instanceName

export const ArrLinks = ({
  links,
  former = null,
}: {
  links: CrossSeedArrLink[]
  former?: CrossSeedArrLink | null
}) => {
  const { t } = useLingui()
  if (links.length === 0 && former) {
    return (
      <span className="text-zinc-400">
        {t`Was in ${{ link: arrLinkLabel(former) }}`}
      </span>
    )
  }
  if (links.length === 0) {
    return <span className="text-zinc-500">{t`Not in any *arr`}</span>
  }
  const first = links[0]
  return (
    <span className="text-zinc-300" title={links.map(arrLinkLabel).join('\n')}>
      {arrLinkLabel(first)}
      {links.length > 1 ? ` (+${links.length - 1})` : ''}
    </span>
  )
}
