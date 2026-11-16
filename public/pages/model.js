import { publicationIssueDetails } from './publication-issues.js';

export const clone = value => JSON.parse(JSON.stringify(value));
export const newId = () => crypto.randomUUID();
export const canPages = (user, permission) => user?.role === 'admin' && (user.permissions?.superAdmin === true || user.permissions?.[permission] === true);
export const allBlocks = doc => doc.sections.flatMap(section => section.rows.flatMap(row => row.columns.flatMap(column => column.blocks)));
export function blockList(doc) { return doc.sections[0].rows[0].columns[0].blocks; }
export function textBlock() { return { id: newId(), type: 'rich_text', content: { type: 'doc', content: [{ type: 'paragraph' }] } }; }
export function safeLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return false;
  if (value.startsWith('/') && !value.startsWith('//')) {
    try { return new URL(value, 'https://pages.invalid').origin === 'https://pages.invalid'; } catch { return false; }
  }
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
export function publicationIssues(doc, cargos) {
  return publicationIssueDetails(doc, cargos).map(issue => issue.message);
}
