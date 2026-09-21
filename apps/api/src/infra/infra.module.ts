import { Global, Module } from '@nestjs/common';
import { MongoService } from './mongo.service';
import { PostgresService } from './postgres.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [MongoService, PostgresService, RedisService],
  exports: [MongoService, PostgresService, RedisService],
})
export class InfraModule {}
