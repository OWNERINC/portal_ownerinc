import type { PayloadRequest } from 'payload'

// In-process capabilities. Neither REST JSON nor Server Action form state can forge these.
const mutation = Symbol('news-publication-mutation')
const worker = Symbol('news-publication-worker')
export const isPublicationMutation = (req: PayloadRequest) => Boolean(Object.getOwnPropertyDescriptor(req.context, mutation)?.value)
export const workerActor = (req: PayloadRequest): string | undefined => Object.getOwnPropertyDescriptor(req.context, worker)?.value
export async function publicationMutation<T>(req: PayloadRequest, work: () => Promise<T>): Promise<T> {
  // Payload's createLocalReq treats symbol-only objects as empty. A non-authorizing
  // string marker preserves the enumerable Symbols across its public Local API.
  req.context = { ...req.context, newsPublicationProtocol: true }
  const previous = Object.getOwnPropertyDescriptor(req.context, mutation)
  Object.defineProperty(req.context, mutation, { value: true, configurable: true, enumerable: true })
  try { return await work() } finally {
    if (previous) Object.defineProperty(req.context, mutation, previous)
    else Reflect.deleteProperty(req.context, mutation)
  }
}
export async function asPublicationWorker<T>(req: PayloadRequest, uid: string, work: () => Promise<T>): Promise<T> {
  req.context = { ...req.context, newsPublicationProtocol: true }
  const previous = Object.getOwnPropertyDescriptor(req.context, worker)
  Object.defineProperty(req.context, worker, { value: uid, configurable: true, enumerable: true })
  try { return await work() } finally {
    if (previous) Object.defineProperty(req.context, worker, previous)
    else Reflect.deleteProperty(req.context, worker)
  }
}
