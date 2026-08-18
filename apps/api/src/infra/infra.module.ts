import { Global, Module } from '@nestjs/common';
import { MongoService } from './mongo.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [MongoService, RedisService],
  exports: [MongoService, RedisService],
})
export class InfraModule {}
