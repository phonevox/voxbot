export const ZABBIX_SCHEMA = `

/* Um evento de trigger do Zabbix = uma thread no Forum, sempre. discord_thread_id fica nullable
   de propósito: repository.tryClaimEvent insere a linha ANTES de criar a thread, pra resolver
   corrida entre webhooks concorrentes pro mesmo event_id (dois PROBLEM quase simultâneos, ou
   reconciliação rodando junto com um webhook tardio) - quem ganha a linha cria a thread. */
CREATE TABLE IF NOT EXISTS zbx_events (
    zabbix_event_id     VARCHAR(32) PRIMARY KEY,
    zabbix_trigger_id   VARCHAR(32) NOT NULL,
    discord_thread_id   VARCHAR(20) UNIQUE,
    discord_head_msg_id VARCHAR(20),
    host_name           TEXT NOT NULL,
    host_ip             TEXT,
    current_severity    SMALLINT NOT NULL DEFAULT 0,
    status               VARCHAR(12) NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','acknowledged','resolved')),
    owner_discord_id     VARCHAR(20),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at           TIMESTAMPTZ,
    archived_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_zbx_events_status ON zbx_events (status);

/* Dedup de webhook - o Zabbix reenvia em caso de timeout/retry do Media Type. dedup_key é um
   hash dos campos que identificam a entrega (event_id + tipo + clock + action + message), não
   um ID novo que precisaria adicionar como parâmetro no Media Type do Zabbix. */
CREATE TABLE IF NOT EXISTS zbx_processed_webhooks (
    dedup_key   VARCHAR(64) PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

`;
