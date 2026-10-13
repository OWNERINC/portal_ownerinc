# CMS deploy — implementação limitada de ownership

## Plano aprovado desta entrega

Objetivo: remover somente a incompatibilidade entre o ambiente operacional
`1000:1000`, modo `0600`, e o controller que exigia UID 0 para esse arquivo.
Não alterar receiver, estados cold/migrated, rollback, bancos, credenciais,
qualificação CI ou harness pertencente às outras frentes.

Contrato: inventário schemaVersion 2 com campo obrigatório
`environmentFileOwner: {uid: 1000, gid: 1000}` em produção. Projetos não produtivos
usam explicitamente `{uid: 0, gid: 0}`. Nenhum owner é inferido do arquivo,
recebido por variável de ambiente ou selecionado por flag. Ambiente deve ser
regular, sem symlink/hardlink, modo exato 0600, owner correspondente e ancestry
protegida. Chave, journal, lock e inventário não recebem a exceção operacional.

Sequência de implementação inline, sem commit/delegação:

- [x] Escrever e executar regressões de contrato v2, ownership/ancestry e
  rejeição pré-efeitos, usando fixtures locais sem Docker/banco.
- [x] Implementar validação compartilhada no helper de inventário, validação
  antecipada no runtime e preservação estrita no preparador privado.
- [x] Atualizar somente os testes de preparação desta frente; comunicar a nova
  interface ao primary para atualização do harness por seu dono.
- [x] Executar focused tests, `npm run verify`, `npm run security` e
  `git diff --check`; registrar resultados e limites reais.

## Migração e fronteira de confiança

Inventário v1 não é atualizado implicitamente. Trocar schema/owner muda a
identidade do inventário vinculada ao journal/provas; estado assinado existente
não pode ser reescrito ou reinicializado por esta correção. O preparador recusa
inventário antigo, divergente ou inseguro antes de escrever; futura migração de
estado exige entrega própria revisada. Na evidência histórica, o inventário e o
controller atuais ainda não estavam instalados — isso não é inspeção nova da VPS.

O harness root descartável deve emitir schemaVersion 2 e
`environmentFileOwner: {uid: 0, gid: 0}` antes de calcular a identidade canônica.
Não copiar a expectativa operacional de produção para esse fixture. Seu arquivo
não é editado nesta entrega.

## Próximas entregas após review independente

Permanecem separados: intent retomável da primeira instalação; rollback fenced
antes/depois do compromisso Payload; recuperação da proteção com admission
fechada; gate obrigatório de qualificação/source binding; checkpoint B1 dos
quatro stores antes da exposição; readiness CMS e aceite real de login/sessões;
reconciliação do caminho manual com o layout production.

Este P0 isolado não qualifica recuperação, não autoriza bypass de roles e não
constitui deploy completo ou prova de VPS/login reais.

## Implementação e extensão de integração autorizada

- `ops/payload-control-inventory.py`: contrato v2 e identidade canônica contendo
  UID/GID esperados; rejeição de tipos coercíveis, owners não aprovados, campos
  extras e versões anteriores. Validação de arquivo/ancestry e leitura com
  `O_NOFOLLOW` e comparação de metadados entre lstat e fstat.
- `ops/payload-control-runtime.py`: validação antecipada do ambiente antes de
  estado/comandos e consumo pelo Compose sem exigir UID 0 nesse arquivo; demais
  verificações root não foram relaxadas.
- `ops/prepare-cms-infrastructure.sh` e helper privado: produção exige
  `1000:1000/0600`, preserva bytes/owner/grupo, recusa inventário antigo antes de
  instalar e revalida metadados antes de substituir o arquivo. Sem rotação
  adicional de credenciais por esta correção.
- `tests/unit/payload-control-owner.test.mjs` e testes de preparação: contratos
  produção/fixture, owner/grupo incorretos, modes, links, ancestry, transporte
  canônico, pré-efeitos e manutenção do piso root para chave/journal/lock.

Steering posterior autorizou somente sincronizar os motivos estáticos de
ownership em `scripts/integration/payload-preauthority-diagnostics.mjs` e
`tests/unit/payload-preauthority-diagnostics.test.mjs`. Foram acrescentados:

```text
invalid_environment_file_owner
environment_unavailable
unsafe_environment_file
unsafe_environment_permissions
unsafe_environment_owner
unsafe_environment_ancestry
unsafe_inventory_ancestry
```

Allowlist continua finita e literal; nenhuma descoberta dinâmica ou aceitação
por regex ampla em produção. Regressão vincula os sete códigos à fonte efetiva
do helper e ao encaminhamento pelo runtime; exige contexto conhecido e linha
exata LF/CRLF, recusando contexto desconhecido, código inventado e detalhe
privado prefixado/anexado. As funções/imports de snapshots já entregues pela
outra frente foram preservadas, assim como os parsers cross-layer existentes.

## Verificação local final — 2026-10-09

| Check | Resultado |
| --- | --- |
| Focused ownership/preparação/controller/diagnostics e regressões snapshots | 47 testes: 44 PASS, 3 skips, zero falhas |
| `npm run verify` — Portal | 1.526 testes: 1.519 PASS, 7 skips, zero falhas |
| `npm run verify` — CMS offline | 458 testes: 448 PASS, 10 skips, zero falhas |
| Gates security/Compose do verify | PASS; `verify: ok` |
| `npm run security` | PASS, zero vulnerabilidades reportadas em API, cron e CMS |
| `git diff --check` | PASS |
| Python AST e LF nos arquivos ops desta entrega | PASS |

O verify anterior falhava pela allowlist de ownership; a sincronização acima
eliminou essa falha. O scanner separado havia apontado o novo teste de pacote
da outra frente; não foi alterado aqui e o verify final passou também no scanner.

Ambiente local Windows: dois skips focused dependem de permissão para symlink;
o terceiro exige Linux root descartável para chown real. A política POSIX foi
exercitada com metadados simulados; o novo teste real de `1000:1000`/chave root
permanece explícito e pendente em Linux, não é evidência de host real. Skips CMS
incluem PGlite opcional indisponível e limitações Windows de fsync/symlink.

O checkout contém alterações concorrentes das outras frentes; resultados
globais são do checkout observado durante a execução, não de um commit isolado.
Entrega pronta para review independente, sem alegar review aprovado. Nenhum
commit/push, CI remoto, SSH, serviço, banco ou produção foi operado. O verify
executou somente a validação read-only de configuração `docker compose config
--quiet`; nenhum container/volume foi criado, iniciado ou alterado.
