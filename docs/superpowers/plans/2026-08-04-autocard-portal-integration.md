# Plano de Implementacao: AutoCard no Portal

Referencia: `docs/superpowers/specs/2026-08-04-autocard-portal-integration-design.md`

## 1. Migrar a interface

- Copiar apenas a interface, estilos e assets necessarios de
  `C:\repo\repo\projects\AutoCard` para `public/autocard/`.
- Remover o servidor local, persistencia em JSON e chamadas `/api/cards` e
  `/api/media` do projeto original no contexto migrado.
- Ajustar caminhos absolutos de assets para `/autocard/...`.
- Ajustar o modulo frontend para usar `/api/autocard/...`.
- Criar `public/autocard.html` com shell, link de navegação e carregamento dos
  assets do modulo.
- Preservar exportacao PNG no browser e os quatro templates ativos atuais.

## 2. Cargos e schema

- Criar `api/db/migrations/010_autocard.sql`.
- Renomear/reassociar os quatro cargos RH para DHO sem violar o índice único de
  nomes ou a FK de `users.job_title_id`.
- Criar `autocard_cards` e `autocard_media` com constraints para JSON, enums,
  UUID, timestamps e foreign keys.
- Atualizar `api/db/schema.sql` para instalações novas.
- Atualizar `api/db/provision.js` com grants de `portal_api`.
- Atualizar `api/db/verify-migrations.js` com a migration 010, tabelas,
  colunas, constraints e privilégios.

## 3. Política e API

- Criar helper de política para nomes exatos de cargo DHO.
- Criar `api/routes/autocard.js` com auth middleware e `403` uniforme.
- Implementar access discovery, CRUD, busca, duplicação e exclusão.
- Implementar upload raw de JPEG/PNG/WebP com limite, assinatura, normalização
  e armazenamento no volume de uploads.
- Implementar entrega autenticada de mídia.
- Usar `withAudit` nas escritas de cards.
- Evitar retorno de caminhos internos, credenciais ou dados de outros recursos.
- Montar a rota em `api/index.js`.

## 4. Navegação e autorização frontend

- Adicionar item `AutoCard` no sidebar, inicialmente oculto.
- Depois de `requireAuth`, mostrar o item somente quando a API de acesso permitir.
- Criar guard no módulo que redireciona ou mostra acesso negado quando a API
  retornar `403`.
- Não confiar em `sessionStorage`, cargo renderizado ou CSS para autorização.
- Garantir que usuários sem cargo DHO não vejam dados, histórico ou mídia.

## 5. Testes

- Testar normalização e allowlist de cargos DHO.
- Testar migration 010 em banco fresco e banco com cargos RH/DHO existentes.
- Testar grants e ledger.
- Testar todas as rotas com acesso autorizado e não autorizado.
- Testar cards compartilhados entre diferentes usuários DHO.
- Testar validação de template, valores, mídia e limites.
- Testar que o frontend não cria link/rota utilizável para usuário não DHO.
- Testar caminhos de assets e chamadas `/api/autocard`.

## 6. Verificacao

- Rodar `npm run verify`.
- Rodar `git diff --check`.
- Revisar o diff para não incluir `.env`, `data/`, `node_modules` ou arquivos
  do repositório pai.
- Fazer commit apenas no repositório `C:\PROJETOS\_ownerinc_portal`.
- Não alterar ou limpar mudanças não relacionadas em `C:\repo\repo`.
