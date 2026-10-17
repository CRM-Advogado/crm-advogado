# ADR 002 — Proposta de recebimento durável do WhatsApp

Estado: **PROPOSTO, aguardando alinhamento; implementação não aprovada**.
Data: 16/10/2026. Base: `origin/develop` em `8fb566e`, após PRs #3 e #4.
Escopo deste documento: desenho técnico. Nenhum SQL, endpoint, teste executável,
serviço, configuração de ambiente ou integração real é criado por esta ADR.

## Problema e direção

A rota Meta atual autentica o webhook e agenda processamento com `after()` antes
de devolver 200. Isso mantém o trabalho ligado ao ciclo do servidor, dentro do
tempo disponível, mas não recupera um processo encerrado após a confirmação.
Mensagens, contadores e acionamentos também não pertencem à mesma transação.

O incremento proposto usa somente o PostgreSQL/Supabase existente para uma
inbox e uma outbox **a criar**. Não acrescenta fornecedor de filas nem ativa
YCloud. Primeiro fortalece o caminho Meta existente, com uma conexão por conta,
preservando `whatsapp_config.id` como identidade da conexão.

O usuário confirmou coexistência obrigatória: aplicativo WhatsApp Business e
CRM devem funcionar no mesmo número, inicialmente para advogado individual.
Isso é requisito de onboarding e homologação, não uma propriedade comprovada
pela porta de mensagens ou pela durabilidade aqui proposta.

## Opções de persistência inicial

| Opção | Vantagem | Custo e limite |
| --- | --- | --- |
| Persistir diretamente mensagem/evento canônico normalizado, ledger e intenções em uma transação antes de confirmar | Evita outra cópia do conteúdo; menos estados intermediários | Exige extrair resolução de contato/conversa, contadores e geração de intenções do handler atual. Não pode esperar download, IA ou fornecedor externo; exige cobrir também status, reações e eventos de modelos, que não são todos mensagens. |
| Persistir fragmento validado da conexão na inbox, materializando depois | Separa confirmação rápida de trabalho lento; permite recuperação mesmo antes da resolução de contato/conversa | Duplica temporariamente parte do conteúdo e precisa de política explícita de remoção, processamento e diagnóstico. |

Recomendação para o primeiro recorte: fragmento mínimo validado por conexão,
com materialização posterior e descarte do conteúdo da inbox após conclusão
transacional. O ledger mínimo de deduplicação é distinto desse conteúdo e não
deve ser apagado junto: remover a chave permitiria repetir um evento antigo.
A persistência canônica direta é uma evolução possível para tipos cujo caminho
inteiro já puder ser executado em transação curta, sem chamadas externas.

O recorte não deve guardar indiscriminadamente todo o envelope HTTP. Um lote
Meta pode conter mais de uma conexão/conta. Cada item deve conter apenas os
dados necessários daquele evento e daquela conexão autorizada. Hash do corpo e
metadados técnicos podem servir ao diagnóstico, sem duplicar conteúdo de outras
contas. Credenciais e headers de autorização não integram o payload persistido.

## Fluxo proposto

1. Limitar o tamanho da requisição e autenticar os bytes originais antes de
   interpretar o corpo. Validar estrutura e resolver número/WABA para uma
   conexão autorizada no servidor, sem aceitar conta indicada pelo JSON.
2. Separar os itens e persistir atomicamente o lote aceito na inbox. Só responder
   2xx depois do commit. Falha de banco deve produzir resposta de falha, permitindo
   nova entrega; uma falha de persistência nunca vira confirmação positiva.
3. Aplicar unicidade por provedor, conexão e identidade do evento. YCloud fornece
   `event.id`. Para Meta, definir chave por tipo: mensagem recebida usa seu ID;
   status distingue ID da mensagem, estado e timestamp; os outros tipos exigem
   chave própria. Não usar hash do envelope inteiro como identidade da mensagem.
4. Um worker reserva itens em lote pequeno, com operação atômica no PostgreSQL,
   `FOR UPDATE SKIP LOCKED`, prazo da reserva e token de posse. Um worker antigo
   não pode concluir um item reservado novamente por outro.
5. Materializar efeitos no banco em transação: registrar o ledger, criar ou
   resolver contato/conversa, persistir a mensagem/reação/status, atualizar
   contadores e produzir as intenções de acionamento na outbox. A conclusão da
   inbox deve pertencer ao mesmo commit. Nenhuma chamada externa nessa transação.
6. Processar as intenções separadamente, com identidade estável por evento e
   ação. Remover o conteúdo do fragmento processado após sua materialização
   confirmada, mantendo apenas o ledger e metadados mínimos acordados.

Eventos de mensagem, status, reação e ciclo de modelos hoje tratados pela rota
Meta precisam de uma classificação explícita de aceito, duplicado, não suportado
ou sem vínculo autorizado. Um lote misto não pode perder silenciosamente um item
conhecido porque outro tipo ainda não foi migrado. A chave dos eventos de modelo
e seu vínculo WABA devem entrar no desenho do processamento antes de substituir
a rota completa; não se deve alegar durabilidade de toda a rota migrando só texto.

## Reserva, falhas e efeitos externos

A inbox distingue pendente, reservado, concluído e falha que exige diagnóstico.
A reserva vencida permite retomar trabalho transacional idempotente. O worker
deve comprovar posse antes de concluir; a unicidade e o ledger impedem outra
mensagem, outro unread ou outro conjunto de intenções para a mesma entrega.

A outbox não promete exatamente uma execução no fornecedor. Os motores atuais
podem enviar mensagens e depois falhar antes do checkpoint; chamá-los novamente
sem controle duplicaria envios. Por isso:

- A outbox também precisa de claim concorrente, lease e token de posse próprios.
  Registrar duravelmente o checkpoint de **efeito externo iniciado antes da
  chamada de rede**. Se a reserva expirar depois desse checkpoint, tratar como
  incerto e encaminhar para reconciliação manual, nunca repetir automaticamente.
  Isso inclui a janela em que o processo pode ter caído antes de executar o
  POST: a classificação é conservadora porque o banco não prova esse instante.
- Separar intenções e sua identidade antes de acioná-las; definir ledger por
  evento/automação ou fluxo e controlar a execução de seus passos.
- Falha definitivamente anterior ao envio pode ser elegível para nova tentativa
  limitada. Timeout, perda de resposta ou queda após iniciar efeito externo
  produzem resultado **incerto**, sem retentativa automática nem failover.
- Disponibilizar diagnóstico manual com conta, conexão, IDs de evento/ação,
  referência do provedor quando existente, fase e motivo estável. Não expor
  tokens ou corpo de mensagens nos logs.
- Uma ação manual de reconciliar ou repetir exige identificação da intenção e
  registro da decisão; não pode ser um botão que reenvia todos os itens incertos.

O worker pode ser acionado por um agendador já utilizado pelo projeto, protegido
por autenticação de cron e com lotes limitados. Implementar o handler não prova
que o agendamento esteja configurado. Destino, frequência e operação devem ser
validados no ambiente exclusivo antes de afirmar recuperação automática.

## Retenção, acesso e saturação

Proposta: remover o conteúdo dos itens processados depois do commit de
materialização, evitando uma cópia permanente. **Ainda precisam de alinhamento**:
retenção do ledger mínimo e dos itens pendentes, falhos ou incertos; responsáveis
pelo diagnóstico; e prazo de tratamento. Esta ADR não escolhe um TTL de falhas.

Não apagar itens não resolvidos silenciosamente ao atingir prazo ou capacidade.
Definir limites de lote/tamanho, métricas de idade e volume, alertas e pausa
controlada. Se não for possível aceitar duravelmente, responder falha; não
devolver 2xx para aliviar uma fila cheia descartando eventos. Um diagnóstico
deve distinguir falha de configuração, evento sem vínculo e processamento parado.

Payloads da inbox e credenciais permanecem acessíveis apenas ao processamento
de servidor; telas administrativas podem receber metadados mínimos por conta.
RLS, privilégios e RPCs precisam ser testados com duas contas e service-role:
usar `account_id` numa tabela não comprova isolamento. RPCs de worker não devem
ficar executáveis por anon/authenticated; limitar permissões e `search_path`.

Cada evento aceito conserva os `accountId` e `connectionId` originais. Revogar
ou revincular um número não reatribui eventos antigos nem permite enviar pela
conexão de outra conta. Remoção de conta/conexão com trabalho pendente exige
cancelamento explícito e decisão de retenção, não exclusão silenciosa dos itens
por `ON DELETE CASCADE`. Homologar revogação, revínculo e cancelamento antes
da ativação, sem manter credenciais revogadas disponíveis para novos envios.

## Fases e rollback

1. Aprovar o recorte, retenção e ambiente; integrar testes de banco descartável
   e preparar migrations aditivas/idempotentes na sequência da base atual.
   Esta base termina em `044`; não importar a migration `055` de outro projeto.
2. Criar inbox/ledger/outbox e worker em ambiente local, com dados sintéticos.
   Validar o conjunto de tipos de evento antes de substituir o caminho Meta.
3. Homologar no ambiente exclusivo, com número autorizado, falhas controladas,
   agendador e métricas. Não aplicar migrations externamente por consequência
   da aprovação deste documento.
4. Ativar gradualmente somente após aceite. A reversão deve poder pausar o
   worker preservando os itens aceitos. Manter leitura/diagnóstico e drenagem;
   não apagar tabelas ou eventos durante rollback.

Voltar para o antigo handler que confirma antes de persistir não é um rollback
seguro para itens já aceitos. Se a aplicação precisar recuar, manter o ingresso
durável compatível ou interromper novas confirmações com resposta de falha.
A estratégia exata de corte deve ser ensaiada antes da ativação.

## Aceite proposto e evidência

- Toda mensagem aceita em 2xx tem registro durável e pode ser recuperada após
  reinício; eventos não suportados ou sem vínculo têm resultado explícito.
- Reentrega e concorrência não duplicam mensagem, unread ou intenção no banco.
- Status atrasados não regridem, e reservas vencidas/worker antigo não corrompem
  a conclusão. Eventos de contas diferentes nunca compartilham processamento.
- Envio externo incerto fica identificável para diagnóstico e não é repetido
  automaticamente. Não se promete exactly-once externo ou entrega comercial.
- Testes em PostgreSQL real cobrem commit/rollback, unicidade, workers paralelos,
  queda antes/depois de cada commit, expiração da reserva, replay, lote misto,
  transições concorrentes, limites e isolamento de duas contas. Mocks isolados
  não comprovam esses pontos.
- Na outbox, dois consumidores da mesma intenção não iniciam dois envios.
  Testar quedas entre checkpoint, POST e resposta; reserva vencida após o
  checkpoint sempre vai para diagnóstico incerto, inclusive se o POST talvez
  não tenha ocorrido. Revogação/revínculo não muda a conta/conexão do evento.
- Testes regressivos acompanham cada bug encontrado. QA independente registra
  candidato, resultados e limitações; a homologação real registra o SHA exato.

## Próximos incrementos e decisões

Após o recorte de durabilidade, preparar persistência comum de conexão e dos
dois IDs da mensagem, com backfill Meta que preserve a identidade atual e
diagnostique conflitos sem apagar dados automaticamente. Manter uma conexão por
conta. Migrar administração de modelos e mídia para portas pequenas pode ocorrer
em PRs separados, sem escolher cobrança ou onboarding.

Antes do piloto YCloud, a coexistência obrigatória exige confirmar elegibilidade
do número/app e modalidade de autorização, além de implementar e homologar os
eventos SMB/echo necessários sem duplicar mensagens entre aplicativo e CRM.
O evento documentado `whatsapp.smb.message.echoes` deve espelhar envios do
aplicativo/companion sem tratá-los como mensagens recebidas de cliente ou
acionar bots. Homologar correlação por `wamid`, deduplicação e pausa coerente
de automação quando uma pessoa intervém pelo aplicativo; não inferir esses
comportamentos apenas pela existência de uma assinatura válida.
O normalizador atual ignora essas famílias; isso é limitação bloqueadora do
piloto com coexistência, não funcionalidade pronta. Não ativar, migrar número,
desinstalar o aplicativo ou contratar serviço como parte deste desenho.

Para avançar, alinhar retenção e operação dos itens não resolvidos, identificar
o ambiente exclusivo de homologação e quem providenciará o credenciamento de
parceiro/número autorizado. Não solicitar ou registrar segredos no documento.
Cobrança e escolha do mecanismo de onboarding continuam pendentes. Nenhuma dessas
pendências impede revisar e aprovar um recorte técnico local bem delimitado.

Referências para detalhar a coexistência antes do piloto: documentação primária
YCloud sobre [atualizações de identidade e eventos](https://docs.ycloud.com/reference/webhook-updates-bsuid)
e [payloads de webhook](https://docs.ycloud.com/reference/webhook-events-payloads).
A consulta da retomada identificou `whatsapp.smb.message.echoes`; isso não
substitui fixtures versionadas, credenciamento e homologação com aplicativo real.
