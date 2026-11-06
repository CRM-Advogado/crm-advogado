# PERF-01 — Latência de Contatos, Funis e Painel

A comparação usa a `develop` do CRM-Advogado em `31efc7f` e o build da PERF-01. O relatório exploratório original usou uma cópia do rebranding, que já tinha um Kanban paginado e usava outra versão do Next.js. A linha de base foi refeita no CRM-Advogado para comparar o mesmo produto.

## Resultado do benchmark

Foram usados dois builds de produção Next.js 16.2.12 (Webpack), servidos localmente com a mesma fixture sintética. O Playwright clicou no menu real do Brave a 1440 × 900, com cache e prefetch normais, após 700 ms de preparação. Cada versão teve cinco rodadas locais e três com 100 ms de latência adicional simulada pelo navegador, com primeira passagem e revisita por sete rotas. Cada rodada começou com cache e armazenamento local limpos.

O tempo de título começa no clique e termina no primeiro frame com o título visível. Funis e Atendimento usam o cabeçalho da aplicação. Para conteúdo, Contatos exige o contato de teste, Funis exige o cartão de teste e Painel exige o fim dos indicadores de carregamento. A janela de contagem de requisições inclui os 120 ms seguintes a esse marco. Tempos em ms, com o intervalo de conteúdo observado entre parênteses.

| Tela | Perfil | Visita | Título antes → depois | Conteúdo antes → depois | Pedidos de dados antes → depois |
| --- | --- | --- | ---: | ---: | ---: |
| Contatos | Local | Primeira | 22 → 26 | 53 (50–55) → 37 (33–40) | 5 → 2 |
| Contatos | Local | Revisita | 20 → 21 | 46 (45–50) → 34 (30–34) | 5 → 2 |
| Contatos | +100 ms | Primeira | 22 → 23 | 372 (366–382) → 157 (148–159) | 4 → 2 |
| Contatos | +100 ms | Revisita | 18 → 19 | 374 (373–379) → 140 (137–145) | 5 → 2 |
| Funis | Local | Primeira | 14 → 19 | 50 (49–54) → 42 (37–45) | 3 → 2 |
| Funis | Local | Revisita | 13 → 16 | 45 (40–49) → 34 (29–38) | 3 → 2 |
| Funis | +100 ms | Primeira | 13 → 16 | 258 (258–266) → 135 (132–143) | 3 → 2 |
| Funis | +100 ms | Revisita | 13 → 15 | 255 (253–257) → 134 (131–139) | 3 → 2 |
| Painel | Local | Primeira | 15 → 16 | 69 (63–75) → 57 (54–60) | 17 → 10 |
| Painel | Local | Revisita | 14 → 16 | 62 (61–72) → 54 (48–57) | 17 → 10 |
| Painel | +100 ms | Primeira | 18 → 18 | 364 (364–365) → 254 (253–254) | 17 → 10 |
| Painel | +100 ms | Revisita | 18 → 16 | 365 (353–365) → 246 (241–255) | 17 → 10 |

As 224 transições terminaram dentro do limite de 3,5 s. Nas quatro rotas de controle (Atendimento, Notificações, Relatórios e Configurações), as diferenças de mediana de conteúdo ficaram entre −14 e +7 ms. A contagem mediana de pedidos dessas rotas permaneceu igual.

## Mudanças verificadas

- **Contatos.** A lista inclui os IDs de etiquetas na mesma consulta. A chegada dos nomes atualiza a tela sem reiniciar a leitura. O filtro por etiquetas continua usando a função paginada existente.
- **Funis.** A lista e o quadro padrão carregam em paralelo. O quadro recebe etapas e negócios em uma consulta e só aparece sob o funil ao qual pertence. A `develop` calcula os totais a partir dos negócios carregados.
- **Painel.** A função `dashboard_metrics` reúne os quatro indicadores em uma chamada e mantém os limites de dia calculados no fuso do navegador. O feed de atividade continua carregando em paralelo com os gráficos. A soma dos negócios ganhos considera todas as linhas da conta, inclusive quando há mais de 1.000.

Aplicar a migração `048_dashboard_metrics.sql` no banco do ambiente de destino antes de disponibilizar o build. O QA local mede o custo de navegação com dados sintéticos. Tempos de banco, volume de uma conta real e rede do ambiente hospedado precisam de medição em homologação.
