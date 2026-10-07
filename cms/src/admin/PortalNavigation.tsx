'use client'
import React from 'react'
import { Link } from '@payloadcms/ui'
export function PortalNavigation() {
  return <div className="portal-navigation"><Link href="/editorial/admin/polls">Enquetes</Link><a href="/cms.html">Voltar à central editorial</a><a href="/announcements.html">Ler Owner News</a></div>
}
