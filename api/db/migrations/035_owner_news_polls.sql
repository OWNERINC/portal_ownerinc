CREATE TABLE owner_news_polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  question TEXT NOT NULL CHECK (char_length(btrim(question)) BETWEEN 1 AND 240),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 600),
  closing TEXT NOT NULL DEFAULT '' CHECK (char_length(closing) <= 200),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX owner_news_one_open_poll
  ON owner_news_polls ((TRUE)) WHERE status='open';

CREATE TABLE owner_news_poll_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id UUID NOT NULL REFERENCES owner_news_polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 100),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 5),
  UNIQUE (poll_id, id),
  UNIQUE (poll_id, position)
);
CREATE TABLE owner_news_poll_votes (
  poll_id UUID NOT NULL REFERENCES owner_news_polls(id) ON DELETE CASCADE,
  option_id UUID NOT NULL,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (poll_id, user_uid),
  FOREIGN KEY (poll_id, option_id) REFERENCES owner_news_poll_options(poll_id, id)
);
CREATE INDEX owner_news_poll_votes_option_idx ON owner_news_poll_votes(poll_id, option_id);
CREATE INDEX owner_news_poll_votes_user_idx ON owner_news_poll_votes(user_uid);
CREATE INDEX owner_news_polls_publication_idx ON owner_news_polls(status, published_at DESC, id);
