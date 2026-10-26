# Payload CMS — go-live acelerado sem migração inicial

**Data:** 26 de outubro de 2026  
**Status:** aprovado para planejamento  
**Escopo:** Portal Ownerinc e Owner News; sem Ownerinc Brain, n8n ou
`ownerinc-novo-agente/`

## 1. Objetivo

Colocar o Payload CMS em produção mais rapidamente para criação e publicação manual
de novas notícias, sem migrar o acervo legado no primeiro go-live. O Portal deve
continuar exibindo um feed unificado com notícias antigas e novas, enquanto o
editor legado passa a ser somente leitura.

O ganho de prazo vem da redução de escopo da primeira entrega, não da remoção de
backup, autenticação, isolamento, autorização, recuperação ou aceite real.

## 2. Decisões aprovadas

- O Payload começa sem cópia do acervo legado e recebe somente conteúdos novos.
- O acervo legado permanece disponível em modo somente leitura.
- O Portal apresenta um feed unificado, combinando legado e Payload.
- A primeira entrega permite apenas publicação manual.
- A criação e edição de Owner News podem ficar bloqueadas por até 30 minutos durante
  o cutover; as demais áreas e as leituras do Portal permanecem disponíveis.
- O deploy inicial do Payload é acionado manualmente e protegido; não é acoplado ao
  push normal de `main`.
- Depois da primeira mutação aceita no Payload, não é permitido reabrir o legado
  como autoridade de escrita.

## 3. Escopo da primeira entrega

### 3.1 Incluído

- login no admin do Payload por identidade do Portal;
- autorização administrativa explícita;
- criação e edição de notícias novas;
- upload de mídia original;
- salvamento de draft;
- publicação manual;
- leitura das notícias do Payload pelo Portal;
- leitura contínua do acervo legado;
- feed unificado, ordenado e paginado;
- bloqueio persistente de todas as escritas editoriais legadas;
- health, readiness, logs e observação mínima de disco e reinícios;
- backup e restore descartável do legado antes do corte;
- backup do banco e uploads do Payload;
- smoke real com editor e leitor em sessões independentes;
- runbook de ativação e recuperação.

### 3.2 Adiado

- importação de notícias antigas para o Payload;
- importação de drafts, versões, histórico, autores e agendamentos;
- reconciliação integral do acervo dentro do Payload;
- delta final, seal e CAS do protocolo de migração existente;
- Versions/restore como critério bloqueante da primeira entrega;
- autosave como critério bloqueante da primeira entrega;
- publicação agendada e worker;
- decisões e successors para agendas legadas;
- ativação automática do Payload em todo push de produção;
- desativação ou remoção física das tabelas e mídias legadas.

Funcionalidades adiadas não podem aparecer como disponíveis na interface inicial.
O desenho deve permitir adicioná-las posteriormente sem reabrir escrita no legado.

## 4. Autoridade editorial

O Portal mantém a máquina de autoridade já existente. Os dois estados estáveis de
escrita são:

```text
legacy_writable
payload_writable
```

Esses nomes descrevem o comportamento; no schema e no código existentes eles
correspondem, respectivamente, aos modos `legacy` e `payload`.

Os estados transitórios existentes `frozen` e `payload_frozen` permanecem válidos e
fecham as escritas dos dois lados durante ativação ou recuperação. Estado ausente,
desconhecido, contraditório ou ilegível também deve fechar ambas as escritas. A
transição estável concluída pelo primeiro go-live é:

```text
legacy_writable -> payload_writable
```

Todos os endpoints, jobs e caminhos internos capazes de criar, editar, publicar ou
excluir conteúdo legado devem verificar o estado no servidor. Ocultar controles no
frontend não satisfaz o bloqueio.

Antes da primeira mutação nativa aceita — inclusive criação de draft ou upload — uma
falha de ativação pode autorizar retorno controlado a `legacy_writable`, desde que a
ausência de mutações Payload seja comprovada e a reversão seja registrada. Depois da
primeira mutação nativa, o floor é `payload_writable`: recuperação deve restaurar o
Payload, nunca criar duas autoridades nem descartar o novo conteúdo.

## 5. Feed unificado

### 5.1 Contrato interno

A API consulta separadamente a fonte legada e a fonte Payload e normaliza cada item
para um contrato comum. O contrato inclui, no mínimo:

- identificador público;
- origem interna `legacy` ou `payload`;
- título e resumo;
- data efetiva de publicação;
- autor exibível quando disponível;
- mídia pública permitida;
- estado publicado;
- destino de leitura;
- chave estável de paginação.

A origem integra a identidade interna do item. IDs iguais em fontes diferentes não
podem colidir. A API não deve expor credenciais, IDs privados de storage nem campos
administrativos.

### 5.2 Ordenação, deduplicação e paginação

- Somente itens publicados entram no feed.
- A ordenação principal é a data efetiva de publicação em ordem decrescente.
- Empates usam origem e ID como desempate estável.
- A deduplicação usa identidade explícita de origem; heurísticas por título não
  podem esconder documentos distintos.
- A paginação deve ser determinística quando novos itens são publicados entre duas
  requisições.
- Itens legados continuam apontando para sua leitura compatível; itens Payload usam
  a rota canônica nova ou o adaptador público definido na implementação.

### 5.3 Degradação parcial

- Se o Payload falhar na leitura, a API entrega o acervo legado disponível e registra
  a degradação; isso não reabre escrita legada.
- Se o legado falhar na leitura, a API entrega os itens disponíveis do Payload e
  registra a degradação.
- Se ambas as fontes falharem, a API retorna erro controlado sem fabricar feed vazio
  como sucesso.
- A resposta deve permitir que operação diferencie resultado completo de parcial,
  sem revelar detalhes internos ao usuário.

## 6. Runtime e segurança mínimos

O Payload usa banco, usuário PostgreSQL, volumes, containers e credenciais separados
do runtime legado. A rota pública `/editorial/admin` permanece fechada até readiness,
autenticação e autorização passarem.

São obrigatórios:

- segredos fora do repositório e de artefatos públicos;
- privilégio mínimo no PostgreSQL e storage;
- TLS e headers compatíveis com o Portal;
- upload com limites e tipos permitidos já definidos pelo produto;
- autorização administrativa validada no servidor;
- health e readiness distintos;
- logs sem tokens, conteúdo privado ou credenciais;
- backup do banco e dos uploads do Payload;
- reinício sem perda de draft, publicação ou mídia.

O primeiro go-live não precisa instalar o conjunto completo de protocolo de migração,
mas a instalação deve ser idempotente, usar imagens imutáveis e recusar configuração
ambígua.

## 7. Entrega em três PRs

### PR 1 — autoridade e convivência de leitura

- materializar e testar o estado de autoridade;
- bloquear todos os writers legados em `payload_writable`;
- implementar o adaptador de leitura Payload;
- implementar o feed unificado;
- cobrir ordenação, paginação, identidade e degradação parcial;
- manter o Payload privado e sem autoridade ao final.

### PR 2 — runtime mínimo do Payload

- preparar banco, volumes, imagem e configuração isolados;
- integrar login e autorização administrativa;
- habilitar criar, editar, upload, draft e publicação manual;
- implementar health, readiness, logs e backup;
- provar persistência após reinício;
- não adicionar worker, agendas ou importador.

### PR 3 — cutover protegido

- implementar a transição fechada de autoridade;
- publicar `/editorial/admin` somente após readiness;
- adicionar o dispatch manual protegido;
- registrar o ponto de não retorno após a primeira mutação aceita;
- documentar backup, restore, ativação, smoke e recuperação;
- executar os checks automatizados e preparar a jornada real de aceite.

Cada PR deve receber revisão fresca, CI verde e aceite antes da seguinte. As três PRs
podem reduzir burocracia documental, mas não podem compartilhar mutações concorrentes
no mesmo ambiente.

## 8. Cutover

1. Qualificar o commit e as imagens imutáveis que serão executados.
2. Capturar backup do banco e uploads legados.
3. Restaurar o backup em destino descartável e validar dados e arquivos.
4. Subir o Payload em rede privada e executar smoke administrativo.
5. Ativar o feed unificado enquanto o Payload ainda não possui conteúdo publicado.
6. Iniciar a janela editorial e registrar o horário.
7. Drenar escritas legadas em andamento e transicionar para `payload_writable`.
8. Publicar `/editorial/admin` e confirmar autenticação, autorização e readiness.
9. Criar uma notícia de aceite, enviar mídia, salvar draft e publicar manualmente.
10. Ler a notícia em sessão independente e conferir sua posição junto ao legado.
11. Registrar a primeira mutação Payload aceita, incluindo draft ou upload, como
    ponto de não retorno.
12. Encerrar a janela, exigindo duração de no máximo 30 minutos.

O GitHub deployment só recebe sucesso depois da jornada de editor e leitor. Falhas
preservam logs e evidências sanitizadas.

## 9. Recuperação e falhas

- **Antes de qualquer mutação Payload:** remover a rota pública e, após comprovar
  ausência de mutação, permitir reversão registrada para `legacy_writable`.
- **Depois da primeira mutação Payload:** manter `payload_writable`, fechar novas
  escritas se necessário e recuperar banco, storage ou aplicação do Payload.
- **Falha de upload ou publicação:** manter o conteúdo não publicado e impedir que
  referências incompletas apareçam no feed.
- **Falha parcial do feed:** servir a fonte saudável e emitir sinal operacional de
  degradação.
- **Estado de autoridade ilegível:** recusar escrita em ambos os sistemas.
- **Resultado desconhecido da transição:** não repetir a transição cegamente;
  observar o estado durável antes de qualquer nova ação.

## 10. Verificação e aceite

### Automatizado

- writers legados aceitam em `legacy_writable` e recusam em `payload_writable`;
- estado desconhecido fecha ambas as escritas;
- feed combina, ordena e pagina as duas fontes de forma estável;
- IDs iguais em fontes diferentes não colidem;
- falha de uma fonte produz resposta parcial observável;
- usuário sem permissão não acessa nem muta o CMS;
- conteúdo não publicado não aparece no feed;
- reinício mantém draft, publicação e mídia;
- repetição do cutover não duplica configuração nem reabre o legado;
- checks existentes do Portal continuam passando com `npm run verify`.

### Operacional

- backup legado restaurado com sucesso em destino descartável;
- login administrativo real via HTTPS;
- acesso de usuário não autorizado recusado;
- notícia criada do zero com mídia original;
- draft salvo e publicação manual concluída;
- notícia exibida no feed unificado em sessão independente;
- notícia antiga continua legível;
- tentativa real de escrita legada recusada;
- Portal permanece disponível fora das escritas editoriais;
- janela editorial medida em até 30 minutos;
- banco e uploads Payload possuem backup identificado privadamente.

## 11. Itens que não podem ser cortados

- backup legado e restore descartável;
- isolamento do Payload;
- autenticação e autorização no servidor;
- bloqueio persistente dos writers legados;
- definição do ponto de não retorno;
- HTTPS e smoke real de editor e leitor;
- imagens imutáveis e segredos protegidos;
- health, readiness e logs mínimos;
- preservação do acervo legado;
- comportamento fechado em estado ambíguo.

## 12. Critério de conclusão

A primeira entrega está concluída somente quando:

- o Payload é a única autoridade para novas escritas;
- o editor legado está bloqueado no servidor;
- o acervo legado continua legível;
- o feed unificado apresenta itens das duas fontes corretamente;
- um administrador real cria, envia mídia, salva draft e publica;
- um leitor independente vê a publicação;
- uma conta sem permissão é recusada;
- backup e recuperação mínimos foram comprovados;
- a janela editorial não excedeu 30 minutos;
- o deployment e o handoff identificam commit, imagens, backups e resultado do
  aceite sem registrar dados privados.

Importar o acervo, ativar agendas, oferecer Versions/restore e automatizar o deploy
normal passam a ser entregas posteriores independentes. Nenhuma delas impede chamar
este primeiro go-live enxuto de entregue quando os critérios acima forem satisfeitos.
