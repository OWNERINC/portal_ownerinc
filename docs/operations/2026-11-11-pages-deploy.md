# Deploy Pages / Editor V2 — 11/11/2026

## Autorização e escopo

Usuário autorizou deploy, preparação corretiva e depois verificação/correção/
instalação do receptor com backup. Portal somente; Brain, outras worktrees e a
main local divergente preservados. Nenhuma concessão de capacidades nem publicação
de piloto sintético foi incluída na autorização de deploy.

## Preparação e receptor

- CI `43021688751` no commit `293a590`: 965 testes Linux PASS, zero falhas/skips,
  migrations, recuperação PG16 com SQL produtiva exata, build, scans e audit.
- Receptor comum instalado sob lock em11/11 às12:38:58Z, root:root0755,
  SHA-256 `614311d154042c61d362a6b26cfe2ff4cd984de1d12ad116df5850389bd7d658`.
- Antigo SHA-256 `c976d36abb8ed70561eaf38dedf0b5b9bd72735d41a05b81bc196e4272bf500e`
  preservado em `/usr/local/libexec/ownerinc-portal-deploy-backups/receiver-before-pages-20261111T123858Z-OO0wOF.sh`.
- Alias SSH existente preservado. Instalação foi somente de arquivo, sem executar
  receiver, migrations, restore, DROP ou restart.
- PR99 e CI `43022294038` aprovados; merge `6221a09d0ccc34bd16b8756dc76d51064010102e`
  com árvore idêntica à feature validada.

## Primeira tentativa produtiva e rollback

CI `43022650901`: validação e publicação de imagens passaram. Deploy falhou na
readiness pública depois de iniciar o container Nginx. API/cron haviam passado
pelos gates internos; migrations040/041 e verificador de schema passaram.

O receptor marcou `public_started=true` e preservou o banco, sem restore
automático, retornando o código para `2cecbe847db7e7b88bbb33c7463aa0260d265cfc`.
Esse marcador não prova que usuários aceitaram tráfego ou gravaram dados.

Após rollback, readiness respondeu ready; API/cron/PostgreSQL saudáveis e Nginx
rodando. Consulta somente leitura confirmou ledger040/041. Backup mantido:
`/opt/ownerinc/backups/portal-ownerinc/production/20261111T124530Z-autodeploy-6221a09d0ccc`.
`sha256sum --check --strict manifest.sha256`: dump e uploads OK. Não se executou
restore manual nem se removeu schema ou conteúdo para repetir o deploy.

## Causa reproduzida e correção

Teste isolado com a imagem Nginx exata de produção, sem rede/portas publicadas e
com config read-only, retornou:

```text
unknown directive "36}/media/?$" in /etc/nginx/conf.d/default.conf:204
```

O quantificador `{36}` da regex de upload estava sem aspas, sendo interpretado
pelo parser de configuração em vez de apenas pelo motor de regex. A correção
candidata coloca a expressão inteira entre aspas, sem alterar seu padrão, e
adiciona `nginx -t` com a imagem fixada ao CI. Não altera a configuração ativa da
VPS à mão; a nova tentativa seguirá PR/CI/deploy oficial.

## Estado de aceite

Correção candidata aplicada. A primária repetiu o mesmo `nginx -t` isolado com
imagem exata: syntax ok / test successful. `verify` local: 959 testes,957 PASS,
zero falhas,dois skips Linux; diff aprovado. Nova revisão, CI e nova tentativa
produtiva ainda pendentes neste registro. Não considerar Editor V2 publicado
somente porque o merge existe na main ou o ledger contém040/041.
