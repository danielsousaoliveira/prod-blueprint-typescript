export type MembershipRole = 'owner' | 'admin' | 'member';
export type MembershipStatus = 'active' | 'suspended';

export interface Membership {
  readonly id: string;
  readonly personId: string;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly createdAt: number;
}

export interface MembershipRepository {
  findByPersonId(personId: string): Promise<Membership | null>;
  save(membership: Membership): Promise<void>;
  remove(personId: string): Promise<void>;
}

export const MEMBERSHIP_REPOSITORY = Symbol('MEMBERSHIP_REPOSITORY');
