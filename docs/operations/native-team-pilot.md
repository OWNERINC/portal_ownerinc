# Piloto da equipe nativa no Portal Ownerinc

O Chief of State e os quatro especialistas operam neste repositório pelo
OpenChamber/OpenCode. O primeiro piloto altera somente
`public/css/dashboard-home.css`: organizar a home autenticada em duas colunas
nas telas largas, mantendo a leitura em uma coluna nas telas menores.

O MCP local `portal_pilot` oferece inspeção dos bytes e SHA-256 da folha de
estilos, substituição de um trecho único com comparação do hash anterior e
parecer versionado em `docs/operations/agent-reviews/`. Somente executor e
especialista podem substituir o trecho; somente o Chief grava pareceres.
Nenhum agente recebe shell, acesso à API, cron, `.env`, deploy ou escrita em
outra página. O operador executa os checks do repositório e verifica os
metadados de sessão e modelo no host antes do parecer.

Aceite do piloto: diff limitado à folha de estilos e aos arquivos do harness,
home utilizável nas larguras desktop e mobile, `npm run verify` e revisão
técnica independentes registrados, parecer do Chief vinculado ao SHA-256 exato.
Sem commit ou deploy automático.
