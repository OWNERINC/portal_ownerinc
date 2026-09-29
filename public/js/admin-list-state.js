// The UI owns these names; only the validated field names below reach the API.
export const ADMIN_LIST_FIELDS = {
  users: ['q', 'role', 'state', 'job_title_id'],
  titles: ['q', 'active'],
  audit: ['action', 'from', 'to'],
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function civilDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12
    && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function validateAdminFilters(key, input) {
  const values = {}, errors = {};
  for (const field of ADMIN_LIST_FIELDS[key]) {
    const value = typeof input[field] === 'string' ? input[field].trim() : '';
    if (!value) continue;
    let error = '';
    if (field === 'q' && value.length > 200) error = 'Use até 200 caracteres.';
    if (field === 'action' && value.length > 120) error = 'Use até 120 caracteres para o código exato.';
    if (field === 'role' && !['viewer', 'admin'].includes(value)) error = 'Selecione um perfil válido.';
    if (field === 'state' && !['active', 'disabled', 'enable_pending'].includes(value)) error = 'Selecione um estado válido.';
    if (field === 'active' && !['true', 'false'].includes(value)) error = 'Selecione uma situação válida.';
    if (field === 'job_title_id' && !uuid.test(value)) error = 'Selecione um cargo válido.';
    if (['from', 'to'].includes(field) && !civilDate(value)) error = 'Informe uma data real entre 0001 e 9999.';
    if (error) errors[field] = error;
    else values[field] = value;
  }
  if (values.from && values.to && values.from > values.to) {
    errors.to = 'A data final deve ser igual ou posterior à inicial.';
    delete values.from; delete values.to;
  }
  return { values, errors };
}

export function readAdminListURL(key, search) {
  const params = new URLSearchParams(search), raw = {};
  for (const field of ADMIN_LIST_FIELDS[key]) {
    const name = `${key}_${field}`;
    // Repeated/structured parameters are discarded rather than choosing one.
    if (params.getAll(name).length === 1 && ![...params.keys()].some(item => item.startsWith(`${name}[`))) raw[field] = params.get(name);
  }
  const rawPage = params.getAll(`${key}_page`);
  const page = rawPage.length === 1 && /^[1-9]\d*$/.test(rawPage[0]) ? Number(rawPage[0]) : 1;
  return { filters: validateAdminFilters(key, raw).values, page: Number.isSafeInteger(page) && page <= 20001 ? page : 1 };
}

export function writeAdminListURL(url, key, state) {
  // Mutate only this namespace, retaining tab, other filters and router URL.
  for (const name of [...url.searchParams.keys()]) {
    if (name.startsWith(`${key}_`)) url.searchParams.delete(name);
  }
  for (const field of ADMIN_LIST_FIELDS[key]) if (state.filters[field]) url.searchParams.set(`${key}_${field}`, state.filters[field]);
  if (state.page > 1) url.searchParams.set(`${key}_page`, String(state.page));
  return url;
}

export function adminListQuery(key, state) {
  const params = new URLSearchParams({ ...(key === 'titles' ? { all: 'true' } : {}), limit: '50', offset: String((state.page - 1) * 50) });
  for (const field of ADMIN_LIST_FIELDS[key]) if (state.filters[field]) params.set(field, state.filters[field]);
  return params.toString();
}
