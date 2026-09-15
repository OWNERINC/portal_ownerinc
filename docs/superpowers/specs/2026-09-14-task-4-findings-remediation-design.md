# Task 4 Findings Remediation Design

## Goal

Corrigir os cinco findings da revisao da Task 4 sem migration, sem novos servicos e sem iniciar dependencias externas.

## Decisoes

1. `safeResponses` preservara somente `firebase_identity_indeterminate` em respostas 503. Todos os demais erros 5xx continuarao genericos.
2. O cadastro pendente, a recuperacao e o convite administrativo consultarao `users` por e-mail depois do lock de identidade e antes de criar uma identidade Firebase.
3. A compensacao de uma identidade conhecida decidira referencias por UID exato. O e-mail continuara sendo usado apenas para lock e para detectar inconsistencias de identidade.
4. A reativacao removera `accountDisabled` e limpara `firebase_enable_pending` no mesmo UPDATE transacional depois do enable Firebase.
5. `authenticatedFetch` tratara todo 401 e os 403 que representam estado de autenticacao: limpará o estado local, fara sign-out e redirecionara para login preservando `reason` e `next`. O 403 sem razao sera tratado assim apenas para `/api/users/me`; 403 de permissao continuara sendo erro da operacao. `requireAuth` nao repetira o fluxo.

## Compatibilidade e erros

- `/api/auth/register` continuara retornando 202 generico para duplicidades e resultados de identidade.
- Convites administrativos continuarao retornando 409/503 com as razoes allowlisted esperadas.
- Falhas de rede continuam apresentando o estado de indisponibilidade existente; somente respostas HTTP de autenticacao ganham redirecionamento centralizado.
- Nenhuma tabela, migration, dependência ou fronteira de servico sera criada.

## Testes

- Testar a preservacao seletiva de `reason` em 503.
- Testar que cadastro pendente, recuperacao sem identidade Firebase e convite nao criam Firebase quando ja existe usuario local.
- Testar que cleanup apaga uma identidade criada quando somente outro UID usa o mesmo e-mail, mas preserva o UID referenciado.
- Testar que a rota de reativacao limpa o marcador pendente.
- Testar o contrato de redirecionamento centralizado de 401/403 no frontend.
- Rodar `node --test tests/unit/*.test.mjs`, `npm run verify` e `git diff --check` sem Docker, PostgreSQL ou Firebase reais.
