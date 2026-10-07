export const SCHEDULE_TIMEZONE = 'America/Sao_Paulo'
export const scheduleConflictMessage = 'A revisão ou a agenda mudou. Seus campos foram preservados. Confira novamente a revisão salva antes de confirmar.'
export function scheduleBlocked(input: { modified: boolean; processing: boolean; backgroundProcessing: boolean;
  initializing: boolean; disabled: boolean; uploading: boolean; otherModalOpen: boolean; busy: boolean }) {
  return Object.values(input).some(Boolean)
}
const localTime = (date: Date) => {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: SCHEDULE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const value = (name: string) => parts.find(part => part.type === name)?.value
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`
}
/** Civil time is interpreted in the displayed zone, never the browser's zone. */
export function scheduleUTC(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(value)) throw new Error('Use AAAA-MM-DD HH:mm em America/Sao_Paulo.')
  const naive = Date.parse(`${value.replace(' ', 'T')}:00.000Z`)
  if (!Number.isFinite(naive)) throw new Error('Data inválida.')
  let candidate = naive
  for (let i = 0; i < 3; i++) {
    const represented = Date.parse(`${localTime(new Date(candidate)).replace(' ', 'T')}:00.000Z`)
    candidate += naive - represented
  }
  if (localTime(new Date(candidate)) !== value) throw new Error('Data inválida no fuso America/Sao_Paulo.')
  return new Date(candidate).toISOString()
}
