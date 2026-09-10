import { monitorEventLoopDelay } from "node:perf_hooks";

// Roda durante toda a vida do processo - um único histograma contínuo, resetado a cada leitura
// para que cada relatório reflita "desde a última checagem" em vez de uma média acumulada.
const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopHistogram.enable();

export interface EventLoopLag {
	meanMs: number;
	maxMs: number;
}

/** Lag alto aqui significa que o processo está CPU-bound (bloqueado fazendo trabalho síncrono) - não é sintoma de DB ou rede. */
export function getEventLoopLag(): EventLoopLag {
	const stats = {
		meanMs: nsToMs(eventLoopHistogram.mean),
		maxMs: nsToMs(eventLoopHistogram.max),
	};
	eventLoopHistogram.reset();
	return stats;
}

function nsToMs(ns: number): number {
	return Number.isFinite(ns) ? Math.round(ns / 1e5) / 10 : 0;
}

export interface EventLoopLagDetail {
	minMs: number;
	meanMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
	stddevMs: number;
}

/** Versão "debug" de `getEventLoopLag` - mesmo histograma compartilhado (não cria um segundo monitor), só expõe mais percentis. Reseta o histograma igual, então não chame os dois de seguida esperando ver o mesmo período. */
export function getEventLoopLagDetail(): EventLoopLagDetail {
	const stats = {
		minMs: nsToMs(eventLoopHistogram.min),
		meanMs: nsToMs(eventLoopHistogram.mean),
		p50Ms: nsToMs(eventLoopHistogram.percentile(50)),
		p95Ms: nsToMs(eventLoopHistogram.percentile(95)),
		p99Ms: nsToMs(eventLoopHistogram.percentile(99)),
		maxMs: nsToMs(eventLoopHistogram.max),
		stddevMs: nsToMs(eventLoopHistogram.stddev),
	};
	eventLoopHistogram.reset();
	return stats;
}

export interface TickStats {
	durationMs: number;
	userCount: number;
	ranAt: Date;
}

let lastTick: TickStats | null = null;

/** Chamado pelo StatusEngine após cada varredura - o sinal mais direto de "o bot está dando conta", já que a varredura tem um intervalo fixo que precisa cumprir. */
export function recordTickStats(durationMs: number, userCount: number): void {
	lastTick = { durationMs, userCount, ranAt: new Date() };
}

export function getLastTickStats(): TickStats | null {
	return lastTick;
}
