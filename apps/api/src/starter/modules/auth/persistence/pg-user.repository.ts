import { Injectable } from '@nestjs/common';
import { IdentityDirectory, IDENTITY_COLUMNS } from '../../../infra/identity-directory';
import { TenantDb } from '../../../infra/tenancy/tenant-transaction';
import type { User } from '../domain/user';
import { normaliseEmail, type UserRepository } from '../domain/user.repository';

@Injectable()
export class PgUserRepository implements UserRepository {
  constructor(
    private readonly identities: IdentityDirectory,
    private readonly db: TenantDb,
  ) {}

  findByEmail(email: string): Promise<User | null> {
    return this.db.inTransaction
      ? this.findInOrganisation('i.email', normaliseEmail(email))
      : this.identities.findByEmail(email);
  }

  findById(id: string): Promise<User | null> {
    return this.db.inTransaction
      ? this.findInOrganisation('i.id', id)
      : this.identities.findById(id);
  }

  async save(user: User): Promise<void> {
    if (this.db.inTransaction) {
      // A tenant operation cannot change a global credential shared with other tenants.
      throw new Error('Save identities outside a tenant transaction');
    }
    await this.identities.save(user);
  }

  private async findInOrganisation(
    column: 'i.email' | 'i.id',
    value: string,
  ): Promise<User | null> {
    const { rows } = await this.db.query<User>(
      `SELECT ${IDENTITY_COLUMNS} FROM app.identities i
       JOIN app.people p ON p.identity_id = i.id
       JOIN app.memberships m ON m.organisation_id = p.organisation_id AND m.person_id = p.id
       WHERE ${column} = $1 AND m.status = 'active'`,
      [value],
    );
    return rows[0] ?? null;
  }
}
