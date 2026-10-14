import { Injectable } from '@nestjs/common';
import { TenantDb } from '../../../infra/tenancy/tenant-transaction';
import type { Membership, MembershipRepository } from '../domain/membership.repository';

@Injectable()
export class PgMembershipRepository implements MembershipRepository {
  constructor(private readonly db: TenantDb) {}

  async findByPersonId(personId: string): Promise<Membership | null> {
    const { rows } = await this.db.query<Membership>(
      `SELECT id, person_id AS "personId", role, status,
         (extract(epoch FROM created_at) * 1000)::float8 AS "createdAt"
       FROM app.memberships WHERE person_id = $1`,
      [personId],
    );
    return rows[0] ?? null;
  }

  async save(membership: Membership): Promise<void> {
    await this.db.query(
      `INSERT INTO app.memberships (organisation_id, id, person_id, role, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organisation_id, id) DO UPDATE SET
         person_id = EXCLUDED.person_id, role = EXCLUDED.role,
         status = EXCLUDED.status, created_at = EXCLUDED.created_at, updated_at = now()`,
      [
        this.db.organisationId,
        membership.id,
        membership.personId,
        membership.role,
        membership.status,
        new Date(membership.createdAt),
      ],
    );
  }

  async remove(personId: string): Promise<void> {
    await this.db.query('DELETE FROM app.memberships WHERE person_id = $1', [personId]);
  }
}
