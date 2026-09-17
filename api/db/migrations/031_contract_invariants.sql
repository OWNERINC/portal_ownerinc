DO $$
DECLARE
  invalid_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO invalid_count
  FROM users
  WHERE contract_type IS NULL
     OR is_pj IS NULL
     OR contract_type NOT IN ('clt', 'pj')
     OR (contract_type = 'pj' AND (
       is_pj IS NOT TRUE
       OR pj_due_day IS NULL
       OR NOT (pj_due_day BETWEEN 1 AND 31)
     ))
     OR (contract_type = 'clt' AND is_pj IS NOT FALSE);

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'Contract invariant preflight found % invalid user rows', invalid_count
      USING HINT = 'Inspect uid, email, contract_type, is_pj, and pj_due_day before rerunning migration 031.';
  END IF;
END $$;

-- A CLT day has no business meaning and is the only safe legacy normalization.
UPDATE users
SET pj_due_day = NULL
WHERE contract_type = 'clt' AND pj_due_day IS NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_contract_consistency;
ALTER TABLE users ADD CONSTRAINT users_contract_consistency CHECK (
  (contract_type = 'pj' AND is_pj IS TRUE AND pj_due_day BETWEEN 1 AND 31)
  OR (contract_type = 'clt' AND is_pj IS FALSE AND pj_due_day IS NULL)
);
