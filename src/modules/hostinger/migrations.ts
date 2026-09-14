export const HOSTINGER_SCHEMA = `

/* Permissão própria do módulo, não cargo/permissão do Discord - controlar DNS é infra da empresa,
   não config de servidor, então é global (sem guild_id) e por usuário. scope 'all' libera
   qualquer área futura do módulo hostinger sem precisar voltar aqui a cada uma nova. */
CREATE TABLE IF NOT EXISTS hostinger_permissions (
    user_id    VARCHAR(20) NOT NULL,
    scope      VARCHAR(32) NOT NULL,
    granted_by VARCHAR(20) NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, scope)
);

`;
