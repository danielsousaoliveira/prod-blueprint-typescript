import { Global, Module } from '@nestjs/common';
import { IdentityDirectory } from './identity-directory';
import { MongoService } from './mongo.service';
import { PostgresService } from './postgres.service';
import { RedisService } from './redis.service';
import { PrivilegedDatabase } from './tenancy/privileged-database';
import { TenantDb, TenantTransactionRunner } from './tenancy/tenant-transaction';

@Global()
@Module({
  providers: [
    IdentityDirectory,
    MongoService,
    PostgresService,
    RedisService,
    TenantTransactionRunner,
    TenantDb,
    PrivilegedDatabase,
  ],
  exports: [
    IdentityDirectory,
    MongoService,
    PostgresService,
    RedisService,
    TenantTransactionRunner,
    TenantDb,
    PrivilegedDatabase,
  ],
})
export class InfraModule {}
