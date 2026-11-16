# Autocadastro — integração local com Ética e Pages

Data: 12/11/2026. O usuário escolheu integrar na `main` **somente localmente**,
sem push nem deploy. A homologação Firebase real permanece pendente.

## Revisões e preservação

- Antes da integração, `main` local continha os dois commits de especificação e
  plano, mas estava dez commits atrás de `origin/main`.
- Base remota incorporada: `e2a855b327910a9004f6484468c1383545d0cfa4`, com
  Código de Ética, Pages/Editor V2 e correções de CI/receptor já publicadas.
  O run remoto `43025079235` estava verde, inclusive o job de deploy. Esse
  resultado comprova a revisão remota anterior, não o cadastro novo.
- Implementação do cadastro preservada no commit `b415366`.
- Merge local da base remota: `5c1e2ec`.
- Merge local do cadastro: `4582d2e`.
- Não houve conflitos textuais. Os testes integrados exigiram explicitar o
  aceite prévio de Ética nas fixtures administrativas; o gate real não foi
  removido nem afrouxado.
- Comparação com `origin/main` confirmou ausência de mudanças em `api/pages`,
  `public/pages`, módulos compartilhados de autenticação/retorno/Ética, termo e
  rotas de Ética, migrations, Nginx, receiver, workflow e manifests de build.
  Alterações de runtime continuam restritas ao cadastro/aprovação/recuperação.

## Contrato integrado

1. Nome, email e senha no cadastro; sem envio de confirmação por email.
2. Conta bloqueada até aprovação administrativa e habilitação concluída.
3. Login com a senha escolhida, mesmo sem email verificado.
4. `/api/users/me` permite bootstrap e informa `ethics_accepted` do servidor.
   Sem aceite vigente, o login encaminha para Ética e as demais APIs negam
   acesso com `ethics-required`. Aceitar o termo continua obrigatório para todos.
5. Pages mantém suas permissões, conteúdo, bundle e comportamento existentes.

O teste HTTP de jornada agora prova a negativa de área protegida após a
aprovação e antes do aceite. O teste DOM de login prova o encaminhamento ao
termo para conta aprovada/não verificada e a entrada no dashboard somente
quando o perfil indica aceite. O aceite real/versionado continua coberto pelos
testes existentes de Ética, sem inventar um bypass para o cadastro novo.

## Gates locais executados

- `npm ci`: dependências de ferramentas da raiz instaladas pelo lockfile atual,
  sem alteração dos manifests.
- `npm run verify`: **986 testes, 984 PASS, 0 FAIL, 2 SKIP** específicos de
  `flock`/symlinks Linux; sintaxe, nomenclatura, scanner e Compose aprovados.
- `npm run security`: zero vulnerabilidades de produção na API e no cron.
- `npm run check:pages-build`: bundle e avisos de licença atuais, sem escrita.
- `node scripts/generate-public-shell.mjs --check`: aprovado.
- `git diff --check`: aprovado.
- `node tests/visual/check-ethics.mjs`: 13 cenários de navegador aprovados,
  incluindo login/links diretos, papéis, gates e aceites; usa servidor loopback,
  Firebase e SQL substituídos.
- `node tests/visual/check-login-approved.mjs`: login, recuperação e cadastro
  aprovados em dez larguras (320–1920 px), axe sem violações automatizadas,
  foco, senha/confirmação e rolagem em 360 × 480/568/667; envios simulados.

Evidências de navegador fora do repositório:
`C:/Users/Criação/AppData/Local/Temp/opencode/registration-integration-20261112/`.
Detalhes da implementação original:
[relatório de 11/11](2026-11-11-registration-without-email-verification.md).

## Limite de entrega

Integração Git é local. Não houve push, PR, execução de CI para o cadastro novo,
reinício de serviço, deploy, alteração de funcionário ou teste em banco remoto.
Publicar requer decisão posterior; o push da `main` aciona o pipeline automático,
portanto não deve ser confundido com um upload inofensivo. A autorização desta
etapa não inclui esse push.

Antes de declarar a jornada real homologada, ainda é necessário testar cadastro
sintético, Firebase/senha original, bloqueio pré-aprovação, login pós-aprovação,
aceite vigente e recuperação de cadastros antigos disabled no ambiente aprovado.
