# Importar e exportar automações (JSON)

Cria automações em lote a partir de um arquivo, em vez de montar cada
uma no builder.

- **Exportar:** botão _Exportar_ na tela de automações, ou
  `GET /api/automations/export` (`?ids=a,b` para escolher quais).
- **Importar:** botão _Importar_, ou `POST /api/automations/import`.
  Com `?dry_run=true` o arquivo é validado e **nada** é gravado — é o
  que a tela usa para montar a prévia.

Os dois falam o mesmo formato. O caminho recomendado para escrever o
primeiro arquivo é montar **uma** automação no builder, exportar, e
usar o resultado como molde.

## Exemplos prontos

Em `docs/exemplos/`, cobertos por `src/lib/automations/docs-examples.test.ts`
— se um deles deixar de importar, o CI quebra antes de chegar na mão de
quem for usar:

| Arquivo | Para quê |
| --- | --- |
| `01-basico-sem-referencias.json` | Importa limpo em **qualquer** conta: 4 automações que não citam tag, funil nem pessoa. É o teste do caminho feliz. |
| `02-com-referencias.json` | Exercita tag, funil, etapa e agente. Troque os `TROQUE PELO...` pelos nomes da sua conta; como está, é recusado de propósito. |
| `03-erros-esperados.json` | Dispara todos os códigos de erro de uma vez, para conferir como a prévia os apresenta. Nada é gravado. |

## Tudo ou nada

A importação valida o documento inteiro antes de gravar qualquer
coisa. Se houver um problema na décima segunda automação de um arquivo
de vinte, nenhuma das vinte é criada. Isso evita o estado em que parte
do arquivo entrou, ninguém sabe qual parte, e reenviar o arquivo
corrigido duplica o que já existia.

## Formato

```json
{
  "version": 1,
  "automations": [
    {
      "name": "Triagem BPC",
      "description": "Classifica o lead e abre o caso no funil.",
      "trigger_type": "keyword_match",
      "trigger_config": { "keywords": ["bpc", "loas"], "match_type": "contains" },
      "is_active": false,
      "steps": [
        {
          "step_type": "send_message",
          "step_config": { "text": "Olá! Vou fazer algumas perguntas sobre o seu caso." }
        },
        {
          "step_type": "add_tag",
          "step_config": { "tag": "Lead BPC" }
        },
        {
          "step_type": "condition",
          "step_config": {
            "subject": "message_content",
            "operand": "message_text",
            "value": "aposentado"
          },
          "branches": {
            "yes": [
              {
                "step_type": "create_deal",
                "step_config": {
                  "pipeline": "Funil BPC",
                  "stage": "Triagem",
                  "title": "BPC — lead do WhatsApp"
                }
              }
            ],
            "no": [
              {
                "step_type": "assign_conversation",
                "step_config": { "mode": "specific", "agent": "ana@escritorio.com" }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

`version` pode ser omitido. `description` e `is_active` também —
`is_active` ausente vale `false`.

## Referências por nome

Tags, funis, etapas, pessoas e campos personalizados são escritos pelo
**nome**, não pelo UUID:

| No arquivo | Vira no banco | Onde aparece |
| --- | --- | --- |
| `"tag": "Lead BPC"` | `tag_id` | `add_tag`, `remove_tag`, gatilho `tag_added` |
| `"pipeline": "Funil BPC"` | `pipeline_id` | `create_deal`, `move_deal_stage`, gatilhos de funil |
| `"stage": "Triagem"` | `stage_id` | idem — resolvido **dentro** do funil declarado |
| `"to_stage"` / `"from_stage"` | `to_stage_id` / `from_stage_id` | gatilho `deal_stage_changed` |
| `"agent": "Ana Souza"` ou o e-mail | `agent_id` | `assign_conversation` com `mode: "specific"` |
| `"field": "custom:Número do Processo"` | `custom:<uuid>` | `update_contact_field` |
| `"tag": "Lead BPC"` | `operand` | `condition` com `subject: "tag_presence"` |

O UUID cru também é aceito (`"tag_id": "..."`), útil quando se copia um
config existente. Nos dois casos vale a mesma regra: **a referência só
resolve se pertencer à sua conta**. Um id de outra conta é recusado
como `unresolved_reference` — nenhum passo é gravado apontando para
algo que a conta não enxerga.

Etapas resolvem dentro do funil porque nomes como "Triagem" ou
"Fechado" se repetem entre funis. Declare sempre `pipeline` junto de
`stage`.

### O que NÃO é referência

`send_signature_request.template_token`, `document_signed.template_token`
e as chaves de `send_signature_request.variables` são identificadores do
**ZapSign**, não registros desta conta. Passam intactos, sem resolução e
sem catálogo — um token errado só falha na primeira execução, não no
import.

### Nomes repetidos

Nem tags nem funis nem etapas têm nome único no banco. Se a conta tiver
duas tags "Lead", o arquivo é recusado com `ambiguous_reference` em vez
de o sistema escolher uma. Renomeie uma das duas, ou use o UUID.

Pela mesma razão, o **export** emite o UUID quando o nome seria
ambíguo: um arquivo exportado sempre reimporta.

## Ativação

`"is_active": true` importa a automação já ligada, e ela passa a
disparar mensagens reais imediatamente. A prévia marca quais entrariam
ativas antes de você confirmar. O padrão é `false`.

Uma automação ativa precisa estar completa: as mesmas regras que o
builder aplica ao ativar valem aqui — e, diferente do builder, valem
**também para rascunhos**, porque um arquivo não passou por nenhuma
tela de validação.

## Limites

| Limite | Valor |
| --- | --- |
| Tamanho do arquivo | 512 KB |
| Automações por arquivo | 50 |
| Passos por automação | 100 |
| Aninhamento de condições | 10 níveis |

## Erros

A resposta `422` traz `issues[]`, cada uma com o caminho exato no
documento:

```json
{
  "error": "The file has problems that must be fixed before importing",
  "issues": [
    {
      "path": "automations[0].steps[1].tag",
      "message": "tag 'Lead Quente' does not exist in this account",
      "code": "unresolved_reference"
    }
  ]
}
```

| `code` | Significa |
| --- | --- |
| `invalid_document` | Envelope malformado, nome duplicado, `branches` fora de um `condition` |
| `limit_exceeded` | Estourou um dos limites da tabela acima |
| `unknown_type` | `trigger_type` ou `step_type` que não existe |
| `invalid_config` | Campo obrigatório faltando, valor fora do domínio, URL de webhook interna |
| `unresolved_reference` | Nome ou id que não existe nesta conta |
| `ambiguous_reference` | Nome que casa com mais de um registro |

## Notas de implementação

- O núcleo é puro e vive em `src/lib/automations/import.ts` /
  `export.ts`; o carregamento do catálogo (a parte que toca o banco)
  fica em `reference-catalog.ts`. É o que permite testar as regras sem
  Supabase.
- `id` de passo presente no arquivo é descartado. `insertSteps` usa
  `s.id ?? uid()`, então aceitá-lo deixaria o arquivo escolher chaves
  primárias — e um documento exportado, que carrega o id de origem,
  precisa gerar cópias novas ao ser reimportado.
- URLs de `send_webhook` passam pelo mesmo guard de SSRF que o motor
  usa ao entregar. Sem essa checagem no import, um endereço interno
  ficaria gravado, apareceria como válido na prévia, e só falharia
  silenciosamente na primeira execução.
- Exportar exige papel `agent`, não `viewer`: o documento inclui
  `send_webhook.headers` na íntegra, que costuma guardar token de
  autenticação.
