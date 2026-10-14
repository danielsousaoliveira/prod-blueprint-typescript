export interface Person {
  readonly id: string;
  readonly identityId: string | null;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: number;
}

/** Organisation context comes from the transaction, never from a caller-supplied row. */
export interface PersonRepository {
  findByEmail(email: string): Promise<Person | null>;
  findById(id: string): Promise<Person | null>;
  save(person: Person): Promise<void>;
}

export const PERSON_REPOSITORY = Symbol('PERSON_REPOSITORY');
