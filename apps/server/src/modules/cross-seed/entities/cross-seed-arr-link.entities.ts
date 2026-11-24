import type { CrossSeedArrType } from '@maintainerr/contracts';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * A download Maintainerr once saw an *arr grab or import. The *arrs erase an
 * item's history when the media is deleted, so this memory is the only way to
 * tell a download whose media was removed from one no *arr ever knew.
 */
@Entity()
export class CrossSeedArrLinkMemory {
  /** Lowercase infohash. */
  @PrimaryColumn()
  hash: string;

  @Column({ type: 'varchar' })
  instanceType: CrossSeedArrType;

  @Column({ type: 'integer' })
  instanceId: number;

  @Column()
  instanceName: string;

  @Column({ default: '' })
  title: string;

  @Column({ type: 'datetime' })
  lastSeenAt: Date;
}
