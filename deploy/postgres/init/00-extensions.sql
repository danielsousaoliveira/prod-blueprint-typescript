-- Runs once, on an empty data directory. `btree_gist` ships in postgres:16's contrib
-- set and is required later for the no-double-booking exclusion constraint on time
-- ranges — enabled now so its availability is a property of the base image rather than
-- a surprise in a later phase.
CREATE EXTENSION IF NOT EXISTS btree_gist;
