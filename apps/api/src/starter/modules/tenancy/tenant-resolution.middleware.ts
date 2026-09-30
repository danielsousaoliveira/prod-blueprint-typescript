import { HttpStatus, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ProblemException, problems } from '../../shared/http/problem-details';
import { OrganisationNotFoundError, type Organisation } from './organisation';
import {
  ORGANISATION_OVERRIDE_HEADER,
  OrganisationResolver,
} from './organisation-resolver';

export const ORGANISATION_PROPERTY = 'organisation';

export interface RequestWithOrganisation extends Request {
  [ORGANISATION_PROPERTY]?: Organisation;
}

@Injectable()
export class TenantResolutionMiddleware implements NestMiddleware {
  constructor(private readonly resolver: OrganisationResolver) {}

  async use(request: RequestWithOrganisation, _response: Response, next: NextFunction) {
    try {
      const organisation = await this.resolver.resolve({
        hostname: request.hostname,
        overrideSlug: request.get(ORGANISATION_OVERRIDE_HEADER),
      });
      if (organisation) request[ORGANISATION_PROPERTY] = organisation;
      next();
    } catch (error) {
      next(
        error instanceof OrganisationNotFoundError
          ? new ProblemException({
              type: problems.notFound,
              title: 'Organisation not found',
              status: HttpStatus.NOT_FOUND,
            })
          : error,
      );
    }
  }
}
