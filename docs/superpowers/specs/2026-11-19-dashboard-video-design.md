# Dashboard com vídeo e Código de Ética

## Proposta aprovada na conversa

O usuário pediu para reduzir a informação da abertura e mover os acessos para
baixo. Escolheu o vídeo não listado `https://youtu.be/VAhBJOKc3-s` e autorizou
continuar a implementação em 19/11/2026.

Ordem no Dashboard:

1. Saudação curta, com primeiro nome e horário de São Paulo.
2. Vídeo em destaque: **Owntime Home Club Gramado — Andamento das Obras
   (Maio 2026)**, responsivo e sem autoplay.
3. Código de Ética existente, com a capa e o botão de leitura oficiais.
4. Acessos rápidos compactos; notificações e ferramentas abaixo, respeitando
   as permissões atuais.

Não criar tela intermediária, modal obrigatório ou nova navegação. Remover o
parágrafo introdutório e as descrições longas dos atalhos, não seus destinos.
Manter o menu atual. Consulta ao Código não substitui o aceite obrigatório.

## Vídeo e privacidade

- Player 16:9 com largura limitada no desktop e reflow no celular.
- Capa local obtida da miniatura do vídeo escolhido, sem conexão a terceiros
  na abertura. Nenhum iframe, preconnect ou miniatura remota antes do clique.
- Botão explícito **Carregar vídeo** e aviso curto de conexão ao YouTube.
- Iframe somente em `https://www.youtube-nocookie.com/embed/VAhBJOKc3-s`,
  com controles, tela cheia, sem autoplay e referrer compatível com o provedor.
- Link externo **Abrir no YouTube**, sem encaminhar a sessão do Portal.
- Mensagem de carregamento, falha e demora com nova tentativa. Um evento de load
  do iframe não prova reprodução nem permite detectar toda restrição do YouTube.
- Remover iframe, fonte, timer e listeners ao sair do Dashboard; descarregar
  também em pagehide e não reconectar automaticamente após BFCache.
- Não listado não é privado. Não mudar a política do vídeo ou hospedar MP4 na VPS.

## Limites e arquitetura

Mudanças localizadas no HTML, CSS e montagem existentes de `public/`, sem novas
dependências. Reutilizar ciclo de vida, helpers e identidade visual do Portal.
O bloco de vídeo pode estar ausente sem bloquear as consultas independentes de
Ética e notificações. Falha de mídia não oculta os demais conteúdos.

Não alterar APIs, schema, permissões, documento de Ética, registros de aceite,
Academy, scripts de deploy ou Nginx. A CSP atual já permite o host necessário.
Não publicar automaticamente: a autorização de deploy anterior era do cadastro.

## Verificação

Testes de ordem, saudação, links compactos/permissões, consentimento, origem fixa,
sem autoplay, duplicidade, erro/retry/timeout, foco, pagehide/BFCache, cleanup,
eventos atrasados e DOM opcional. Manter os testes existentes de Ética e lembretes.
Verificar em Chrome emulado 320/390/768/1366 px, overflow, teclado e axe, com
tráfego externo bloqueado nos testes determinísticos.

Conferir separadamente o player real escolhido quando o ambiente permitir,
registrando a diferença entre iframe carregado e reprodução efetiva. Não afirmar
teste físico Safari/mobile nem autenticação produtiva usando fixtures locais.
Rodar `npm run verify` e `git diff --check`; atualizar a documentação e apresentar
uma prévia antes de discutir publicação.
