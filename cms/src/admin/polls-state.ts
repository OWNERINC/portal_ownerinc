import type { Poll, PollDraft } from './polls-client'
export const emptyPoll = (): PollDraft => ({ title: '', question: '', description: '', closing: '', options: ['', ''] })
export const pollDraft = (poll: Poll): PollDraft => ({ title: poll.title, question: poll.question, description: poll.description, closing: poll.closing, options: poll.options.map(option => option.label) })
export const pollBaseline = (draft: PollDraft) => JSON.stringify(draft)
export function validPollDraft(draft: PollDraft) {
  const limits = { title: 80, question: 240, description: 600, closing: 200 }
  const keys = draft.options.map(label => label.trim().normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' '))
  return !!draft.title.trim() && !!draft.question.trim() && Object.entries(limits).every(([key, max]) => draft[key as keyof typeof limits].trim().length <= max)
    && draft.options.length >= 2 && draft.options.length <= 6 && draft.options.every(label => label.trim() && label.trim().length <= 100 && !/[\r\n]/.test(label)) && new Set(keys).size === keys.length
}
export function pollMutation(action: 'draft' | 'publish' | 'close', selected: Poll | null, draft: PollDraft) {
  const creating = action === 'draft' && !selected
  return { path: creating ? '/' : `/${selected!.id}/${action}`, method: action === 'draft' && !creating ? 'PUT' : 'POST',
    body: { ...(action === 'draft' ? draft : {}), ...(!creating ? { expected_version: selected!.version } : {}) } }
}
