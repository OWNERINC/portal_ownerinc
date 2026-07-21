# Changelog

## Unreleased

- Estrutura local com Docker Compose, Firebase Auth Emulator e migrations reais.
- API, cron e frontend preparados para deploy por imagens imutáveis no GHCR.
- Verificações de segurança, governança, retenção, backup, restore, smoke e rollback.
- Integração Sólides preparada, read-only e desligada por padrão (`off`).
- Rollout Sólides documentado por estágios, sem ativar credenciais ou endpoints
  externos antes da homologação.

### Ainda não é release de produção

- Validar Firebase e SendGrid reais.
- Executar backup, restore, smoke e rollback na VPS.
- Configurar domínio, proxy TLS e secrets na VPS.
- Concluir Gate 0 externo da Sólides antes de qualquer promoção de estágio.
