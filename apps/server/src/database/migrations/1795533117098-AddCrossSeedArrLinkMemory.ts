import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCrossSeedArrLinkMemory1795533117098 implements MigrationInterface {
  name = 'AddCrossSeedArrLinkMemory1795533117098';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "cross_seed_arr_link_memory" (
                "hash" varchar PRIMARY KEY NOT NULL,
                "instanceType" varchar NOT NULL,
                "instanceId" integer NOT NULL,
                "instanceName" varchar NOT NULL,
                "title" varchar NOT NULL DEFAULT (''),
                "lastSeenAt" datetime NOT NULL
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP TABLE "cross_seed_arr_link_memory"
        `);
  }
}
