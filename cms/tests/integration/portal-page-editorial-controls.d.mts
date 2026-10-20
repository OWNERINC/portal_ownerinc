export type EditorialBrowserCase = {
  name: string
  status: 'PASS' | 'FAIL' | 'NOT_EXECUTED'
  detail: string
}

export function assertEqual(actual: unknown, expected: unknown, detail: string): void
export function assertNotEqual(actual: unknown, expected: unknown, detail: string): void
export function assertMatch(actual: unknown, pattern: RegExp, detail: string): void
export function runEditorialControlCases(page: unknown, structuralPage: unknown): Promise<EditorialBrowserCase[]>
