import type { LegacyNewsRevisionInput } from '../contracts/news';
export function historyHashes(value: Omit<LegacyNewsRevisionInput, 'contentHash' | 'provenanceHash' | 'mediaReferences'>): {contentHash: string; provenanceHash: string};
