import { Global, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { OrganisationDirectory } from '../../infra/tenancy/organisation-directory';
import { OrganisationResolver } from './organisation-resolver';
import { TenantResolutionMiddleware } from './tenant-resolution.middleware';

@Global()
@Module({
  providers: [OrganisationDirectory, OrganisationResolver],
  exports: [OrganisationDirectory, OrganisationResolver],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantResolutionMiddleware).forRoutes('*');
  }
}
