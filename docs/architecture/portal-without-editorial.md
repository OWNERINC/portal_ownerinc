# Portal sem editorial no runtime

Atualizado em 3 de novembro de 2026 (OWN-45).

## Contrato ativo

O Portal executável mantém:

- autenticação, sessão, administração, perfil e permissões;
- Knowledge com texto simples próprio;
- Academy com catálogo elegível, módulos, aulas, mídia própria, gestão e
  progresso individual;
- Benefits como rota/CRUD preservados fora da navegação inicial;
- Reminders com descrição, instruções, audiência, ledger e entrega próprios;
- AutoCard, Cards Pós, auditoria, backup/restore e integrações explicitamente
  habilitadas.

Esses domínios não dependem de CMS, Payload CMS, Owner News, enquetes, editor
editorial, renderer de blocos, importadores editoriais ou jobs de retenção editorial.
Os contratos de ausência confirmam que não há chamadas `/api/cms` nos domínios
mantidos, que `/announcements.html` retorna 404 controlado e que o Nginx não usa
fallback SPA para a URL antiga.

## Histórico preservado sem consumidor

As migrations e estruturas editoriais antigas continuam preservadas:

| Histórico | Estado no runtime atual |
| --- | --- |
| `015_cms_editor`, `019_cms_asset_deletion_state` | Migrations editoriais versionadas e verificadas; sem grants de runtime e sem leitura/serviço ativo. |
| `033_academy_learning` | Migration ativa da Academy; suas tabelas próprias (`academy`, módulos, aulas e progresso) são consumidoras do runtime. |
| `034_owner_news_editorial`, `035_owner_news_polls` | Migrations editoriais versionadas para preservar ledger e dados; Owner News não é servido. |
| `cms_documents`, `cms_revisions`, `cms_assets` | Podem existir em bancos históricos; `portal_api`/`portal_cron` não recebem privilégios editoriais no candidato aprovado. |
| `owner_news_*`, votos, documentos e uploads privados | Preservados para auditoria/compatibilidade; endpoints antigos não são consumidores. `/uploads/cms-private` é 404. |
| documentação e relatórios Owner News/CMS | Mantidos como registros históricos, com o rótulo histórico; não representam a superfície atual. |

Nenhum item da tabela acima é removido pela OWN-45. Alterações futuras que decidam
limpar dados reais exigem um gate e autorização separados.

## Evidência e limites

OWN-43 aprovou o cluster PostgreSQL descartável separado, o ledger fresh/bootstrap,
upgrade, repetição, readiness, grants e preservação de hashes. OWN-44 inventariou
nominalmente as referências, removeu somente `public/js/cms-editor-values.js` sem
consumidores e renomeou helpers/testes compartilhados.

Isso não equivale a homologação full-stack em produção: Firebase, Nginx autenticado,
SMTP externo, mídia real e dispositivos físicos continuam pendentes quando indicados
na matriz de aceite.
