# Correções do Portal — lote 2 (F04)

Data: 29/09/2026. Implementação delimitada às dependências da API e regressões
de parsing/upload, conforme o plano aprovado. Referência inicial: `ff14c66`;
estado recebido após o lote 1: 578 testes aprovados. Esta entrega ainda depende
da conferência do diff, revisão independente e aceitação pela sessão principal.

## Arquivos deste lote

- `api/package.json`
- `api/package-lock.json`
- `tests/helpers/api-dependency-harness.mjs` — novo
- `tests/unit/api-dependency-regressions.test.mjs` — novo
- `docs/reviews/2026-09-29-portal-corrections-batch-2.md` — novo

Nenhuma rota, parser, limite, política, configuração de runtime/deploy ou
dependência do cron foi alterada. Os arquivos do lote 1, seu relatório, a
auditoria histórica, capturas e documentos mantidos pela sessão principal
foram preservados. Sem commit, push, deploy, leitura de credenciais ou operação
sobre serviços em execução.

## Dependências resolvidas e instaladas

| Pacote | Lock anterior | Lock/instalação deste lote | Decisão |
| --- | --- | --- | --- |
| `express` | 4.22.2 | **4.22.3** | Mínimo direto elevado de `^4.18.0` para `^4.22.3`; permanece Express 4. |
| `body-parser` | 1.20.6 | **1.20.8** | Resolvido pelo intervalo `~1.20.5` do Express; passa a pedir `qs ~6.16.0`. |
| `qs` | 6.15.3 | **6.16.0** | Uma única cópia no lock e na árvore instalada, compartilhada por Express, body-parser e Superagent. |
| `multer` | 2.3.0 | **2.4.0** | Mínimo direto elevado para `^2.4.0`; permanece Multer 2 e `memoryStorage` nas duas rotas. |
| `path-to-regexp` | 0.1.13 | **0.1.13** | Versão resolvida inalterada; Express atualizou apenas seu requisito de `~0.1.12` para `~0.1.13`. |

As versões e metadados corrigidos foram consultados no registry. A resolução foi
direcionada aos quatro pacotes afetados:

```sh
npm --prefix api update express multer body-parser qs --package-lock-only --ignore-scripts --no-audit --no-fund
npm --prefix api ci
npm --prefix api ls express body-parser multer qs path-to-regexp --all
```

A inspeção completa do diff do lock identificou somente quatro mudanças de
versão: Express, body-parser, qs e Multer. A atualização do Multer removeu sua
dependência de `concat-stream`; por consequência, saíram `concat-stream`,
`buffer-from` e `typedarray`. `readable-stream`, `string_decoder` e
`util-deprecate` apenas passaram a ser marcados como opcionais, sem mudança de
versão. Não houve `audit fix`, upgrade em massa ou novo override; o override
preexistente de `brace-expansion` permaneceu intacto.

A enumeração de todas as entradas `node_modules/.../qs` no lock encontrou apenas
`node_modules/qs@6.16.0`. `npm ls --all` e a resolução de módulos a partir de cada
consumidor confirmaram a mesma versão instalada: Express 4.22.3, body-parser
1.20.8 e Superagent 10.3.0 (via Supertest 7.1.4, ambos inalterados).

## Auditoria: escopos e todas as severidades

F04 registrava quatro ocorrências moderadas no escopo sem dependências dev e
opcionais: `express`, `body-parser`, `qs` e `multer`. Elas não eram quatro
advisories independentes. Os avisos subjacentes eram:

- Multer: [GHSA-3pph-fpjx-jg34](https://github.com/advisories/GHSA-3pph-fpjx-jg34),
  negação de serviço por escritas em disco órfãs em uploads interrompidos.
- qs: [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx),
  bypass de limite de array com parsing de vírgulas em chaves entre colchetes.
- qs: [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g),
  aviso relacionado a `isBuffer`.

Nenhum desses três avisos ou dos quatro pacotes afetados aparece na auditoria
após a atualização, inclusive na consulta integral.

| Comando | Exit | Info | Low | Moderate | High | Critical |
| --- | --- | --- | --- | --- | --- | --- |
| `npm audit --prefix api --omit=dev --omit=optional --json` | 0 | 0 | 0 | 0 | 0 | 0 |
| `npm audit --prefix api --json` | **1** | 0 | 0 | **6** | 0 | 0 |
| `npm audit --prefix cron --json` | 0 | 0 | 0 | 0 | 0 | 0 |

`npm run security` também passou (exit 0), informando zero vulnerabilidades
para API e cron no seu escopo `--omit=dev --omit=optional --audit-level=high`.
O sucesso desse comando não foi usado como substituto da inspeção integral.

### Risco residual fora da cadeia corrigida

A auditoria integral ainda acusa seis entradas moderadas ligadas ao advisory
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq):
`uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided`, faixa
afetada `<11.1.1`. O npm classifica o aviso como **moderate**; seu objeto CVSS
informa 7.5. Mantivemos a classificação reportada, sem reclassificação local.

| Entrada reportada | Versão resolvida | Relação |
| --- | --- | --- |
| `firebase-admin` | 14.2.0 | Dependência direta, afetada indiretamente pela cadeia opcional de Storage. |
| `@google-cloud/storage` | 7.21.0 | Opcional; inclui `gaxios`, `retry-request` e `teeny-request`. |
| `gaxios` | 6.7.1 | Opcional; usa uma cópia de `uuid@9.0.1`. |
| `retry-request` | 7.0.2 | Opcional; afetado via `teeny-request`. |
| `teeny-request` | 9.0.0 | Opcional; usa outra cópia de `uuid@9.0.1`. |
| `uuid` | 9.0.1 | Duas cópias opcionais: `gaxios/node_modules/uuid` e `teeny-request/node_modules/uuid`. |

Todas essas entradas do lock foram comparadas com a referência anterior e
permanecem inalteradas, inclusive os marcadores opcionais. `npm ci` instala essa
cadeia neste ambiente e avisa sobre as seis ocorrências; não se afirma ausência
de risco ou impossibilidade de exploração. O resultado foi reportado sem
ampliar o lote para Firebase/Google Storage. Uma correção dessa cadeia requer
avaliação e autorização próprias.

## Regressões executáveis

Foram acrescentados **12 testes** com requisições HTTP reais em loopback,
Supertest e um socket interrompido deliberadamente. O harness executa o código
integral, sem reescrita, de `api/index.js`, middleware de autenticação e rotas de
lembretes, CMS, foto e assets. Express, body-parser, qs, Multer, Sharp, policy,
validação e helpers de auditoria são reais. Firebase, PostgreSQL e operações de
arquivo são doubles explícitos; rotas alheias ficam inertes, sem SMTP, SDK
Firebase real, banco ou stack em execução. Nenhum asset real é gravado.

Cobertura:

- Query estendida do Express: duplicatas, arrays, objetos/nesting (`isBuffer` e
  `constructor` incluídos), limites/paginação inválidos, escapes malformados em
  valores, filtros desconhecidos, UUID/UID/data inválidos e intervalo invertido
  retornam 400 antes de SQL de negócio. Casos válidos mantêm parâmetros SQL,
  paginação, datas civis e o canal histórico `whatsapp`.
- JSON malformado e scalar retornam 400 sem vazar conteúdo do parser; array é
  rejeitado pela rota. JSON válido chega à mutation real e à auditoria mockada.
  Limites reais do index: 100 KiB geral, 1 MiB bulk e 6 MiB CMS retornam 413 ao
  exceder. Corpos logo abaixo dos limites especiais atravessam o parser próprio
  sem cair no limite geral. O bulk usa somente um endpoint de observação no
  harness, não uma simulação da lógica de importação.
- Foto: PNG sintético válido passa por Multer e Sharp e é normalizado em WebP;
  a atualização preserva UID e reset de crop. Ausência, vazio, assinatura falsa,
  conteúdo inválido e bytes após a imagem retornam 400; 500 KiB + 1 byte retorna
  413. Uma requisição válida posterior funciona.
- Upload protegido: autenticação real com verificador Firebase mockado, e
  autorização CMS, precedem parsing multipart e persistência. Campo incorreto,
  múltiplos arquivos, campo textual inesperado, ausência, multipart truncado ou
  sem boundary e divergência MIME/assinatura retornam 400 no CMS.
- Assets: retorno sem caminho interno, auditoria correlacionada pelo request ID,
  negação de leitura sem referência/publicação/audiência compatível, proibição
  durante exclusão e 404 em `/uploads/cms-private`. Leitura permitida mantém
  MIME, tamanho, `nosniff` e lock de referência antes da abertura do arquivo.
- Interrupção: o teste espera o Multer consumir o corpo pelo socket real antes
  de abortar. Nenhum arquivo/row parcial é persistido; o próximo upload válido
  responde 201 e mantém bytes corretos, sem derrubar o processo.
- Erros HTTP exercitados preservam `X-Request-Id` e `requestId`, corpo pequeno e
  mensagens sanitizadas. A interrupção de socket não é contada como uma
  resposta HTTP entregue ao cliente.

Os limites CMS de 50 MiB para imagens/vídeos e 100 MiB para PDF continuam cobertos
pelos contratos de fonte existentes em `cms-routes.test.mjs`; não alocamos um
PDF de mais de 100 MiB por teste. O limite real de upload foi exercitado pela
foto de perfil, sem reduzir os limites do aplicativo para facilitar o teste.

## Resultados de verificação

Ambiente: Windows, Node **24.15.0**, npm **11.12.1**.

| Verificação | Resultado real |
| --- | --- |
| `npm --prefix api ci` | Exit 0; 324 pacotes instalados, 325 auditados; seis moderadas da cadeia descrita acima. |
| `npm --prefix api ls express body-parser multer qs path-to-regexp --all` | Exit 0; versões e deduplicação confirmadas. |
| `node --test tests/unit/api-dependency-regressions.test.mjs` | **12 passaram**, zero falhas/cancelamentos/skips. |
| Nova suíte + `api-routes.test.mjs`, `api-security.test.mjs`, `cms-routes.test.mjs` | **67 passaram**, zero falhas/cancelamentos/skips. |
| `npm run security` e consultas `npm audit --json` | Resultados e exits separados na seção de auditoria. |
| `npm run verify` | Exit 0; **590 passaram**, zero falhas/cancelamentos/skips; sintaxe, segurança, nomenclatura e Compose aprovados. |
| `git diff --check` | Exit 0; sem erro de whitespace. |

Compose não foi ocultado do PATH: o verificador executou apenas consultas de
versão e `docker compose --env-file .env.example config --quiet`, conforme
autorizado. Nenhum container foi iniciado, recriado ou parado por este worker.

Avisos esperados: `npm ci` emite deprecações de `node-domexception@1.0.0`,
`glob@10.5.0` e das duas cópias de `uuid@9.0.1`. A suíte existente de Cards Pós
emite `MODULE_TYPELESS_PACKAGE_JSON`. Testes negativos registram erros
deliberados de JSON, tamanho, campo inesperado e socket abortado; não são
falhas ocultadas do runner.

## Limitações e pontos para a sessão principal

- **Comportamento preexistente:** campo inesperado na foto de perfil segue o
  error handler genérico e retorna 500 sanitizado, não 400. A regressão documenta
  esse resultado; a rota não foi alterada para satisfazer uma expectativa nova.
- **Socket abortado:** a classificação atual registra `Request aborted` como
  500, depois de encerrada a conexão. O teste demonstra isolamento do upload e
  recuperação, não uma resposta 400 entregue ao cliente desconectado.
- O advisory do Multer descreve escrita em disco; o Portal usa `memoryStorage`.
  Não foi feita exploração de disk storage nem benchmark de consumo sob carga.
- A sintaxe adicionada permanece compatível com Node 18, mas não foi executada
  nesse runtime. Os engines e o verificador continuam exigindo Node 24 e as
  dependências já existentes não estabelecem suporte da aplicação a Node 18.
- Rebuild da imagem local da API e aceitação por navegador/upload na stack são
  responsabilidade exclusiva da sessão principal, após conferência/revisão.
  Estes testes usam persistência simulada e não homologam volumes, PostgreSQL,
  Nginx, browser, imagem Linux atualizada ou dependências em produção.
- As seis ocorrências moderadas residuais precisam permanecer visíveis na
  aceitação; esta entrega resolve os avisos de F04, não toda a árvore opcional.

Não há bloqueio de implementação identificado no escopo autorizado. Revisão
independente e aceitação final do lote permanecem pendentes.
