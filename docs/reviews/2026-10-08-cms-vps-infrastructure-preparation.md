# Preparação inativa da infraestrutura CMS na VPS

Data: 2026-10-08. Alteração autorizada pelo usuário: atualizar o receptor de deploy
e configurar a infraestrutura necessária ao CMS. Preparador revisado no commit
`0501bb8`, após a implementação inicial `7cfd8ce`.

## Execução e evidência

- `--check` na VPS: exit 0; configuração Compose combinada válida.
- `--apply`: exit 0; backup privado anterior às alterações, sem iniciar serviços.
- Receiver `/usr/local/libexec/ownerinc-portal-deploy`: bytes iguais ao bundle
  revisado; proprietário/grupo `root:root`, modo `0755`.
- `runtime/payload-operations-guard`: bytes iguais ao bundle; `root:root`, `0755`.
- `runtime/compose.payload.production.yaml`: bytes iguais ao bundle; `root:root`,
  `0644`; selecionado pelo receptor apenas para produção `payload-v1`.
- Configuração CMS validada como completa. O arquivo privado preservou uid/gid
  `1000:1000` e modo `0600`; nenhuma credencial integra este relatório.
- Referência candidata da imagem registrada separadamente do manifesto ativo:
  `ghcr.io/ownerinc/ownerinc-portal-cms@sha256:6eaddc9a333ba682508a09a4ae8a6409d9e571abab9ec4a62829c2e9828730b0`.

Backup privado:
`/opt/ownerinc/backups/portal-ownerinc/production/cms-infrastructure-preparation-20261008T174857Z-8a5b97f2-8464-468a-aa08-9b4406381e25`.

O primeiro check recusou permissões de grupo no diretório do bundle recém-extraído;
foram corrigidas apenas nesse bundle. O check seguinte identificou a ausência de
`PORTAL_PUBLIC_URL` no ambiente privado. O ajuste revisado acrescenta a origem
canônica somente na primeira preparação sem credenciais CMS; valores explícitos
divergentes continuam recusados.

## Estado após aplicação

- Release ativo: `d285029970c82d48cd50cc393a054af4cbfdf1e8`.
- `GET /api/ready`: HTTP 200.
- `GET /editorial/admin`: HTTP 502; CMS ainda inativo.
- Consulta de autoridade Owner News: `legacy|1`.
- Não houve criação de banco/volumes CMS, migrations, início de worker, importação,
  cutover, alteração de chaves SSH ou reinício de serviços nesta preparação.

## Pendências para iniciar e aceitar o CMS

O adapter durável `runtime/payload-control` e o suporte comprovado de
backup/recuperação continuam bloqueantes para o release completo. A API ativa
também não contém o contrato de sessão v2 exigido pelo painel novo. Esta evidência
aceita somente a preparação inativa; não aceita runtime, login, CRUD, publicação,
jobs ou ativação editorial.
