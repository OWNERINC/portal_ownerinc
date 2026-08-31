ALTER TABLE pos_cards
  DROP CONSTRAINT IF EXISTS pos_cards_template_check;

ALTER TABLE pos_cards
  ADD CONSTRAINT pos_cards_template_check CHECK (template IN ('convite_owntime', 'convite_owner'));
