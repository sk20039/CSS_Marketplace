'use strict';

// Adds 'draft' as a valid listing status and makes price_cents nullable so
// sellers can save incomplete draft listings before filling in all details.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE listings DROP CONSTRAINT listings_status_check;
    ALTER TABLE listings ADD CONSTRAINT listings_status_check
      CHECK (status IN ('active', 'sold', 'inactive', 'draft'));

    -- Allow NULL price_cents so incomplete drafts can be saved without a price.
    ALTER TABLE listings ALTER COLUMN price_cents DROP NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Safety check: refuse rollback if any draft listings exist.
    -- Drafts may have NULL price_cents, which violates the pre-draft NOT NULL
    -- constraint. Rolling back with drafts present would silently erase seller
    -- work. Review and resolve all drafts manually before running this rollback.
    DO $$
    DECLARE draft_count INTEGER;
    BEGIN
      SELECT COUNT(*) INTO draft_count FROM listings WHERE status = 'draft';
      IF draft_count > 0 THEN
        RAISE EXCEPTION
          'Cannot roll back draft_status migration: % draft listing(s) exist. '
          'Review and manually resolve all drafts before running this migration rollback.',
          draft_count;
      END IF;
    END $$;

    -- No drafts remain; safe to restore the NOT NULL constraint.
    ALTER TABLE listings ALTER COLUMN price_cents SET NOT NULL;
    ALTER TABLE listings DROP CONSTRAINT listings_status_check;
    ALTER TABLE listings ADD CONSTRAINT listings_status_check
      CHECK (status IN ('active', 'sold', 'inactive'));
  `);
};
