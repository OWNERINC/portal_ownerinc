const TIME_ZONE = 'America/Sao_Paulo';
const RUN_HOUR = 8;
const MAX_CATCH_UP_DAYS = 7;

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeDateKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
  if (!match) throw new Error('Invalid scheduled date');
  return match[1];
}

function zonedDateAndHour(date, timeZone = TIME_ZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function dueDateKeys(now, lastScheduledDate, maxDays = MAX_CATCH_UP_DAYS) {
  const local = zonedDateAndHour(now);
  const latest = local.hour >= RUN_HOUR ? local.dateKey : addDays(local.dateKey, -1);
  const lowerBound = addDays(latest, -(maxDays - 1));
  let next = lastScheduledDate ? addDays(normalizeDateKey(lastScheduledDate), 1) : lowerBound;
  if (next < lowerBound) next = lowerBound;

  const dates = [];
  while (next <= latest) {
    dates.push(next);
    next = addDays(next, 1);
  }
  return dates;
}

function reminderMatchesDate(triggerDay, dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day === Math.min(triggerDay, lastDay);
}

function resolveTargets(targetUsers, users) {
  if (targetUsers === 'all') return users;
  if (targetUsers === 'pj') return users.filter((user) => user.contract_type === 'pj' || user.is_pj);
  if (targetUsers === 'clt') return users.filter((user) => user.contract_type !== 'pj' && !user.is_pj);
  if (!Array.isArray(targetUsers)) return [];

  const requested = new Set(targetUsers);
  return users.filter((user) => requested.has(user.uid));
}

module.exports = { TIME_ZONE, RUN_HOUR, MAX_CATCH_UP_DAYS, dueDateKeys, normalizeDateKey, reminderMatchesDate, resolveTargets };
