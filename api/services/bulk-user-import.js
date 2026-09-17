const HEADERS = ['name', 'email', 'job_title', 'contract_type', 'pj_due_day', 'phone'];
const MAX_ROWS = 500;
const { normalizeContract } = require('../middleware/validation');

function parseCsv(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 1024 * 1024) throw new Error('CSV must be a UTF-8 text file up to 1 MB.');
  const text = input.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  if (field || row.length) { row.push(field); if (row.some(value => value !== '')) rows.push(row); }
  if (!rows.length || rows[0].join(',') !== HEADERS.join(',')) throw new Error(`CSV headers must be exactly: ${HEADERS.join(',')}`);
  if (rows.length - 1 > MAX_ROWS) throw new Error(`CSV cannot contain more than ${MAX_ROWS} users.`);
  if (rows.slice(1).some(values => values.length !== HEADERS.length)) throw new Error('CSV rows must contain exactly six columns.');
  return rows.slice(1).map(values => Object.fromEntries(HEADERS.map((header, column) => [header, String(values[column] || '').trim()])));
}

function validateRows(rows, titles, existingEmails = new Set()) {
  const seen = new Set(existingEmails);
  return rows.map((row, index) => {
    const source = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    const name = String(source.name || '').trim();
    const jobTitle = String(source.job_title || '').trim();
    const contractType = String(source.contract_type || '').trim();
    const dueDay = String(source.pj_due_day || '').trim();
    const phone = String(source.phone || '').trim();
    const email = String(source.email || '').trim().toLowerCase();
    const title = titles.get(jobTitle.toLocaleLowerCase('pt-BR'));
    const contract = normalizeContract(contractType, dueDay);
    const errors = [];
    if (!name || name.length > 120 || /[\r\n]/.test(name)) errors.push('name');
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
    if (!validEmail) errors.push('email');
    else if (seen.has(email)) errors.push('duplicate_email');
    else seen.add(email);
    if (!title) errors.push('unknown_or_inactive_job_title');
    if (!contract) errors.push(contractType === 'pj' ? 'pj_due_day' : 'contract_type');
    if (phone.length > 40 || /[\r\n]/.test(phone)) errors.push('phone');
    const normalizedDueDay = contract?.contract_type === 'pj' ? String(contract.pj_due_day) : contractType === 'clt' ? '' : dueDay;
    return {
      row_number: index + 2, name, email, job_title: jobTitle, contract_type: contractType, pj_due_day: normalizedDueDay, phone, job_title_id: title?.id || null,
      status: errors.length ? (errors.includes('duplicate_email') ? 'duplicate' : 'invalid') : 'ready', errors,
    };
  });
}

function decideImportIdentity({ knownUid, email, pending, localUser, queuedCleanup, firebaseUser }) {
  if (localUser) {
    return {
      state: knownUid && localUser.uid === knownUid ? 'invited' : 'duplicate',
      uid: localUser.uid,
    };
  }
  if (pending) return { state: 'pending_registration', uid: pending.firebase_uid };
  if (queuedCleanup) return { state: 'pending_cleanup', uid: knownUid || null };
  if (!firebaseUser) return { state: 'resolved_missing', uid: null };
  if (knownUid && firebaseUser.uid !== knownUid) return { state: 'indeterminate', uid: firebaseUser.uid };
  const reusable = firebaseUser.email?.toLowerCase() === email?.toLowerCase()
    && firebaseUser.disabled === true && firebaseUser.emailVerified === true;
  return { state: reusable ? 'reusable' : 'indeterminate', uid: firebaseUser.uid };
}

function canClaimImportIdentity(state) {
  return state === 'resolved_missing' || state === 'reusable';
}

module.exports = {
  HEADERS,
  MAX_ROWS,
  canClaimImportIdentity,
  decideImportIdentity,
  parseCsv,
  validateRows,
};
