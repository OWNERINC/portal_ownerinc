# Primeira release Pages — gate operacional

Status em 11/11/2026: **não promover à main antes de fechar a recuperação**.
O usuário autorizou corrigir, validar e retomar o deploy; uma eventual atualização
do receptor instalado na VPS exige autorização operacional específica.

## Escopo verificado

- Candidato original: `5143794`, baseado diretamente em `origin/main=2cecbe8`.
- Produção oficial `https://portal.ownerinc.com.br` respondeu health/ready no
  preflight; o último CI/deploy da main estava verde. Isso não prova a revisão do
  receiver instalado ou o estado das tabelas no banco real.
- Auditoria API/cron sem vulnerabilidades e archive de 7.301.694 bytes, dentro do
  teto de 10 MiB. Não foi feito push/merge/deploy durante a análise inicial.
- A main dispara produção após validate, sem regras de aprovação reportadas no
  ambiente GitHub. Usar somente branch de feature para o CI de preparação.

## Correção do teste portátil

O helper de mídia pressupunha `tmpdir()/opencode` já criado. Em temporário limpo,
a primária reproduziu ENOENT em mkdtemp antes de executar FFmpeg. A correção cria
o pai de forma idempotente e mantém os casos reais de decode; não pula Linux nem
modifica o caminho de mídia produtivo.

## Ensaio nativo de banco

`scripts/test-pages-recovery.mjs` exige NODE_ENV=test, autorização de banco
descartável, cluster system_identifier correspondente, conexão loopback, nome
dedicado `portal_test_pages_recovery`, PostgreSQL16 e banco inicialmente vazio.
Exige porta, usuário e senha explícitos na URL e rejeita query/fragmento para
impedir destinos diferentes entre o driver e as ferramentas de dump/restore.
O CI cria esse banco no serviço efêmero; não é o banco de produção.

O ensaio executa migrations reais até039, semeia usuário/cargo fictícios e cria
dump custom com checksum. Depois aplica 040/041 pelo runner real e tenta o mesmo
pg_restore legado do receiver, após a preparação limitada a tabelas de cadastro.
A falha esperada por novas FKs identifica a lacuna da primeira transição Pages.

Somente no banco do ensaio, valida a alternativa de remover as tabelas Pages
criadas pelo próprio teste, ausentes do dump e ainda vazias, em ordem explícita
e sem CASCADE genérico. Restaura o dump e compara schema, ledger/timestamps e
dados fictícios. Reaplica as migrations e testa um segundo backup já com Pages:
esse backup deve preservar a página/revisão, sem apagar Pages indiscriminadamente.

**O ensaio não instala nem corrige o receiver da VPS.** Também não simula o
receiver completo, retomada da API/cron, volume de uploads ou autenticação real.
Um PASS de banco não deve ser chamado de aceite operacional completo.

## Condições antes de produção

1. Correções revisadas e CI da feature verde, incluindo PG16, scan e imagem.
2. Evidência da revisão efetivamente instalada do receiver e do procedimento de
   recuperação da primeira transição Pages, confirmada por operador autorizado.
3. Caso o receiver precise mudar: autorização específica, instalação controlada
   e ensaio operacional. Alterar o arquivo no archive não instala o binário do
   host, e a chave CI forced-command não concede shell administrativo.
4. Só então promover remotamente para main sem alterar a main local divergente.
   Exigir validação do SHA final, imagens por digest, backup verificado, migrations,
   readiness, smoke, cron e marcador de release.
5. Não conceder permissões reais nem publicar o piloto sintético em audiência
   real como efeito implícito do deploy. Aceite autenticado usa acessos já aprovados.

Não executar remoção das tabelas Pages em um banco real só por serem novas no
código: backups futuros podem contê-las com dados legítimos. Uma recuperação
produtiva destrutiva precisa comprovar escopo, backup, janela e autorização.
