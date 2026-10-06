import { Global, Module } from '@nestjs/common';
import { MongoService } from './mongo.service';
import { PostgresService } from './postgres.service';
import { RedisService } from './redis.service';
import { PrivilegedDatabase } from './tenancy/privileged-database';
import { TenantDb, TenantTransactionRunner } from './tenancy/tenant-transaction';

@Global()
@Module({
  providers: [
    MongoService,
    PostgresService,
    RedisService,
    TenantTransactionRunner,
    TenantDb,
    PrivilegedDatabase,
  ],
  exports: [
    MongoService,
    PostgresService,
    RedisService,
    TenantTransactionRunner,
    TenantDb,
    PrivilegedDatabase,
  ],
})
export class InfraModule {}
