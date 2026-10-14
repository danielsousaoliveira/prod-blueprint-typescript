import { Injectable } from '@nestjs/common';
import { TenantDb } from '../../../infra/tenancy/tenant-transaction';
import type { Person, PersonRepository } from '../domain/person.repository';
import { normaliseEmail } from '../domain/user.repository';

const COLUMNS = `id, identity_id AS "identityId", email, display_name AS "displayName",
  (extract(epoch FROM created_at) * 1000)::float8 AS "createdAt"`;

@Injectable()
export class PgPersonRepository implements PersonRepository {
  constructor(private readonly db: TenantDb) {}

  async findByEmail(email: string): Promise<Person | null> {
    const { rows } = await this.db.query<Person>(
      `SELECT ${COLUMNS} FROM app.people WHERE email = $1`,
      [normaliseEmail(email)],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<Person | null> {
    const { rows } = await this.db.query<Person>(
      `SELECT ${COLUMNS} FROM app.people WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async save(person: Person): Promise<void> {
    await this.db.query(
      `INSERT INTO app.people (organisation_id, id, identity_id, email, display_name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organisation_id, id) DO UPDATE SET
         identity_id = EXCLUDED.identity_id, email = EXCLUDED.email,
         display_name = EXCLUDED.display_name, created_at = EXCLUDED.created_at, updated_at = now()`,
      [
        this.db.organisationId,
        person.id,
        person.identityId,
        normaliseEmail(person.email),
        person.displayName,
        new Date(person.createdAt),
      ],
    );
  }
}
