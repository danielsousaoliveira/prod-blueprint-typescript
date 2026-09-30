export interface Organisation {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export class OrganisationNotFoundError extends Error {
  constructor(readonly slug: string) {
    super(`No organisation for ${slug}`);
    this.name = 'OrganisationNotFoundError';
  }
}
