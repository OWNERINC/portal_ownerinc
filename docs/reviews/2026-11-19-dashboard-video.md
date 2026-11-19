# Dashboard com vídeo — implementação e evidência local

## Escopo

Proposta da conversa: reduzir a informação da abertura, usar o vídeo aprovado
`https://youtu.be/VAhBJOKc3-s`, manter o Código de Ética logo abaixo e deslocar
atalhos/notificações/ferramentas para a parte inferior.

Branch `feat/dashboard-video`, baseada na release `0a2a58d`. Sem push, merge,
deploy, mudança de conta ou acesso ao banco produtivo nesta implementação.
Plano de execução em `C:/Users/Criação/.opencode/plan/2026-11-19-dashboard-video.md`.

## Comportamento

- Saudação curta, primeiro nome como texto e horário de São Paulo preservados.
- Vídeo 16:9 até 880 px, com miniatura local do próprio vídeo escolhido.
  Fonte da capa: `https://i.ytimg.com/vi/VAhBJOKc3-s/maxresdefault.jpg`.
- Sem iframe, thumbnail externa ou preconnect antes do clique. Botão **Carregar
  vídeo**, aviso de conexão externa e fallback **Abrir no YouTube**.
- Iframe no host `youtube-nocookie.com`, ID fixo, `autoplay=0`, reprodução inline,
  tela cheia e referrer compatível com o provedor.
- Loading, erro/retry e limite de 15 segundos para aguardar o load do iframe.
  Um load não prova reprodução nem permite detectar toda restrição do provedor.
- Fonte/listeners/timer removidos em navegação e pagehide. BFCache não reconecta
  automaticamente. Eventos antigos não alteram uma tentativa nova.
- Capa, ação e consulta autenticada de Ética preservadas, sem mudar termo/aceite.
- Links com ícone/nome, sem descrições longas; duas colunas no celular e uma em
  até 360 px para evitar que nomes sejam quebrados. Permissões atuais preservadas.
- Nenhuma nova dependência, API, migration ou alteração de Nginx/deploy.

## Verificação determinística

- Baseline antes das mudanças: `npm run verify`, 1.288 PASS, 4 SKIP, zero falhas.
- Novos testes primeiro falharam na implementação antiga: 10 falhas/19 casos
  focais, incluindo ordem, saudação, atalhos e consentimento.
- Após implementação: 53 testes focais PASS, incluindo fluxos existentes de
  Ética e notificações; 8 regressões novas específicas do vídeo.
- `npm run verify`: 1.300 testes, 1.296 PASS, 4 SKIP, zero falhas; security/compose
  checks concluídos. `git diff --check` sem erros.
- `check-portal-welcome.mjs`: 7 cenários PASS; 320/390/768/1366 px sem overflow,
  ordem geométrica correta, teclado/foco, permissões, leitura oficial, histórico,
  erro/retry, DOM opcional e descarte. Axe no conteúdo local anterior ao player:
  zero violações e zero incompletos nas quatro larguras.
- SQL/API Knowledge em PGlite descartável; Firebase, notificações, Academy e
  transporte YouTube são fixtures explícitas. Player stub não prova reprodução.
- BFCache usa eventos persistidos simulados; não é teste físico Safari/mobile.

Evidência final determinística:
`C:/Users/Criação/AppData/Local/Temp/opencode/dashboard-video-20261119-r4/`.
A primeira rodada visual falhou por procurar um botão já oculto na árvore
acessível; o teste passou a despachar o clique sintético por ID. Rodadas anteriores
permanecem preservadas e não substituem o resultado final.

## Reprodução real separada

`check-dashboard-video-live.mjs` é opt-in e usa uma prévia loopback própria com
autenticação/API simuladas e a CSP versionada do Portal. Não usa sessão produtiva.

Execução final:
`C:/Users/Criação/AppData/Local/Temp/opencode/dashboard-video-live-20261119-r4/`.

- Zero contato com YouTube antes do clique.
- Player real do vídeo escolhido navegou no host no-cookie.
- Após ação explícita no botão de reprodução do YouTube, `currentTime=2.007589`,
  `duration=75.381`, `paused=false`, `adShowing=false`.
- Título real: **Owntime Home Club Gramado - Andamento das Obras (Maio 2026)**.
- Zero pageerrors; resultado `STARTED`. Não certifica reprodução integral,
  disponibilidade futura, captions ou todos os navegadores/dispositivos.
- As rodadas r1/r2 não comprovaram reprodução por seletores desatualizados do
  teste: o player atual usa **Assistir vídeo**. A correção foi apenas no teste,
  sem alterar o iframe ou relaxar a CSP. r3 iniciou; r4 exigiu pelo menos 2 segundos.

## Documentação e entrega

Brief, inventário, guia Markdown e instruções de testes foram atualizados.
O guia Markdown identifica explicitamente que o PDF continua na edição anterior
de 18/11/2026; não se afirma que o PDF foi regenerado.

Revisão independente read-only concluída sem achados P0/P1/P2; o revisor executou
19 testes focais e conferiu diff/checks/capturas. A reprodução avançando pelo
menos dois segundos foi conferida pela primária na rodada live r4.
Prévia e autorização de publicação permanecem etapas separadas; nenhuma
autorização de deploy do cadastro se estende automaticamente a este Dashboard.
