# Payload B0-01a — envelope mínimo autenticado de coleta

Data: 15/10/2026

Produto: Portal Ownerinc / Payload CMS

Estado: design aprovado; implementação ainda não autorizada por esta especificação

## 1. Objetivo

Criar a primeira fatia de B0-01: um envelope autenticado e bounded que execute uma
única operação read-only para produzir contexto real de `source`, `inventory` e
`state` sob a lease FD9 existente.

O incremento substitui contexto declarado livremente pelo caller por uma coleta
iniciada pela cadeia autenticada de preparação. Ele não aprova o significado da
observação, não fecha B0-02 ou B0-03 e não autoriza qualquer mutação produtiva.

## 2. Estado de partida

- P2-01 possui trust, verifier, policy, records, incoming, launcher e receiver
  implementados e qualificados em TEST; instalação e autoridade reais do host
  continuam pendentes.
- P2-02 possui approval, closure exata e lease FD9 implementados e qualificados em
  TEST; approval e execução reais no host continuam pendentes.
- B0-01 não possui collector produtivo autenticado integrado.
- B0-02 possui SQL, validator e qualificação PG16 isolada, mas não possui profile
  produtivo aprovado, exclusividade de consumidores ou prova real de credenciais.
- B0-03 possui checker e fixture de topologia, mas não possui observer externo
  produtivo nem cobertura autenticada de host e não-Docker.
- P2-03 permanece bloqueado e `release_not_preflighted` permanece obrigatório.
- O CI `38617436909`, attempt 1, passou no SHA
  `242652c9b43f5d3a7c8a93cebc85634a6fe0bbd1`; o deploy foi skipped. Essa evidência
  é TEST-only e não autoriza produção.

## 3. Decisão de arquitetura

Adotar um envelope mínimo, e não um collector unificado ou framework antecipado de
security/fence.

### 3.1 Launcher autenticado

`ops/prepare-cms-authenticated.py` continua sendo a fronteira que:

1. autentica approval, policy, record, source, inventory, state e toda a closure;
2. adquire ou recebe e reafirma a lease exclusiva no FD9;
3. gera um nonce fresco e uma requisição interna de operação fixa;
4. executa o observer com Python isolado e ambiente limpo;
5. limita e valida integralmente sua resposta;
6. reautentica closure, source, inventory, state e FD9 após a coleta;
7. retorna somente um resultado bounded com autorizações produtivas falsas.

O caller não escolhe path, SQL, role, database, origin, comando ou módulo.

### 3.2 Observer de produção

Um novo módulo `ops/payload-production-observer.py` oferece somente a operação
`collect-context`. Suas responsabilidades são:

- validar request e response com schemas fechados e versionados;
- coletar uma projeção bounded de `source`, `inventory` e `state` a partir das
  fontes já autenticadas pelo launcher;
- conferir a identidade esperada do processo e do FD9 antes e depois;
- produzir JSON canônico e sanitizado;
- manter todas as autorizações produtivas explicitamente falsas.

O observer não importa nem executa código do candidato, não executa SQL, não chama
Docker, não lê credenciais e não transforma a observação em approval.

### 3.3 Closure autenticada

O observer entra na closure de preparação mantida por
`ops/provision-payload-candidate-trust.py`. Seu hash integral passa a ser obrigatório
no approval independente. A publicação preserva closure-first e approval-last.
Nenhum arquivo é localizado por convenção não autenticada ou por path do caller.

## 4. Contrato do envelope

O contrato detalhado será derivado durante o plano de implementação, respeitando as
seguintes propriedades obrigatórias:

- versão e kind fechados;
- operação única `collect-context`;
- nonce fresco;
- source commit e inventory identity autenticados;
- hash e sequência do journal/state;
- PID e process start reais;
- device e inode do FD9 real;
- tamanho e profundidade limitados;
- campos desconhecidos, duplicados ou ausentes recusados;
- nenhuma string de path privado, segredo, DSN, environment ou comando bruto;
- `destructiveOperationAuthorized`, `installationExecuted`,
  `deploymentAuthorized` e `productionAuthorized` sempre `false`.

O envelope comprova somente que aquela projeção foi coletada pela closure, processo,
contexto e lease vinculados. Não comprova que o conteúdo observado foi aprovado por
uma autoridade independente.

## 5. Fluxo de execução

1. Um processo novo inicia a preparação autenticada.
2. A closure completa é autenticada antes de import ou execução do observer.
3. O processo adquire ou valida a lease exclusiva e sua mesma open description no
   FD9.
4. Approval, policy, record, source, inventory e state são relidos e vinculados.
5. O launcher gera nonce novo e monta a requisição interna sem seletores livres.
6. O observer é iniciado com Python isolado, ambiente limpo, timeout e output cap.
7. O observer coleta e devolve somente a projeção `context/inventory/state`.
8. O launcher valida schema, limites e correspondência da resposta.
9. Closure, contexto e FD9 são reafirmados depois da coleta.
10. O launcher retorna o envelope com todas as autorizações falsas.

Cada reentrada exige processo, nonce, leitura de autoridade e validação de lease
frescos. Um resultado anterior nunca é reutilizado como autorização.

## 6. Falha fechada e diagnósticos

Devem causar recusa antes de qualquer resultado positivo:

- closure, approval, policy ou record ausente, alterado ou incompatível;
- FD9 ausente, compartilhado, desbloqueado, substituído ou com device/inode errado;
- source, inventory, journal ou state alterado durante a coleta;
- nonce inválido ou reutilizado no mesmo processo;
- schema, versão ou operação desconhecidos;
- campo extra, ausente ou duplicado;
- tentativa de fornecer path, SQL, role, database, origin ou comando;
- timeout, output overflow, JSON excessivo ou status inesperado do filho;
- stderr inesperado;
- resposta contendo material proibido ou não canonicalizável.

O diagnóstico público usa códigos finitos e sanitizados. Não reproduz traceback,
stderr, path privado, argumentos, environment, DSN, credenciais ou conteúdo bruto
do state.

## 7. Persistência e efeitos

O primeiro incremento não cria receipt produtivo durável e não altera:

- journal ou state;
- policy ou records;
- serviços, containers, redes ou volumes;
- banco, roles, grants ou passwords;
- releases, pointers ou admission;
- arquivos fora da closure administrativa já definida.

A persistência durável da observação será decidida em uma fatia posterior, antes de
B0-02/B0-03 dependerem dela.

## 8. Contrato de testes

### 8.1 Teste unitário do observer

Novo arquivo: `tests/unit/payload-production-observer.test.mjs`.

Deve cobrir:

- request e response válidos;
- campo ausente, extra ou duplicado;
- versão e operação desconhecidas;
- recusa de selectors livres;
- source, inventory, state, PID, process start, nonce e FD9 inválidos;
- FD9 ausente, não herdado, compartilhado, desbloqueado ou substituído;
- drift de source, inventory ou journal durante a coleta;
- timeout, output overflow, profundidade e tamanho excessivos;
- stderr e diagnósticos sanitizados;
- ausência de traceback, DSN, environment e segredo sintético;
- recusa de subprocesso, comando ou escrita não permitidos;
- autorizações produtivas falsas no sucesso.

Doubles de metadata/FD9 são permitidos em plataformas sem POSIX real, desde que o
teste os identifique explicitamente e não os apresente como prova nativa.

### 8.2 Integração com a preparação autenticada

Arquivo: `tests/unit/payload-preparation-authentication.test.mjs`.

Deve provar:

- observer presente na closure e approval;
- byte alterado impede import e execução;
- autenticação completa ocorre antes de carregar o observer;
- dispatch aceita somente a operação interna fixa;
- FD9 herdado é a mesma open description mantida pelo pai;
- lease permanece retida durante toda a execução;
- falha não libera nem substitui indevidamente a lease;
- drift entre validações pré e pós-execução recusa;
- reentrada exige processo e nonce novos;
- todas as autorizações permanecem falsas.

### 8.3 Provisionamento da closure

Arquivo: `tests/unit/payload-candidate-trust-provisioning.test.mjs`.

Deve provar:

- hash do observer obrigatório;
- instalação protegida e closure-first;
- retomada após publicação parcial;
- arquivo conflitante recusado sem overwrite;
- approval não publicado antes da closure completa;
- records existentes preservados.

### 8.4 Prova nativa Linux/root

A prova deve ser incorporada ao gate candidate-only existente **Test preauthority CI
setup with native Linux root**, sem criar uma segunda rota de autoridade e sem
renomear o step autenticado.

Ela deve exercitar owner/mode/ancestry reais, no-follow, single-link, FD9 real,
lease exclusiva, mesma open description herdada, pathname/inode replacement,
timeout, output cap e cleanup apenas de recursos próprios. Nenhum path produtivo
fixo pode ser acessado pela fixture.

Quando required-native estiver ativo, incompatibilidade ou falha não pode virar
skip. O proof público deve ser pequeno e redigido e afirmar apenas a qualificação
Linux/root do mecanismo TEST.

### 8.5 Invariantes estáticas

Os testes devem impedir:

- nova ação destrutiva no dispatcher do runtime;
- comandos Docker ou SQL;
- leitura de passwords, DSNs, `pg_authid` ou environment;
- alteração de journal/state, policy ou records;
- mudança em `install_receiver_preflight()`;
- remoção de `release_not_preflighted`;
- qualquer autorização produtiva verdadeira.

## 9. Arquivos da implementação

### Código

- `ops/payload-production-observer.py` — novo observer de operação única.
- `ops/prepare-cms-authenticated.py` — integração, FD9, execução bounded e
  reautenticação.
- `ops/provision-payload-candidate-trust.py` — inclusão do observer na closure e no
  approval.

### Testes

- `tests/unit/payload-production-observer.test.mjs` — novo contrato unitário.
- `tests/unit/payload-preparation-authentication.test.mjs` — integração autenticada.
- `tests/unit/payload-candidate-trust-provisioning.test.mjs` — closure/publicação.

### CI condicional

- `.github/workflows/ci.yml` somente se o gate existente não descobrir a prova
  nativa pela configuração atual. Não renomear steps, criar deploy, ampliar budgets
  sem evidência, reduzir checks ou transformar falha em skip.

### Documentação

- `docs/operations/payload-runtime-recovery.md` — contrato, limites e evidência.
- `docs/operations/deployment.md` — entrypoint, ambiente e fronteira operacional.
- `docs/operations/payload-pendencias-e-plano-de-conclusao-2026-10-14.md` — P1-02
  atualizado e B0-01a separado de B0-02/B0-03.

## 10. Verificação

Ordem de verificação:

1. teste focal do observer;
2. teste focal da preparação autenticada;
3. teste focal do provisionamento de trust;
4. sintaxe Python;
5. invariantes estáticas;
6. prova Linux/root isolada, quando disponível e especificamente autorizada;
7. `npm run verify`;
8. `git diff --check`;
9. revisão read-only fresca;
10. correções delimitadas e nova revisão quando necessárias.

Docker local, serviços, VPS, SSH, banco, CI remoto e deploy exigem autorização
específica e não fazem parte da implementação local por padrão.

## 11. Critérios de aceite

O incremento é aceito somente quando:

- a coleta é iniciada exclusivamente pela closure autenticada;
- request e response são fechados, bounded e sanitizados;
- processo, nonce, source, inventory, state e FD9 são vinculados e estáveis antes e
  depois da coleta;
- negativas falham antes de produzir observação aceita;
- testes portáteis e a prova nativa aplicável passam sem redução de critérios;
- não existe mutação produtiva ou nova autoridade;
- B0-02 e B0-03 continuam explicitamente pendentes;
- P2-03 continua bloqueado;
- `release_not_preflighted` e todos os campos de autorização falsos permanecem
  preservados.

## 12. Fora de escopo

- profile pré-grants e SQL produtivo de B0-02;
- autenticação real de API/cron;
- inventário e allowlist de consumidores externos;
- Docker topology, host/non-Docker e observer externo de B0-03;
- contenção contínua entre coleta e mutação;
- backup B0, restore, floor, B1 e readiness;
- instalação, rollback, ativação ou deploy;
- alteração de outros projetos, proxy compartilhado, n8n ou Ownerinc Brain.
