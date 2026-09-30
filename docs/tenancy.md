# Tenancy

How organisations are modelled, how isolation is enforced, and the decisions behind both.
Each section is added by the change that introduces the mechanism it describes.

## Schema

Four tables in the `app` schema, all in `apps/api/src/starter/persistence/pg/schema.ts`:

| Table           | Scoped by `organisation_id` | Purpose                                             |
| --------------- | --------------------------- | --------------------------------------------------- |
| `organisations` | no (see below)              | One row per customer; the subdomain slug lives here |
| `people`        | yes                         | Identity within one organisation                    |
| `memberships`   | yes                         | A person's role and standing in the organisation    |
| `invitations`   | yes                         | Pending invitations, keyed by a hashed token        |

### One column name, leading every index

Every tenant-scoped table spells its organisation reference `organisation_id`. Isolation
policies are written against that name, so a table that spells it differently would
silently receive no policy. The column also leads every index, unique constraint and primary key, which
is what makes uniqueness per organisation rather than global. That includes primary keys:
`people`, `memberships` and `invitations` are keyed by `(organisation_id, id)`, and the
membership foreign key to `people` references that composite key.

### Email is unique per organisation, not globally

`people` has `UNIQUE (organisation_id, email)`. A globally unique email would let one
customer probe whether another customer's staff have accounts, by attempting to invite an
address and reading the error. The cost is that the same human appearing in two
organisations has two `people` rows; linking them across organisations is a later concern
and would sit above this table, not inside it.

Emails are stored lowercase and the database refuses anything else, so uniqueness cannot be
sidestepped by case.

### Memberships carry the standing

`memberships` holds `role` and `status`, separate from `people`, so suspending someone or
changing their role never touches their identity row. Its foreign key to `people` is the
composite `(organisation_id, person_id)`, so a membership cannot point at a person from a
different organisation even if application code tries.

### Slugs

`organisations.slug` is unique and constrained to a DNS label: lowercase letters, digits and
inner hyphens, 3 to 63 characters, never starting or ending with a hyphen.

### Deleting an organisation

Every foreign key to `organisations` is `ON DELETE CASCADE`, and so is the membership to
person key. Deleting an organisation removes its people, memberships and invitations in
one statement. This is covered in `tenancy-schema.integration.spec.ts`.

### `organisations` is the deliberate exception to isolation

A request carries a subdomain. Turning that into an organisation id has to happen before
any tenant context exists, so the table it is read from cannot itself require one. The
runtime role can read and write `organisations`; nothing else is exempt.
