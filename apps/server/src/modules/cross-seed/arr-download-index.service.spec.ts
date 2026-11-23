import { Mocked, TestBed } from '@suites/unit';
import { ServarrService } from '../api/servarr-api/servarr.service';
import { SettingsDataService } from '../settings/settings-data.service';
import { ArrDownloadIndexService } from './arr-download-index.service';

describe('ArrDownloadIndexService', () => {
  let service: ArrDownloadIndexService;
  let settings: Mocked<SettingsDataService>;
  let servarr: Mocked<ServarrService>;

  beforeEach(async () => {
    const { unit, unitRef } = await TestBed.solitary(
      ArrDownloadIndexService,
    ).compile();
    service = unit;
    settings = unitRef.get(
      SettingsDataService,
    ) as unknown as Mocked<SettingsDataService>;
    servarr = unitRef.get(ServarrService) as unknown as Mocked<ServarrService>;

    settings.getRadarrSettings.mockResolvedValue([
      { id: 1, serverName: 'Radarr' },
    ] as never);
    settings.getSonarrSettings.mockResolvedValue([
      { id: 2, serverName: 'Sonarr' },
    ] as never);
    settings.getSportarrSettings.mockResolvedValue([] as never);
  });

  const radarrReturns = (links: unknown) =>
    servarr.getRadarrApiClient.mockResolvedValue({
      getDownloadLinks: jest.fn().mockResolvedValue(links),
    } as never);
  const sonarrReturns = (links: unknown) =>
    servarr.getSonarrApiClient.mockResolvedValue({
      getDownloadLinks: jest.fn().mockResolvedValue(links),
    } as never);

  it('indexes every instance and keeps a file seen by any record of the same item', async () => {
    radarrReturns([
      { hash: 'aa', title: 'Sample Movie', hasFile: false },
      { hash: 'aa', title: 'Sample Movie', hasFile: true },
    ]);
    sonarrReturns([
      { hash: 'bb', title: 'Sample Series S01E01', hasFile: true },
    ]);

    const index = await service.getIndex();

    expect(index.complete).toBe(true);
    expect(index.links.get('aa')).toEqual([
      {
        instanceType: 'radarr',
        instanceId: 1,
        instanceName: 'Radarr',
        title: 'Sample Movie',
        hasFile: true,
      },
    ]);
    expect(index.links.get('bb')?.[0].instanceType).toBe('sonarr');
  });

  it('marks the index incomplete when one instance cannot be read', async () => {
    radarrReturns([{ hash: 'aa', title: 'Sample Movie', hasFile: true }]);
    sonarrReturns(undefined);

    const index = await service.getIndex();

    expect(index.complete).toBe(false);
    expect(index.instances).toEqual([
      expect.objectContaining({ instanceType: 'radarr', ok: true }),
      expect.objectContaining({ instanceType: 'sonarr', ok: false }),
    ]);
  });

  it('reuses a fresh index unless a refresh is asked for', async () => {
    radarrReturns([]);
    sonarrReturns([]);

    await service.getIndex();
    await service.getIndex();
    expect(servarr.getRadarrApiClient).toHaveBeenCalledTimes(1);

    await service.getIndex(true);
    expect(servarr.getRadarrApiClient).toHaveBeenCalledTimes(2);
  });
});
