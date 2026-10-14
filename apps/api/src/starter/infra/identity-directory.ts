import { Injectable } from '@nestjs/common';
import { PostgresService } from './postgres.service';
import type { User } from '../modules/auth/domain/user';
import { normaliseEmail } from '../modules/auth/domain/user.repository';

export const IDENTITY_COLUMNS = `i.id, i.email, i.password_hash AS "passwordHash",
  i.role, i.profile_id AS "profileId",
  (extract(epoch FROM i.created_at) * 1000)::float8 AS "createdAt"`;

/** Global authentication data only; this handle never reads tenant tables. */
@Injectable()
export class IdentityDirectory {
  constructor(private readonly postgres: PostgresService) {}

  async findByEmail(email: string): Promise<User | null> {
    const { rows } = await this.postgres.queryOutsideTenant<User>(
      `SELECT ${IDENTITY_COLUMNS} FROM app.identities i WHERE i.email = $1`,
      [normaliseEmail(email)],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<User | null> {
    const { rows } = await this.postgres.queryOutsideTenant<User>(
      `SELECT ${IDENTITY_COLUMNS} FROM app.identities i WHERE i.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async save(user: User): Promise<void> {
    await this.postgres.queryOutsideTenant(
      `INSERT INTO app.identities (id, email, password_hash, role, profile_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash, role = EXCLUDED.role,
         profile_id = EXCLUDED.profile_id, created_at = EXCLUDED.created_at, updated_at = now()`,
      [
        user.id,
        normaliseEmail(user.email),
        user.passwordHash,
        user.role,
        user.profileId,
        new Date(user.createdAt),
      ],
    );
  }
}
