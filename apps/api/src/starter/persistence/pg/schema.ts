import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const appSchema = pgSchema('app');

export const SLUG_PATTERN = '^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$';

export const MEMBERSHIP_ROLES = ['owner', 'admin', 'member'] as const;
export const MEMBERSHIP_STATUSES = ['active', 'suspended'] as const;

export const organisations = appSchema.table(
  'organisations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'organisations_slug_format',
      sql`${table.slug} ~ ${sql.raw(`'${SLUG_PATTERN}'`)}`,
    ),
  ],
);

export const people = appSchema.table(
  'people',
  {
    id: uuid('id').defaultRandom().notNull(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'people_pkey', columns: [table.organisationId, table.id] }),
    unique('people_organisation_id_email_unique').on(table.organisationId, table.email),
    check('people_email_lowercase', sql`${table.email} = lower(${table.email})`),
  ],
);

export const memberships = appSchema.table(
  'memberships',
  {
    id: uuid('id').defaultRandom().notNull(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').notNull(),
    role: text('role', { enum: MEMBERSHIP_ROLES }).notNull().default('member'),
    status: text('status', { enum: MEMBERSHIP_STATUSES }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'memberships_pkey', columns: [table.organisationId, table.id] }),
    unique('memberships_organisation_id_person_id_unique').on(
      table.organisationId,
      table.personId,
    ),
    foreignKey({
      name: 'memberships_person_fk',
      columns: [table.organisationId, table.personId],
      foreignColumns: [people.organisationId, people.id],
    }).onDelete('cascade'),
    index('memberships_organisation_id_role_idx').on(table.organisationId, table.role),
    check('memberships_role_valid', sql`${table.role} IN ('owner', 'admin', 'member')`),
    check('memberships_status_valid', sql`${table.status} IN ('active', 'suspended')`),
  ],
);

export const invitations = appSchema.table(
  'invitations',
  {
    id: uuid('id').defaultRandom().notNull(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: MEMBERSHIP_ROLES }).notNull().default('member'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'invitations_pkey', columns: [table.organisationId, table.id] }),
    unique('invitations_organisation_id_token_hash_unique').on(
      table.organisationId,
      table.tokenHash,
    ),
    index('invitations_organisation_id_email_idx').on(table.organisationId, table.email),
    check('invitations_email_lowercase', sql`${table.email} = lower(${table.email})`),
    check('invitations_role_valid', sql`${table.role} IN ('owner', 'admin', 'member')`),
  ],
);
