import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_portal_page_media_mime_type" AS ENUM('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm');
  CREATE TYPE "public"."enum_portal_page_media_state" AS ENUM('uploading', 'complete');
  CREATE TYPE "public"."enum_portal_pages_blocks_heading_level" AS ENUM('2', '3', '4');
  CREATE TYPE "public"."enum_portal_pages_blocks_heading_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_portal_pages_blocks_rich_text_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_portal_pages_blocks_image_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_portal_pages_blocks_gallery_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_portal_pages_blocks_video_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_portal_pages_blocks_embed_provider" AS ENUM('youtube', 'vimeo');
  CREATE TYPE "public"."enum_portal_pages_blocks_embed_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_portal_pages_blocks_pdf_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_portal_pages_blocks_callout_tone" AS ENUM('info', 'warning', 'success');
  CREATE TYPE "public"."enum_portal_pages_blocks_callout_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_portal_pages_blocks_link_style" AS ENUM('primary', 'secondary');
  CREATE TYPE "public"."enum_portal_pages_blocks_link_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_portal_pages_blocks_divider_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum_portal_pages_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_heading_level" AS ENUM('2', '3', '4');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_heading_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_rich_text_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_image_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_gallery_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_video_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_embed_provider" AS ENUM('youtube', 'vimeo');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_embed_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_pdf_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_callout_tone" AS ENUM('info', 'warning', 'success');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_callout_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_link_style" AS ENUM('primary', 'secondary');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_link_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__portal_pages_v_blocks_divider_layout" AS ENUM('content', 'wide', 'full', 'left', 'right');
  CREATE TYPE "public"."enum__portal_pages_v_version_status" AS ENUM('draft', 'published');
  CREATE TABLE "portal_page_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar NOT NULL,
	"slug" varchar NOT NULL,
	"description" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "portal_page_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_name" varchar NOT NULL,
	"storage_key" varchar NOT NULL,
	"mime_type" "enum_portal_page_media_mime_type" NOT NULL,
	"filesize" numeric NOT NULL,
	"sha256" varchar NOT NULL,
	"state" "enum_portal_page_media_state" NOT NULL,
	"uploaded_by" varchar NOT NULL,
	"completed_at" timestamp(3) with time zone,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "portal_pages_blocks_heading" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"text" varchar,
	"level" "enum_portal_pages_blocks_heading_level" DEFAULT '2',
	"layout" "enum_portal_pages_blocks_heading_layout",
	"block_name" varchar
  );

  CREATE TABLE "portal_pages_blocks_rich_text" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"content" jsonb,
	"layout" "enum_portal_pages_blocks_rich_text_layout",
	"block_name" varchar
  );

  CREATE TABLE "portal_pages_blocks_image" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"asset_id" uuid,
	"alt" varchar,
	"caption" varchar,
	"layout" "enum_portal_pages_blocks_image_layout",
	"block_name" varchar
  );

  CREATE TABLE "portal_pages_blocks_gallery_images" (
	"_order" integer NOT NULL,
	"_parent_id" varchar NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"asset_id" uuid,
	"alt" varchar,
	"caption" varchar
  );

  CREATE TABLE "portal_pages_blocks_gallery" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"layout" "enum_portal_pages_blocks_gallery_layout",
	"block_name" varchar
  );

  CREATE TABLE "portal_pages_blocks_video" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"asset_id" uuid,
	"title" varchar,
	"layout" "enum_portal_pages_blocks_video_layout",
	"block_name" varchar
  );

  CREATE TABLE "portal_pages_blocks_embed" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"provider" "enum_portal_pages_blocks_embed_provider",
	"url" varchar,
	"title" varchar,
	"layout" "enum_portal_pages_blocks_embed_layout",
	"block_name" varchar
  );

  CREATE TABLE "portal_pages_blocks_pdf" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"asset_id" uuid,
	"title" varchar,
	"layout" "enum_portal_pages_blocks_pdf_layout",
	"block_name" varchar
  );

  CREATE TABLE "portal_pages_blocks_callout" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"tone" "enum_portal_pages_blocks_callout_tone" DEFAULT 'info',
	"title" varchar,
	"text" varchar,
	"layout" "enum_portal_pages_blocks_callout_layout",
	"block_name" varchar
  );

  CREATE TABLE "portal_pages_blocks_link" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"label" varchar,
	"url" varchar,
	"new_tab" boolean DEFAULT false,
	"style" "enum_portal_pages_blocks_link_style" DEFAULT 'primary',
	"layout" "enum_portal_pages_blocks_link_layout",
	"block_name" varchar
  );

  CREATE TABLE "portal_pages_blocks_divider" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"layout" "enum_portal_pages_blocks_divider_layout",
	"block_name" varchar
  );

  CREATE TABLE "portal_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar,
	"slug" varchar,
	"summary" varchar,
	"cover_id" uuid,
	"cover_alt" varchar,
	"published_at" timestamp(3) with time zone,
	"created_by" varchar,
	"updated_by" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"_status" "enum_portal_pages_status" DEFAULT 'draft'
  );

  CREATE TABLE "portal_pages_rels" (
	"id" serial PRIMARY KEY NOT NULL,
	"order" integer,
	"parent_id" uuid NOT NULL,
	"path" varchar NOT NULL,
	"portal_page_categories_id" uuid
  );

  CREATE TABLE "_portal_pages_v_blocks_heading" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" varchar,
	"level" "enum__portal_pages_v_blocks_heading_level" DEFAULT '2',
	"layout" "enum__portal_pages_v_blocks_heading_layout",
	"_uuid" varchar,
	"block_name" varchar
  );

  CREATE TABLE "_portal_pages_v_blocks_rich_text" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" jsonb,
	"layout" "enum__portal_pages_v_blocks_rich_text_layout",
	"_uuid" varchar,
	"block_name" varchar
  );

  CREATE TABLE "_portal_pages_v_blocks_image" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid,
	"alt" varchar,
	"caption" varchar,
	"layout" "enum__portal_pages_v_blocks_image_layout",
	"_uuid" varchar,
	"block_name" varchar
  );

  CREATE TABLE "_portal_pages_v_blocks_gallery_images" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid,
	"alt" varchar,
	"caption" varchar,
	"_uuid" varchar
  );

  CREATE TABLE "_portal_pages_v_blocks_gallery" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"layout" "enum__portal_pages_v_blocks_gallery_layout",
	"_uuid" varchar,
	"block_name" varchar
  );

  CREATE TABLE "_portal_pages_v_blocks_video" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid,
	"title" varchar,
	"layout" "enum__portal_pages_v_blocks_video_layout",
	"_uuid" varchar,
	"block_name" varchar
  );

  CREATE TABLE "_portal_pages_v_blocks_embed" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "enum__portal_pages_v_blocks_embed_provider",
	"url" varchar,
	"title" varchar,
	"layout" "enum__portal_pages_v_blocks_embed_layout",
	"_uuid" varchar,
	"block_name" varchar
  );

  CREATE TABLE "_portal_pages_v_blocks_pdf" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid,
	"title" varchar,
	"layout" "enum__portal_pages_v_blocks_pdf_layout",
	"_uuid" varchar,
	"block_name" varchar
  );

  CREATE TABLE "_portal_pages_v_blocks_callout" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tone" "enum__portal_pages_v_blocks_callout_tone" DEFAULT 'info',
	"title" varchar,
	"text" varchar,
	"layout" "enum__portal_pages_v_blocks_callout_layout",
	"_uuid" varchar,
	"block_name" varchar
  );

  CREATE TABLE "_portal_pages_v_blocks_link" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" varchar,
	"url" varchar,
	"new_tab" boolean DEFAULT false,
	"style" "enum__portal_pages_v_blocks_link_style" DEFAULT 'primary',
	"layout" "enum__portal_pages_v_blocks_link_layout",
	"_uuid" varchar,
	"block_name" varchar
  );

  CREATE TABLE "_portal_pages_v_blocks_divider" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"_path" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"layout" "enum__portal_pages_v_blocks_divider_layout",
	"_uuid" varchar,
	"block_name" varchar
  );

  CREATE TABLE "_portal_pages_v" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"version_title" varchar,
	"version_slug" varchar,
	"version_summary" varchar,
	"version_cover_id" uuid,
	"version_cover_alt" varchar,
	"version_published_at" timestamp(3) with time zone,
	"version_created_by" varchar,
	"version_updated_by" varchar,
	"version_updated_at" timestamp(3) with time zone,
	"version_created_at" timestamp(3) with time zone,
	"version__status" "enum__portal_pages_v_version_status" DEFAULT 'draft',
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"latest" boolean,
	"autosave" boolean
  );

  CREATE TABLE "_portal_pages_v_rels" (
	"id" serial PRIMARY KEY NOT NULL,
	"order" integer,
	"parent_id" uuid NOT NULL,
	"path" varchar NOT NULL,
	"portal_page_categories_id" uuid
  );

  ALTER TABLE "portal_pages_blocks_heading" ADD CONSTRAINT "portal_pages_blocks_heading_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."portal_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_rich_text" ADD CONSTRAINT "portal_pages_blocks_rich_text_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."portal_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_image" ADD CONSTRAINT "portal_pages_blocks_image_asset_id_portal_page_media_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."portal_page_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_image" ADD CONSTRAINT "portal_pages_blocks_image_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."portal_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_gallery_images" ADD CONSTRAINT "portal_pages_blocks_gallery_images_asset_id_portal_page_media_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."portal_page_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_gallery_images" ADD CONSTRAINT "portal_pages_blocks_gallery_images_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."portal_pages_blocks_gallery"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_gallery" ADD CONSTRAINT "portal_pages_blocks_gallery_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."portal_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_video" ADD CONSTRAINT "portal_pages_blocks_video_asset_id_portal_page_media_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."portal_page_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_video" ADD CONSTRAINT "portal_pages_blocks_video_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."portal_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_embed" ADD CONSTRAINT "portal_pages_blocks_embed_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."portal_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_pdf" ADD CONSTRAINT "portal_pages_blocks_pdf_asset_id_portal_page_media_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."portal_page_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_pdf" ADD CONSTRAINT "portal_pages_blocks_pdf_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."portal_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_callout" ADD CONSTRAINT "portal_pages_blocks_callout_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."portal_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_link" ADD CONSTRAINT "portal_pages_blocks_link_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."portal_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "portal_pages_blocks_divider" ADD CONSTRAINT "portal_pages_blocks_divider_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."portal_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "portal_pages" ADD CONSTRAINT "portal_pages_cover_id_portal_page_media_id_fk" FOREIGN KEY ("cover_id") REFERENCES "public"."portal_page_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "portal_pages_rels" ADD CONSTRAINT "portal_pages_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."portal_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "portal_pages_rels" ADD CONSTRAINT "portal_pages_rels_portal_page_categories_fk" FOREIGN KEY ("portal_page_categories_id") REFERENCES "public"."portal_page_categories"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_heading" ADD CONSTRAINT "_portal_pages_v_blocks_heading_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_portal_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_rich_text" ADD CONSTRAINT "_portal_pages_v_blocks_rich_text_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_portal_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_image" ADD CONSTRAINT "_portal_pages_v_blocks_image_asset_id_portal_page_media_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."portal_page_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_image" ADD CONSTRAINT "_portal_pages_v_blocks_image_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_portal_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_gallery_images" ADD CONSTRAINT "_portal_pages_v_blocks_gallery_images_asset_id_portal_page_media_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."portal_page_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_gallery_images" ADD CONSTRAINT "_portal_pages_v_blocks_gallery_images_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_portal_pages_v_blocks_gallery"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_gallery" ADD CONSTRAINT "_portal_pages_v_blocks_gallery_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_portal_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_video" ADD CONSTRAINT "_portal_pages_v_blocks_video_asset_id_portal_page_media_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."portal_page_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_video" ADD CONSTRAINT "_portal_pages_v_blocks_video_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_portal_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_embed" ADD CONSTRAINT "_portal_pages_v_blocks_embed_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_portal_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_pdf" ADD CONSTRAINT "_portal_pages_v_blocks_pdf_asset_id_portal_page_media_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."portal_page_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_pdf" ADD CONSTRAINT "_portal_pages_v_blocks_pdf_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_portal_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_callout" ADD CONSTRAINT "_portal_pages_v_blocks_callout_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_portal_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_link" ADD CONSTRAINT "_portal_pages_v_blocks_link_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_portal_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_blocks_divider" ADD CONSTRAINT "_portal_pages_v_blocks_divider_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_portal_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_portal_pages_v" ADD CONSTRAINT "_portal_pages_v_parent_id_portal_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."portal_pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_portal_pages_v" ADD CONSTRAINT "_portal_pages_v_version_cover_id_portal_page_media_id_fk" FOREIGN KEY ("version_cover_id") REFERENCES "public"."portal_page_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_rels" ADD CONSTRAINT "_portal_pages_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."_portal_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_portal_pages_v_rels" ADD CONSTRAINT "_portal_pages_v_rels_portal_page_categories_fk" FOREIGN KEY ("portal_page_categories_id") REFERENCES "public"."portal_page_categories"("id") ON DELETE cascade ON UPDATE no action;
  CREATE UNIQUE INDEX "portal_page_categories_slug_idx" ON "portal_page_categories" USING btree ("slug");
  CREATE INDEX "portal_page_categories_updated_at_idx" ON "portal_page_categories" USING btree ("updated_at");
  CREATE INDEX "portal_page_categories_created_at_idx" ON "portal_page_categories" USING btree ("created_at");
  CREATE UNIQUE INDEX "portal_page_media_storage_key_idx" ON "portal_page_media" USING btree ("storage_key");
  CREATE INDEX "portal_page_media_updated_at_idx" ON "portal_page_media" USING btree ("updated_at");
  CREATE INDEX "portal_page_media_created_at_idx" ON "portal_page_media" USING btree ("created_at");
  CREATE INDEX "portal_pages_blocks_heading_order_idx" ON "portal_pages_blocks_heading" USING btree ("_order");
  CREATE INDEX "portal_pages_blocks_heading_parent_id_idx" ON "portal_pages_blocks_heading" USING btree ("_parent_id");
  CREATE INDEX "portal_pages_blocks_heading_path_idx" ON "portal_pages_blocks_heading" USING btree ("_path");
  CREATE INDEX "portal_pages_blocks_rich_text_order_idx" ON "portal_pages_blocks_rich_text" USING btree ("_order");
  CREATE INDEX "portal_pages_blocks_rich_text_parent_id_idx" ON "portal_pages_blocks_rich_text" USING btree ("_parent_id");
  CREATE INDEX "portal_pages_blocks_rich_text_path_idx" ON "portal_pages_blocks_rich_text" USING btree ("_path");
  CREATE INDEX "portal_pages_blocks_image_order_idx" ON "portal_pages_blocks_image" USING btree ("_order");
  CREATE INDEX "portal_pages_blocks_image_parent_id_idx" ON "portal_pages_blocks_image" USING btree ("_parent_id");
  CREATE INDEX "portal_pages_blocks_image_path_idx" ON "portal_pages_blocks_image" USING btree ("_path");
  CREATE INDEX "portal_pages_blocks_image_asset_idx" ON "portal_pages_blocks_image" USING btree ("asset_id");
  CREATE INDEX "portal_pages_blocks_gallery_images_order_idx" ON "portal_pages_blocks_gallery_images" USING btree ("_order");
  CREATE INDEX "portal_pages_blocks_gallery_images_parent_id_idx" ON "portal_pages_blocks_gallery_images" USING btree ("_parent_id");
  CREATE INDEX "portal_pages_blocks_gallery_images_asset_idx" ON "portal_pages_blocks_gallery_images" USING btree ("asset_id");
  CREATE INDEX "portal_pages_blocks_gallery_order_idx" ON "portal_pages_blocks_gallery" USING btree ("_order");
  CREATE INDEX "portal_pages_blocks_gallery_parent_id_idx" ON "portal_pages_blocks_gallery" USING btree ("_parent_id");
  CREATE INDEX "portal_pages_blocks_gallery_path_idx" ON "portal_pages_blocks_gallery" USING btree ("_path");
  CREATE INDEX "portal_pages_blocks_video_order_idx" ON "portal_pages_blocks_video" USING btree ("_order");
  CREATE INDEX "portal_pages_blocks_video_parent_id_idx" ON "portal_pages_blocks_video" USING btree ("_parent_id");
  CREATE INDEX "portal_pages_blocks_video_path_idx" ON "portal_pages_blocks_video" USING btree ("_path");
  CREATE INDEX "portal_pages_blocks_video_asset_idx" ON "portal_pages_blocks_video" USING btree ("asset_id");
  CREATE INDEX "portal_pages_blocks_embed_order_idx" ON "portal_pages_blocks_embed" USING btree ("_order");
  CREATE INDEX "portal_pages_blocks_embed_parent_id_idx" ON "portal_pages_blocks_embed" USING btree ("_parent_id");
  CREATE INDEX "portal_pages_blocks_embed_path_idx" ON "portal_pages_blocks_embed" USING btree ("_path");
  CREATE INDEX "portal_pages_blocks_pdf_order_idx" ON "portal_pages_blocks_pdf" USING btree ("_order");
  CREATE INDEX "portal_pages_blocks_pdf_parent_id_idx" ON "portal_pages_blocks_pdf" USING btree ("_parent_id");
  CREATE INDEX "portal_pages_blocks_pdf_path_idx" ON "portal_pages_blocks_pdf" USING btree ("_path");
  CREATE INDEX "portal_pages_blocks_pdf_asset_idx" ON "portal_pages_blocks_pdf" USING btree ("asset_id");
  CREATE INDEX "portal_pages_blocks_callout_order_idx" ON "portal_pages_blocks_callout" USING btree ("_order");
  CREATE INDEX "portal_pages_blocks_callout_parent_id_idx" ON "portal_pages_blocks_callout" USING btree ("_parent_id");
  CREATE INDEX "portal_pages_blocks_callout_path_idx" ON "portal_pages_blocks_callout" USING btree ("_path");
  CREATE INDEX "portal_pages_blocks_link_order_idx" ON "portal_pages_blocks_link" USING btree ("_order");
  CREATE INDEX "portal_pages_blocks_link_parent_id_idx" ON "portal_pages_blocks_link" USING btree ("_parent_id");
  CREATE INDEX "portal_pages_blocks_link_path_idx" ON "portal_pages_blocks_link" USING btree ("_path");
  CREATE INDEX "portal_pages_blocks_divider_order_idx" ON "portal_pages_blocks_divider" USING btree ("_order");
  CREATE INDEX "portal_pages_blocks_divider_parent_id_idx" ON "portal_pages_blocks_divider" USING btree ("_parent_id");
  CREATE INDEX "portal_pages_blocks_divider_path_idx" ON "portal_pages_blocks_divider" USING btree ("_path");
  CREATE UNIQUE INDEX "portal_pages_slug_idx" ON "portal_pages" USING btree ("slug");
  CREATE INDEX "portal_pages_cover_idx" ON "portal_pages" USING btree ("cover_id");
  CREATE INDEX "portal_pages_updated_at_idx" ON "portal_pages" USING btree ("updated_at");
  CREATE INDEX "portal_pages_created_at_idx" ON "portal_pages" USING btree ("created_at");
  CREATE INDEX "portal_pages__status_idx" ON "portal_pages" USING btree ("_status");
  CREATE INDEX "portal_pages_rels_order_idx" ON "portal_pages_rels" USING btree ("order");
  CREATE INDEX "portal_pages_rels_parent_idx" ON "portal_pages_rels" USING btree ("parent_id");
  CREATE INDEX "portal_pages_rels_path_idx" ON "portal_pages_rels" USING btree ("path");
  CREATE INDEX "portal_pages_rels_portal_page_categories_id_idx" ON "portal_pages_rels" USING btree ("portal_page_categories_id");
  CREATE INDEX "_portal_pages_v_blocks_heading_order_idx" ON "_portal_pages_v_blocks_heading" USING btree ("_order");
  CREATE INDEX "_portal_pages_v_blocks_heading_parent_id_idx" ON "_portal_pages_v_blocks_heading" USING btree ("_parent_id");
  CREATE INDEX "_portal_pages_v_blocks_heading_path_idx" ON "_portal_pages_v_blocks_heading" USING btree ("_path");
  CREATE INDEX "_portal_pages_v_blocks_rich_text_order_idx" ON "_portal_pages_v_blocks_rich_text" USING btree ("_order");
  CREATE INDEX "_portal_pages_v_blocks_rich_text_parent_id_idx" ON "_portal_pages_v_blocks_rich_text" USING btree ("_parent_id");
  CREATE INDEX "_portal_pages_v_blocks_rich_text_path_idx" ON "_portal_pages_v_blocks_rich_text" USING btree ("_path");
  CREATE INDEX "_portal_pages_v_blocks_image_order_idx" ON "_portal_pages_v_blocks_image" USING btree ("_order");
  CREATE INDEX "_portal_pages_v_blocks_image_parent_id_idx" ON "_portal_pages_v_blocks_image" USING btree ("_parent_id");
  CREATE INDEX "_portal_pages_v_blocks_image_path_idx" ON "_portal_pages_v_blocks_image" USING btree ("_path");
  CREATE INDEX "_portal_pages_v_blocks_image_asset_idx" ON "_portal_pages_v_blocks_image" USING btree ("asset_id");
  CREATE INDEX "_portal_pages_v_blocks_gallery_images_order_idx" ON "_portal_pages_v_blocks_gallery_images" USING btree ("_order");
  CREATE INDEX "_portal_pages_v_blocks_gallery_images_parent_id_idx" ON "_portal_pages_v_blocks_gallery_images" USING btree ("_parent_id");
  CREATE INDEX "_portal_pages_v_blocks_gallery_images_asset_idx" ON "_portal_pages_v_blocks_gallery_images" USING btree ("asset_id");
  CREATE INDEX "_portal_pages_v_blocks_gallery_order_idx" ON "_portal_pages_v_blocks_gallery" USING btree ("_order");
  CREATE INDEX "_portal_pages_v_blocks_gallery_parent_id_idx" ON "_portal_pages_v_blocks_gallery" USING btree ("_parent_id");
  CREATE INDEX "_portal_pages_v_blocks_gallery_path_idx" ON "_portal_pages_v_blocks_gallery" USING btree ("_path");
  CREATE INDEX "_portal_pages_v_blocks_video_order_idx" ON "_portal_pages_v_blocks_video" USING btree ("_order");
  CREATE INDEX "_portal_pages_v_blocks_video_parent_id_idx" ON "_portal_pages_v_blocks_video" USING btree ("_parent_id");
  CREATE INDEX "_portal_pages_v_blocks_video_path_idx" ON "_portal_pages_v_blocks_video" USING btree ("_path");
  CREATE INDEX "_portal_pages_v_blocks_video_asset_idx" ON "_portal_pages_v_blocks_video" USING btree ("asset_id");
  CREATE INDEX "_portal_pages_v_blocks_embed_order_idx" ON "_portal_pages_v_blocks_embed" USING btree ("_order");
  CREATE INDEX "_portal_pages_v_blocks_embed_parent_id_idx" ON "_portal_pages_v_blocks_embed" USING btree ("_parent_id");
  CREATE INDEX "_portal_pages_v_blocks_embed_path_idx" ON "_portal_pages_v_blocks_embed" USING btree ("_path");
  CREATE INDEX "_portal_pages_v_blocks_pdf_order_idx" ON "_portal_pages_v_blocks_pdf" USING btree ("_order");
  CREATE INDEX "_portal_pages_v_blocks_pdf_parent_id_idx" ON "_portal_pages_v_blocks_pdf" USING btree ("_parent_id");
  CREATE INDEX "_portal_pages_v_blocks_pdf_path_idx" ON "_portal_pages_v_blocks_pdf" USING btree ("_path");
  CREATE INDEX "_portal_pages_v_blocks_pdf_asset_idx" ON "_portal_pages_v_blocks_pdf" USING btree ("asset_id");
  CREATE INDEX "_portal_pages_v_blocks_callout_order_idx" ON "_portal_pages_v_blocks_callout" USING btree ("_order");
  CREATE INDEX "_portal_pages_v_blocks_callout_parent_id_idx" ON "_portal_pages_v_blocks_callout" USING btree ("_parent_id");
  CREATE INDEX "_portal_pages_v_blocks_callout_path_idx" ON "_portal_pages_v_blocks_callout" USING btree ("_path");
  CREATE INDEX "_portal_pages_v_blocks_link_order_idx" ON "_portal_pages_v_blocks_link" USING btree ("_order");
  CREATE INDEX "_portal_pages_v_blocks_link_parent_id_idx" ON "_portal_pages_v_blocks_link" USING btree ("_parent_id");
  CREATE INDEX "_portal_pages_v_blocks_link_path_idx" ON "_portal_pages_v_blocks_link" USING btree ("_path");
  CREATE INDEX "_portal_pages_v_blocks_divider_order_idx" ON "_portal_pages_v_blocks_divider" USING btree ("_order");
  CREATE INDEX "_portal_pages_v_blocks_divider_parent_id_idx" ON "_portal_pages_v_blocks_divider" USING btree ("_parent_id");
  CREATE INDEX "_portal_pages_v_blocks_divider_path_idx" ON "_portal_pages_v_blocks_divider" USING btree ("_path");
  CREATE INDEX "_portal_pages_v_parent_idx" ON "_portal_pages_v" USING btree ("parent_id");
  CREATE INDEX "_portal_pages_v_version_version_slug_idx" ON "_portal_pages_v" USING btree ("version_slug");
  CREATE INDEX "_portal_pages_v_version_version_cover_idx" ON "_portal_pages_v" USING btree ("version_cover_id");
  CREATE INDEX "_portal_pages_v_version_version_updated_at_idx" ON "_portal_pages_v" USING btree ("version_updated_at");
  CREATE INDEX "_portal_pages_v_version_version_created_at_idx" ON "_portal_pages_v" USING btree ("version_created_at");
  CREATE INDEX "_portal_pages_v_version_version__status_idx" ON "_portal_pages_v" USING btree ("version__status");
  CREATE INDEX "_portal_pages_v_created_at_idx" ON "_portal_pages_v" USING btree ("created_at");
  CREATE INDEX "_portal_pages_v_updated_at_idx" ON "_portal_pages_v" USING btree ("updated_at");
  CREATE INDEX "_portal_pages_v_latest_idx" ON "_portal_pages_v" USING btree ("latest");
  CREATE INDEX "_portal_pages_v_autosave_idx" ON "_portal_pages_v" USING btree ("autosave");
  CREATE INDEX "_portal_pages_v_rels_order_idx" ON "_portal_pages_v_rels" USING btree ("order");
  CREATE INDEX "_portal_pages_v_rels_parent_idx" ON "_portal_pages_v_rels" USING btree ("parent_id");
  CREATE INDEX "_portal_pages_v_rels_path_idx" ON "_portal_pages_v_rels" USING btree ("path");
  CREATE INDEX "_portal_pages_v_rels_portal_page_categories_id_idx" ON "_portal_pages_v_rels" USING btree ("portal_page_categories_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "portal_page_categories" CASCADE;
  DROP TABLE "portal_page_media" CASCADE;
  DROP TABLE "portal_pages_blocks_heading" CASCADE;
  DROP TABLE "portal_pages_blocks_rich_text" CASCADE;
  DROP TABLE "portal_pages_blocks_image" CASCADE;
  DROP TABLE "portal_pages_blocks_gallery_images" CASCADE;
  DROP TABLE "portal_pages_blocks_gallery" CASCADE;
  DROP TABLE "portal_pages_blocks_video" CASCADE;
  DROP TABLE "portal_pages_blocks_embed" CASCADE;
  DROP TABLE "portal_pages_blocks_pdf" CASCADE;
  DROP TABLE "portal_pages_blocks_callout" CASCADE;
  DROP TABLE "portal_pages_blocks_link" CASCADE;
  DROP TABLE "portal_pages_blocks_divider" CASCADE;
  DROP TABLE "portal_pages" CASCADE;
  DROP TABLE "portal_pages_rels" CASCADE;
  DROP TABLE "_portal_pages_v_blocks_heading" CASCADE;
  DROP TABLE "_portal_pages_v_blocks_rich_text" CASCADE;
  DROP TABLE "_portal_pages_v_blocks_image" CASCADE;
  DROP TABLE "_portal_pages_v_blocks_gallery_images" CASCADE;
  DROP TABLE "_portal_pages_v_blocks_gallery" CASCADE;
  DROP TABLE "_portal_pages_v_blocks_video" CASCADE;
  DROP TABLE "_portal_pages_v_blocks_embed" CASCADE;
  DROP TABLE "_portal_pages_v_blocks_pdf" CASCADE;
  DROP TABLE "_portal_pages_v_blocks_callout" CASCADE;
  DROP TABLE "_portal_pages_v_blocks_link" CASCADE;
  DROP TABLE "_portal_pages_v_blocks_divider" CASCADE;
  DROP TABLE "_portal_pages_v" CASCADE;
  DROP TABLE "_portal_pages_v_rels" CASCADE;
  DROP TYPE "public"."enum_portal_page_media_mime_type";
  DROP TYPE "public"."enum_portal_page_media_state";
  DROP TYPE "public"."enum_portal_pages_blocks_heading_level";
  DROP TYPE "public"."enum_portal_pages_blocks_heading_layout";
  DROP TYPE "public"."enum_portal_pages_blocks_rich_text_layout";
  DROP TYPE "public"."enum_portal_pages_blocks_image_layout";
  DROP TYPE "public"."enum_portal_pages_blocks_gallery_layout";
  DROP TYPE "public"."enum_portal_pages_blocks_video_layout";
  DROP TYPE "public"."enum_portal_pages_blocks_embed_provider";
  DROP TYPE "public"."enum_portal_pages_blocks_embed_layout";
  DROP TYPE "public"."enum_portal_pages_blocks_pdf_layout";
  DROP TYPE "public"."enum_portal_pages_blocks_callout_tone";
  DROP TYPE "public"."enum_portal_pages_blocks_callout_layout";
  DROP TYPE "public"."enum_portal_pages_blocks_link_style";
  DROP TYPE "public"."enum_portal_pages_blocks_link_layout";
  DROP TYPE "public"."enum_portal_pages_blocks_divider_layout";
  DROP TYPE "public"."enum_portal_pages_status";
  DROP TYPE "public"."enum__portal_pages_v_blocks_heading_level";
  DROP TYPE "public"."enum__portal_pages_v_blocks_heading_layout";
  DROP TYPE "public"."enum__portal_pages_v_blocks_rich_text_layout";
  DROP TYPE "public"."enum__portal_pages_v_blocks_image_layout";
  DROP TYPE "public"."enum__portal_pages_v_blocks_gallery_layout";
  DROP TYPE "public"."enum__portal_pages_v_blocks_video_layout";
  DROP TYPE "public"."enum__portal_pages_v_blocks_embed_provider";
  DROP TYPE "public"."enum__portal_pages_v_blocks_embed_layout";
  DROP TYPE "public"."enum__portal_pages_v_blocks_pdf_layout";
  DROP TYPE "public"."enum__portal_pages_v_blocks_callout_tone";
  DROP TYPE "public"."enum__portal_pages_v_blocks_callout_layout";
  DROP TYPE "public"."enum__portal_pages_v_blocks_link_style";
  DROP TYPE "public"."enum__portal_pages_v_blocks_link_layout";
  DROP TYPE "public"."enum__portal_pages_v_blocks_divider_layout";
  DROP TYPE "public"."enum__portal_pages_v_version_status";`)
}
