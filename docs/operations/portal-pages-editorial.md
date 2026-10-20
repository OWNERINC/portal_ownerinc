# Operação editorial das páginas modulares

## Criar e salvar

O editor é o formulário nativo do Payload. Título, endereço canônico e campos de
texto obrigatórios continuam sujeitos à validação nativa. Para criar uma página,
preencha o formulário e use **Salvar versão**; se houver erro, o editor mantém os
valores e move o foco para o primeiro campo inválido. Após a criação confirmada,
o controle oferece o endereço do documento no editor nativo.

Em uma página existente, o autosave nativo continua ativo em intervalos de dois
segundos. **Salvar versão** aguarda a conclusão do autosave antes de criar um
snapshot explícito e imutável. Aguarde a mensagem **Versão salva** e confira o UUID
e o horário apresentados. A prévia só é liberada quando a Version recém-salva ainda
é a `latest` explícita e seu conteúdo corresponde ao formulário.

Uma edição, upload, autosave concorrente, troca de documento, sessão expirada ou
conflito invalida a confirmação e o link de prévia. Em conflito 409, os campos
nativos permanecem intactos: revise o estado atual, confirme novamente e então
salve uma nova versão. Não repita automaticamente uma mutação cujo resultado ficou
ambíguo. Para uma criação com resposta perdida, confira a lista nativa e o slug
antes de tentar criar outra página.

## Prévia, publicação e histórico

**Abrir prévia desta versão em nova aba** abre `/editorial/portal-pages/preview/`
com os UUIDs exatos da página e da Version. A prévia é privada e mostra que não
publica a página. Salvar ou publicar uma versão posterior não muda o conteúdo
histórico já aberto. Cada nova requisição de imagem, vídeo ou PDF revalida a sessão
editorial; uma sessão revogada não recebe novos bytes, inclusive em uma nova
requisição Range.

Para publicar ou despublicar, use o controle editorial e confira título, UUID da
Version e horário no diálogo antes de confirmar. Cancelar não altera a publicação.
Publicar exige mídia completa e MIME compatível com o destino. Despublicar cria uma
nova versão draft e remove a página do leitor público. Não há ação para restaurar
uma Version histórica; edite e salve o estado desejado como uma nova revisão.

As telas nativas **Versions** e comparação/diff permanecem disponíveis. Elas são
histórico e inspeção, não autorização automática para publicar uma revisão antiga.

## Mídia

Os formatos são fechados; MIME declarado incompatível com a extensão é recusado.
Quando o navegador não informa MIME, só a extensão permitida pode determinar o
tipo. MOV/QuickTime, GIF, SVG, HTML e MIME genérico não são aceitos.

| Destino | Tipos aceitos | Limite por arquivo |
|---|---|---:|
| Capa, imagem e galeria | JPEG, PNG, WebP | 15 MiB |
| Vídeo | MP4, WebM | 500 MiB |
| PDF | PDF | 100 MiB |

Um envio transmite blocos sequenciais de 5 MiB. A barra mede bytes confirmados pelo
servidor, não progresso de rede estimado. A mídia só pode ser selecionada depois
da conclusão, validação e releitura autenticada da relação. **Usar este arquivo**
é uma ação separada; fechar o painel não altera a relação. Texto alternativo e
título continuam campos nativos obrigatórios e não são preenchidos pelo nome do
arquivo.

Há no máximo dois envios ativos por editor e oito no total. `upload_limit_reached`
significa que outro envio está usando uma vaga. Falhas transitórias de chunk e
conclusão têm até três tentativas adicionais (1, 2 e 4 segundos, com jitter); erro
de autenticação, conflito, tipo, limite ou quota não é repetido. Se uma tentativa
de início perdeu a resposta, confira o estado antes de iniciar conscientemente um
novo envio. Cancelamento só é anunciado depois de confirmação; caso contrário, o
estado permanece pendente para reconciliação. Não recarregue a página esperando
retomada: o cliente não promete retomada após reload; limpeza durável de sessões
incompletas pode levar até 24 horas.

## Verificação local

Checks offline:

```sh
npm --prefix cms run test:unit
npm --prefix cms run typecheck
npm run verify
```

O aceite real de Payload/PostgreSQL é separado e requer URLs distintas de bancos
loopback de teste/desenvolvimento, diretórios privados fora do checkout e UUIDv4
de execução:

```sh
npm --prefix cms run test:portal-pages:integration -- --check-config
npm --prefix cms run test:portal-pages:integration -- --execute
node cms/tests/integration/portal-page-editorial-browser.mjs
```

`--check-config` é somente preflight e informa `NOT_EXECUTED`; não conecta. `--execute`
aplica migrations apenas ao banco CMS explicitamente guardado e não inicia Docker.
O browser usa a handoff privada escrita pela própria fixture native; ele não aceita
URL remota, cookie de produção nem storage state fora do diretório de evidências.
Não execute estes comandos com `.env`/URLs de runtime. O runner genérico
`npm run test:payload` mantém seu comportamento bloqueado e não é substituído.

O runner dedicado e o entrypoint browser exigem `NODE_ENV=test`; somente o processo
Next local, iniciado e encerrado pelo entrypoint browser, recebe `NODE_ENV=development`.
Em Linux, os diretórios configurados de upload/evidências devem pertencer ao UID do
processo e ter modo sem permissões de grupo/outros; arquivos de evidência são regulares,
sem symlink, do mesmo UID e sem permissões de grupo/outros. A subpasta de mídia do
fixture é criada ou apertada para `0700`, e evidências são gravadas em arquivo temporário
exclusivo, com `0600`, `fsync` e rename atômico. No Windows, o guard verifica caminho,
tipo e symlink, mas não declara privacidade POSIX por UID/modo.

Antes de uma execução `--execute`, somente os nomes conhecidos de artefatos Task 4
(handoff, storage state e resultados anteriores) são validados e removidos; qualquer
arquivo existente inseguro interrompe o preflight antes da migration/adapter. A fixture
native só cria storage state e handoff novos em teardown, depois de setup e de todos os
casos native obrigatórios passarem. Casos são agregados por registro nomeado: nome
faltante, duplicado, inesperado ou status inválido falha; qualquer `FAIL` falha o grupo;
`NOT_EXECUTED` ou `SKIP` impede `PASS`. Um caso não executado nunca é omitido do JSON.

## Checklist manual de acessibilidade

Marque cada item somente após validação manual no fixture local:

- [ ] Salvar por teclado e foco no primeiro campo inválido.
- [ ] Ordem de tabulação, foco visível e explicações de controles desabilitados.
- [ ] Abrir confirmação, cancelar e confirmar publicação/despublicação.
- [ ] Selecionar arquivo pelo teclado e conferir destino da capa, imagem, galeria, vídeo e PDF.
- [ ] Escape em envio ativo apresenta **Cancelar envio?**; Drawer mantém trap e devolve foco.
- [ ] Fechar ou reordenar/remover galeria não seleciona mídia no destino errado.
- [ ] Link de prévia comunica nova aba; conteúdos antigos continuam presos à Version exata.
- [ ] Status são anunciados de forma polida; alertas finais são claros; frequência de progresso é aceitável.
- [ ] Testar viewport pequeno, foco visível e preferência de movimento reduzido.
- [ ] Testar perda de sessão/permissão em uma nova requisição Range sem afirmar revogação retroativa de bytes já recebidos.
- [ ] Testar erro 409, perda de resposta e sessão expirada sem perder campos ou repetir POST automaticamente.

Um teste Playwright não equivale a uma validação de leitor de tela. Nginx,
Firebase real, deploy e filesystem Linux exigem aceite separado.
