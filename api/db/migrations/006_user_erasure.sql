ALTER TABLE notifications_log DROP CONSTRAINT IF EXISTS notifications_log_user_uid_fkey;
ALTER TABLE notifications_log ALTER COLUMN user_uid DROP NOT NULL;
ALTER TABLE notifications_log ADD CONSTRAINT notifications_log_user_uid_fkey
  FOREIGN KEY (user_uid) REFERENCES users(uid) ON DELETE SET NULL;
