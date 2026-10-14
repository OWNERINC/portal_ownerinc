# Prévia funcional isolada do CMS Owner News — especificação

**Estado:** proposta revisada e preservada como referência; não implementada. Este documento autoriza somente a especificação; não autoriza build, início de serviços, migrations, acesso a banco, uso de credenciais reais nem alteração da autoridade de Owner News.

## Objetivo

Entregar uma demonstração local realmente funcional do CMS nativo Payload 3.90.2, acessível por uma entrada claramente identificada dentro do Portal. A pessoa deve conseguir entrar em um editor nativo, criar do zero uma publicação fictícia sem registro legado relacionado, editar título e conteúdo, enviar uma capa, salvar rascunho, consultar versões, publicar e abrir a leitura publicada.

O dado precisa ser real e durável **dentro do ambiente isolado da demonstração**: uma gravação deve sobreviver a reload do navegador e reinício autorizado dos serviços. Nenhum artigo, arquivo, autoridade ou sessão de produção é parte da demonstração. A prévia comprova fluxo de produto, não migração, cutover nem prontidão de produção.

## Decisões de arquitetura

### 1. Runtime e persistência realmente isolados

- Usar a versão já fixada de Payload `3.90.2`, Next.js e dependências; não instalar outro CMS, criar mocks de formulário ou simular persistência no browser.
- Executar um perfil/processo Payload de demonstração separado do runtime CMS existente, em projeto Compose local próprio, com **novo serviço/volume PostgreSQL** e **novo volume de uploads**. Não apontar para o Portal DB, `ownerinc_cms`, qualquer banco existente ou serviço remoto. Não montar volumes já existentes.
- Usar uma origem de demonstração própria servida por Nginx de demonstração, em porta escolhida/configurada para loopback (`127.0.0.1`/`localhost`) e não publicada na rede. A origem serve assets estáticos Ownerinc e encaminha apenas as rotas do CMS/reader ao processo demo. O PostgreSQL não publica porta ao host. O processo demo não tem conexão com API, Firebase, SMTP, cron, CMS worker, bridge/importador ou Payload de produção.
- O perfil demo é explícito e fail-closed: credenciais, `PAYLOAD_SECRET`, cookie prefix e storage próprios; não inicia sob `NODE_ENV=production`. Configuração ausente ou URL não loopback impede a inicialização. Um bootstrap único cria somente o usuário editor nativo sintético da base demo, a partir de segredo fornecido no ambiente privado; não cria artigos nem exibe segredo em logs. O cadastro aberto de usuários permanece desabilitado.
- As migrations e tabelas necessárias são próprias do perfil/base demo. Nenhuma das seis migrations nativas Owner News existentes, snapshots ou migrations de produção é editada, aplicada em banco existente ou reutilizada para alterar seus dados. `push` de schema não é habilitado.

### 2. Modelo demo apartado, com editor e versões nativos

Criar coleções próprias, com slugs inequívocos como `demo-news-publications`, `demo-news-media` e `demo-editors`. A coleção editorial deve ter somente o essencial para esta jornada:

- título;
- corpo Lexical/Rich Text editável nativamente;
- relação de capa para a mídia demo;
- status nativo Draft/Published e versões/drafts do Payload.

O ID da publicação é gerado pelo Payload/DB. Não há `legacyDocumentId`, importação, registro Owner News do Portal, `NewsDTO`, referência a artigo existente, vínculo a pessoa real, agenda ou histórico importado. O upload aceita imagens para a capa e persiste bytes fora do checkout, no volume dedicado; não os grava sob `public/` nem no upload legado.

O ciclo de escrita usa a UI, REST, Draft/Versions e publicação nativos do Payload. Autosave/Save Draft e histórico devem persistir no banco demo, não em estado local. Uma edição de um artigo já publicado pode ter rascunho novo sem substituir o conteúdo que o leitor ainda vê: o reader consulta exclusivamente o documento publicado. Agendamento e jobs ficam desabilitados.

Não pré-semear publicação de exemplo. O usuário começa com a coleção vazia e cria a matéria fictícia do zero. Para aceite, usar texto explicitamente fictício e uma imagem sintética de teste.

### 3. Identidade sem ampliar a autenticação de Owner News

O link aparece na área CMS do **Portal local** somente para usuário autenticado com `manageKnowledge` e quando a demonstração foi explicitamente configurada. A API do Portal devolve uma URL fixa validada como loopback; o browser não pode fornecer uma URL de redirecionamento. Sem a flag/configuração local, a rota não oferece o link; a produção nunca o mostra.

A demonstração usa um usuário/sessão local nativo do Payload na base isolada e pede login próprio nessa prévia. Essa separação é intencional: não reutilizar a sessão Payload editorial/Portal, cookie, Firebase, UID real nem o endpoint de resolução v1/v2. O link do Portal abre a origem de demonstração em nova página/aba e declara claramente que é uma base local separada, não sincronizada e sem SSO. Não apresentar o login demo como login Portal.

Este design mantém sem alteração os guards, DTOs e contratos existentes (`canWriteNews`, `canReadNewsArea`, ator v1/v2, `owner_news_authority`, bridge e `/api/cms/session`). As coleções `news-articles`/`news-media` e seus gates continuam indisponíveis para escrita quando sua autoridade não permite; nenhum toggle/flag do demo pode fazê-las aceitar escrita.

### 4. Entrada e experiência visual sem painel vazio ou UI falsa

- Acrescentar ao hub CMS do Portal uma ação `Prévia funcional do novo CMS`, visível só no ambiente local autorizado e para `manageKnowledge`. O texto informa “base isolada” e “login próprio”. A entrada continua dentro do Portal; a navegação abre a UI real do Payload nativo em sua origem local dedicada, não um iframe nem uma tela estática de demonstração.
- No Payload, abrir uma home de demonstração com chamada funcional para **Criar publicação** e acesso à lista real da coleção demo. Ambos levam a rotas/componentes admin nativos do Payload; não são botões que fingem salvar ou abrem um formulário paralelo.
- Mostrar identificação persistente `DEMO LOCAL · CONTEÚDO FICTÍCIO · BASE ISOLADA` dentro da administração/reader.
- Reutilizar a marca/Logo, Icon, tema e CSS responsivo do Payload Ownerinc aceito quando independentes da sessão Portal. Não reutilizar componentes que emitem, revogam ou observam sessão editorial, nem a home que afirma que outras áreas continuam no CMS central. O logout demo é somente o logout da sessão local Payload.
- Depois que a versão publicada foi persistida, oferecer no documento um link `Ver publicação publicada` construído do ID persistido. É uma navegação ao reader descrito abaixo, não uma prévia de rascunho nem simulação de publish.
- Depois da publicação, disponibilizar uma página reader real da origem demo por ID/UUID persistido. Ela lê apenas publicações `Published`; rascunho, versão antiga e ID inexistente retornam não encontrado. A capa exibida é a relação persistida e o arquivo original do volume demo. O endpoint de leitura não expõe versões/rich text de rascunho. A UI fornece acesso a esse resultado sem criar conteúdo artificial.

“Dentro do Portal” nesta proposta significa entrada no hub do Portal e fluxo contínuo para outra página de mesma demonstração local; não significa incorporar Payload por iframe ao shell. Isso preserva a interface admin nativa e a separação de origem/cookie. Se a expectativa for editar dentro do DOM/layout do shell Portal, essa é uma mudança de arquitetura que precisa ser aprovada antes do plano.

## Limites de segurança e operação

- Somente conteúdo/arquivos fictícios e não sensíveis. Os uploads ficam em storage privado dedicado; o reader local pode entregar apenas mídia da publicação demo já publicada. A origem loopback e o escopo dos dados devem ser verificados, não presumidos.
- Não usar conta, senha, perfil, conteúdo ou arquivo real do Portal; não copiar dados de `announcements`, `cms_documents`, Payload existente, Firebase ou backups. Não incluir segredos no Git, bundles, prints ou relatórios.
- Sem email/SMTP, Sólides, Firebase, analytics, tarefas agendadas, cron, worker, importação, autoridade, reconciliação, assinatura, cutover ou leitor público. Não alterar a navegação/entry de Owner News existente nem expandir o aceite das outras áreas do CMS.
- Não publicar a porta da demonstração em interface pública/VPS. Não adicionar link à navegação de produção. Não modificar script de deploy.
- Os volumes são persistentes para demonstrar reload/restart; setup e cleanup devem nomear somente o projeto/volumes demo. Não apagar volumes automaticamente e não usar limpeza genérica que possa atingir o Portal ou o CMS existente.
- As rotas mutáveis do Payload demo continuam protegidas por autenticação Payload e Origin exata da própria origem de demonstração; requests cross-site são negadas. Cookie demo tem prefixo distinto. Falha de DB/storage/upload deve ser estado de erro visível, nunca sucesso otimista.

## Escopo de implementação esperado após aprovação

O próximo plano deve permanecer limitado a esta fatia e cobrir, no mínimo:

- um config/perfil Payload demo opt-in com editor local, coleções e migrações namespaced; uma rota de leitura que só publique estado persistido;
- teste de perfil que prove que config default/produção, News DTO, guards e authority ficam inalterados e que demo recusa configuração não loopback/produção;
- Compose e Nginx dedicados a DB, uploads e origem demo loopback; não reutilizar o projeto/volume CMS atual;
- ação condicionada no hub CMS local e endpoint Portal de URL fixa loopback, sem alterar emissão/resolução/revogação de sessão do Portal;
- uma home demo pequena com links ao create/list nativos, marca visual reaproveitada e texto que explicite o login/base separados;
- migration/bootstrap explícitos e seguros para a base demo, que nunca escolham fallback de URL de banco e falhem antes de escrever se a identidade não for a base configurada como demo;
- testes offline de guards/config/UI e teste real autorizado de Payload/PostgreSQL/browser, incluindo upload e bytes originais.

Arquivos de implementação prováveis (não alterados nesta especificação): `cms/src/payload.config.ts`, novos módulos `cms/src/demo/` e rotas `cms/src/app/`, `cms/src/proxy.ts`/layout para a origem exata, scripts e testes CMS, `docker-compose.payload-demo.yml`, `nginx/payload-demo.conf`, route/config e teste API do link local, `public/cms.html`/`public/js/cms.js`, e runbook `docs/operations/payload-demo.md`. Tipos/import map/schema gerados devem ser tratados como saída derivada e nunca editados manualmente. O implementador deve confirmar o inventário final antes do plano.

### Protegidos — não alterar para entregar a demo

- `cms/src/news/**`, `cms/src/auth/**` e os contratos/guards de escrita/leitura existentes, exceto integração mínima explicitamente revisada para a seleção fail-closed do perfil;
- as seis migrations aplicadas Owner News e seus snapshots, os bancos/volumes/credenciais existentes, API de autoridade e rotas de importação/cutover;
- runtime, Compose, Nginx, arquivos estáticos, contas e dados de produção; credenciais Firebase/Portal/DB/SMTP; deploy.

Qualquer necessidade de escrever nesses alvos ou de depender do banco/sessão Portal para persistir conteúdo suspende a implementação para revisão de escopo. Esta demo não reutiliza as coleções de notícia de produção nem desativa seus guards para “fazer o botão funcionar”.

## Aceite funcional

Com uma base demo física nova e serviços locais autorizados:

1. A API/config default continuam sem mudança observável; perfil demo ausente/desligado não mostra link e perfil demo em `production`, com URL externa ou sem DB/storage próprios recusa inicialização. URL do link não é controlável pelo browser. O link autorizado só é retornado a ator Portal atual com `manageKnowledge`.
2. Abrir a ação do hub entra na origem demo, mostra banner e login Payload próprio. O operador entra sem usar senha/UID/ficha Firebase/Portal. A home apresenta criação e lista reais, não dashboard fictício vazio.
3. Criar publicação sem ID/link legado, gravar título e texto fictícios, enviar capa sintética JPEG/PNG/WebP, salvar rascunho e fazer reload: título, rich text, relação da capa e bytes/hash continuam disponíveis na base/volume demo; leitor anônimo não mostra rascunho.
4. Editar/salvar de novo produz histórico/versionamento nativo consultável; não há linha em `news-articles`, `news-media`, Portal nem registro legado. Publicar habilita a leitura real da matéria e sua capa. A leitura só mostra estado publicado; um rascunho posterior não substitui a última publicação visível.
5. Reiniciar somente os serviços identificados pelo projeto demo conserva login após reautenticar, registros, versões e bytes. Nginx/Compose bindam só loopback; DB não tem porta host publicada. Nenhuma chamada sai para email, Firebase de produção ou serviço externo.
6. Executar os checks offline do CMS/API, scanner de segredos e `git diff --check`. A aceitação browser/DB deve ser registrada separadamente e só após aprovação para criar/usar a fixture demo; sucesso de build/config ou captura visual sozinho não satisfaz aceite funcional.

## Não objetivos

- Não é substituto de Owner News, migração, piloto, cutover, teste de produção ou prova de compatibilidade dos registros antigos.
- Não migra as 19 matérias observadas, não insere notícia de exemplo, não lê conteúdo legado e não demonstra importação.
- Não ativa `owner_news_authority`, não altera gates, não dá permissão genérica de escrita News a ator Portal v2 e não reutiliza endpoints do DTO de leitor.
- Não implementa edição completa de agenda, polls, home/global, múltiplas editorias, imagens inline, permissões por editor, aprovação/revisão editorial, e-mail, analytics ou publicação programada.

## Base verificada nesta proposta

- `cms/package.json` fixa Payload e pacotes de admin/rich text em `3.90.2`.
- `cms/src/payload.config.ts` integrações atuais usam PortalEditors, `/editorial/admin`, `/editorial/api`, `news-articles`, `news-media`, Lexical e uploads com limite de 50 MiB.
- `cms/src/collections/NewsArticles.ts` já configura native drafts/autosave; seu write access continua exigindo o ator News estrito. `NewsMedia.ts` e `news/blocks.ts` confirmam os atuais vínculos de mídia e suas proteções.
- `docs/architecture/payload-native-admin-gate3b2.md` separa o ator Portal v2 do escritor News e afirma que a entrada administrativa não implementa CRUD Owner News.
- `docs/operations/payload-preview.md` é prepare-only, não semeia admin/conteúdo, não altera autoridade e não constitui editor funcional. A presente proposta não reutiliza sua fixture ou volumes.
- `cms/src/admin/Brand.tsx`, `cms/src/app/(payload)/editorial.css` e o aceite delimitado `docs/reviews/2026-10-08-payload-native-admin-acceptance.md` são referências visuais/nativas; esse aceite não comprova edição/publicação.
