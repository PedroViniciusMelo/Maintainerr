import type {
  CrossSeedDeleteRequest,
  CrossSeedDeleteResponse,
  CrossSeedOverview,
} from '@maintainerr/contracts'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query'
import GetApiHandler, { PostApiHandler } from '../utils/ApiHandler'

type CrossSeedQueryKey = ['cross-seed']

const crossSeedQueryKey: CrossSeedQueryKey = ['cross-seed']

type UseCrossSeedOverviewOptions = Omit<
  UseQueryOptions<
    CrossSeedOverview,
    Error,
    CrossSeedOverview,
    CrossSeedQueryKey
  >,
  'queryKey' | 'queryFn'
>

/**
 * The cross-seed groups of the download client. Reading every *arr history is
 * slow, so the server caches it briefly; `refresh` asks for a fresh read.
 */
export const fetchCrossSeedOverview = (refresh = false) =>
  GetApiHandler<CrossSeedOverview>(
    refresh ? '/cross-seed?refresh=true' : '/cross-seed',
  )

export const useCrossSeedOverview = (options?: UseCrossSeedOverviewOptions) =>
  useQuery<CrossSeedOverview, Error, CrossSeedOverview, CrossSeedQueryKey>({
    queryKey: crossSeedQueryKey,
    queryFn: () => fetchCrossSeedOverview(),
    staleTime: 60 * 1000,
    ...options,
  })

/** Re-read everything, bypassing the server's *arr history cache. */
export const useRefreshCrossSeedOverview = () => {
  const queryClient = useQueryClient()

  return useMutation<CrossSeedOverview, Error, void>({
    mutationKey: ['cross-seed', 'refresh'],
    mutationFn: () => fetchCrossSeedOverview(true),
    onSuccess: (overview) => {
      queryClient.setQueryData(crossSeedQueryKey, overview)
    },
  })
}

export const useDeleteCrossSeedOrphans = () => {
  const queryClient = useQueryClient()

  return useMutation<CrossSeedDeleteResponse, Error, CrossSeedDeleteRequest>({
    mutationKey: ['cross-seed', 'delete'],
    mutationFn: (payload) =>
      PostApiHandler<CrossSeedDeleteResponse>('/cross-seed/delete', payload),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: crossSeedQueryKey })
    },
  })
}
