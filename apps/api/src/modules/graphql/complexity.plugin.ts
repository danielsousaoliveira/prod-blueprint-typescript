import { Injectable } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { Plugin } from '@nestjs/apollo';
import type { ApolloServerPlugin, GraphQLRequestListener } from '@apollo/server';
import { GraphQLError, separateOperations } from 'graphql';
import {
  fieldExtensionsEstimator,
  getComplexity,
  simpleEstimator,
} from 'graphql-query-complexity';
import { MAX_COMPLEXITY } from './query-guards';

/**
 * Enforces the query complexity budget.
 *
 * Depth limiting alone is not enough, and the reason is worth stating precisely: a
 * SHALLOW query can still be enormous.
 *
 *   { appointments { doctor { name } patient { name } } }
 *
 * That is depth 3 and passes any depth limit, but if `appointments` returns 10,000 rows
 * it resolves 30,000 fields. Depth catches deep-and-narrow; complexity catches
 * shallow-and-wide. A public endpoint needs both.
 *
 * Implemented as a Nest plugin rather than inline in the module factory because it needs
 * the built schema, which only exists after the module has initialised —
 * `GraphQLSchemaHost` is how that dependency is expressed rather than reached for.
 */
@Plugin()
@Injectable()
export class ComplexityPlugin implements ApolloServerPlugin {
  constructor(private readonly schemaHost: GraphQLSchemaHost) {}

  requestDidStart(): Promise<GraphQLRequestListener<never>> {
    const { schema } = this.schemaHost;
    const maxComplexity = MAX_COMPLEXITY;

    return Promise.resolve({
      /**
       * `didResolveOperation` runs after parsing and validation but BEFORE execution.
       *
       * That is the only hook where rejecting is still free — the query has been
       * understood but no resolver has run and no database has been touched. A check in
       * `willSendResponse` would report on abuse that had already completed.
       */
      didResolveOperation({ request, document }): Promise<void> {
        const complexity = getComplexity({
          schema,
          // A document may carry several named operations; cost only the one being run.
          query: request.operationName
            ? (separateOperations(document)[request.operationName] ?? document)
            : document,
          variables: request.variables ?? {},
          estimators: [
            // Field-level overrides first: a field that fans out to a database query can
            // declare a higher cost than a scalar already in memory.
            fieldExtensionsEstimator(),
            // Fallback — every field costs 1.
            simpleEstimator({ defaultComplexity: 1 }),
          ],
        });

        if (complexity > maxComplexity) {
          throw new GraphQLError(
            `Query is too complex: ${complexity} exceeds the maximum of ${maxComplexity}`,
            { extensions: { code: 'QUERY_TOO_COMPLEX' } },
          );
        }

        return Promise.resolve();
      },
    });
  }
}
