# Modelo CSV para convites em massa

## Objetivo

Explicar o formato aceito pela importação de usuários em lote e oferecer um
modelo CSV pronto para download na própria tela administrativa.

## Interface

O painel `Importar usuários em lote`, na seção de usuários, terá um link
`Baixar modelo CSV` próximo ao seletor de arquivo.

A tela apresentará orientações curtas para cada coluna:

- `name`: obrigatório, com até 120 caracteres;
- `email`: obrigatório, válido e não repetido no arquivo ou no Portal;
- `job_title`: nome exato de um cargo ativo cadastrado no Portal;
- `contract_type`: somente `clt` ou `pj`, em letras minúsculas;
- `pj_due_day`: vazio para CLT e um dia de `1` a `31` para PJ;
- `phone`: opcional, com até 40 caracteres.

A orientação também informará que o arquivo deve permanecer em CSV UTF-8,
conservar os cabeçalhos e a ordem das colunas e conter no máximo 500 pessoas.

## Arquivo

O modelo será um arquivo estático em `public/`, sem nova rota ou dependência.
Ele terá os cabeçalhos exatos aceitos pela API, nesta ordem:

```text
name,email,job_title,contract_type,pj_due_day,phone
```

Haverá duas linhas fictícias para demonstrar os formatos CLT e PJ. Os dados
serão claramente marcados como exemplos, e a tela avisará que ambas as linhas
devem ser substituídas ou removidas antes da pré-visualização.

## Comportamento

O download não altera o importador. O administrador continua selecionando um
CSV, executando a pré-visualização, corrigindo linhas inválidas e confirmando o
envio dos convites apenas depois da validação existente.

## Validação

Um teste automatizado verificará que:

- o painel contém o link para download e as instruções essenciais;
- o arquivo usa os seis cabeçalhos na ordem exigida;
- as duas linhas de exemplo são aceitas pelo parser CSV quanto à estrutura.

Será executado `npm run verify` antes da entrega.
