import { APIError, type CollectionConfig } from 'payload'
import type { CmsEnvironment } from '../config/environment'
import { canManageNews, denyEditorMutation, readOwnEditor, type PortalRuntimeUser } from '../auth/access'
import { assertEditorialOrigin, editorialCookieSettings, readEditorialCookie } from '../auth/cookie'
import { createPortalClient } from '../auth/portal-client'
import { createPortalStrategy } from '../auth/portal-strategy'

export function createPortalEditors(environment: CmsEnvironment, client = createPortalClient(environment)): CollectionConfig {
  const cookie = editorialCookieSettings(environment.portalPublicURL)
  const portalStrategy = createPortalStrategy({ cookieName: cookie.name, resolve: client.resolvePortalEditor })
  return {
    slug: 'portal-editors',
    admin: { useAsTitle: 'displayName', hidden: true },
    auth: { disableLocalStrategy: true, useSessions: false, useAPIKey: false, removeTokenFromResponses: true, strategies: [portalStrategy] },
    access: {
      admin: canManageNews,
      create: denyEditorMutation,
      read: readOwnEditor,
      update: denyEditorMutation,
      delete: denyEditorMutation,
      unlock: denyEditorMutation,
    },
    fields: [
      { name: 'portalUid', type: 'text', required: true, unique: true, index: true, admin: { readOnly: true } },
      { name: 'email', type: 'email', required: true, admin: { readOnly: true } },
      { name: 'displayName', type: 'text', admin: { readOnly: true } },
    ],
    hooks: {
      // Custom authentication must not mint a second, independently valid Payload session.
      beforeOperation: [({ operation }) => { if (operation === 'refresh') throw new APIError('Portal session refresh is not supported.', 403) }],
      me: [({ args, user }) => ({ user, exp: Math.floor(Date.parse((args.req.user as PortalRuntimeUser).portalExpiresAt!) / 1000) })],
      afterLogout: [async ({ req }) => {
        assertEditorialOrigin(req.headers, cookie.origin)
        const value = readEditorialCookie(req.headers, cookie.name)
        if (value) await client.revokePortalEditor(value)
        // Only expire after confirmed revocation; Task 9 owns the browser exit view.
        req.responseHeaders ??= new Headers()
        req.responseHeaders.append('Set-Cookie', `${cookie.name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${cookie.secure ? '; Secure' : ''}`)
      }],
    },
  }
}
