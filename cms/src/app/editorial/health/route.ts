export const dynamic = 'force-dynamic'

/** Liveness only. Readiness is deliberately separate at /editorial/ready. */
export async function GET(): Promise<Response> {
  return Response.json({ status: 'alive' }, { headers: { 'Cache-Control': 'no-store' } })
}
