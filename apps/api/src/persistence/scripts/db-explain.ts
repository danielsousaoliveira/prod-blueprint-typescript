import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { loadEnv } from '../../config/env';
import { MongoAppointmentRepository } from '../../modules/appointments/persistence/mongo-appointment.repository';

/**
 * `npm run db:explain`
 *
 * Runs `explain('executionStats')` over the main queries and prints, for each, whether an
 * index was used and how efficiently.
 *
 * The number that matters is the ratio of KEYS EXAMINED to DOCUMENTS RETURNED. An index
 * existing proves nothing — the planner may still ignore it, or use it badly. A ratio
 * near 1 means the index is doing the work; a ratio in the hundreds means the query is
 * scanning a large part of the tree and filtering afterwards, which is what
 * equality-sort-range ordering exists to prevent.
 *
 * A `COLLSCAN` on a query with an index is the loudest possible signal that the index and
 * the query shape disagree.
 */

interface ExplainOutput {
  queryPlanner: { winningPlan: Record<string, unknown> };
  executionStats: {
    nReturned: number;
    totalKeysExamined: number;
    totalDocsExamined: number;
    executionTimeMillis: number;
  };
}

function leafStage(plan: Record<string, unknown>): string {
  let node = plan;
  while (node.inputStage) node = node.inputStage as Record<string, unknown>;
  return (node.stage as string) ?? 'UNKNOWN';
}

function indexName(plan: Record<string, unknown>): string | undefined {
  let node = plan;
  while (node) {
    if (node.indexName) return node.indexName as string;
    if (!node.inputStage) break;
    node = node.inputStage as Record<string, unknown>;
  }
  return undefined;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const client = new MongoClient(env.MONGO_URL);
  await client.connect();

  try {
    const db = client.db(env.MONGO_DB_NAME);
    const queries = MongoAppointmentRepository.explainQueries(db);

    let anyCollScan = false;

    for (const query of queries) {
      const explain = (await query.run()) as unknown as ExplainOutput;
      const stage = leafStage(explain.queryPlanner.winningPlan);
      const stats = explain.executionStats;
      const ratio =
        stats.nReturned === 0
          ? stats.totalKeysExamined
          : (stats.totalKeysExamined / stats.nReturned).toFixed(2);

      const usedIndex = stage === 'IXSCAN';
      if (!usedIndex) anyCollScan = true;

      console.log(`\n${usedIndex ? 'OK  ' : 'SCAN'}  ${query.name}`);
      console.log(`      stage:            ${stage}`);
      console.log(
        `      index:            ${indexName(explain.queryPlanner.winningPlan) ?? '(none)'}`,
      );
      console.log(`      returned:         ${stats.nReturned}`);
      console.log(`      keys examined:    ${stats.totalKeysExamined}`);
      console.log(`      docs examined:    ${stats.totalDocsExamined}`);
      console.log(`      keys/returned:    ${ratio}`);
      console.log(`      time:             ${stats.executionTimeMillis}ms`);
    }

    if (anyCollScan) {
      console.log(
        '\nAt least one query used a collection scan. On an empty or tiny collection ' +
          'that is expected — the planner picks a scan when it is genuinely cheaper. ' +
          'Seed representative data before drawing conclusions.',
      );
    }
  } finally {
    await client.close();
  }
}

void main();
