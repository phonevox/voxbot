type Quip = {
	text: string;
	funnyLevel: number;
};

export enum QuipTypes {
	THINKING = "thinking",
	SUCCESS = "success",
	FAILURE = "failure",
}

export const DEFAULT_FUNNY_LEVEL = Number.parseInt(
	process.env.DEFAULT_QUIP_JOKE_LEVEL ?? "0",
	10,
);

export const THINKING_QUIPS = [
	{ text: "Processando...", funnyLevel: 0 },
	{ text: "Pensando...", funnyLevel: 0 },
	{ text: "Trabalhando nisso...", funnyLevel: 0 },
	{ text: "Um momento...", funnyLevel: 0 },
	{ text: "Analisando a solicitação...", funnyLevel: 0 },
	{ text: "Calculando a resposta...", funnyLevel: 0 },
	{ text: "Cozinhando algo...", funnyLevel: 1 },
	{ text: "Preparando a resposta...", funnyLevel: 1 },
	{ text: "Invocando a resposta...", funnyLevel: 1 },
	{ text: "Reunindo poder mental...", funnyLevel: 1 },
	{ text: "Consultando os arquivos...", funnyLevel: 1 },
	{ text: "Reticulando splines...", funnyLevel: 1 },
	{ text: "Consultando o vazio...", funnyLevel: 2 },
	{ text: "Carregando neurônios...", funnyLevel: 2 },
	{ text: "Negociando com os deuses da API...", funnyLevel: 2 },
	{ text: "Desembaraçando código espaguete...", funnyLevel: 2 },
	{ text: "Gerando genialidade...", funnyLevel: 2 },
	{ text: "Procurando a solução menos amaldiçoada...", funnyLevel: 2 },
	{ text: "Fazendo matemática de mago...", funnyLevel: 3 },
	{ text: "Os hamsters estão girando na velocidade máxima...", funnyLevel: 3 },
	{ text: "Convencendo os elétrons a cooperar...", funnyLevel: 3 },
	{ text: "Vibecodando a resposta...", funnyLevel: 3 },
	{ text: "Roubando conhecimento do universo...", funnyLevel: 3 },
	{ text: "Perguntando ao Stack Overflow espiritualmente...", funnyLevel: 3 },
	{ text: "Girando o problema até funcionar...", funnyLevel: 3 },
	{ text: "Moggando um betinha...", funnyLevel: 3 },
	{ text: "leo baiter", funnyLevel: 3}
] as const satisfies readonly Quip[];

export const SUCCESS_QUIPS = [
	{ text: "Feito!", funnyLevel: 0 },
	{ text: "Sucesso!", funnyLevel: 0 },
	{ text: "Concluído com sucesso.", funnyLevel: 0 },
	{ text: "Tudo pronto!", funnyLevel: 0 },
	{ text: "Finalizado.", funnyLevel: 0 },
	{ text: "Tarefa concluída.", funnyLevel: 0 },
	{ text: "Operação bem-sucedida.", funnyLevel: 0 },
	{ text: "Tudo correu bem.", funnyLevel: 1 },
	{ text: "Funcionou perfeitamente.", funnyLevel: 1 },
	{ text: "Missão cumprida.", funnyLevel: 1 },
	{ text: "Estamos prontos para seguir em frente.", funnyLevel: 1 },
	{ text: "W absurdo.", funnyLevel: 2 },
	{ text: "A gente aceita esses.", funnyLevel: 2 },
	{ text: "Sucesso comum.", funnyLevel: 2 },
	{ text: "O código sobreviveu.", funnyLevel: 2 },
	{ text: "Nenhum erro dessa vez.", funnyLevel: 2 },
	{ text: "Tarefa concluída sem explodir.", funnyLevel: 3 },
	{ text: "A fita adesiva aguentou.", funnyLevel: 3 },
	{ text: "Contra todas as chances, funcionou.", funnyLevel: 3 },
	{ text: "Manda antes que quebre de novo.", funnyLevel: 3 },
	{ text: "Os duendes estão satisfeitos.", funnyLevel: 3 },
	{ text: "Conquista desbloqueada: funcionalidade.", funnyLevel: 3 },
	{ text: "Um betinha foi moggado com sucesso.", funnyLevel: 3 },
	{ text: "leo baiter", funnyLevel: 3}
] as const satisfies readonly Quip[];

export const FAILURE_QUIPS = [
	{ text: "Algo deu errado.", funnyLevel: 0 },
	{ text: "A tarefa falhou.", funnyLevel: 0 },
	{ text: "Não foi possível concluir a solicitação.", funnyLevel: 0 },
	{ text: "Ocorreu um erro.", funnyLevel: 0 },
	{ text: "Isso não funcionou.", funnyLevel: 0 },
	{ text: "A execução falhou.", funnyLevel: 0 },
	{ text: "Ops, algo quebrou.", funnyLevel: 1 },
	{ text: "Encontrei um obstáculo.", funnyLevel: 1 },
	{ text: "A operação não pôde ser concluída.", funnyLevel: 1 },
	{ text: "Bom... isso foi lamentável.", funnyLevel: 1 },
	{ text: "Os hamsters pararam de correr.", funnyLevel: 2 },
	{ text: "Tropecei num ponto e vírgula.", funnyLevel: 2 },
	{ text: "O código revidou.", funnyLevel: 2 },
	{ text: "Algo pegou fogo internamente.", funnyLevel: 2 },
	{ text: "Caos inesperado detectado.", funnyLevel: 2 },
	{ text: "Sucesso catastrófico, quase.", funnyLevel: 3 },
	{ text: "Skill Issue detectada.", funnyLevel: 3 },
	{ text: "O espaguete escapou do recipiente.", funnyLevel: 3 },
	{ text: "Os duendes venceram essa rodada.", funnyLevel: 3 },
	{ text: "Já tentou desligar e ligar a realidade de novo?", funnyLevel: 3 },
	{ text: "Em algum lugar, um desenvolvedor está chorando.", funnyLevel: 3 },
	{ text: "As vibes não estavam imaculadas.", funnyLevel: 3 },
	{ text: "Fui moggado.", funnyLevel: 3 },
	{ text: "leo baiter", funnyLevel: 3}
] as const satisfies readonly Quip[];

const QUIPS: Record<QuipTypes, readonly Quip[]> = {
	[QuipTypes.THINKING]: THINKING_QUIPS,
	[QuipTypes.SUCCESS]: SUCCESS_QUIPS,
	[QuipTypes.FAILURE]: FAILURE_QUIPS,
};

export function getRandomQuip(type: QuipTypes, maxFunnyLevel = 0): string {
	const allowed = QUIPS[type].filter((q) => q.funnyLevel <= maxFunnyLevel);

	const pool = allowed.length > 0 ? allowed : QUIPS[type];

	return pool[Math.floor(Math.random() * pool.length)].text;
}

export function getSuccessQuip(maxFunnyLevel?: number): string {
	return getRandomQuip(QuipTypes.SUCCESS, maxFunnyLevel ?? DEFAULT_FUNNY_LEVEL);
}

export function getFailureQuip(maxFunnyLevel?: number): string {
	return getRandomQuip(QuipTypes.FAILURE, maxFunnyLevel ?? DEFAULT_FUNNY_LEVEL);
}

export function getThinkingQuip(maxFunnyLevel?: number): string {
	return getRandomQuip(
		QuipTypes.THINKING,
		maxFunnyLevel ?? DEFAULT_FUNNY_LEVEL,
	);
}
