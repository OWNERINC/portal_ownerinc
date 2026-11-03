DO $$
BEGIN
  IF to_regclass('public.cms_documents') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON TABLE public.cms_documents FROM portal_api, portal_cron';
  END IF;
  IF to_regclass('public.cms_revisions') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON TABLE public.cms_revisions FROM portal_api, portal_cron';
  END IF;
  IF to_regclass('public.cms_assets') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON TABLE public.cms_assets FROM portal_api, portal_cron';
  END IF;
END
$$;
