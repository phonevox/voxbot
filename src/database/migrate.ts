import { createHash } from "node:crypto";
import { Logger } from "@/utils/logging";
import { closePool, query, testConnection } from "./connection";

const logger = new Logger("core.database");

// ─── Schema Base ──────────────────────────────────────────────────────────────

const BASE_SCHEMA = `
-- Tabela de configuração por guild
CREATE TABLE IF NOT EXISTS guilds (
  id          VARCHAR(20)  PRIMARY KEY,           -- Discord snowflake ID
  prefix      VARCHAR(10)  NOT NULL DEFAULT '!',  -- Prefix customizável
  settings    JSONB        NOT NULL DEFAULT '{}', -- Dados livres por módulo
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Índice no JSONB para queries em settings específicas
CREATE INDEX IF NOT EXISTS idx_guilds_settings ON guilds USING gin(settings);

-- Tabela de tracking de migrações (evita re-executar)
CREATE TABLE IF NOT EXISTS _migrations (
  name       VARCHAR(255) PRIMARY KEY,
  hash       VARCHAR(64),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Garante a coluna hash em bancos migrados antes dela existir
ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS hash VARCHAR(64);
`;

function hashOf(sql: string): string {
	return createHash("sha256").update(sql).digest("hex");
}

/**
 * Registra e executa uma migração de forma idempotente.
 * Migrações são reaplicadas automaticamente quando o SQL muda (por hash),
 * então cada bloco de migração deve ser escrito de forma idempotente
 * (CREATE TABLE/INDEX IF NOT EXISTS, etc).
 */
async function runMigration(name: string, sql: string): Promise<void> {
	const hash = hashOf(sql);
	const check = await query<{ hash: string | null }>(
		`SELECT hash FROM _migrations WHERE name = $1`,
		[name],
	);

	if (check.rowCount && check.rowCount > 0) {
		if (check.rows[0].hash === hash) {
			logger.debug(`Migração já aplicada: ${name}`);
			return;
		}

		await query(sql);
		await query(
			`UPDATE _migrations SET hash = $2, applied_at = NOW() WHERE name = $1`,
			[name, hash],
		);
		logger.info(`Conteúdo da migração mudou, reaplicada: ${name}`);
		return;
	}

	await query(sql);
	await query(`INSERT INTO _migrations (name, hash) VALUES ($1, $2)`, [
		name,
		hash,
	]);
	logger.info(`Migração aplicada: ${name}`);
}

/**
 * Ponto de entrada para migrações adicionais (módulos podem chamar isso).
 */
export async function runModuleMigrations(
	moduleName: string,
	migrations: string[],
): Promise<void> {
	for (let i = 0; i < migrations.length; i++) {
		await runMigration(`${moduleName}_${i + 1}`, migrations[i]);
	}
}

/**
 * Bootstrap completo do banco.
 */
export async function migrate(): Promise<void> {
	await testConnection();

	// Schema base sempre primeiro (inclui bootstrap de _migrations)
	await query(BASE_SCHEMA);

	logger.info("Schema base pronto.");
}

// ─── CLI runner ───────────────────────────────────────────────────────────────
// Permite rodar: ts-node src/database/migrate.ts

if (require.main === module) {
	migrate()
		.then(() => {
			logger.info("Migrações concluídas.");
			process.exit(0);
		})
		.catch((err) => {
			logger.error(err instanceof Error ? err : new Error(String(err)));
			process.exit(1);
		})
		.finally(closePool);
}
