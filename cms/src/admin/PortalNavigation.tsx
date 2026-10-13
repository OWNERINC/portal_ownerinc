'use client'
import React from 'react'
import { Link, useAuth } from '@payloadcms/ui'

type PortalAdminClientUser = {
  portalUid?: string
  portalActor?: { uid?: string; canManageNews?: boolean }
  adminActor?: { version?: number; uid?: string; capabilities?: { manageKnowledge?: boolean } }
}

export function PortalNavigation() {
  const { user } = useAuth()
  const actor = user as PortalAdminClientUser | null | undefined
  const canManageKnowledge = actor?.portalActor?.canManageNews === true && actor.portalActor.uid === actor.portalUid ||
    actor?.adminActor?.version === 2 && actor.adminActor.capabilities?.manageKnowledge === true && actor.adminActor.uid === actor.portalUid
  return <div className="portal-navigation">
    {canManageKnowledge && <Link href="/editorial/admin/polls">Enquetes</Link>}
    <a href="/cms.html">Voltar à central editorial</a>
    <a href="/announcements.html">Ler Owner News</a>
  </div>
}
