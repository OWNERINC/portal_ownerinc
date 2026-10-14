import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { validateExternalRoot } from '../../scripts/payload-preview/security.mjs'

// Test-only escape from an unwritable inferred parent; never relax the real
// preview boundary or create/change the operator-selected parent itself.
export async function selectExternalTestParent(fallback, checkoutRoot, override) {
  if (override === undefined) return fallback
  const parent = await validateExternalRoot(override, checkoutRoot)
  await fs.access(parent, constants.W_OK)
  return parent
}
