import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_news_articles_blocks_rich_text_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_news_articles_blocks_rich_text_typography" AS ENUM('serif', 'sans');
  CREATE TYPE "public"."enum_news_articles_blocks_heading_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_news_articles_blocks_paragraph_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_news_articles_blocks_paragraph_typography" AS ENUM('serif', 'sans');
  CREATE TYPE "public"."enum_news_articles_blocks_list_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_news_articles_blocks_list_typography" AS ENUM('serif', 'sans');
  CREATE TYPE "public"."enum_news_articles_blocks_image_usage" AS ENUM('cover', 'body');
  CREATE TYPE "public"."enum_news_articles_blocks_image_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_news_articles_blocks_callout_tone" AS ENUM('info', 'warning', 'success');
  CREATE TYPE "public"."enum_news_articles_blocks_callout_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_news_articles_blocks_callout_typography" AS ENUM('serif', 'sans');
  CREATE TYPE "public"."enum_news_articles_blocks_quote_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_news_articles_blocks_quote_typography" AS ENUM('serif', 'sans');
  CREATE TYPE "public"."enum_news_articles_blocks_profile_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_news_articles_blocks_profile_typography" AS ENUM('serif', 'sans');
  CREATE TYPE "public"."enum_news_articles_blocks_divider_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_news_articles_blocks_link_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_news_articles_blocks_pdf_usage" AS ENUM('edition', 'attachment');
  CREATE TYPE "public"."enum_news_articles_blocks_pdf_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_news_articles_blocks_video_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_news_articles_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__news_articles_v_blocks_rich_text_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__news_articles_v_blocks_rich_text_typography" AS ENUM('serif', 'sans');
  CREATE TYPE "public"."enum__news_articles_v_blocks_heading_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__news_articles_v_blocks_paragraph_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__news_articles_v_blocks_paragraph_typography" AS ENUM('serif', 'sans');
  CREATE TYPE "public"."enum__news_articles_v_blocks_list_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__news_articles_v_blocks_list_typography" AS ENUM('serif', 'sans');
  CREATE TYPE "public"."enum__news_articles_v_blocks_image_usage" AS ENUM('cover', 'body');
  CREATE TYPE "public"."enum__news_articles_v_blocks_image_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__news_articles_v_blocks_callout_tone" AS ENUM('info', 'warning', 'success');
  CREATE TYPE "public"."enum__news_articles_v_blocks_callout_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__news_articles_v_blocks_callout_typography" AS ENUM('serif', 'sans');
  CREATE TYPE "public"."enum__news_articles_v_blocks_quote_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__news_articles_v_blocks_quote_typography" AS ENUM('serif', 'sans');
  CREATE TYPE "public"."enum__news_articles_v_blocks_profile_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__news_articles_v_blocks_profile_typography" AS ENUM('serif', 'sans');
  CREATE TYPE "public"."enum__news_articles_v_blocks_divider_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__news_articles_v_blocks_link_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__news_articles_v_blocks_pdf_usage" AS ENUM('edition', 'attachment');
  CREATE TYPE "public"."enum__news_articles_v_blocks_pdf_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__news_articles_v_blocks_video_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__news_articles_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum_news_home_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__news_home_v_version_status" AS ENUM('draft', 'published');
  CREATE TABLE "portal_editors" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "portal_uid" varchar NOT NULL,
    "email" varchar NOT NULL,
    "display_name" varchar,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "news_articles_blocks_rich_text" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "content" jsonb,
    "layout" "enum_news_articles_blocks_rich_text_layout",
    "typography" "enum_news_articles_blocks_rich_text_typography",
    "block_name" varchar
  );

  CREATE TABLE "news_articles_blocks_heading" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "text" varchar,
    "level" numeric DEFAULT 2,
    "layout" "enum_news_articles_blocks_heading_layout",
    "block_name" varchar
  );

  CREATE TABLE "news_articles_blocks_paragraph" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "text" varchar,
    "layout" "enum_news_articles_blocks_paragraph_layout",
    "typography" "enum_news_articles_blocks_paragraph_typography",
    "block_name" varchar
  );

  CREATE TABLE "news_articles_blocks_list_items" (
    "_order" integer NOT NULL,
    "_parent_id" varchar NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "text" varchar
  );

  CREATE TABLE "news_articles_blocks_list" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "ordered" boolean DEFAULT false,
    "layout" "enum_news_articles_blocks_list_layout",
    "typography" "enum_news_articles_blocks_list_typography",
    "block_name" varchar
  );

  CREATE TABLE "news_articles_blocks_image" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "media_id" uuid,
    "alt" varchar,
    "caption" varchar,
    "credit" varchar,
    "usage" "enum_news_articles_blocks_image_usage",
    "layout" "enum_news_articles_blocks_image_layout",
    "block_name" varchar
  );

  CREATE TABLE "news_articles_blocks_callout" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "tone" "enum_news_articles_blocks_callout_tone" DEFAULT 'info',
    "title" varchar,
    "text" varchar,
    "layout" "enum_news_articles_blocks_callout_layout",
    "typography" "enum_news_articles_blocks_callout_typography",
    "block_name" varchar
  );

  CREATE TABLE "news_articles_blocks_quote" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "text" varchar,
    "attribution" varchar,
    "layout" "enum_news_articles_blocks_quote_layout",
    "typography" "enum_news_articles_blocks_quote_typography",
    "block_name" varchar
  );

  CREATE TABLE "news_articles_blocks_profile" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "name" varchar,
    "role" varchar,
    "text" varchar,
    "media_id" uuid,
    "alt" varchar,
    "layout" "enum_news_articles_blocks_profile_layout",
    "typography" "enum_news_articles_blocks_profile_typography",
    "block_name" varchar
  );

  CREATE TABLE "news_articles_blocks_divider" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "layout" "enum_news_articles_blocks_divider_layout",
    "block_name" varchar
  );

  CREATE TABLE "news_articles_blocks_link" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "label" varchar,
    "url" varchar,
    "new_tab" boolean DEFAULT false,
    "layout" "enum_news_articles_blocks_link_layout",
    "block_name" varchar
  );

  CREATE TABLE "news_articles_blocks_pdf" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "media_id" uuid,
    "title" varchar,
    "usage" "enum_news_articles_blocks_pdf_usage",
    "layout" "enum_news_articles_blocks_pdf_layout",
    "block_name" varchar
  );

  CREATE TABLE "news_articles_blocks_video" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "media_id" uuid,
    "url" varchar,
    "title" varchar,
    "layout" "enum_news_articles_blocks_video_layout",
    "block_name" varchar
  );

  CREATE TABLE "news_articles" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "title" varchar DEFAULT '',
    "category" varchar DEFAULT '',
    "editorial" jsonb DEFAULT '{"version":1,"kind":"article","summary":"","author":"","source_label":"","source_date":null}'::jsonb,
    "published_at" timestamp(3) with time zone,
    "publication_generation" numeric DEFAULT 0,
    "legacy_document_id" varchar,
    "legacy_source_id" varchar,
    "legacy_revision_id" varchar,
    "imported_at" timestamp(3) with time zone,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "_status" "enum_news_articles_status" DEFAULT 'draft'
  );

  CREATE TABLE "_news_articles_v_blocks_rich_text" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "content" jsonb,
    "layout" "enum__news_articles_v_blocks_rich_text_layout",
    "typography" "enum__news_articles_v_blocks_rich_text_typography",
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "_news_articles_v_blocks_heading" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "text" varchar,
    "level" numeric DEFAULT 2,
    "layout" "enum__news_articles_v_blocks_heading_layout",
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "_news_articles_v_blocks_paragraph" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "text" varchar,
    "layout" "enum__news_articles_v_blocks_paragraph_layout",
    "typography" "enum__news_articles_v_blocks_paragraph_typography",
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "_news_articles_v_blocks_list_items" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "text" varchar,
    "_uuid" varchar
  );

  CREATE TABLE "_news_articles_v_blocks_list" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "ordered" boolean DEFAULT false,
    "layout" "enum__news_articles_v_blocks_list_layout",
    "typography" "enum__news_articles_v_blocks_list_typography",
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "_news_articles_v_blocks_image" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "media_id" uuid,
    "alt" varchar,
    "caption" varchar,
    "credit" varchar,
    "usage" "enum__news_articles_v_blocks_image_usage",
    "layout" "enum__news_articles_v_blocks_image_layout",
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "_news_articles_v_blocks_callout" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "tone" "enum__news_articles_v_blocks_callout_tone" DEFAULT 'info',
    "title" varchar,
    "text" varchar,
    "layout" "enum__news_articles_v_blocks_callout_layout",
    "typography" "enum__news_articles_v_blocks_callout_typography",
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "_news_articles_v_blocks_quote" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "text" varchar,
    "attribution" varchar,
    "layout" "enum__news_articles_v_blocks_quote_layout",
    "typography" "enum__news_articles_v_blocks_quote_typography",
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "_news_articles_v_blocks_profile" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" varchar,
    "role" varchar,
    "text" varchar,
    "media_id" uuid,
    "alt" varchar,
    "layout" "enum__news_articles_v_blocks_profile_layout",
    "typography" "enum__news_articles_v_blocks_profile_typography",
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "_news_articles_v_blocks_divider" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "layout" "enum__news_articles_v_blocks_divider_layout",
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "_news_articles_v_blocks_link" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "label" varchar,
    "url" varchar,
    "new_tab" boolean DEFAULT false,
    "layout" "enum__news_articles_v_blocks_link_layout",
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "_news_articles_v_blocks_pdf" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "media_id" uuid,
    "title" varchar,
    "usage" "enum__news_articles_v_blocks_pdf_usage",
    "layout" "enum__news_articles_v_blocks_pdf_layout",
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "_news_articles_v_blocks_video" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "_path" text NOT NULL,
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "media_id" uuid,
    "url" varchar,
    "title" varchar,
    "layout" "enum__news_articles_v_blocks_video_layout",
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "_news_articles_v" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "parent_id" uuid,
    "version_title" varchar DEFAULT '',
    "version_category" varchar DEFAULT '',
    "version_editorial" jsonb DEFAULT '{"version":1,"kind":"article","summary":"","author":"","source_label":"","source_date":null}'::jsonb,
    "version_published_at" timestamp(3) with time zone,
    "version_publication_generation" numeric DEFAULT 0,
    "version_legacy_document_id" varchar,
    "version_legacy_source_id" varchar,
    "version_legacy_revision_id" varchar,
    "version_imported_at" timestamp(3) with time zone,
    "version_updated_at" timestamp(3) with time zone,
    "version_created_at" timestamp(3) with time zone,
    "version__status" "enum__news_articles_v_version_status" DEFAULT 'draft',
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "latest" boolean,
    "autosave" boolean
  );

  CREATE TABLE "news_media" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "sha256" varchar,
    "legacy_asset_id" varchar,
    "imported_at" timestamp(3) with time zone,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "url" varchar,
    "thumbnail_u_r_l" varchar,
    "filename" varchar,
    "mime_type" varchar,
    "filesize" numeric,
    "width" numeric,
    "height" numeric
  );

  CREATE TABLE "payload_kv" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "key" varchar NOT NULL,
    "data" jsonb NOT NULL
  );

  CREATE TABLE "payload_locked_documents" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "global_slug" varchar,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "payload_locked_documents_rels" (
    "id" serial PRIMARY KEY NOT NULL,
    "order" integer,
    "parent_id" uuid NOT NULL,
    "path" varchar NOT NULL,
    "portal_editors_id" uuid,
    "news_articles_id" uuid,
    "news_media_id" uuid
  );

  CREATE TABLE "payload_preferences" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "key" varchar,
    "value" jsonb,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "payload_preferences_rels" (
    "id" serial PRIMARY KEY NOT NULL,
    "order" integer,
    "parent_id" uuid NOT NULL,
    "path" varchar NOT NULL,
    "portal_editors_id" uuid
  );

  CREATE TABLE "payload_migrations" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" varchar,
    "batch" numeric,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "news_home" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "eyebrow" varchar DEFAULT '',
    "headline" varchar DEFAULT '',
    "summary" varchar DEFAULT '',
    "published_at" timestamp(3) with time zone,
    "publication_generation" numeric DEFAULT 0,
    "legacy_document_id" varchar,
    "legacy_source_id" varchar,
    "legacy_revision_id" varchar,
    "imported_at" timestamp(3) with time zone,
    "_status" "enum_news_home_status" DEFAULT 'draft',
    "updated_at" timestamp(3) with time zone,
    "created_at" timestamp(3) with time zone
  );

  CREATE TABLE "_news_home_v" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "version_eyebrow" varchar DEFAULT '',
    "version_headline" varchar DEFAULT '',
    "version_summary" varchar DEFAULT '',
    "version_published_at" timestamp(3) with time zone,
    "version_publication_generation" numeric DEFAULT 0,
    "version_legacy_document_id" varchar,
    "version_legacy_source_id" varchar,
    "version_legacy_revision_id" varchar,
    "version_imported_at" timestamp(3) with time zone,
    "version__status" "enum__news_home_v_version_status" DEFAULT 'draft',
    "version_updated_at" timestamp(3) with time zone,
    "version_created_at" timestamp(3) with time zone,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "latest" boolean,
    "autosave" boolean
  );

  ALTER TABLE "news_articles_blocks_rich_text" ADD CONSTRAINT "news_articles_blocks_rich_text_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_heading" ADD CONSTRAINT "news_articles_blocks_heading_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_paragraph" ADD CONSTRAINT "news_articles_blocks_paragraph_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_list_items" ADD CONSTRAINT "news_articles_blocks_list_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."news_articles_blocks_list"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_list" ADD CONSTRAINT "news_articles_blocks_list_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_image" ADD CONSTRAINT "news_articles_blocks_image_media_id_news_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."news_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_image" ADD CONSTRAINT "news_articles_blocks_image_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_callout" ADD CONSTRAINT "news_articles_blocks_callout_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_quote" ADD CONSTRAINT "news_articles_blocks_quote_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_profile" ADD CONSTRAINT "news_articles_blocks_profile_media_id_news_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."news_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_profile" ADD CONSTRAINT "news_articles_blocks_profile_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_divider" ADD CONSTRAINT "news_articles_blocks_divider_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_link" ADD CONSTRAINT "news_articles_blocks_link_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_pdf" ADD CONSTRAINT "news_articles_blocks_pdf_media_id_news_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."news_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_pdf" ADD CONSTRAINT "news_articles_blocks_pdf_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_video" ADD CONSTRAINT "news_articles_blocks_video_media_id_news_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."news_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "news_articles_blocks_video" ADD CONSTRAINT "news_articles_blocks_video_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_rich_text" ADD CONSTRAINT "_news_articles_v_blocks_rich_text_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_news_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_heading" ADD CONSTRAINT "_news_articles_v_blocks_heading_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_news_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_paragraph" ADD CONSTRAINT "_news_articles_v_blocks_paragraph_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_news_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_list_items" ADD CONSTRAINT "_news_articles_v_blocks_list_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_news_articles_v_blocks_list"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_list" ADD CONSTRAINT "_news_articles_v_blocks_list_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_news_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_image" ADD CONSTRAINT "_news_articles_v_blocks_image_media_id_news_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."news_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_image" ADD CONSTRAINT "_news_articles_v_blocks_image_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_news_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_callout" ADD CONSTRAINT "_news_articles_v_blocks_callout_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_news_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_quote" ADD CONSTRAINT "_news_articles_v_blocks_quote_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_news_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_profile" ADD CONSTRAINT "_news_articles_v_blocks_profile_media_id_news_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."news_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_profile" ADD CONSTRAINT "_news_articles_v_blocks_profile_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_news_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_divider" ADD CONSTRAINT "_news_articles_v_blocks_divider_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_news_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_link" ADD CONSTRAINT "_news_articles_v_blocks_link_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_news_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_pdf" ADD CONSTRAINT "_news_articles_v_blocks_pdf_media_id_news_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."news_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_pdf" ADD CONSTRAINT "_news_articles_v_blocks_pdf_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_news_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_video" ADD CONSTRAINT "_news_articles_v_blocks_video_media_id_news_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."news_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_news_articles_v_blocks_video" ADD CONSTRAINT "_news_articles_v_blocks_video_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_news_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_news_articles_v" ADD CONSTRAINT "_news_articles_v_parent_id_news_articles_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."news_articles"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_locked_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_portal_editors_fk" FOREIGN KEY ("portal_editors_id") REFERENCES "public"."portal_editors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_news_articles_fk" FOREIGN KEY ("news_articles_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_news_media_fk" FOREIGN KEY ("news_media_id") REFERENCES "public"."news_media"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_portal_editors_fk" FOREIGN KEY ("portal_editors_id") REFERENCES "public"."portal_editors"("id") ON DELETE cascade ON UPDATE no action;
  CREATE UNIQUE INDEX "portal_editors_portal_uid_idx" ON "portal_editors" USING btree ("portal_uid");
  CREATE INDEX "portal_editors_updated_at_idx" ON "portal_editors" USING btree ("updated_at");
  CREATE INDEX "portal_editors_created_at_idx" ON "portal_editors" USING btree ("created_at");
  CREATE INDEX "news_articles_blocks_rich_text_order_idx" ON "news_articles_blocks_rich_text" USING btree ("_order");
  CREATE INDEX "news_articles_blocks_rich_text_parent_id_idx" ON "news_articles_blocks_rich_text" USING btree ("_parent_id");
  CREATE INDEX "news_articles_blocks_rich_text_path_idx" ON "news_articles_blocks_rich_text" USING btree ("_path");
  CREATE INDEX "news_articles_blocks_heading_order_idx" ON "news_articles_blocks_heading" USING btree ("_order");
  CREATE INDEX "news_articles_blocks_heading_parent_id_idx" ON "news_articles_blocks_heading" USING btree ("_parent_id");
  CREATE INDEX "news_articles_blocks_heading_path_idx" ON "news_articles_blocks_heading" USING btree ("_path");
  CREATE INDEX "news_articles_blocks_paragraph_order_idx" ON "news_articles_blocks_paragraph" USING btree ("_order");
  CREATE INDEX "news_articles_blocks_paragraph_parent_id_idx" ON "news_articles_blocks_paragraph" USING btree ("_parent_id");
  CREATE INDEX "news_articles_blocks_paragraph_path_idx" ON "news_articles_blocks_paragraph" USING btree ("_path");
  CREATE INDEX "news_articles_blocks_list_items_order_idx" ON "news_articles_blocks_list_items" USING btree ("_order");
  CREATE INDEX "news_articles_blocks_list_items_parent_id_idx" ON "news_articles_blocks_list_items" USING btree ("_parent_id");
  CREATE INDEX "news_articles_blocks_list_order_idx" ON "news_articles_blocks_list" USING btree ("_order");
  CREATE INDEX "news_articles_blocks_list_parent_id_idx" ON "news_articles_blocks_list" USING btree ("_parent_id");
  CREATE INDEX "news_articles_blocks_list_path_idx" ON "news_articles_blocks_list" USING btree ("_path");
  CREATE INDEX "news_articles_blocks_image_order_idx" ON "news_articles_blocks_image" USING btree ("_order");
  CREATE INDEX "news_articles_blocks_image_parent_id_idx" ON "news_articles_blocks_image" USING btree ("_parent_id");
  CREATE INDEX "news_articles_blocks_image_path_idx" ON "news_articles_blocks_image" USING btree ("_path");
  CREATE INDEX "news_articles_blocks_image_media_idx" ON "news_articles_blocks_image" USING btree ("media_id");
  CREATE INDEX "news_articles_blocks_callout_order_idx" ON "news_articles_blocks_callout" USING btree ("_order");
  CREATE INDEX "news_articles_blocks_callout_parent_id_idx" ON "news_articles_blocks_callout" USING btree ("_parent_id");
  CREATE INDEX "news_articles_blocks_callout_path_idx" ON "news_articles_blocks_callout" USING btree ("_path");
  CREATE INDEX "news_articles_blocks_quote_order_idx" ON "news_articles_blocks_quote" USING btree ("_order");
  CREATE INDEX "news_articles_blocks_quote_parent_id_idx" ON "news_articles_blocks_quote" USING btree ("_parent_id");
  CREATE INDEX "news_articles_blocks_quote_path_idx" ON "news_articles_blocks_quote" USING btree ("_path");
  CREATE INDEX "news_articles_blocks_profile_order_idx" ON "news_articles_blocks_profile" USING btree ("_order");
  CREATE INDEX "news_articles_blocks_profile_parent_id_idx" ON "news_articles_blocks_profile" USING btree ("_parent_id");
  CREATE INDEX "news_articles_blocks_profile_path_idx" ON "news_articles_blocks_profile" USING btree ("_path");
  CREATE INDEX "news_articles_blocks_profile_media_idx" ON "news_articles_blocks_profile" USING btree ("media_id");
  CREATE INDEX "news_articles_blocks_divider_order_idx" ON "news_articles_blocks_divider" USING btree ("_order");
  CREATE INDEX "news_articles_blocks_divider_parent_id_idx" ON "news_articles_blocks_divider" USING btree ("_parent_id");
  CREATE INDEX "news_articles_blocks_divider_path_idx" ON "news_articles_blocks_divider" USING btree ("_path");
  CREATE INDEX "news_articles_blocks_link_order_idx" ON "news_articles_blocks_link" USING btree ("_order");
  CREATE INDEX "news_articles_blocks_link_parent_id_idx" ON "news_articles_blocks_link" USING btree ("_parent_id");
  CREATE INDEX "news_articles_blocks_link_path_idx" ON "news_articles_blocks_link" USING btree ("_path");
  CREATE INDEX "news_articles_blocks_pdf_order_idx" ON "news_articles_blocks_pdf" USING btree ("_order");
  CREATE INDEX "news_articles_blocks_pdf_parent_id_idx" ON "news_articles_blocks_pdf" USING btree ("_parent_id");
  CREATE INDEX "news_articles_blocks_pdf_path_idx" ON "news_articles_blocks_pdf" USING btree ("_path");
  CREATE INDEX "news_articles_blocks_pdf_media_idx" ON "news_articles_blocks_pdf" USING btree ("media_id");
  CREATE INDEX "news_articles_blocks_video_order_idx" ON "news_articles_blocks_video" USING btree ("_order");
  CREATE INDEX "news_articles_blocks_video_parent_id_idx" ON "news_articles_blocks_video" USING btree ("_parent_id");
  CREATE INDEX "news_articles_blocks_video_path_idx" ON "news_articles_blocks_video" USING btree ("_path");
  CREATE INDEX "news_articles_blocks_video_media_idx" ON "news_articles_blocks_video" USING btree ("media_id");
  CREATE INDEX "news_articles_category_idx" ON "news_articles" USING btree ("category");
  CREATE INDEX "news_articles_legacy_document_id_idx" ON "news_articles" USING btree ("legacy_document_id");
  CREATE INDEX "news_articles_updated_at_idx" ON "news_articles" USING btree ("updated_at");
  CREATE INDEX "news_articles_created_at_idx" ON "news_articles" USING btree ("created_at");
  CREATE INDEX "news_articles__status_idx" ON "news_articles" USING btree ("_status");
  CREATE INDEX "_news_articles_v_blocks_rich_text_order_idx" ON "_news_articles_v_blocks_rich_text" USING btree ("_order");
  CREATE INDEX "_news_articles_v_blocks_rich_text_parent_id_idx" ON "_news_articles_v_blocks_rich_text" USING btree ("_parent_id");
  CREATE INDEX "_news_articles_v_blocks_rich_text_path_idx" ON "_news_articles_v_blocks_rich_text" USING btree ("_path");
  CREATE INDEX "_news_articles_v_blocks_heading_order_idx" ON "_news_articles_v_blocks_heading" USING btree ("_order");
  CREATE INDEX "_news_articles_v_blocks_heading_parent_id_idx" ON "_news_articles_v_blocks_heading" USING btree ("_parent_id");
  CREATE INDEX "_news_articles_v_blocks_heading_path_idx" ON "_news_articles_v_blocks_heading" USING btree ("_path");
  CREATE INDEX "_news_articles_v_blocks_paragraph_order_idx" ON "_news_articles_v_blocks_paragraph" USING btree ("_order");
  CREATE INDEX "_news_articles_v_blocks_paragraph_parent_id_idx" ON "_news_articles_v_blocks_paragraph" USING btree ("_parent_id");
  CREATE INDEX "_news_articles_v_blocks_paragraph_path_idx" ON "_news_articles_v_blocks_paragraph" USING btree ("_path");
  CREATE INDEX "_news_articles_v_blocks_list_items_order_idx" ON "_news_articles_v_blocks_list_items" USING btree ("_order");
  CREATE INDEX "_news_articles_v_blocks_list_items_parent_id_idx" ON "_news_articles_v_blocks_list_items" USING btree ("_parent_id");
  CREATE INDEX "_news_articles_v_blocks_list_order_idx" ON "_news_articles_v_blocks_list" USING btree ("_order");
  CREATE INDEX "_news_articles_v_blocks_list_parent_id_idx" ON "_news_articles_v_blocks_list" USING btree ("_parent_id");
  CREATE INDEX "_news_articles_v_blocks_list_path_idx" ON "_news_articles_v_blocks_list" USING btree ("_path");
  CREATE INDEX "_news_articles_v_blocks_image_order_idx" ON "_news_articles_v_blocks_image" USING btree ("_order");
  CREATE INDEX "_news_articles_v_blocks_image_parent_id_idx" ON "_news_articles_v_blocks_image" USING btree ("_parent_id");
  CREATE INDEX "_news_articles_v_blocks_image_path_idx" ON "_news_articles_v_blocks_image" USING btree ("_path");
  CREATE INDEX "_news_articles_v_blocks_image_media_idx" ON "_news_articles_v_blocks_image" USING btree ("media_id");
  CREATE INDEX "_news_articles_v_blocks_callout_order_idx" ON "_news_articles_v_blocks_callout" USING btree ("_order");
  CREATE INDEX "_news_articles_v_blocks_callout_parent_id_idx" ON "_news_articles_v_blocks_callout" USING btree ("_parent_id");
  CREATE INDEX "_news_articles_v_blocks_callout_path_idx" ON "_news_articles_v_blocks_callout" USING btree ("_path");
  CREATE INDEX "_news_articles_v_blocks_quote_order_idx" ON "_news_articles_v_blocks_quote" USING btree ("_order");
  CREATE INDEX "_news_articles_v_blocks_quote_parent_id_idx" ON "_news_articles_v_blocks_quote" USING btree ("_parent_id");
  CREATE INDEX "_news_articles_v_blocks_quote_path_idx" ON "_news_articles_v_blocks_quote" USING btree ("_path");
  CREATE INDEX "_news_articles_v_blocks_profile_order_idx" ON "_news_articles_v_blocks_profile" USING btree ("_order");
  CREATE INDEX "_news_articles_v_blocks_profile_parent_id_idx" ON "_news_articles_v_blocks_profile" USING btree ("_parent_id");
  CREATE INDEX "_news_articles_v_blocks_profile_path_idx" ON "_news_articles_v_blocks_profile" USING btree ("_path");
  CREATE INDEX "_news_articles_v_blocks_profile_media_idx" ON "_news_articles_v_blocks_profile" USING btree ("media_id");
  CREATE INDEX "_news_articles_v_blocks_divider_order_idx" ON "_news_articles_v_blocks_divider" USING btree ("_order");
  CREATE INDEX "_news_articles_v_blocks_divider_parent_id_idx" ON "_news_articles_v_blocks_divider" USING btree ("_parent_id");
  CREATE INDEX "_news_articles_v_blocks_divider_path_idx" ON "_news_articles_v_blocks_divider" USING btree ("_path");
  CREATE INDEX "_news_articles_v_blocks_link_order_idx" ON "_news_articles_v_blocks_link" USING btree ("_order");
  CREATE INDEX "_news_articles_v_blocks_link_parent_id_idx" ON "_news_articles_v_blocks_link" USING btree ("_parent_id");
  CREATE INDEX "_news_articles_v_blocks_link_path_idx" ON "_news_articles_v_blocks_link" USING btree ("_path");
  CREATE INDEX "_news_articles_v_blocks_pdf_order_idx" ON "_news_articles_v_blocks_pdf" USING btree ("_order");
  CREATE INDEX "_news_articles_v_blocks_pdf_parent_id_idx" ON "_news_articles_v_blocks_pdf" USING btree ("_parent_id");
  CREATE INDEX "_news_articles_v_blocks_pdf_path_idx" ON "_news_articles_v_blocks_pdf" USING btree ("_path");
  CREATE INDEX "_news_articles_v_blocks_pdf_media_idx" ON "_news_articles_v_blocks_pdf" USING btree ("media_id");
  CREATE INDEX "_news_articles_v_blocks_video_order_idx" ON "_news_articles_v_blocks_video" USING btree ("_order");
  CREATE INDEX "_news_articles_v_blocks_video_parent_id_idx" ON "_news_articles_v_blocks_video" USING btree ("_parent_id");
  CREATE INDEX "_news_articles_v_blocks_video_path_idx" ON "_news_articles_v_blocks_video" USING btree ("_path");
  CREATE INDEX "_news_articles_v_blocks_video_media_idx" ON "_news_articles_v_blocks_video" USING btree ("media_id");
  CREATE INDEX "_news_articles_v_parent_idx" ON "_news_articles_v" USING btree ("parent_id");
  CREATE INDEX "_news_articles_v_version_version_category_idx" ON "_news_articles_v" USING btree ("version_category");
  CREATE INDEX "_news_articles_v_version_version_legacy_document_id_idx" ON "_news_articles_v" USING btree ("version_legacy_document_id");
  CREATE INDEX "_news_articles_v_version_version_updated_at_idx" ON "_news_articles_v" USING btree ("version_updated_at");
  CREATE INDEX "_news_articles_v_version_version_created_at_idx" ON "_news_articles_v" USING btree ("version_created_at");
  CREATE INDEX "_news_articles_v_version_version__status_idx" ON "_news_articles_v" USING btree ("version__status");
  CREATE INDEX "_news_articles_v_created_at_idx" ON "_news_articles_v" USING btree ("created_at");
  CREATE INDEX "_news_articles_v_updated_at_idx" ON "_news_articles_v" USING btree ("updated_at");
  CREATE INDEX "_news_articles_v_latest_idx" ON "_news_articles_v" USING btree ("latest");
  CREATE INDEX "_news_articles_v_autosave_idx" ON "_news_articles_v" USING btree ("autosave");
  CREATE INDEX "news_media_sha256_idx" ON "news_media" USING btree ("sha256");
  CREATE INDEX "news_media_legacy_asset_id_idx" ON "news_media" USING btree ("legacy_asset_id");
  CREATE INDEX "news_media_updated_at_idx" ON "news_media" USING btree ("updated_at");
  CREATE INDEX "news_media_created_at_idx" ON "news_media" USING btree ("created_at");
  CREATE UNIQUE INDEX "news_media_filename_idx" ON "news_media" USING btree ("filename");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "payload_kv" USING btree ("key");
  CREATE INDEX "payload_locked_documents_global_slug_idx" ON "payload_locked_documents" USING btree ("global_slug");
  CREATE INDEX "payload_locked_documents_updated_at_idx" ON "payload_locked_documents" USING btree ("updated_at");
  CREATE INDEX "payload_locked_documents_created_at_idx" ON "payload_locked_documents" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_order_idx" ON "payload_locked_documents_rels" USING btree ("order");
  CREATE INDEX "payload_locked_documents_rels_parent_idx" ON "payload_locked_documents_rels" USING btree ("parent_id");
  CREATE INDEX "payload_locked_documents_rels_path_idx" ON "payload_locked_documents_rels" USING btree ("path");
  CREATE INDEX "payload_locked_documents_rels_portal_editors_id_idx" ON "payload_locked_documents_rels" USING btree ("portal_editors_id");
  CREATE INDEX "payload_locked_documents_rels_news_articles_id_idx" ON "payload_locked_documents_rels" USING btree ("news_articles_id");
  CREATE INDEX "payload_locked_documents_rels_news_media_id_idx" ON "payload_locked_documents_rels" USING btree ("news_media_id");
  CREATE INDEX "payload_preferences_key_idx" ON "payload_preferences" USING btree ("key");
  CREATE INDEX "payload_preferences_updated_at_idx" ON "payload_preferences" USING btree ("updated_at");
  CREATE INDEX "payload_preferences_created_at_idx" ON "payload_preferences" USING btree ("created_at");
  CREATE INDEX "payload_preferences_rels_order_idx" ON "payload_preferences_rels" USING btree ("order");
  CREATE INDEX "payload_preferences_rels_parent_idx" ON "payload_preferences_rels" USING btree ("parent_id");
  CREATE INDEX "payload_preferences_rels_path_idx" ON "payload_preferences_rels" USING btree ("path");
  CREATE INDEX "payload_preferences_rels_portal_editors_id_idx" ON "payload_preferences_rels" USING btree ("portal_editors_id");
  CREATE INDEX "payload_migrations_updated_at_idx" ON "payload_migrations" USING btree ("updated_at");
  CREATE INDEX "payload_migrations_created_at_idx" ON "payload_migrations" USING btree ("created_at");
  CREATE INDEX "news_home_legacy_document_id_idx" ON "news_home" USING btree ("legacy_document_id");
  CREATE INDEX "news_home__status_idx" ON "news_home" USING btree ("_status");
  CREATE INDEX "_news_home_v_version_version_legacy_document_id_idx" ON "_news_home_v" USING btree ("version_legacy_document_id");
  CREATE INDEX "_news_home_v_version_version__status_idx" ON "_news_home_v" USING btree ("version__status");
  CREATE INDEX "_news_home_v_created_at_idx" ON "_news_home_v" USING btree ("created_at");
  CREATE INDEX "_news_home_v_updated_at_idx" ON "_news_home_v" USING btree ("updated_at");
  CREATE INDEX "_news_home_v_latest_idx" ON "_news_home_v" USING btree ("latest");
  CREATE INDEX "_news_home_v_autosave_idx" ON "_news_home_v" USING btree ("autosave");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "portal_editors" CASCADE;
  DROP TABLE "news_articles_blocks_rich_text" CASCADE;
  DROP TABLE "news_articles_blocks_heading" CASCADE;
  DROP TABLE "news_articles_blocks_paragraph" CASCADE;
  DROP TABLE "news_articles_blocks_list_items" CASCADE;
  DROP TABLE "news_articles_blocks_list" CASCADE;
  DROP TABLE "news_articles_blocks_image" CASCADE;
  DROP TABLE "news_articles_blocks_callout" CASCADE;
  DROP TABLE "news_articles_blocks_quote" CASCADE;
  DROP TABLE "news_articles_blocks_profile" CASCADE;
  DROP TABLE "news_articles_blocks_divider" CASCADE;
  DROP TABLE "news_articles_blocks_link" CASCADE;
  DROP TABLE "news_articles_blocks_pdf" CASCADE;
  DROP TABLE "news_articles_blocks_video" CASCADE;
  DROP TABLE "news_articles" CASCADE;
  DROP TABLE "_news_articles_v_blocks_rich_text" CASCADE;
  DROP TABLE "_news_articles_v_blocks_heading" CASCADE;
  DROP TABLE "_news_articles_v_blocks_paragraph" CASCADE;
  DROP TABLE "_news_articles_v_blocks_list_items" CASCADE;
  DROP TABLE "_news_articles_v_blocks_list" CASCADE;
  DROP TABLE "_news_articles_v_blocks_image" CASCADE;
  DROP TABLE "_news_articles_v_blocks_callout" CASCADE;
  DROP TABLE "_news_articles_v_blocks_quote" CASCADE;
  DROP TABLE "_news_articles_v_blocks_profile" CASCADE;
  DROP TABLE "_news_articles_v_blocks_divider" CASCADE;
  DROP TABLE "_news_articles_v_blocks_link" CASCADE;
  DROP TABLE "_news_articles_v_blocks_pdf" CASCADE;
  DROP TABLE "_news_articles_v_blocks_video" CASCADE;
  DROP TABLE "_news_articles_v" CASCADE;
  DROP TABLE "news_media" CASCADE;
  DROP TABLE "payload_kv" CASCADE;
  DROP TABLE "payload_locked_documents" CASCADE;
  DROP TABLE "payload_locked_documents_rels" CASCADE;
  DROP TABLE "payload_preferences" CASCADE;
  DROP TABLE "payload_preferences_rels" CASCADE;
  DROP TABLE "payload_migrations" CASCADE;
  DROP TABLE "news_home" CASCADE;
  DROP TABLE "_news_home_v" CASCADE;
  DROP TYPE "public"."enum_news_articles_blocks_rich_text_layout";
  DROP TYPE "public"."enum_news_articles_blocks_rich_text_typography";
  DROP TYPE "public"."enum_news_articles_blocks_heading_layout";
  DROP TYPE "public"."enum_news_articles_blocks_paragraph_layout";
  DROP TYPE "public"."enum_news_articles_blocks_paragraph_typography";
  DROP TYPE "public"."enum_news_articles_blocks_list_layout";
  DROP TYPE "public"."enum_news_articles_blocks_list_typography";
  DROP TYPE "public"."enum_news_articles_blocks_image_usage";
  DROP TYPE "public"."enum_news_articles_blocks_image_layout";
  DROP TYPE "public"."enum_news_articles_blocks_callout_tone";
  DROP TYPE "public"."enum_news_articles_blocks_callout_layout";
  DROP TYPE "public"."enum_news_articles_blocks_callout_typography";
  DROP TYPE "public"."enum_news_articles_blocks_quote_layout";
  DROP TYPE "public"."enum_news_articles_blocks_quote_typography";
  DROP TYPE "public"."enum_news_articles_blocks_profile_layout";
  DROP TYPE "public"."enum_news_articles_blocks_profile_typography";
  DROP TYPE "public"."enum_news_articles_blocks_divider_layout";
  DROP TYPE "public"."enum_news_articles_blocks_link_layout";
  DROP TYPE "public"."enum_news_articles_blocks_pdf_usage";
  DROP TYPE "public"."enum_news_articles_blocks_pdf_layout";
  DROP TYPE "public"."enum_news_articles_blocks_video_layout";
  DROP TYPE "public"."enum_news_articles_status";
  DROP TYPE "public"."enum__news_articles_v_blocks_rich_text_layout";
  DROP TYPE "public"."enum__news_articles_v_blocks_rich_text_typography";
  DROP TYPE "public"."enum__news_articles_v_blocks_heading_layout";
  DROP TYPE "public"."enum__news_articles_v_blocks_paragraph_layout";
  DROP TYPE "public"."enum__news_articles_v_blocks_paragraph_typography";
  DROP TYPE "public"."enum__news_articles_v_blocks_list_layout";
  DROP TYPE "public"."enum__news_articles_v_blocks_list_typography";
  DROP TYPE "public"."enum__news_articles_v_blocks_image_usage";
  DROP TYPE "public"."enum__news_articles_v_blocks_image_layout";
  DROP TYPE "public"."enum__news_articles_v_blocks_callout_tone";
  DROP TYPE "public"."enum__news_articles_v_blocks_callout_layout";
  DROP TYPE "public"."enum__news_articles_v_blocks_callout_typography";
  DROP TYPE "public"."enum__news_articles_v_blocks_quote_layout";
  DROP TYPE "public"."enum__news_articles_v_blocks_quote_typography";
  DROP TYPE "public"."enum__news_articles_v_blocks_profile_layout";
  DROP TYPE "public"."enum__news_articles_v_blocks_profile_typography";
  DROP TYPE "public"."enum__news_articles_v_blocks_divider_layout";
  DROP TYPE "public"."enum__news_articles_v_blocks_link_layout";
  DROP TYPE "public"."enum__news_articles_v_blocks_pdf_usage";
  DROP TYPE "public"."enum__news_articles_v_blocks_pdf_layout";
  DROP TYPE "public"."enum__news_articles_v_blocks_video_layout";
  DROP TYPE "public"."enum__news_articles_v_version_status";
  DROP TYPE "public"."enum_news_home_status";
  DROP TYPE "public"."enum__news_home_v_version_status";`)
}
