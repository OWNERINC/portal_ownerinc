export const ADMIN_CAPABILITIES = [
  'manageKnowledge',
  'manageAcademy',
  'manageBenefits',
  'manageReminders',
] as const

export type AdminCapability = typeof ADMIN_CAPABILITIES[number]
export type AdminCapabilities = Readonly<Record<AdminCapability, boolean>>
export type VerifiedAdminActor = {
  version: 2
  uid: string
  email: string
  name: string | null
  capabilities: AdminCapabilities
}
export type AdminPortalResolution = { actor: VerifiedAdminActor; expiresAt: string }

const actorKeys = ['capabilities', 'email', 'name', 'uid', 'version']

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index])
}

/** Parse only the fixed, server-resolved v2 admin actor. Unknown grants fail closed. */
export function parseAdminActor(value: unknown): VerifiedAdminActor | null {
  if (!record(value) || !hasExactKeys(value, actorKeys) || value.version !== 2 ||
    typeof value.uid !== 'string' || !value.uid || value.uid.length > 128 ||
    typeof value.email !== 'string' || !value.email || value.email.length > 320 ||
    !(value.name === null || typeof value.name === 'string') || !record(value.capabilities)) return null
  const rawCapabilities = value.capabilities
  if (!hasExactKeys(rawCapabilities, ADMIN_CAPABILITIES) ||
    ADMIN_CAPABILITIES.some(key => typeof rawCapabilities[key] !== 'boolean')) return null

  const capabilities = rawCapabilities as Record<AdminCapability, boolean>
  if (!ADMIN_CAPABILITIES.some(key => capabilities[key] === true)) return null
  return {
    version: 2,
    uid: value.uid,
    email: value.email,
    name: value.name,
    capabilities: {
      manageKnowledge: capabilities.manageKnowledge,
      manageAcademy: capabilities.manageAcademy,
      manageBenefits: capabilities.manageBenefits,
      manageReminders: capabilities.manageReminders,
    },
  }
}

export function isAdminActor(value: unknown): value is VerifiedAdminActor {
  return parseAdminActor(value) !== null
}

export function validAdminExpiry(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false
  try { return new Date(value).toISOString() === value } catch { return false }
}
