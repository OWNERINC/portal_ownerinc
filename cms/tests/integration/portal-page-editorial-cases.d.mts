export type AcceptanceStatus = 'PASS' | 'FAIL' | 'NOT_EXECUTED' | 'SKIP'
export type AcceptanceCase = { name: string; status: AcceptanceStatus; detail: string }
export const expectedNativeAcceptanceCases: readonly string[]
export const expectedBrowserAcceptanceCases: readonly string[]
export function aggregateAcceptanceCases(expectedNames: readonly string[], actualCases: Array<Record<string, unknown>>): {
  status: 'PASS' | 'FAIL' | 'NOT_EXECUTED'
  cases: Array<{ name: string; status: AcceptanceStatus; detail: string }>
}
export function notExecutedAcceptanceCases(expectedNames: readonly string[], detail: string): AcceptanceCase[]
