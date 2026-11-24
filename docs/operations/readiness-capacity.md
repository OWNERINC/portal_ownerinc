# Prontidão, tráfego e recuperação

Este documento descreve o contrato do pacote de correções de 17/11/2026.
A evidência de implementação fica no
[registro de aceite](../reviews/2026-11-17-portal-readiness.md).
Os orçamentos abaixo não certificam a capacidade da VPS.

## Proteção de tráfego

| Camada | Chave confiável | Orçamento |
| --- | --- | --- |
| API, entrada agregada | IP obtido pelo caminho de proxy configurado | 30.000/15 minutos |
| API autenticada | UID de token validado pelo Firebase, com revogação | 300/15 minutos |
| Escritas autenticadas | UID | 60/15 minutos |
| Progresso Academy | UID, rota PUT específica | 120/15 minutos |
| Foto do perfil | UID | 10/15 minutos |
| Cadastro público | IP | 300/hora por padrão, configurável |
| Recuperação pública de senha | IP | 5/hora por limitador específico |
| Nginx API, Pages e bulk | IP resolvido pelo Nginx | 20 req/s, burst 500 |
| Nginx uploads | IP, zona compartilhada | 60/minuto, burst 20 |
| Nginx leitura de mídia | IP | 60 req/s, burst 500 |

Os limites são cumulativos, não quotas independentes somáveis. Uma escrita ou
transferência autenticada também consome o orçamento geral do UID. Cem usuários
da mesma rede deixam de disputar um único orçamento de 300 chamadas; continuam
sujeitos às proteções agregadas.

O cadastro segue a configuração e a fila descritas em
[Tráfego do cadastro público](registration-traffic.md), incorporadas à main
após o pacote original de 17/11. A integração preserva esse contrato; as duas
rotas públicas de recuperação de senha mantêm seus limites independentes.

Só o UID retornado pela validação do token define identidade. Enviar um header
Bearer, variar seu texto ou informar UID em payload/header não cria uma
identidade validada. Os gates de conta ativa, habilitação, cargo, capacidades,
audiência e Ética continuam necessários.

A API responde 429 e `Retry-After` quando seu bucket se esgota. O valor indica
segundos até a próxima janela. A limitação Nginx é uma camada diferente e mantém
seu comportamento HTTP próprio; um erro de borda não deve ser diagnosticado
somente pelo corpo JSON da API. Não fazer retry imediato em loop.

Os limitadores Express vivem na memória do processo. Reiniciar o processo
reinicia seus buckets; réplicas diferentes não compartilham esses contadores.
Uma mudança para múltiplas réplicas exige rever esse contrato.

O IP depende da cadeia real de ingress/proxy. O pacote não altera `trust proxy`
ou amplia confiança em cabeçalhos. Validar a cadeia e a sanitização de headers
no ambiente autorizado é parte da homologação.

### Rajadas e uploads

O burst de API atende o envelope inicial proposto de cem pessoas com até cinco
chamadas próximas. Com `nodelay`, as chamadas admitidas podem chegar juntas ao
backend. Isso é orçamento de admissão, não prova de latência ou CPU disponível.

Uploads conservam limites de bytes e normalização. Pages admite um processamento
de mídia por processo; concorrentes podem receber `media_busy`. Cem uploads ou
exportações simultâneos não são equivalentes a cem leitores e exigem um perfil
de carga próprio.

## Conexões de convites

O convite administrativo termina a transação de criação e devolve a conexão
antes de chamar a habilitação que pode adquirir outra. Compensação também deve
começar após liberar ou descartar a conexão do handler.

Conexões recebidas por um helper pertencem ao chamador. Resultado incerto deve
ser comunicado para descarte, sem liberação duplicada ou reutilização da mesma
conexão como se estivesse saudável.

Na aprovação de cadastro, `enableActiveUser` pode devolver os metadados internos
não enumeráveis `discardClient` e `afterRelease`. O serviço de aprovação propaga
ambos; a rota proprietária libera/descarta o client antes de aguardar
`afterRelease()`, que restaura o marcador pendente com uma nova conexão. Esses
metadados não integram o JSON HTTP. Um futuro chamador que forneça client deve
cumprir o mesmo contrato.

Os seletores de cleanup Firebase e reconciliação de habilitação também liberam
sua conexão antes de chamar helpers que adquirem outra. A evidência cobre esses
caminhos e o convite administrativo, não uma garantia global para todos os
fluxos. O worker bulk ainda retém conexões de job/linha ao usar helpers; rejeição
e retenção possuem outros ramos históricos de reconciliação. Devem entrar no
perfil de carga e falhas da homologação.

O pool padrão não é uma contagem de pessoas suportadas. Ele compartilha conexões
entre operações; sua ocupação e tempo de retenção precisam ser medidos. Aumentar
o pool não substitui corrigir aquisição circular.

## Retenção de cadastros

A identidade temporal usada pela exclusão é texto retornado pelo PostgreSQL na
releitura sob lock. O DELETE compara essa chave exata, além de ID, UID, estado e
marcador de cleanup. Converter a chave em Date perderia microssegundos.

Uma exclusão inesperada de zero linhas deve aparecer como falha de retenção,
não como execução sem trabalho. Monitorar os contadores e repetição de candidatos.
Controles de aprovação, referências existentes e elegibilidade seguem válidos.

Ensaio local descartável: instalar PGlite fora do projeto, informar seu módulo
em `PGLITE_MODULE_PATH` e executar
`node tests/database/check-registration-retention.mjs`. O script usa SQL em
memória, parser/bind de `pg` e Firebase falso; não aceita URL de banco existente
nem comprova concorrência do PostgreSQL nativo.

## Resultado incerto em uploads

Existem três situações distintas:

1. **Falha anterior ao COMMIT e rollback confirmado:** o arquivo novo pode ser
   removido pela compensação.
2. **COMMIT confirmado:** preservar o arquivo novo, inclusive se falhar apenas
   o envio da resposta HTTP.
3. **COMMIT enviado sem resultado conhecido ou rollback incerto:** preservar
   bytes potencialmente referenciados e descartar a conexão.

Um ROLLBACK enviado depois de perder a confirmação do COMMIT não prova que a
transação foi desfeita. Não apagar a imagem para “limpar o erro” sem esclarecer
o estado persistido.

Essa política não transforma erro em sucesso nem dispara nova escrita
automaticamente. O operador deve correlacionar request ID, estado do banco e
existência do arquivo antes de uma ação de limpeza.

Na foto, a imagem anterior só é removida após confirmar a nova gravação.
A preservação conservadora pode deixar órfãos. Cards têm retenção específica
de mídias sem referência/arquivos órfãos; seu prazo e execução continuam
necessários. Não há expurgo automático geral de fotos órfãs implementado.

## Critério de liberação para cem usuários

O aceite depende de identificar:

- revisão e configuração efetivamente implantadas;
- hardware, concorrência de outros serviços, armazenamento e banda;
- atividades, proporção de leitores/editores, NAT e pico de entrada;
- SLOs, duração, métricas e limites de interrupção aprovados.

A proposta da auditoria é subir 20→50→100 usuários ativos e sustentar cem por
30 minutos, incluindo rede compartilhada e distribuída. Esses parâmetros
continuam uma proposta até aprovação do ambiente e da carga.

Medir p95/p99, códigos por camada, falhas de jornada, CPU/RSS, event loop,
aquisição/ocupação do pool, locks, disco e banda. Separar uso comum de uploads,
exportações, manutenção e provedores externos lentos.

Testes unitários, transporte SQL falso, Firebase falso e PGlite não substituem
PostgreSQL nativo, autenticação real, Nginx efetivo, SMTP ou hardware. A release
também precisa das jornadas completas e da recuperação de backup autorizada.
