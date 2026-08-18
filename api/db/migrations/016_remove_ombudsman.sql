UPDATE users
SET permissions = permissions - 'viewOmbudsman'
WHERE permissions ? 'viewOmbudsman';

DROP INDEX IF EXISTS ombudsman_workflow_idx;
DROP TABLE IF EXISTS ombudsman CASCADE;
