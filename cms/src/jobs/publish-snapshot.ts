import { APIError, type TaskConfig } from 'payload'
import { runScheduledRevision } from '../publication/schedule'
import { uuid } from '../news/primitives'

export const publishNewsSnapshot: TaskConfig<{ input: { scheduleId: string }; output: { state: string } }> = {
  slug: 'publish-news-snapshot',
  concurrency: ({ input, queue }) => {
    if (queue !== 'owner-news' || Object.keys(input).length !== 1) throw new APIError('invalid_snapshot_job', 400, undefined, true)
    return `news-schedule:${uuid(input.scheduleId)}`
  },
  inputSchema: [{ name: 'scheduleId', type: 'text', required: true }],
  outputSchema: [{ name: 'state', type: 'text', required: true }],
  retries: { attempts: 5, backoff: { type: 'exponential', delay: 10000 } },
  handler: async ({ req, input }) => ({ output: await runScheduledRevision(req, input) }),
}
