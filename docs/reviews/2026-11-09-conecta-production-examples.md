# Conecta — cadastro de exemplos em produção

## Autorização e escopo

O usuário aprovou cadastrar conteúdo de exemplo no Portal real, em vez de
publicar o servidor local que simula autenticação. Também aprovou manter as
trilhas em rascunho por ausência de vídeos autorizados:

- oito artigos com prefixo `[Exemplo]` e aviso de conteúdo fictício;
- seis lembretes com `active=false`, sem disparos;
- dois cursos internos com `active=false`, dois módulos inativos por curso e
  roteiro de seis aulas na descrição de cada curso;
- nenhuma aula, mídia inválida ou progresso cadastrado;
- nenhum usuário, benefício, registro de ponto ou privilégio fictício;
- nenhum conteúdo oficial sobrescrito, removido ou desativado.

A retomada foi explicitamente autorizada pelo usuário com uma conta existente.
A credencial foi recebida pelo mecanismo privado, sem cópia no repositório,
saída de comandos ou registro documental. Não há alteração de autenticação ou
autorização para acomodar exemplos.

## Evidências antes da escrita

- Autenticação oficial Firebase e `/api/users/me`: conta administrativa com
  permissões de Conhecimento, Lembretes e Academy.
- Enumeração autenticada e paginada completa: **zero artigos, zero lembretes e
  zero cursos** na consulta anterior à criação. Nenhuma listagem de usuários ou
  dados pessoais de terceiros foi necessária.
- Payloads com projeção explícita das fixtures: oito artigos, seis lembretes
  inativos, dois cursos inativos, quatro módulos inativos e zero aulas. Cursos
  aprovados pelo validator real da API, sem campos de progresso ou identidades
  fictícias das fixtures locais.
- Release existente: `98d3939bf5bdf1d6c18614bc5aaadcb6b5e223be`, CI
  [42560279323](https://github.com/OWNERINC/portal_ownerinc/actions/runs/42560279323)
  com `Deploy production` aprovado. Não é necessário novo deploy para cadastrar
  conteúdo via API.
- Oito arquivos de rotas, catálogo, validators, mutações e política conferidos
  byte a byte contra a revisão publicada, via hashes Git: todos coincidem com
  o checkout usado na validação.
- Smoke HTTPS público com `scripts/smoke.sh`: PASS. Usado Git Bash explícito
  após o alias `bash` do PowerShell apontar para um WSL sem `/bin/bash`.

## Salvaguardas operacionais

Operação avulsa fora do runtime, exclusivamente pela API oficial e com o token
em memória. Não há acesso direto ao banco, bypass de permissões, instalação de
serviços, migration ou deploy. A escrita é limitada a POSTs de criação dos itens
autorizados, com inventário completo e detecção de colisões antes de iniciar.

O lote tem até vinte POSTs independentes, não uma transação única. O processo
não repete gravações automaticamente, não apaga registros para compensar falhas
e registra intenções/IDs localmente sem credenciais. Qualquer resultado ambíguo
exige reconciliação antes de outra tentativa. Execução única e supervisionada;
não representa garantia de idempotência distribuída contra outro operador.

As revisões read-only independentes confirmaram os contratos e solicitaram
reforço de recuperação e confirmação. Foram adicionados lock exclusivo de
execução, bloqueio de intenções sem ACK, pares método/rota explícitos e leitura
final exata dos módulos e da audiência. Review fresco final: **ship**, restrito
a esta execução única supervisionada, não a um importador distribuído.

SHA-256 do helper exato revisado e executado:
`063929a5a4eeb6c3f3b33c791952c01969ed70522c1183acfa190a7908ef8268`.
Helper operacional e recibos permanecem no diretório temporário externo
`C:/Users/Criação/AppData/Local/Temp/opencode/conecta-production-content/`.
O helper não é parte do runtime nem de um novo deploy.

## Estado da execução

**Concluída em 09/11/2026, entre 10:28:33 e 10:28:40 UTC**: vinte criações com
ACK e leitura autenticada de confirmação. Oito artigos, seis lembretes inativos,
dois cursos em rascunho e quatro módulos inativos. Zero aulas criadas.

Uma segunda execução em modo somente verificação confirmou contagens, campos,
IDs e ausência de duplicatas. O diário possui vinte intenções correspondentes
a vinte ACKs, sem intenção pendente. Cursos e módulos conferidos por ID, pai,
título, ordem, atividade, audiência vazia e ausência de aulas. Artigos conferidos
também por GET individual. Nenhuma atualização ou exclusão foi realizada.

Lembretes não aparecem na leitura ordinária nem em `/api/reminders/upcoming?days=7`;
cursos não aparecem no catálogo ordinário. Não houve ativação ou acionamento de
envio. Os artigos estão disponíveis a usuários autenticados; os rascunhos da
Academy e lembretes inativos são consultados pela gestão.

## Evidência de aceite

- API autenticada: apply e verificação independente PASS, totais 8/6/2,
  quatro módulos inativos e zero aulas.
- Navegador real com Firebase, sem fixtures: **7/7 cenários PASS**, sem erros de
  página ou overflow em 1366 px. Inclui lista/detalhe de artigo, lembretes
  inativos, administração Academy, ambas as árvores em rascunho e catálogo do
  aluno sem esses rascunhos. Contexto temporário de navegador encerrado sem
  salvar credenciais ou storage.
- Smoke HTTPS público antes e depois: PASS.
- `npm run verify`: **825 PASS, zero falhas e dois skips Linux**, `verify: ok`.
  Essa suíte local não substitui as confirmações reais de API/navegador acima.
- `git diff --check`: sem problemas.

Capturas e resultado de navegador em `conecta-production-content/ui/`, no
diretório temporário acima. A evidência não comprova reprodução de vídeo,
conclusão de aula, entrega de email ou comportamento de conta leitora separada.

## IDs do lote criado

### Artigos

- Primeiros passos: `9742d0ac-6f7c-4d4e-a015-3976773169f8`.
- Apoio ao DHO: `9ea69b26-ad19-4a7a-8a56-481eb574ca4a`.
- Feedback: `bf1acefb-3e5e-4763-8845-00d198e0f247`.
- Segurança de acesso: `8816bb6a-9500-4fa1-8b83-5179d6b9128b`.
- Ferramentas: `8fe4cd67-e09a-4d2a-bd09-4f0cc761da12`.
- Passagem de atendimento: `47af99f2-9912-4229-a4cf-cad45a877f46`.
- Comunicação acolhedora: `bfab2e63-9498-4213-a974-5a52337c83f2`.
- Primeira semana: `bb0d2686-438f-4738-8ece-6cc3137efcbf`.

### Lembretes inativos

- Boas-vindas: `f52f5d50-3975-4559-a069-2ba83cb9e25d`.
- Atualização cadastral: `c93668d9-59ac-49c7-8ff8-b3d2654819e8`.
- Integração: `f5851a26-4ea0-45f2-815c-c7d79d3af9f7`.
- Retomada Academy: `7aa6aa59-fa16-4661-a6fa-c19ad5740219`.
- Nota fiscal: `09a35781-ba4f-4563-ba7c-ecd49ee12a88`.
- Desenvolvimento: `5442a563-1c20-4163-b997-332bea14c028`.

### Cursos e módulos inativos

- Primeiros passos na Ownerinc: `35de97e4-cca9-4045-aeb9-a47fa6a06854`.
  - Conhecer e pertencer: `4103a174-a348-40f9-a0cf-d4e901c1c313`.
  - Conectar e colocar em prática: `0445010c-abfb-40ee-8631-bd92401c09d4`.
- Atendimento e relacionamento: `454c96ef-a00a-4e87-9e80-6b4b2b0f0491`.
  - Entender para acolher: `19508bc1-2149-4e4a-a6b2-9597c9f7855e`.
  - Cuidar da continuidade: `6961a7e4-9c65-4cd2-98ae-2cd6906ef1ac`.

Os IDs delimitam este lote para auditoria. Não autorizam exclusão automática ou
reativação posterior; qualquer remoção/ativação exige nova decisão explícita.
