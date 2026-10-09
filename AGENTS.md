<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Regras do projeto CRM-Advogado

- Repositório de trabalho: https://github.com/CRM-Advogado/crm-advogado.
- `develop` é a base para desenvolvimento e validação. Crie branches de implementação a partir dela e direcione os PRs para `develop`.
- `main` é destinada à produção para os clientes. Promova alterações de `develop` para `main` por PR após revisão e validação; não envie implementações diretamente para `main`.
- O ambiente atual do Moacir permanece separado. Não altere seu repositório, implantação ou serviços como parte de implementações neste projeto, salvo solicitação explícita.
- Antes de configurar ou publicar ambientes, confirme o repositório, a branch e os serviços de destino. A separação do código não comprova isolamento de banco, credenciais, integrações e webhooks.
- Consulte [a política de branches e ambientes](docs/branches-e-ambientes.md) antes de futuras implementações. Esta política prevalece sobre orientações genéricas herdadas do template quanto à branch de trabalho.
