import { Module } from '@nestjs/common';
import { DownloadClientApiModule } from '../api/download-client-api/download-client-api.module';
import { ServarrApiModule } from '../api/servarr-api/servarr-api.module';
import { ArrDownloadIndexService } from './arr-download-index.service';
import { CrossSeedController } from './cross-seed.controller';
import { CrossSeedService } from './cross-seed.service';

@Module({
  imports: [DownloadClientApiModule, ServarrApiModule],
  controllers: [CrossSeedController],
  providers: [CrossSeedService, ArrDownloadIndexService],
})
export class CrossSeedModule {}
