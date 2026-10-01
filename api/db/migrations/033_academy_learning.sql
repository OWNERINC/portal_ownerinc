ALTER TABLE academy ALTER COLUMN url DROP NOT NULL;
ALTER TABLE academy ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'external'
  CHECK (delivery_mode IN ('external', 'internal'));
ALTER TABLE academy ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'all'
  CHECK (audience IN ('all', 'job_titles'));
ALTER TABLE academy ADD COLUMN IF NOT EXISTS learning_group TEXT NOT NULL DEFAULT 'initial'
  CHECK (learning_group IN ('initial', 'role'));
ALTER TABLE academy ADD COLUMN IF NOT EXISTS icon_key TEXT NOT NULL DEFAULT 'icon-01'
  CHECK (icon_key IN ('icon-01','icon-02','icon-03','icon-04','icon-05','icon-06'));
ALTER TABLE academy ADD COLUMN IF NOT EXISTS instructor_name TEXT NOT NULL DEFAULT ''
  CHECK (char_length(instructor_name) <= 120);
ALTER TABLE academy ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE academy DROP CONSTRAINT IF EXISTS academy_delivery_url_check;
ALTER TABLE academy ADD CONSTRAINT academy_delivery_url_check CHECK (
  (delivery_mode='external' AND url IS NOT NULL AND url ~ '^https?://')
  OR (delivery_mode='internal' AND url IS NULL)
);

CREATE TABLE IF NOT EXISTS academy_course_job_titles (
  course_id UUID NOT NULL REFERENCES academy(id) ON DELETE CASCADE,
  job_title_id UUID NOT NULL REFERENCES job_titles(id) ON DELETE RESTRICT,
  PRIMARY KEY (course_id, job_title_id)
);
CREATE INDEX IF NOT EXISTS academy_course_job_titles_job_idx
  ON academy_course_job_titles(job_title_id, course_id);

CREATE TABLE IF NOT EXISTS academy_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES academy(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  "order" INTEGER NOT NULL DEFAULT 0 CHECK ("order" BETWEEN -100000 AND 100000),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS academy_modules_course_idx ON academy_modules(course_id, "order", id);

CREATE TABLE IF NOT EXISTS academy_lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id UUID NOT NULL REFERENCES academy_modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description)<=5000),
  "order" INTEGER NOT NULL DEFAULT 0 CHECK ("order" BETWEEN -100000 AND 100000),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  media_type TEXT NOT NULL CHECK (media_type IN ('youtube','file')),
  youtube_video_id TEXT,
  media_url TEXT,
  media_version INTEGER NOT NULL DEFAULT 1 CHECK (media_version>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT academy_lesson_media_check CHECK (
    (media_type='youtube' AND youtube_video_id IS NOT NULL
      AND youtube_video_id ~ '^[A-Za-z0-9_-]{11}$' AND media_url IS NULL)
    OR (media_type='file' AND youtube_video_id IS NULL AND media_url IS NOT NULL
      AND media_url ~ '^https://' AND char_length(media_url)<=2048)
  )
);
CREATE INDEX IF NOT EXISTS academy_lessons_module_idx ON academy_lessons(module_id, "order", id);

CREATE TABLE IF NOT EXISTS academy_lesson_progress (
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  lesson_id UUID NOT NULL REFERENCES academy_lessons(id) ON DELETE CASCADE,
  media_version INTEGER NOT NULL CHECK (media_version>0),
  position_seconds INTEGER NOT NULL DEFAULT 0 CHECK (position_seconds BETWEEN 0 AND 86400),
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_uid, lesson_id, media_version),
  CHECK ((completed AND completed_at IS NOT NULL)
    OR (NOT completed AND completed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS academy_progress_recent_idx ON academy_lesson_progress(user_uid, updated_at DESC);

ALTER TABLE cms_documents DROP CONSTRAINT cms_documents_content_type_check;
ALTER TABLE cms_documents ADD CONSTRAINT cms_documents_content_type_check CHECK (
  content_type IN ('knowledge','academy','academy_lesson','benefit','announcement','reminder')
);
