# Acompanhamento das issues — 28/09/2026

## Escopo e evidências de versão

Revisadas as issues abertas #1–#11 e #36–#38 de `OWNERINC/portal_ownerinc`.
Nenhuma homologação externa foi presumida concluída por testes locais.

- Base local: `d89209b`, contida em `main` (comparação GitHub: ahead 0, behind 1).
- `main`: `3062cc7e2304286dd44f8bca56eeee074c495979`.
- [Workflow 36137451587](https://github.com/OWNERINC/portal_ownerinc/actions/runs/36137451587):
  `validate` e `Deploy production` concluídos com sucesso.
- Comparação de conteúdo confirmou que `public/autocard/app.js`,
  `cron/autocard-media-retention.js`, `cron/index.js`, `scripts/backup.sh`,
  `scripts/restore.sh` e `scripts/backup-s3.sh` locais já estão na `main`.
- O workflow informa deploy bem-sucedido; a revisão/digest dos containers em
  execução não foi consultada por SSH nesta execução.

## Correções desta entrega

### #36 — Origem pública e porta do proxy

Todas as locations de proxy do Nginx removem `X-Forwarded-Port`, usando a
autoridade pública completa já encaminhada por `X-Forwarded-Host`. Isso evita
confundir o listener interno 80 com a porta HTTPS pública. A política CORS da
API permanece restrita à origem reconstruída e às origens explicitamente
configuradas. A borda deve preservar Host e protocolo públicos.

O smoke verifica health com `Origin`, além dos checks anteriores. Uma regressão
executa o script Bash contra um servidor HTTP local: falha quando apenas o GET
com Origin é recusado e passa quando a origem é aceita. Testes cobrem HTTPS
padrão, HTTPS com porta não padrão, HTTP local, IPv6 e origens indevidas.

### #37 — Feedback e substituição de imagem

`APIError` preserva `requestId` nas respostas JSON e de mídia. Cards Pós exibe
feedback específico da imagem por modelo, em português, independente do status
do PDF. A mídia anterior só é substituída quando a nova imagem autenticada
carrega; uma falha libera o blob provisório e preserva a anterior. O input é
limpo após a seleção para permitir repetir o mesmo arquivo. A validação local
inclui o limite de 3 MB já imposto pelo backend.

Regressões cobrem POST recusado, leitura de mídia recusada, imagem inválida,
prontidão antes da troca, recuperação, isolamento entre modelos e persistência
do feedback após exportar.

### #8–#11 — Implementações existentes

Foram mantidas as implementações já presentes na `main`. A cobertura do
AutoCard foi complementada com execução dos handlers reais de editar,
duplicar e excluir em falha/sucesso, falha de captura e recuperação do botão,
e revogação da URL local em `onload` e `onerror`.

A retenção existente usa janela padrão de sete dias, advisory lock compartilhado
com as mutações dos cards e limpeza dos namespaces AutoCard e Cards Pós. Os
testes de cron verificam a limpeza de órfãos; a rotina em produção ainda exige
conferência de configuração, heartbeat, grants e auditoria pelo operador.

## Validação no navegador

Verificações finais: `npm run verify` aprovou **537 testes**, sem falhas ou
skips, incluindo sintaxe, invariantes, scan de segredos e configuração Compose.
`git diff --check` passou. A revisão independente não encontrou bloqueios;
a sugestão de cobertura de descarte durante `image.decode()` foi incorporada
com o lifecycle real e aprovada na suíte final.

`npm run security` passou no limiar configurado (`high`), mas informou três
vulnerabilidades moderadas na árvore de produção da API (`qs` e seus dependentes
Express/body-parser). O cron não apresentou vulnerabilidades. As dependências
não foram alteradas nesta correção de proxy/upload; esse resultado não significa
uma auditoria sem achados.

Playwright com Google Chrome 153, frontend e bibliotecas reais, APIs simuladas
somente no ambiente de teste:

- PDFs reais baixados para Convidado e Owner com foto padrão e foto enviada.
- Foto de diagnóstico vermelha/verde identificada pelos pixels do canvas
  incorporado no PDF, inclusive nos viewports de 768 e 320 px.
- POST 403 com referência de suporte; exportação preserva o aviso de upload.
- Falha de decodificação mantém foto anterior; terceira tentativa com o mesmo
  arquivo conclui a substituição.
- Status isolado por modelo, botão de upload focável e associado ao live status.
- Sem overflow horizontal nas larguras testadas e sem erros JS capturados.

Esses testes não equivalem à sessão original do relato, a Safari/iPhone, nem a
uma execução com NVDA/VoiceOver. Os artefatos contêm apenas conteúdo de teste e
ficam no diretório temporário local, não no repositório.

## Situação de todas as issues

| Issue | Situação nesta entrega | Evidência ainda necessária |
|---|---|---|
| #1 | Scripts existentes; Docker local indisponível | Restore completo em Linux isolado, checksum, banco, uploads, roles, smoke e RTO ≤ 4 h |
| #2 | Checagens locais de teclado/status e layout dos Cards Pós | Jornadas completas com NVDA/VoiceOver e zoom 400% |
| #3 | Implementação usa Firebase e Resend SMTP; referência antiga a SendGrid deve ser atualizada na issue | Entrega real, expiração/revogação de sessão, lembrete, retry e alertas com contas de teste |
| #4 | Scripts de backup e envio S3 já estão na main | Bucket/role, retenção, agendamento, falha de upload e restore de cópia externa; RPO ≤ 24 h |
| #5 | Domínio apresentou TLS 1.3 válido e HTTP → HTTPS 301 | Renovação, firewall, bindings e portas da VPS |
| #6 | Workflow recente de deploy concluído | Backup e digests efetivos; ensaio de rollback e integridade em ambiente autorizado |
| #7 | Encerrada com evidência: V1 `fd45dc1` e base/hardening contidos na main; CI e deploy recentes verdes | Concluída; novas correções continuam nas issues específicas |
| #8 | Tratamentos existentes e regressões de sucesso/falha aprovadas localmente | Homologação autenticada da versão publicada |
| #9 | Prontidão existente e regressões de exportação/erro/recuperação aprovadas localmente | Homologação autenticada após corrigir origem |
| #10 | Liberação em finally já existente; onload/onerror cobertos | Registrar revisão e testes |
| #11 | Retenção implementada e testes locais aprovados | Agendamento, permissões e resultado real da execução |
| #36 | Correção e regressões locais implementadas | Publicar e repetir upload real pelo domínio público |
| #37 | Correção e regressões locais implementadas | Publicar e homologar mensagens/recuperação |
| #38 | Fotos presentes nos PDFs locais; relato ainda não reproduzido | Card/PDF afetado, navegador/dispositivo e reteste de mídia personalizada em produção |

## Limites operacionais encontrados

- Docker CLI existe, mas o daemon Linux não está disponível.
- Não há configuração SSH local disponível para consultar a VPS; os secrets de
  deploy do GitHub não fornecem shell interativo nesta sessão.
- AWS CLI não está disponível e nenhum destino/role S3 foi fornecido.
- Não foram fornecidos o card/PDF afetado nem ambiente físico VoiceOver/NVDA.

Não foram executados restore, limpeza manual de mídias, mudanças de firewall,
troca de credenciais ou rollback em produção. As pendências acima exigem os
ambientes/acessos correspondentes; não são resolvidas criando código duplicado.
