const TIME_ZONE = 'America/Sao_Paulo';
const RUN_HOUR = 8;
const MAX_CATCH_UP_DAYS = 7;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

function civilDateKey(date = new Date(), timeZone = TIME_ZONE) {
  return zonedDateAndHour(date, timeZone).dateKey;
}

function zonedDateAndHour(date, timeZone = TIME_ZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function zonedDateTime(dateKey, hour = RUN_HOUR, minute = 0, timeZone = TIME_ZONE) {
  const normalized = normalizeDateKey(dateKey);
  if (!DATE_KEY_PATTERN.test(normalized) || !Number.isInteger(hour) || hour < 0 || hour > 23
    || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error('Invalid scheduled date');
  }
  const probe = new Date(`${normalized}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hourCycle: 'h23',
  }).formatToParts(probe).map(({ type, value }) => [type, value]));
  const localAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return new Date(probe.getTime() - (localAsUtc - probe.getTime()));
}

function reminderIsEligibleForDate(createdAt, dateKey) {
  if (createdAt === undefined || createdAt === null || createdAt === '') return true;
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) return false;
  return created <= zonedDateTime(dateKey);
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

module.exports = {
  TIME_ZONE,
  RUN_HOUR,
  MAX_CATCH_UP_DAYS,
  civilDateKey,
  dueDateKeys,
  normalizeDateKey,
  reminderIsEligibleForDate,
  reminderMatchesDate,
  resolveTargets,
  zonedDateAndHour,
  zonedDateTime,
};
