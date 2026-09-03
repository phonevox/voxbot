export const AUTOBLOQUEADOR_SCHEMA = `

/* Quem pode rodar /autobloqueador - substitui a lista hardcoded do módulo Python original. */
CREATE TABLE IF NOT EXISTS ab_authorized_users (
    user_id    VARCHAR(20) PRIMARY KEY,
    added_by   VARCHAR(20),
    added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/* Semeia com a lista original (AUTHORIZED_USERS_ID no .py) - ninguém perde acesso na migração. */
INSERT INTO ab_authorized_users (user_id) VALUES
    ('1356243257855705271'), -- pedro
    ('1083013666074546277'), -- leonardo
    ('660153918214504480'),  -- abner
    ('968851062679302164'),  -- adrian (trabalho)
    ('188851299255713792'),  -- adrian (pessoal)
    ('1214929223572127874'), -- andre
    ('1087873539635433522'), -- rafael
    ('1361389121066500206')  -- fabiano
ON CONFLICT (user_id) DO NOTHING;

`;
