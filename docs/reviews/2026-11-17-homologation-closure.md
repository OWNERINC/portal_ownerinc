# Portal — fechamento D09/D08 e ensaios Linux

Data: 17/11/2026.
Candidato: `524e1319b9109f2ef6c28c144e10cda884d77f5f`.
Branch publicada: `fix/portal-readiness`.

**D09/D08 e CI Linux aprovados; homologação operacional integral ainda pendente.**

## Autorização e entrega

O usuário aprovou paginação de 20 cursos, posição/retorno/retry, mudança de cor
dos dois títulos Convidado inclusive PDF e execução na CI Linux isolada.
Revisou a especificação escrita (`e729e3e`) como **Documento correto**.
Especificação e plano estão em `docs/superpowers/`.

O candidato foi commitado/publicado na branch de homologação.
Main e produção não foram alteradas nesta etapa.

## Correções e revalidação local

- **D09:** 105 cursos acessíveis em seis páginas (20/20/20/20/20/5), sem omissão
  ou duplicação, em 1366/402 px. Links preservam `manage_offset`; retorno do editor,
  criação/cancelamento, reload, Back/Forward, retry/foco e catálogo do aluno
  exercitados pelo router real. URL inválida e página removida recuperadas.
  Permissão negada testada na UI/API.
- **D08:** somente `.guest-body .benefit-box h3` mudou para `#6f6250`.
  Browser mediu **4,758:1** sobre `#e9e6de` nos dois títulos e nas duas larguras.
- Provas específicas integradas: **8/8 PASS**.
- Jornadas de gestão Academy: **17/17 PASS**, incluindo rascunhos, guardas,
  mídia, ordem, gravação e troca de tipo de entrega.
- Exportações: **29/29 PASS** (25 PNGs 1080² e 4 PDFs). PDFs de uma página, renderizados
  com PyMuPDF; pixels desktop/mobile iguais por modelo. Owner idêntico ao
  baseline; Convidado mudou 4.350 pixels, restritos à região dos dois títulos.
- Axe: **20/20 estados sem violações**, mas **7 ocorrências incomplete/33 alvos**
  permanecem para inspeção manual. Não é aceite integral WCAG.
- `npm run verify` final: **1.280 testes / 1.276 PASS / 4 SKIP / 0 FAIL**.
- `npm run security`: zero vulnerabilidades reportadas em API e cron.
- Shell gerado/build Pages em `--check` e `git diff --check`: PASS.

Quatro harnesses finais totalizam 300 requisições, zero pageerror/serverErrors,
e 18 tabelas idênticas após reabertura em cada um.
Frontend/router/API/SQL foram reais localmente; banco PGlite serializado em
disco e identidades Firebase/SMTP de fixture. Essas provas não certificam
concorrência PostgreSQL, provedores externos ou recuperação operacional.

## Revisão independente e tentativas

Parecer final independente **ship** para D09/D08. Primeira revisão encontrou
offset seguro em JavaScript, mas acima do máximo 1.000.000 da API.
Regressão falhou antes da correção; frontend passou a respeitar o limite.
Nova prova integrada 8/8 e verify final concluídos.

A primeira repetição do runner Academy teve 13 PASS/4 FAIL: dois seletores
href exigiam a URL antiga sem `manage_offset`; dois cenários posteriores
dependiam do dado que deixara de ser criado. Runner/tentativa originais
preservados. Ajustados somente os dois seletores no runner novo; 17/17 PASS.

O revisor leu diff real, código, testes e cópias das evidências no repositório
(o sandbox impediu shell/acesso externo direto). Não executou testes.
Primary executou e conferiu as provas e o verify final.

## CI Linux

[Run 44166828544](https://github.com/OWNERINC/portal_ownerinc/actions/runs/44166828544),
`workflow_dispatch`, ref `fix/portal-readiness`, SHA exato do candidato.
Resultado: **SUCCESS**, concluído em 17/11/2026. Job `validate` aprovado.

- Ubuntu 24.04/PostgreSQL 16 nativos; clientes dump/restore 16.15.
- `npm run verify`: **1.288 testes / 1.286 PASS / 2 SKIP / 0 FAIL**.
  Skips: pranchas externas Pages (`PAGES_REFERENCE_DIR`) e suplemento PGlite
  041→042 (`PGLITE_MODULE_PATH`), ausentes nesse runner.
- Migrations/bootstrap/upgrade, schema, grants e readiness: PASS.
  Concorrência de aliases Pages observou quatro esperas de lock nativas em
  cada execução de migrations. Integração Academy nativa: **6/6 PASS**.
- Recuperação **DB-only** Pages: PASS. SQL/TOC do receiver, guardas de recusa,
  schema/ledger/dados, 040/041/042, restore pré-042/re-upgrade e paridade
  v3 de aliases/mídia/revisões conferidos.
- `nginx -t` na imagem fixada: PASS. Builds API/cron: PASS.
- Scans API/cron: PASS para HIGH/CRITICAL, com `ignore-unfixed: true`.
  Audit das dependências de produção: zero vulnerabilidades reportadas.
- SBOMs API/cron baixados e preservados.
- Autenticação/publicação GHCR e job **Deploy production: SKIPPED**, conforme
  a execução na branch de homologação.

Esses resultados fecham os ensaios nativos correspondentes. Configuração Nginx
aprovada não comprova proxy vivo; recovery DB-only não fecha uploads,
armazenamento externo nem retomada da stack.

## Gates que permanecem abertos

- Proxy Nginx em execução e stack operacional representativa.
- Carga 20→50→100/30 min com alvo/hardware, perfil/NAT, SLOs e critérios de parada.
- Firebase e SMTP reais: projeto/contas/remetente/caixa de teste designados.
- Restore integral: banco+uploads, destino descartável, armazenamento off-host
  e verificação de retomada.
- Dispositivos físicos/Safari/IME e aceite humano; incomplete axe.

Formulário assíncrono **Destinos das integrações reais** solicita somente os
destinos ainda ausentes; credenciais serão solicitadas por cartão privado.
Critérios de carga continuam no acompanhamento anterior.
Pages A18 e permissões/retenção de backups produtivos mantêm escopo próprio.
Documento oficial de Ética preservado.

## Evidências

`C:/Users/Criação/AppData/Local/Temp/opencode/portal-closure-20261117-r1/`:
`local-summary.json`, `tested-sources.json`, `integrity.json`, `review-final.md`,
logs locais/CI, metadados do run, SBOMs, runners originais/revisados, capturas,
PDFs, SQL e transportes. Manifesto SHA-256 sela o pacote final.

522 fontes testadas conferidas após o commit. Pacotes anteriores conferidos
contra seus manifestos, sem alteração: 8.681 arquivos da homologação ampliada
e 9.291 arquivos da correção anterior. Documentos/worktrees/capturas preservados.
