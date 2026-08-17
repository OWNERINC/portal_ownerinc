# Catálogo de Cargos e Acessos por Cargo

## Objetivo

Atualizar o catálogo de cargos do Portal com as nomenclaturas padronizadas
aprovadas e alinhar o acesso ao AutoCard às novas nomenclaturas de RH.

## Catálogo Ativo

Os seguintes cargos permanecerão ativos:

- Analista Administrativo
- Analista de Cobrança
- Analista de Engenharia
- Analista de Pós-Vendas
- Analista de RH Sênior
- Analista de Departamento Pessoal
- Analista Financeiro
- Analista Financeiro Sênior
- Assistente Administrativo
- Auxiliar de Limpeza
- CEO
- Consultor de Vendas
- Consultora de Pós-Vendas
- Consultora de Pós-Vendas Júnior
- Consultora de Pós-Vendas Pleno
- Coordenador Central de Férias
- Coordenador de Compras
- Coordenador de Contratos
- Coordenador de Sala
- Coordenador Financeiro
- Coordenador de Pós-Vendas
- Coordenadora Administrativa
- Coordenadora de Planejamento
- Coordenadora de Projetos
- Coordenadora de Vendas
- Design
- Diretor Comercial
- Diretor de Incorporação
- Diretor de Marketing
- Engenheiro Civil
- Especialista de Controladoria
- Especialista de Marketing
- Garçom
- Garçom Sênior
- Garçonete
- Gerente Administrativo
- Gerente Comercial
- Gerente de Marketing
- Gerente de Obra
- Gerente de Pós-Vendas
- Gerente de Promoção
- Gerente de RH
- Jovem Aprendiz
- Líder de Promoção
- Motorista
- Promotor de Vendas
- Recepcionista
- Redator
- SDR
- Social Media

Os nomes serão únicos sem diferenciação entre maiúsculas e minúsculas. A
normalização corrige acentos, grafia e concordância aprovados pelo usuário,
incluindo `Auxiliar`, `Design`, `Líder`, `Sênior`, `Júnior`, `Pós-Vendas` e
`Coordenadora Administrativa`.

## Migração de Dados

Uma migration nova fará o seed do catálogo e desativará cargos antigos que
não estejam na lista ativa. Registros antigos não serão apagados, preservando
histórico e respeitando a referência `users.job_title_id` com `ON DELETE
RESTRICT`.

Os vínculos atuais serão migrados nestes casos:

- `Analista de DHO` para `Analista de RH Sênior`;
- `Gerente de DHO` para `Gerente de RH`.

`Assistente de DHO` e `Coordenador de DHO` serão mantidos apenas como registros
inativos, sem substituição automática e sem acesso ao AutoCard.

## Acesso ao AutoCard

O conjunto de cargos permitido será substituído por:

- `Analista de RH Sênior`;
- `Gerente de RH`.

A comparação continuará normalizada para minúsculas com locale `pt-BR`. Admin
ou super-admin sem um desses cargos não receberá acesso ao AutoCard por essa
regra.

## Interface e Validação

O painel administrativo continuará carregando cargos ativos pela API. A
seleção de cargo em usuários novos e existentes exibirá somente cargos ativos,
enquanto usuários legados com cargo inativo continuarão legíveis até serem
reatribuídos.

Testes cobrirão a lista ativa, a migração das duas nomenclaturas DHO, a
desativação dos cargos fora do catálogo e o acesso/negação do AutoCard para os
dois cargos aprovados e para cargos sem acesso.

## Rollout

1. Criar e validar a migration em banco descartável.
2. Atualizar a política do AutoCard, invariantes e documentação relevante.
3. Executar `npm run verify` e os testes de migration.
4. Publicar via CI/deploy, que aplica a migration antes do smoke test.
5. Confirmar no ambiente live a lista administrativa e o acesso dos cargos
   aprovados.
