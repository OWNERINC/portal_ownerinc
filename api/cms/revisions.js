class CmsRouteError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function resolveDraftRevisionId(document, requestedRevisionId) {
  if (!document?.draft_revision_id
    || (requestedRevisionId !== undefined && requestedRevisionId !== document.draft_revision_id)) {
    throw new CmsRouteError(409, 'draft_required');
  }
  return document.draft_revision_id;
}

function unscheduleRevisionState(document) {
  if (!document?.scheduled_revision_id) return null;
  const preserveDraft = document.draft_revision_id && document.draft_revision_id !== document.scheduled_revision_id;
  return {
    scheduledRevisionId: document.scheduled_revision_id,
    draftRevisionId: preserveDraft ? document.draft_revision_id : document.scheduled_revision_id,
    preserveDraft: Boolean(preserveDraft),
  };
}

function withdrawalState(document) {
  return {
    publishedRevisionId: document?.published_revision_id || null,
    scheduledRevisionId: document?.scheduled_revision_id || null,
  };
}

module.exports = {
  CmsRouteError,
  resolveDraftRevisionId,
  unscheduleRevisionState,
  withdrawalState,
};
