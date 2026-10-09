# Embedded Signup: habilitação e piloto

Esta entrega adiciona a conexão inicial pelo Facebook Login for Business, com uma WABA e um número da Cloud API por escritório. A conexão atual continua disponível. O recurso permanece desligado até ser configurado e validado com a Meta em desenvolvimento.

## Conferir o aplicativo na Meta

O envio e o recebimento atuais não confirmam que o Embedded Signup esteja habilitado. No [painel da Meta](https://developers.facebook.com/apps/), identifique ou prepare um aplicativo exclusivo do produto CRM-Advogado, com domínio, credenciais e webhook próprios. Não altere o aplicativo nem o webhook que atendem o escritório do Moacir. O fato de o ambiente antigo enviar mensagens não comprova a configuração do novo produto.

1. Confira a empresa vinculada e sua verificação.
2. Procure Facebook Login for Business e uma configuração de Tech Provider com a variação WhatsApp Embedded Signup. Se não existir, configure esse produto/fluxo e obtenha o **configuration ID**. O App ID sozinho não substitui esse ID.
3. Confira os domínios permitidos para o SDK e as URLs OAuth. Use o domínio HTTPS do ambiente de desenvolvimento primeiro.
4. Confira `whatsapp_business_management` e `whatsapp_business_messaging`, o acesso necessário para clientes externos e o estado da avaliação/publicação do aplicativo. Funcionamento com administradores/testadores não prova acesso por outros escritórios.
5. Confira o webhook `https://SEU-DOMINIO/api/whatsapp/webhook`, a assinatura de `messages` e o segredo de verificação. Configure o segredo e o destino exclusivos da homologação do produto. Não reutilize nem redirecione o webhook do ambiente do Moacir.

Os nomes do painel podem mudar. Referências oficiais: [aplicativo de exemplo da Meta e instruções de configuração](https://github.com/fbsamples/business-messaging-sample-tech-provider-app#3-meta-developer-app), [requisitos para clientes externos](https://github.com/fbsamples/business-messaging-sample-tech-provider-app#going-to-production), [Embedded Signup](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation). A documentação direta da Meta limitou a leitura automática nesta sessão; o exemplo oficial foi consultado.

## Habilitar este CRM em desenvolvimento

1. Reconciliar primeiro o baseline conforme [homologação e migrações](homologacao-e-migracoes.md). O esquema foi importado diretamente do catálogo, sem histórico de migrations: não executar `db push` nem reaplicar cegamente as migrations anteriores. Somente após comparação, revisão e validação do baseline, aplicar o delta `055_whatsapp_embedded_signup.sql` no novo banco de homologação e testar os papéis e políticas reais. Esta entrega não aplica SQL em banco remoto.
2. Configurar no servidor `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`, `META_EMBEDDED_SIGNUP_API_VERSION`, `META_WEBHOOK_VERIFY_TOKEN`, `ENCRYPTION_KEY` e a chave service-role do Supabase. Escolher a versão da Graph API suportada pelo aplicativo. O exemplo de ambiente sugere `v25.0`, sem alterar a versão usada pela integração manual existente.
3. Manter `META_EMBEDDED_SIGNUP_ENABLED=false` até concluir os passos anteriores. Depois habilitar **apenas em desenvolvimento** e reiniciar/republicar o ambiente.
4. Entrar como owner/admin em um escritório de teste sem configuração WhatsApp existente. Em Configurações → WhatsApp, informar o PIN de seis dígitos, preparar a conexão e continuar na Meta.
5. Autorizar uma WABA e um número de teste adequados ao fluxo padrão. Confirmar o salvamento, enviar uma mensagem e receber uma resposta pelo webhook. Nenhuma dessas ações reais foi executada nesta entrega.

Tokens, códigos e PINs não devem ser enviados por chat nem incluídos em comentários da tarefa. Segredos ficam na configuração privada do servidor; nunca use variáveis `NEXT_PUBLIC` para eles. O PIN é usado no registro e não é armazenado pelo CRM: o administrador deve guardá-lo.

## Como o fluxo protege os escritórios

- A API exige owner/admin e resolve `account_id` pela sessão autenticada, nunca pelo formulário.
- Um nonce também fica em cookie HttpOnly, restrito à rota. Sua hash é persistida; uma atualização condicional permite consumir a sessão uma única vez. A sessão expira em dez minutos.
- O token é trocado no servidor, verificado contra o aplicativo, as permissões e a WABA; o número deve constar na WABA autorizada.
- Reservas no PostgreSQL impedem disputas de duas sessões guiadas pelo mesmo escritório, número ou WABA, inclusive em múltiplas instâncias. O limite de início é persistente, por escritório, de um minuto.
- Registro e assinatura do webhook precisam de confirmação positiva. Tokens são criptografados; configuração e conclusão da sessão são gravadas na mesma transação. A entrega só insere uma conexão inicial e não sobrescreve conexões existentes.
- A tabela de sessões é inacessível a anon/authenticated e não armazena tokens, códigos ou PINs. Índices sustentam buscas por conta e reservas; não se introduz fila ou lock em memória.

Não há transação distribuída com a Meta: pode ocorrer registro externo sem confirmação final no CRM. Nessa situação, consultar o suporte e verificar a Meta antes de repetir. Não registrar envelopes brutos de OAuth em logs. Sessões falhadas/expiradas são recuperáveis; registros antigos podem ser eliminados por manutenção periódica, preservando o período de auditoria definido pelo operador.

## Limites e critérios de venda

O fluxo desta entrega é o padrão Cloud API. Não implementa coexistência com o WhatsApp Business do celular, migração de provedor, troca/reconexão de um número existente, cobrança ou renovação automática de autorizações. Não se deve orientar o cliente a apagar o aplicativo ou comprar um SIM novo como regra universal. Para quem depende do aplicativo no celular, avaliar o [fluxo específico de coexistência](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users) e sua elegibilidade antes de qualquer migração.

Os testes de reserva cobrem sessões do novo fluxo. As rotas manuais legadas não usam as mesmas reservas de WABA; operações manuais concorrentes e os achados de isolamento existentes exigem validação adicional. O índice único de número existente continua protegendo o salvamento contra duplicidade. A aplicação no Supabase real deve confirmar grants, RLS e toda a cadeia de migrations.

Antes de liberar para escritórios externos, validar com duas contas distintas: UI e REST, agentes/viewers sem acesso de administração, número/WABA de outra conta rejeitados, envio/recebimento isolados, revogação e falhas parciais. Esta funcionalidade não resolve por si só os outros achados da análise técnica e de segurança do projeto.

Para avaliar a venda, proponho um piloto assistido com três a cinco advogados: medir tempo entre criar o escritório e receber a primeira mensagem, proporção de conexões concluídas sem ajuda, onde abandonam, chamados de suporte e preferência por manter o aplicativo no celular. Critérios propostos para discutir com o time: nenhuma exposição entre contas; pelo menos quatro de cinco conexões concluídas sem intervenção técnica; mediana até dez minutos; resposta recebida em todos os casos concluídos. São metas propostas, não resultados obtidos.

## Fluxo de desenvolvimento

No repositório `CRM-Advogado/crm-advogado`, a branch `codex/embedded-signup` foi criada de `origin/develop` em `efdd4ce`: `develop` estava dois commits à frente de `main`, sem divergência. O port traz somente o Embedded Signup, sem módulos posteriores específicos do ambiente do Moacir. Cada incremento é commitado separadamente; push e PR para `develop` somente após QA local favorável. Promover `develop` para `main` depois da revisão/integração e da validação do ambiente de desenvolvimento, sem ativação automática do recurso em produção.

Os comentários da tarefa técnica registram commits, testes, limites e PR. A tarefa permanece em andamento até a habilitação e o teste real com a Meta.
