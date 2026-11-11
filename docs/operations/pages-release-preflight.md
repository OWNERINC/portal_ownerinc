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

O primeiro CI da feature (`43015229339`, commit `fcb1d6c`) encontrou outra
pré-condição ausente no runner: FFmpeg não instalado. Dois testes falharam com
`spawn ffmpeg ENOENT`; o ensaio PG16 não chegou a executar e produção foi pulada.
O workflow passa a instalar e verificar `ffmpeg`/`ffprobe` antes de `verify`,
sem pular os testes de mídia real ou alterar a imagem produtiva.
Após essa correção, `verify` local: 928 testes, 926 PASS, zero falhas, dois skips
Linux; revisão da alteração de CI: `ship`. Uma execução local anterior encerrou
o processo de `academy-catalog` sem diagnóstico de assertion; o arquivo isolado
e a suíte completa subsequente passaram, sem alteração de código da Academy.

O segundo CI (`43015699581`, commit `c98edc5`) passou `verify`, migrations,
readiness e Academy. O ensaio de recuperação parou antes do primeiro dump com
`spawn /usr/lib/postgresql/16/bin/pg_dump ENOENT`. Não houve teste efetivo do
restore, build/scan das imagens ou deploy nessa execução. O job de validação
passa a usar Ubuntu 24.04 e instalar explicitamente `postgresql-client-16`,
verificando as versões de dump/restore antes de iniciar os testes. Não se altera
o runner do job de deploy nem se substituem ferramentas 16 por outra major.
Correção revisada (`ship`); `verify` local com 929 testes, 927 PASS, zero falhas e
dois skips Linux. A instalação e recuperação nativas ainda dependem do novo CI.

O terceiro CI (`43016147355`, commit `ed80098`) executou dump/restore em PG16 e
reproduziu a falha esperada do restore legado por dependências Pages. A limpeza
restrita e o restore seguinte terminaram, mas a comparação textual de schema
falhou: o parser reagrupou ANDs em dois CHECKs de `autocard_cards`, removendo
parênteses associativos. Ledger/dados após recuperação e o backup posterior com
Pages ainda não foram aceitos nessa execução. Para evitar um falso negativo sem
ignorar constraints ou remover parênteses por regex, o ensaio agora restaura o
mesmo dump pré-Pages antes do upgrade e captura essa estrutura como referência.
Após a recuperação, compara integralmente tabelas/colunas/constraints/índices
contra essa referência restaurada; ledger e dados são comparados ao original.

## Resultado aprovado da preparação

CI [`43016622141`](https://github.com/OWNERINC/portal_ownerinc/actions/runs/43016622141),
commit `7c2c97b6a050b992c7a72f8356babdb794b3b7da`: **verde**.

- Linux: 938 testes PASS, zero falhas/skips; migrations, readiness e Academy passam.
- PostgreSQL16: falha legado reproduzida, alternativa restrita recupera schema,
  ledger e fixtures; upgrade repetido e backup posterior com Pages preservados.
- Build API/cron, scans configurados HIGH/CRITICAL, audit e SBOM aprovados.
- Imagens não publicadas e deploy de produção pulado por ser branch de feature.

Isso aceita o ensaio de banco de preparação, **não a integração de uma correção
no receptor instalado**. Essa integração tem seu próprio gate abaixo.

## Etapa operacional autorizada

O usuário autorizou verificar/corrigir/testar/instalar o receptor com backup,
sem restore/DROP/migration/restart no ambiente real durante a instalação.

Inspeção somente leitura confirmou o receiver comum root:root0755 com hash
`c976d36abb8ed70561eaf38dedf0b5b9bd72735d41a05b81bc196e4272bf500e`, idêntico ao
arquivo versionado antigo. A release atual é `2cecbe8`, ledger039 e Pages ausente.
API/cron/PostgreSQL saudáveis, Nginx rodando; cerca de24GB livres, volume de uploads
6,75MB e banco11,77MB no preflight (não equivalem ao tamanho de backups futuros).

O alias produtivo instalado é `/usr/local/sbin/portal-ownerinc-deploy-from-ci`,
com o conteúdo do wrapper de produção versionado; não é necessário alterar
chaves ou normalizá-lo para o caminho documental em libexec.

A correção candidata permanecerá em um único arquivo. Só permitirá cleanup
pré-tráfego após validar o dump real e seu inventário, com seis tabelas Pages
ausentes no backup e vazias no destino sob bloqueios/SQL transacional. Backups
com Pages não autorizam esse cleanup. Estados parciais, linhas, permissões,
RLS, dependências externas ou falha de ferramentas devem recusar a recuperação
automática sem reiniciar serviços. O ensaio executará a SQL produtiva exata e
testes funcionais executarão as funções Bash reais em ambiente simulado.

Depois de revisão e CI dessa integração, a instalação usará o lock de deploy,
hash anterior, backup verificável, sintaxe/hash do candidato e troca atômica do
receptor root:root0755. Não executar o receptor como teste de instalação.
`scripts/restore.sh` continua sem correção Pages: não o anunciar como fallback
automático para esse restore; procedimento manual segue exigindo escopo aprovado.

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
