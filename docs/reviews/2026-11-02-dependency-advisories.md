# Dependências — qs e situação do advisory deepmerge

## Escopo e resultado

Revisão e correção local em 02/11/2026, com Node `v24.15.0`:

- `api/package-lock.json`: somente `version`, `resolved` e `integrity` de
  `packages["node_modules/qs"]`, de `6.16.0` para `6.16.2`.
- `tests/unit/qs-advisory-regression.test.mjs`: quatro regressões comportamentais
  baseadas no fix e nos testes upstream.
- Este relatório.

Após `npm --prefix api ci`, Express, body-parser e Superagent resolvem a mesma
cópia `qs@6.16.2`. Nenhum manifest, override ou pacote CMS foi alterado.
O teste existente de dependências da API foi executado, sem edição nesta tarefa.

## API — GHSA-6pq8-jhm2-2vcw / CVE-2026-110816

O lock anterior resolvia:

```text
express@4.22.3 -> qs@6.16.0                         (~6.16.0)
express@4.22.3 -> body-parser@1.20.9 -> qs@6.16.0    (~6.16.0)
supertest@7.1.4 -> superagent@10.3.0 -> qs@6.16.0    (^6.14.1, dev)
```

O advisory cobre `>=6.7.0 <=6.16.0`; a primeira versão corrigida é `6.16.1`.
`6.16.2` é o patch publicado mais recente da linha `6.16.x`, compatível com
as três constraints existentes. Seu manifest mantém `es-define-property ^1.0.1`,
`side-channel ^1.1.1` e engine Node `>=0.6`.

Metadados conferidos com `npm view qs@6.16.2 version dist.tarball dist.integrity
engines dependencies --json` antes da edição:

```text
resolved: https://registry.npmjs.org/qs/-/qs-6.16.2.tgz
integrity: sha512-VYdnB5S7/0IeXzBacUtwNAaM6d7Y/PgYnNC7bJCI6meqA/OgnsQbZMtVW8Dt2D1PHgbHGtYmhSoEIgvt7xZ2ZA==
```

A alteração de `qs` preserva compatibilidade Node 18 nesse pacote. Isso não é
uma certificação da árvore inteira em Node 18: o manifest atual da API declara
`>=24 <25`, e os checks desta tarefa usaram Node 24.

### Comportamento e alcance da evidência

O vetor exige `qs.stringify` com `arrayFormat: 'comma'` e um elemento de array
sem `toString` chamável. Foram reproduzidos os dois caminhos de coerção na
versão instalada antiga: `join` ordinário e `encodeValuesOnly: true`.
Os testes novos verificam saída exata para JSON, resultado de parse com
`allowPrototypes: true`, objetos sem prototype com `plainObjects: true`,
elementos primitivos adjacentes e um `toString` chamável como controle.

A linha de patch também corrige o reconhecimento de `[]=` na fronteira entre
chave e valor. Dois testes usam exemplos publicados pelo upstream: conteúdo
`[]=` no valor não deve introduzir um nível extra de array no parse com `comma`,
nem substituir a política solicitada de duplicatas. Essas regressões de parser
são distintas do advisory de serialização.

A inspeção de JavaScript próprio em `api/` não encontrou uso de `qs` ou
`arrayFormat`; Express utiliza o parser estendido. A reprodução da biblioteca
não demonstra um endpoint explorável no Portal. A suíte existente testa também
os filtros reais do Express, com rejeição de duplicatas, objetos e valores
malformados, além do caminho válido.

Fontes upstream:

- Advisory: <https://github.com/advisories/GHSA-6pq8-jhm2-2vcw>
- Fix e saídas esperadas:
  <https://github.com/ljharb/qs/commit/a952e7519338ef0cfb25694a2988848f93333727>
- Changelog: <https://github.com/ljharb/qs/blob/v6.16.2/CHANGELOG.md>
- Exemplos de parser: <https://github.com/ljharb/qs/blob/v6.16.2/test/parse.js>
- Manifest publicado: <https://registry.npmjs.org/qs/6.16.2>

## CMS — CVE rejeitado, feed ainda presente

O caminho permanece `payload@3.90.2 -> deepmerge@4.3.1`, com dependência exata
`"deepmerge": "4.3.1"`. O registry continua publicando `4.3.1` como latest;
não havia versão corrigida publicada para atualizar dentro desse contrato.
A sugestão automática de downgrade de pacotes Payload para `0.1.9` não é
compatível com o pin `3.90.2`.

### Fontes e horários da consulta

Em **2026-11-02T21:22:28.632Z**, a API da autoridade CVE retornou HTTP 200 e:

```text
cveId: CVE-2026-93753
assignerShortName: VulnCheck
state: REJECTED
dateRejected: 2026-11-02T16:33:19.357Z
dateUpdated: 2026-11-02T16:33:19.357Z
rejectedReasons[0].value:
This CVE ID has been rejected because it does not describe a security vulnerability.
```

Fontes primárias consultadas:

- <https://cveawg.mitre.org/api/cve/CVE-2026-93753>
- <https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/2026/93xxx/CVE-2026-93753.json>

Em **2026-11-02T21:24:11.059Z**, a API pública do GitHub ainda retornou:

```text
ghsa_id: GHSA-gcqx-w48m-w2h4
cve_id: CVE-2026-93753
severity: low
updated_at: 2026-10-27T21:34:58Z
withdrawn_at: null
vulnerable_version_range: >= 4.2.0, <= 4.3.1
first_patched_version: null
```

- API: <https://api.github.com/advisories/GHSA-gcqx-w48m-w2h4>
- Advisory: <https://github.com/advisories/GHSA-gcqx-w48m-w2h4>
- Discussão upstream, incluindo o relato da rejeição:
  <https://github.com/TehShrike/deepmerge/issues/273>
- Manifest publicado: <https://registry.npmjs.org/deepmerge/4.3.1>

O audit CMS executado nessa coleta ainda reportou oito entradas low: `deepmerge`,
`payload`, `@payloadcms/db-postgres`, `@payloadcms/drizzle`,
`@payloadcms/graphql`, `@payloadcms/next`, `@payloadcms/richtext-lexical` e
`@payloadcms/ui`. São efeitos de um mesmo advisory na árvore, não oito falhas
independentes. Há divergência temporal entre o CVE rejeitado e os feeds
GitHub/npm. A rejeição não é evidência de instalação de um patch; nenhuma
supressão foi adicionada.

### Uso real e limite da reprodução

Deepmerge é usado em runtime pelo Payload, inclusive no contexto entregue aos
validadores de campos:

- `cms/node_modules/payload/dist/utilities/deepMerge.js:30`:
  `deepMergeWithSourceArrays`.
- `cms/node_modules/payload/dist/fields/hooks/beforeChange/promise.js:114,126`:
  merge de `doc`/`data` e `siblingDoc`/`siblingData`.

Uma chamada local ao helper instalado, sem inicializar o CMS, confirmou:

```js
const source = JSON.parse('{"session":{"__proto__":{"admin":true}}}');
const output = deepMergeWithSourceArrays({ session: null }, source);
output.session.admin;                      // true
Object.hasOwn(output.session, 'admin');     // false
({}).admin;                                // undefined
deepMergeWithSourceArrays({ session: {} }, source).session.admin; // undefined
```

Isso demonstra alteração do prototype do objeto retornado no caso com target
nulo; não demonstra poluição global, escalada de privilégio ou travessia de uma
fronteira de autorização. As escritas News exigem o ator verificado do Portal
(`cms/src/auth/access.ts`); a validação editorial examina o valor submetido,
e a validação da coleção combina os documentos com object spread
(`cms/src/news/fields.ts`, `cms/src/news/validation.ts`). Não houve prova
end-to-end de bypass, nem certificação de que todos os caminhos Payload são
inalcançáveis. Essa distinção é mantida separada do estado formal `REJECTED`.

## Verificação local

| Check executado | Resultado |
|---|---|
| Novo teste contra `qs@6.16.0`, antes da troca | RED: 4 testes, 0 pass, 4 fail, 0 skips; duas exceções de coerção e duas diferenças de parse esperadas |
| `npm --prefix api ci` após o patch | PASS; instalação local concluída |
| Novo teste contra `qs@6.16.2` | GREEN: 4 testes, 4 pass, 0 fail, 0 skips |
| Suíte de dependências API + novo teste | PASS: 19 testes, 19 pass, 0 fail, 0 skips |
| Audit API com `--omit=dev --omit=optional --audit-level=low --json` | Exit 0, zero findings |
| Audit CMS com `--omit=dev --audit-level=low --json` | Exit 1, 8 low, 0 moderate/high/critical; feed residual descrito acima |
| `git diff --check` e inspeção dos arquivos novos | PASS; LF, newline final e ausência de whitespace final nos arquivos novos |
| Comparação estrutural do lock com `HEAD` | PASS; somente os três campos autorizados de `node_modules/qs` diferem |

Comandos dos testes:

```sh
node --test tests/unit/qs-advisory-regression.test.mjs
node --test tests/unit/api-dependency-regressions.test.mjs tests/unit/qs-advisory-regression.test.mjs
npm audit --prefix api --omit=dev --omit=optional --audit-level=low --json
npm audit --prefix cms --omit=dev --audit-level=low --json
```

O audit padrão disparado por `npm ci` informou 12 entradas moderate. A consulta
complementar `npm audit --prefix api --json` confirmou esse resultado amplo e
ausência de `qs` nos findings: os advisories raiz são `brace-expansion`, `glob`,
`minimatch` e `uuid`, em caminhos opcionais de dependências Google/Firebase;
as demais entradas são transitivas. O lock marca os nós afetados dessas quatro
bibliotecas como `optional: true`. Os advisories correspondentes são:

- <https://github.com/advisories/GHSA-q2hr-2g5m-vwhr>
- <https://github.com/advisories/GHSA-3g3m-2fjr-6pw4>
- <https://github.com/advisories/GHSA-g3hv-75wg-m249>
- <https://github.com/advisories/GHSA-w5hq-g745-h8pq>

Portanto, zero findings no recorte de produção adotado pelo repositório não
significa zero findings no audit completo. Esta correção não altera esses
caminhos nem comprova sua explorabilidade. O limiar `high` de
`npm run security` também não certifica ausência de findings low/moderate.

A verificação completa `npm run verify` pertence à sessão primária, após
estabilizar as alterações concorrentes. Os resultados acima são os checks
delimitados desta tarefa.
