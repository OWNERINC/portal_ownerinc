DO $$
BEGIN
  IF EXISTS (
    SELECT employee_id FROM solides_employee_links GROUP BY employee_id HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce global Sólides employee uniqueness: duplicate employee_id values exist';
  END IF;
  IF EXISTS (SELECT 1 FROM solides_employee_links WHERE employer_scope <> 'default') THEN
    RAISE EXCEPTION 'Cannot enforce the initial Sólides scope: non-default scopes exist';
  END IF;
END $$;

ALTER TABLE solides_employee_links
  DROP CONSTRAINT IF EXISTS solides_employee_links_employee_unique,
  DROP CONSTRAINT IF EXISTS solides_employee_links_verification,
  ADD CONSTRAINT solides_employee_links_employee_unique UNIQUE (employee_id),
  ADD CONSTRAINT solides_employee_links_scope_check CHECK (employer_scope = 'default'),
  ADD CONSTRAINT solides_employee_links_verification CHECK (
    status <> 'verified' OR verified_at IS NOT NULL
  );
