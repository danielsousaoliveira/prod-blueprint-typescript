import { Injectable, Logger } from '@nestjs/common';
import { SlugTakenError, assertClaimableSlug } from '../../modules/tenancy/slug';
import type { Organisation } from '../../modules/tenancy/organisation';
import { PostgresService } from '../postgres.service';
import { RedisService } from '../redis.service';
import { PrivilegedDatabase } from './privileged-database';

export const ORGANISATION_CACHE_TTL_SECONDS = 60;

const cacheKey = (slug: string): string => `organisation:slug:${slug}`;

const UNIQUE_VIOLATION = '23505';
const SLUG_UNIQUE_CONSTRAINT = 'organisations_slug_unique';

function translateSlugConflict(error: unknown, slug: string): unknown {
  const failure = error as { code?: unknown; constraint?: unknown };
  return failure.code === UNIQUE_VIOLATION &&
    failure.constraint === SLUG_UNIQUE_CONSTRAINT
    ? new SlugTakenError(slug)
    : error;
}

@Injectable()
export class OrganisationDirectory {
  private readonly logger = new Logger(OrganisationDirectory.name);

  constructor(
    private readonly postgres: PostgresService,
    private readonly privileged: PrivilegedDatabase,
    private readonly redis: RedisService,
  ) {}

  async findBySlug(slug: string): Promise<Organisation | null> {
    const cached = await this.readCache(slug);
    if (cached) return cached;

    const { rows } = await this.postgres.queryOutsideTenant<Organisation>(
      'SELECT id, slug, name FROM app.organisations WHERE slug = $1',
      [slug],
    );
    const found = rows[0] ?? null;
    if (found) await this.writeCache(found);
    return found;
  }

  async create(slug: string, name: string): Promise<Organisation> {
    assertClaimableSlug(slug);
    try {
      const { rows } = await this.privileged.query<Organisation>(
        'INSERT INTO app.organisations (slug, name) VALUES ($1, $2) RETURNING id, slug, name',
        [slug, name],
      );
      return rows[0]!;
    } catch (error) {
      throw translateSlugConflict(error, slug);
    }
  }

  async renameSlug(id: string, newSlug: string): Promise<Organisation | null> {
    assertClaimableSlug(newSlug);

    const previous = await this.postgres.queryOutsideTenant<{ slug: string }>(
      'SELECT slug FROM app.organisations WHERE id = $1',
      [id],
    );
    const oldSlug = previous.rows[0]?.slug;
    if (!oldSlug) return null;

    try {
      const { rows } = await this.privileged.query<Organisation>(
        'UPDATE app.organisations SET slug = $2, updated_at = now() WHERE id = $1 RETURNING id, slug, name',
        [id, newSlug],
      );
      await this.invalidate(oldSlug, newSlug);
      return rows[0] ?? null;
    } catch (error) {
      throw translateSlugConflict(error, newSlug);
    }
  }

  async invalidate(...slugs: string[]): Promise<void> {
    try {
      await this.redis.client.del(...slugs.map(cacheKey));
    } catch (error) {
      this.logger.warn(`Organisation cache invalidation failed: ${String(error)}`);
    }
  }

  private async readCache(slug: string): Promise<Organisation | null> {
    try {
      const raw = await this.redis.client.get(cacheKey(slug));
      return raw ? (JSON.parse(raw) as Organisation) : null;
    } catch (error) {
      this.logger.warn(`Organisation cache read failed: ${String(error)}`);
      return null;
    }
  }

  private async writeCache(organisation: Organisation): Promise<void> {
    try {
      await this.redis.client.set(
        cacheKey(organisation.slug),
        JSON.stringify(organisation),
        'EX',
        ORGANISATION_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(`Organisation cache write failed: ${String(error)}`);
    }
  }
}
