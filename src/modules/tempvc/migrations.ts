export const TEMP_CHANNELS_SCHEMA = `

/* Canais de voz que admins marcaram como geradores - entrar em um cria um novo canal temporário. */
CREATE TABLE IF NOT EXISTS tc_generators (
    channel_id VARCHAR(20) PRIMARY KEY,
    guild_id   VARCHAR(20) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/* Canais temporários ativos, persistidos pra que a posse sobreviva a um restart do bot (ver docs/adr/0001). */
CREATE TABLE IF NOT EXISTS tc_channels (
    channel_id VARCHAR(20) PRIMARY KEY,
    guild_id   VARCHAR(20) NOT NULL,
    owner_id   VARCHAR(20) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/* Preferência de nome por guild/usuário, aplicada só aos futuros canais temporários desse usuário. */
CREATE TABLE IF NOT EXISTS tc_apelidos (
    guild_id   VARCHAR(20) NOT NULL,
    user_id    VARCHAR(20) NOT NULL,
    name       TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id, user_id)
);

`;
