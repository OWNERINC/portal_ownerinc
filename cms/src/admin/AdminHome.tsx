import React from 'react'
import { Gutter, SetStepNav } from '@payloadcms/ui'

/** Empty native landing: do not query or prefetch any News documents here. */
export function AdminHome() {
  return <>
    <SetStepNav nav={[]} />
    <Gutter>
      <h1>Painel administrativo</h1>
      <p>As áreas nativas do Portal ainda estão sendo integradas. Use a central editorial para os conteúdos disponíveis.</p>
      <p><a href="/cms.html">Voltar à central editorial</a></p>
    </Gutter>
  </>
}
