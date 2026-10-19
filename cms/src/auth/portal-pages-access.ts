import type { PayloadRequest } from 'payload'
import { canManageNews } from './access'

/**
 * Page editorial capability intentionally follows the verified Portal editor
 * capability, not Owner News' authority mode or mutation protocol.
 */
export function canManagePortalPages({ req }: { req: PayloadRequest }): boolean {
  return canManageNews({ req })
}

export const portalPageEditorAccess = ({ req }: { req: PayloadRequest }) => canManagePortalPages({ req })
