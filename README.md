# voxbot

Framework modular para bots de Discord em TypeScript.

Cada funcionalidade vive em um **módulo** isolado, dentro de `src/modules/`. O bot descobre e carrega módulos automaticamente pelo filesystem. Não existe registro manual.

## Stack

| Peça | Ferramenta |
|---|---|
| Runtime | Node 20 + Bun (gerenciador de pacotes) |
| Linguagem | TypeScript |
| Discord | discord.js v14 |
| Banco | PostgreSQL via `pg` (sem ORM) |
| Lint/format | Biome |

## Quickstart

Execute os passos na ordem.

1. Copie o arquivo de exemplo de ambiente:
   ```bash
   cp .env.example .env
   ```
2. Preencha `BOT_TOKEN`, `BOT_CLIENT_ID` e as variáveis `POSTGRES_*` no `.env`.
3. Instale as dependências:
   ```bash
   bun install
   ```
4. Rode as migrações do banco:
   ```bash
   bun run db:migrate
   ```
5. Suba o bot em modo desenvolvimento:
   ```bash
   bun run dev
   ```

O bot conecta ao Discord, registra os slash commands e fica pronto para uso.

## Estrutura

```
src/
├── index.ts                  # Bootstrap: migra o banco, carrega módulos, conecta ao Discord
├── define.ts                 # defineCog() e defineCommand() - as duas únicas funções que um módulo usa pra se registrar
├── config/
│   └── index.ts               # Lê o .env e valida as variáveis obrigatórias
├── types/
│   └── index.ts                # Cog, CommandDefinition e os outros tipos compartilhados
├── database/
│   ├── connection.ts          # Pool do pg, query() e transaction()
│   ├── guildRepository.ts     # CRUD de guilds e cache de prefix
│   └── migrate.ts              # Roda as migrações de cada módulo, uma vez só, na ordem
├── core/
│   ├── BotClient.ts            # Estende o Client do discord.js
│   ├── CogLoader.ts            # Descobre e carrega cada pasta de src/modules/ como um módulo
│   ├── CommandHandler.ts       # Escuta messageCreate e interactionCreate, roteia pro comando certo
│   ├── CommandRegistry.ts      # Map<nome, CommandDefinition> com busca O(1)
│   └── PrefixArgs.ts           # Deriva argumentos de comando de prefixo a partir do SlashCommandBuilder
├── utils/                     # Logger, formatação de embed, cache, quips etc.
└── modules/                   # Cada pasta = um módulo
    └── <nome>/
        ├── index.ts            # export default: um Cog, criado com defineCog()
        ├── commands/           # Um arquivo por comando, criado com defineCommand()
        ├── repository.ts       # Acesso ao banco, se o módulo guarda dados
        └── migrations.ts       # Schema SQL do módulo, se precisar de tabela própria
```

## Módulos existentes

| Módulo | O que faz |
|---|---|
| `core` | Comandos nativos do bot: ping, help, setprefix, administração |
| `tempvc` | Cria um canal de voz temporário quando alguém entra em um canal gerador |
| `autobloqueador` | Controla o Auto-Bloqueador Magnus e quem pode usá-lo |
| `zabbix` | Ponte entre o Zabbix e o Discord - cada evento de trigger vira uma thread |
| `developer` | Ferramentas de debug (quip, request HTTP) - só pro dono do bot, oculto do `/help` |

## Criar um módulo

Um módulo é uma pasta em `src/modules/<nome>/`. O `index.ts` exporta um `Cog`. Um `Cog` pode ter comandos, escutar eventos do Discord e guardar dados no banco.

O exemplo abaixo cria o módulo `boasvindas`. Ele:

- Guarda uma contagem de mensagens por usuário no banco (persistência).
- Escuta o evento `messageCreate` do Discord (evento nativo).
- Expõe um comando `/contagem` para consultar o total (comando).

### 1. Defina o schema (`migrations.ts`)

Toda string de migração é idempotente. O `migrate.ts` roda cada uma uma vez só, na ordem em que aparece.

```typescript
// src/modules/boasvindas/migrations.ts
export const BOASVINDAS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bv_contagem (
    guild_id VARCHAR(20) NOT NULL,
    user_id  VARCHAR(20) NOT NULL,
    total    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
`;
```

### 2. Defina o acesso ao banco (`repository.ts`)

Use `query()` de `@/database/connection`. Ele aceita `$1, $2...` como parâmetros - isso protege contra SQL injection.

```typescript
// src/modules/boasvindas/repository.ts
import { query } from "@/database/connection";

export async function incrementar(guildId: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO bv_contagem (guild_id, user_id, total) VALUES ($1, $2, 1)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET total = bv_contagem.total + 1`,
    [guildId, userId],
  );
}

export async function getTotal(guildId: string, userId: string): Promise<number> {
  const res = await query<{ total: number }>(
    `SELECT total FROM bv_contagem WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  );
  return res.rows[0]?.total ?? 0;
}
```

### 3. Defina o comando (`commands/contagem.ts`)

Use `defineCommand()`. Um comando roda como slash (`executeAsSlash`), como prefixo (`executeAsPrefix`), ou os dois.

```typescript
// src/modules/boasvindas/commands/contagem.ts
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { getTotal } from "../repository";

export default defineCommand({
  name: "contagem",
  description: "Mostra quantas mensagens você já mandou.",
  category: CommandCategory.UTILITY,
  showOnHelp: true,

  async executeAsSlash(interaction) {
    if (!interaction.guild) return;
    const total = await getTotal(interaction.guild.id, interaction.user.id);
    await interaction.reply(`Você mandou ${total} mensagem(ns) até agora.`);
  },

  async executeAsPrefix(message) {
    if (!message.guild) return;
    const total = await getTotal(message.guild.id, message.author.id);
    await message.reply(`Você mandou ${total} mensagem(ns) até agora.`);
  },
});
```

### 4. Junte tudo no `index.ts`

O campo `events` conecta o módulo a qualquer evento nativo do discord.js (`messageCreate`, `voiceStateUpdate`, etc). O handler recebe o `client` e os argumentos originais do evento.

```typescript
// src/modules/boasvindas/index.ts
import { defineCog } from "@/define";
import _contagem from "./commands/contagem";
import { BOASVINDAS_SCHEMA } from "./migrations";
import { incrementar } from "./repository";

export default defineCog({
  name: "boasvindas",
  description: "Conta mensagens por usuário e responde ao comando /contagem.",
  authors: [{ name: "seu-nome", id: 123456789012345678n }],

  commands: [_contagem],
  migrations: [BOASVINDAS_SCHEMA],

  events: {
    async messageCreate(_client, message) {
      if (message.author.bot || !message.guild) return;
      await incrementar(message.guild.id, message.author.id);
    },
  },
});
```

Pronto. Reinicie o bot (ou rode `/bot mod load boasvindas`) e o módulo carrega sozinho - nenhum outro arquivo precisa saber que ele existe.

## Scripts

| Comando | O que faz |
|---|---|
| `bun run dev` | Sobe o bot em modo desenvolvimento (`ts-node`, hot-free) |
| `bun run build` | Valida os comandos, compila TypeScript e resolve os aliases `@/` |
| `bun run start` | Roda a build de produção (`dist/index.js`) |
| `bun run db:migrate` | Aplica as migrações pendentes de todos os módulos |
| `bun run check:commands` | Valida a árvore de slash commands sem subir o bot |
| `bun run lint` / `lint:fix` | Checa ou corrige o código com o Biome |
| `bun run format` | Formata o código com o Biome |

## Decisões de arquitetura

| Decisão | Motivo |
|---|---|
| Módulo por pasta, carregado por filesystem | Adicionar módulo = criar pasta. Sem registro manual, sem boilerplate |
| `pg` sem ORM | Controle total sobre as queries. Sem overhead. Schema flexível com JSONB quando precisa |
| Map no `CommandRegistry` | Busca O(1) - o handler roda a cada mensagem recebida |
| Migrações idempotentes por módulo | A tabela `_migrations` rastreia o que já rodou. Nenhuma migração roda duas vezes |
| Cache de prefix em memória | Evita uma query ao banco a cada mensagem (TTL de 5 minutos) |
| `transaction()` como wrapper | Faz rollback automático. Ninguém esquece de tratar erro |
| Prefixo de env var por módulo (`MOD_<NOME>_*`) | Isola a config de cada módulo. Fácil saber de onde uma variável vem |
