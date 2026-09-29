import { Injectable } from '@nestjs/common';
import type { Collection } from 'mongodb';
import { MongoService } from '../../../infra/mongo.service';
import type { User } from '../domain/user';
import {
  USERS_COLLECTION,
  normaliseEmail,
  type UserRepository,
} from '../domain/user.repository';

/**
 * The stored shape. Separate from the domain `User` because `_id` is Mongo's concern and
 * `id` is the domain's — the same document/domain mapping the appointment repository does.
 */
interface UserDocument {
  _id: string;
  email: string;
  passwordHash: string;
  role: 'doctor' | 'patient';
  profileId: string;
  createdAt: number;
}

@Injectable()
export class MongoUserRepository implements UserRepository {
  constructor(private readonly mongo: MongoService) {}

  private get collection(): Collection<UserDocument> {
    return this.mongo.db.collection<UserDocument>(USERS_COLLECTION);
  }

  /**
   * Normalisation happens HERE, not at the call site.
   *
   * The unique index created in migration 005 is on the lowercased email, so a lookup
   * that skipped normalising would miss a user whose stored address differs only in case
   * — the account exists, the password is right, and login fails. That bug reproduces
   * only for users who typed a capital letter when signing up, which is exactly the kind
   * that survives a test suite.
   */
  async findByEmail(email: string): Promise<User | null> {
    const document = await this.collection.findOne({ email: normaliseEmail(email) });
    return document ? toDomain(document) : null;
  }

  async findById(id: string): Promise<User | null> {
    const document = await this.collection.findOne({ _id: id });
    return document ? toDomain(document) : null;
  }

  async save(user: User): Promise<void> {
    await this.collection.replaceOne(
      { _id: user.id },
      {
        email: normaliseEmail(user.email),
        passwordHash: user.passwordHash,
        role: user.role,
        profileId: user.profileId,
        createdAt: user.createdAt,
      },
      { upsert: true },
    );
  }
}

function toDomain(document: UserDocument): User {
  return {
    id: document._id,
    email: document.email,
    passwordHash: document.passwordHash,
    role: document.role,
    profileId: document.profileId,
    createdAt: document.createdAt,
  };
}
