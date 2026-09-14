export const STICKY_MESSAGE_SCHEMA = `

/* channel_id como PK já garante a regra de negócio "uma sticky por canal" - não precisa de
   constraint extra. guild_id fica desnormalizado pra permitir listar/limpar por guilda sem
   depender do cache do Discord. */
CREATE TABLE IF NOT EXISTS sticky_messages (
    channel_id VARCHAR(20) PRIMARY KEY,
    guild_id   VARCHAR(20) NOT NULL,
    content    TEXT NOT NULL,
    color      INTEGER,
    created_by VARCHAR(20) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sticky_messages_guild ON sticky_messages (guild_id);

-- Campo de título dedicado (versão anterior) virou marcador de separador dentro do próprio
-- content - dropa a coluna em quem já rodou aquela migração (mesmo padrão de migrate.ts:30).
ALTER TABLE sticky_messages DROP COLUMN IF EXISTS title;

-- color é opcional e foi adicionado depois da criação inicial da tabela - garante a coluna em
-- quem já rodou a migração antiga.
ALTER TABLE sticky_messages ADD COLUMN IF NOT EXISTS color INTEGER;

`;
