import 'dotenv/config';
import { Pool } from 'pg';
import { hashPassword } from '../../modules/auth/domain/password';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Demo identity seeding is forbidden in production');
  }
  const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
  try {
    const hash = await hashPassword(
      process.env.SEED_DEMO_PASSWORD ?? 'demo-password-123',
    );
    for (const [id, email, role, profileId] of [
      ['user-doctor-demo', 'doctor@clinic.test', 'doctor', 'doctor-1'],
      ['user-patient-demo', 'patient@example.test', 'patient', 'patient-1'],
    ]) {
      await pool.query(
        `INSERT INTO app.identities (id, email, password_hash, role, profile_id, created_at)
         VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT (id) DO NOTHING`,
        [id, email, hash, role, profileId],
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Identity seeding failed:', error);
  process.exitCode = 1;
});
