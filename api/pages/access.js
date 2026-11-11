const { can } = require('../middleware/policy');
const editor = user => can(user, 'editPages');
const publisher = user => can(user, 'publishPages');
const owns = (user, page) => Boolean(page.author_uid && page.author_uid === user.uid);
const mayEdit = (user, page) => editor(user) && owns(user, page);
const mayReview = (user, page) => publisher(user) || mayEdit(user, page);
function capabilities(user, page) {
  return { edit: mayEdit(user, page) && !page.archived_at, publish: publisher(user) && !page.archived_at, archive: publisher(user) };
}
module.exports = { editor, publisher, owns, mayEdit, mayReview, capabilities };
