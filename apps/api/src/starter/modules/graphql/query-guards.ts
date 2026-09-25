import { GraphQLError, type ValidationContext, type ASTVisitor, Kind } from 'graphql';

/**
 * Query depth limiting and complexity analysis.
 *
 * ============================================================================
 * WHY GRAPHQL NEEDS THIS AND REST DOES NOT
 * ============================================================================
 *
 * In REST, the server decides how much work an endpoint does. In GraphQL the CLIENT
 * composes the query, so without limits a single anonymous request can ask for
 * arbitrarily much work. The classic form is a cyclic query:
 *
 *   { appointments { doctor { appointments { doctor { appointments { ... } } } } } }
 *
 * Each level multiplies the resolver count. Around ten levels this is a denial of service
 * from one request, and DataLoader does not save you — batching reduces round trips, not
 * the exponential number of objects being resolved.
 *
 * So these limits are not hardening to add later. They are the cost of accepting
 * client-composed queries, and shipping a public GraphQL endpoint without them is the
 * mistake, not the omission.
 * ============================================================================
 */

export const MAX_DEPTH = 7;
export const MAX_COMPLEXITY = 1000;

/**
 * Reject queries nested deeper than `MAX_DEPTH`.
 *
 * Runs as a VALIDATION rule, which matters: validation happens before execution, so a
 * rejected query costs one parse and zero database work. Checking during execution would
 * mean the abuse has already partly happened.
 *
 * Fragments are counted by inlining their depth at each spread site — otherwise a query
 * hides its real depth behind a chain of fragments and trivially evades the limit.
 *
 * Note that Apollo normalises every validation-rule failure to the standard
 * `GRAPHQL_VALIDATION_FAILED` code, overriding the `QUERY_TOO_DEEP` set below. That is
 * correct behaviour — this IS a validation failure — so the specific reason travels in
 * the message rather than the code, and the tests assert on the message.
 */
export function depthLimit(maxDepth: number = MAX_DEPTH) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = context
      .getDocument()
      .definitions.reduce<Record<string, unknown>>((acc, definition) => {
        if (definition.kind === Kind.FRAGMENT_DEFINITION) {
          acc[definition.name.value] = definition;
        }
        return acc;
      }, {});

    function depthOf(node: unknown, seen: Set<string>): number {
      const anyNode = node as {
        kind?: string;
        selectionSet?: { selections: unknown[] };
        name?: { value: string };
      };

      if (anyNode.kind === Kind.FRAGMENT_SPREAD) {
        const name = anyNode.name?.value ?? '';
        // Guard against a fragment cycle, which would otherwise recurse forever — the
        // limiter must not itself become the denial of service.
        if (seen.has(name)) return 0;
        const fragment = fragments[name];
        return fragment ? depthOf(fragment, new Set([...seen, name])) : 0;
      }

      if (!anyNode.selectionSet) return 0;

      const childDepths = anyNode.selectionSet.selections.map((selection) =>
        depthOf(selection, seen),
      );
      const deepest = childDepths.length > 0 ? Math.max(...childDepths) : 0;

      // Inline fragments and fragment spreads do not add a level themselves; they are a
      // syntactic grouping, not a traversal step.
      const isGrouping =
        anyNode.kind === Kind.INLINE_FRAGMENT ||
        anyNode.kind === Kind.FRAGMENT_DEFINITION;

      return deepest + (isGrouping ? 0 : 1);
    }

    return {
      OperationDefinition(node) {
        const depth = depthOf(node, new Set());
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `Query is too deep: ${depth} exceeds the maximum of ${maxDepth}`,
              { nodes: [node], extensions: { code: 'QUERY_TOO_DEEP' } },
            ),
          );
        }
      },
    };
  };
}

/**
 * Complexity is deliberately a SEPARATE limit from depth, because they catch different
 * abuse.
 *
 * A shallow query can still be enormous:
 *
 *   { appointments(first: 10000) { doctor { name } patient { name } } }
 *
 * Depth 3, and it resolves 30,000 fields. Depth limiting alone would wave it through.
 * Complexity assigns a cost per field, multiplies by list sizes, and rejects anything
 * over budget — so the two limits together cover both the deep-and-narrow and the
 * shallow-and-wide shapes.
 *
 * Applied via `graphql-query-complexity` in graphql.module.ts, where it has access to the
 * schema and variables it needs to compute list multipliers.
 */
