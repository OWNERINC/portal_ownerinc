# Tráfego do cadastro público

## Senha e validação do formulário

O cadastro exige senha de 8 a 128 unidades UTF-16, com pelo menos uma letra
maiúscula (inclusive acentuada), e confirmação igual. Não exige número ou símbolo,
nem altera senhas existentes. A mesma regra é aplicada na tela e na API.

O formulário mostra erro textual antes de limpar as senhas quando a validação
falha; nome e email permanecem para correção. Somente um formulário válido envia
a requisição. Essa correção não acrescenta timeout de rede e, sozinha, não
comprova publicação nem identifica a causa de uma tentativa anterior.

## Configuração

`REGISTRATION_MAX_ATTEMPTS_PER_IP_PER_HOUR` define o orçamento da rota pública
`/api/auth/register`: padrão de 300 tentativas por IP por hora, incluindo
repetições e payloads inválidos. Redes com saída compartilhada dividem esse
orçamento. Ausência, zero, negativos, frações e valores inválidos usam 300.

`MAX_PENDING_REGISTRATIONS_PER_HOUR` define uma cota global opcional de novas
solicitações. O padrão é 0, desativada. Ausência, negativos, frações e valores
inválidos também a desativam. Inteiro positivo habilita contagem da última hora
sob lock transacional, independentemente do estado das solicitações.
Quando desativada, a contagem e seu lock não são executados.

O Compose repassa ambas à API. Recuperação de senha e endpoint legado de senha
de cadastro conservam seus limitadores independentes de 5 tentativas/IP/hora.
As proteções gerais de API e Nginx continuam aplicáveis.

## Espera e proteção do banco

O gate compartilhado conserva duas operações ativas por processo. Somente a
rota pública de cadastro, incluindo recuperação de uma repetição, pode aguardar
em fila FIFO: até 100 solicitações, por no máximo 10 segundos cada, antes de
adquirir conexão com o banco ou chamar Firebase.

A operação mantém sua vaga até terminar rollback, compensação e liberação do
client. A conexão original é liberada/descartada antes de helpers adquirirem
outra. Recuperação de repetição readquire admissão depois de liberar a conexão
e a vaga iniciais. Revisões administrativas e recuperação de senha mantêm
admissão imediata, sem entrar na espera.

Desconexões removem entradas aguardando. Operações já iniciadas terminam sua
transação e compensações normalmente; 10 segundos limitam somente a espera.
A fila não é persistente e não grava senha ou payload em disco.

Fila cheia ou espera expirada devolvem 503, motivo seguro `registration_busy`
e `Retry-After: 5`, orientação de nova tentativa, não previsão de capacidade.
Limitação por IP devolve 429 com segundos até a janela seguinte. Cota global
opcional também devolve 429 e o intervalo estimado até expirar a linha mais antiga.

A interface distingue limite, serviço ocupado/indisponível, validação e conexão.
Mostra `Retry-After` quando disponível, sem retry automático ou enumeração de
emails. Sucesso continua estritamente `202 {status:"accepted",state:"received"}`.
Cadastro nasce desabilitado no Firebase e depende de aprovação administrativa.

## Ativação e limites da evidência

Produção usa `/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf`,
não o `.env` da máquina local. Preservar permissão 0600, proprietário e valores
não relacionados; manter backup protegido e usar o lock do deploy.

A configuração **exige código e Compose compatíveis**: na versão antiga,
o limite de 5/IP/hora é fixo e `MAX_PENDING_REGISTRATIONS_PER_HOUR=0` significa
fallback para 100, não desativação. Alterar somente o arquivo não ativa a correção.
Configuração explícita antiga com valor global 100 também precisa ser revisada.

Na ativação, conferir revisão/digests, ambas as variáveis no container e presença
do gate novo, além de readiness, smoke e cron saudável. Não criar contas reais
nem executar carga como efeito implícito da publicação. Nenhum valor acima
certifica 100 cadastros simultâneos: latência do Firebase/banco, fila e demais
orçamentos continuam determinando o resultado.
