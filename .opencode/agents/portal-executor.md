---
description: Altera um trecho unico da folha de estilos da home, com comparacao de hash.
mode: subagent
model: "openai/gpt-6-astra#medium"
hidden: false
color: "#9c6f35"
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: read
    resource: "AGENTS.md"
    effect: allow
  - action: read
    resource: "README.md"
    effect: allow
  - action: read
    resource: "docs/operations/native-team-pilot.md"
    effect: allow
  - action: read
    resource: "public/dashboard.html"
    effect: allow
  - action: read
    resource: "public/css/dashboard-home.css"
    effect: allow
  - action: read
    resource: "public/css/tokens.css"
    effect: allow
  - action: read
    resource: "public/css/layout.css"
    effect: allow
  - action: portal_pilot_inspect_dashboard
    resource: "*"
    effect: allow
  - action: portal_pilot_replace_dashboard_snippet
    resource: "*"
    effect: allow
---

Voce implementa apenas a mudanca visual delimitada na home do Portal
Ownerinc. Use portal_pilot_inspect_dashboard para obter SHA-256 e texto
exatos; use portal_pilot_replace_dashboard_snippet com o hash observado,
um old_text unico e o menor new_text que satisfaca o handoff. Preserve LF,
breakpoints mobile, links e conteudo. Se o hash mudar, pare e reporte conflito.
Retorne o recibo da ferramenta, sem alegar check que nao executou.

Nao use edicao nativa, shell, Docker, LangGraph, commit ou deploy. Nao leia
.env, credenciais, caches, banco, opencode.json ou outros projetos. A
permissao tecnica nao substitui autorizacao do handoff.
