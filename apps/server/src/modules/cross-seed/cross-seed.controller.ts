import {
  CrossSeedDeleteResponse,
  crossSeedDeleteRequestSchema,
  CrossSeedOverview,
} from '@maintainerr/contracts';
import type { CrossSeedDeleteRequest } from '@maintainerr/contracts';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { CrossSeedService } from './cross-seed.service';

@Controller('api/cross-seed')
export class CrossSeedController {
  constructor(private readonly crossSeedService: CrossSeedService) {}

  @Get()
  @ApiOperation({
    summary:
      'Cross-seed groups in the download client (each original with its cross-seeds) and which downloads are orphaned.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Returns the groups, the cross-seed tags/categories detected and whether every *arr history was read.',
  })
  async getOverview(
    @Query('refresh') refresh?: string,
  ): Promise<CrossSeedOverview> {
    return this.crossSeedService.getOverview(refresh === 'true');
  }

  @Post('delete')
  @ApiOperation({
    summary:
      'Remove orphaned downloads from the download client, following the seeding-goal and delete-data rules of the media-delete cleanup.',
  })
  @ApiResponse({
    status: 201,
    description: 'Returns the outcome for each requested download.',
  })
  async deleteOrphans(
    @Body(new ZodValidationPipe(crossSeedDeleteRequestSchema))
    body: CrossSeedDeleteRequest,
  ): Promise<CrossSeedDeleteResponse> {
    return this.crossSeedService.deleteOrphans(body);
  }
}
