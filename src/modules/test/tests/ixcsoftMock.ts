// Dados mockados (nada real do IXC) - fixture compartilhada entre os testes design/ixcsoft-*.
// Status/status acesso são do CONTRATO, não do produto - produto só tem um "ativo" simples.
export const MOCK_CONTRATO = {
	id: 351,
	cliente: "EMPRESA EXEMPLO LTDA",
	status: "A", // código real do IXC (P/A/I/N/D) - ver STATUS_CONTRATO em ixcsoftPaginado.ts
	statusAcesso: "CM", // idem (A/D/CM/CA/FA/AA) - ver STATUS_ACESSO
	ativacao: "2023-07-01",
};

// ativo cru como string ("S"/"N") - igual ao formato real do IXC (ver parseAtivo em status.ts).
export const MOCK_PRODUTOS = [
	{
		descricao: "CANAL EXTRA ENTRADA",
		tipo: "TA",
		valor: "R$ 1.242,00",
		quantidade: 1,
		ativo: "S",
		observacao: "0000000000000",
	},
	{
		descricao: "CANAL EXTRA BUSINESS",
		tipo: "TA",
		valor: "R$ 890,00",
		quantidade: 2,
		ativo: "S",
		observacao: "-",
	},
	{
		descricao: "DID BUSINESS",
		tipo: "T",
		valor: "R$ 45,00",
		quantidade: 1,
		ativo: "N",
		observacao: "55 (00) 0000-0000",
	},
] as const;
