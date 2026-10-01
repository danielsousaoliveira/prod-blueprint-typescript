import { createParamDecorator, type ExecutionContext, HttpStatus } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ProblemException, problems } from '../../shared/http/problem-details';
import type { Organisation } from './organisation';
import {
  ORGANISATION_PROPERTY,
  type RequestWithOrganisation,
} from './tenant-resolution.middleware';

function organisationFromContext(context: ExecutionContext): Organisation | undefined {
  if (context.getType<'graphql' | 'http'>() === 'graphql') {
    const gqlContext = GqlExecutionContext.create(context).getContext<{
      organisation?: Organisation;
      req?: RequestWithOrganisation;
    }>();
    return gqlContext.organisation ?? gqlContext.req?.[ORGANISATION_PROPERTY];
  }

  return context.switchToHttp().getRequest<RequestWithOrganisation>()[
    ORGANISATION_PROPERTY
  ];
}

export const CurrentOrganisation = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Organisation => {
    const organisation = organisationFromContext(context);

    if (!organisation) {
      throw new ProblemException({
        type: problems.notFound,
        title: 'Organisation not found',
        status: HttpStatus.NOT_FOUND,
      });
    }

    return organisation;
  },
);

export const OptionalOrganisation = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Organisation | undefined =>
    organisationFromContext(context),
);
