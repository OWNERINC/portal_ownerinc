// Raw array field payloads captured after all six actual migration up() calls
// through Drizzle PgDialect, PGlite 0.2.17 / PostgreSQL 16.4 WASM. These are
// observed regression inputs; expected types still come from the native snapshot.
// The original query returned name[] / OID 1003; the fixed query returns
// text[] / OID 1009 with the same text payloads. Use the real pg decoder in tests.
export const nativeTypeLabelsPg16Oid = 1009
export const nativeTypesPg16 = `enum__news_articles_v_blocks_callout_layout|{content,wide,full,left,right}
enum__news_articles_v_blocks_callout_tone|{info,warning,success}
enum__news_articles_v_blocks_callout_typography|{serif,sans}
enum__news_articles_v_blocks_divider_layout|{content,wide,full,left,right}
enum__news_articles_v_blocks_heading_layout|{content,wide,full,left,right}
enum__news_articles_v_blocks_image_layout|{content,wide,full,left,right}
enum__news_articles_v_blocks_image_usage|{cover,body}
enum__news_articles_v_blocks_link_layout|{content,wide,full,left,right}
enum__news_articles_v_blocks_list_layout|{content,wide,full,left,right}
enum__news_articles_v_blocks_list_typography|{serif,sans}
enum__news_articles_v_blocks_paragraph_layout|{content,wide,full,left,right}
enum__news_articles_v_blocks_paragraph_typography|{serif,sans}
enum__news_articles_v_blocks_pdf_layout|{content,wide,full,left,right}
enum__news_articles_v_blocks_pdf_usage|{edition,attachment}
enum__news_articles_v_blocks_profile_layout|{content,wide,full,left,right}
enum__news_articles_v_blocks_profile_typography|{serif,sans}
enum__news_articles_v_blocks_quote_layout|{content,wide,full,left,right}
enum__news_articles_v_blocks_quote_typography|{serif,sans}
enum__news_articles_v_blocks_rich_text_layout|{content,wide,full,left,right}
enum__news_articles_v_blocks_rich_text_typography|{serif,sans}
enum__news_articles_v_blocks_video_layout|{content,wide,full,left,right}
enum__news_articles_v_version_status|{draft,published}
enum__news_home_v_version_status|{draft,published}
enum_legacy_news_revisions_original_status|{draft,published,scheduled,archived}
enum_news_articles_blocks_callout_layout|{content,wide,full,left,right}
enum_news_articles_blocks_callout_tone|{info,warning,success}
enum_news_articles_blocks_callout_typography|{serif,sans}
enum_news_articles_blocks_divider_layout|{content,wide,full,left,right}
enum_news_articles_blocks_heading_layout|{content,wide,full,left,right}
enum_news_articles_blocks_image_layout|{content,wide,full,left,right}
enum_news_articles_blocks_image_usage|{cover,body}
enum_news_articles_blocks_link_layout|{content,wide,full,left,right}
enum_news_articles_blocks_list_layout|{content,wide,full,left,right}
enum_news_articles_blocks_list_typography|{serif,sans}
enum_news_articles_blocks_paragraph_layout|{content,wide,full,left,right}
enum_news_articles_blocks_paragraph_typography|{serif,sans}
enum_news_articles_blocks_pdf_layout|{content,wide,full,left,right}
enum_news_articles_blocks_pdf_usage|{edition,attachment}
enum_news_articles_blocks_profile_layout|{content,wide,full,left,right}
enum_news_articles_blocks_profile_typography|{serif,sans}
enum_news_articles_blocks_quote_layout|{content,wide,full,left,right}
enum_news_articles_blocks_quote_typography|{serif,sans}
enum_news_articles_blocks_rich_text_layout|{content,wide,full,left,right}
enum_news_articles_blocks_rich_text_typography|{serif,sans}
enum_news_articles_blocks_video_layout|{content,wide,full,left,right}
enum_news_articles_status|{draft,published}
enum_news_audit_action|{draft_saved,published,unpublished,scheduled,schedule_cancelled,schedule_rejected}
enum_news_home_status|{draft,published}
enum_news_migration_items_commit_outcome|{acknowledged,unknown}
enum_news_migration_items_entity_kind|{asset,history,document,home,schedule}
enum_news_migration_items_state|{planned,applied,verified,conflict}
enum_news_migration_runs_admission_state|{open,sealed}
enum_news_migration_runs_commit_outcome|{acknowledged,unknown}
enum_news_migration_runs_progress_state|{preparing,reconciled,conflict}
enum_news_schedules_action|{publish,unpublish}
enum_news_schedules_original_actor_evidence|{not_recorded}
enum_news_schedules_state|{pending,published,unpublished,cancelled,rejected,suspended}
enum_news_schedules_target|{news-articles,news-home}
enum_payload_jobs_log_state|{failed,succeeded}
enum_payload_jobs_log_task_slug|{inline,publish-news-snapshot}
enum_payload_jobs_task_slug|{inline,publish-news-snapshot}`.split('\n').map(line => {
  const [name, labels] = line.split('|')
  return { schema: 'public', name: name!, kind: 'e', labels: labels! }
})
