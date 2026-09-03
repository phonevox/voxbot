export type ZbxEventStatus = "open" | "acknowledged" | "resolved";

export interface ZbxEventRow {
	zabbix_event_id: string;
	zabbix_trigger_id: string;
	discord_thread_id: string | null;
	discord_head_msg_id: string | null;
	host_name: string;
	host_ip: string | null;
	current_severity: number;
	status: ZbxEventStatus;
	owner_discord_id: string | null;
	created_at: Date;
	updated_at: Date;
	resolved_at: Date | null;
	archived_at: Date | null;
}

/**
 * Payload cru mandado pelo script fino do Zabbix (Media Type), um POST JSON com os campos brutos
 * do trigger - sem lógica de tradução/template, isso fica todo do lado do bot.
 */
export interface WebhookPayload {
	event_id: string;
	trigger_id: string;
	event_source: string;
	event_value: string;
	event_update_status: string;
	event_nseverity: string;
	event_name: string;
	event_opdata?: string;
	event_date: string;
	event_time: string;
	event_tags?: string;

	event_update_action?: string;
	event_update_user?: string;
	event_update_message?: string;
	event_update_date?: string;
	event_update_time?: string;

	event_recovery_date?: string;
	event_recovery_time?: string;

	trigger_description?: string;

	host_name: string;
	host_ip?: string;
	host_uid?: string;

	zabbix_url: string;
}

/** Classificação derivada do payload - todo o resto do módulo lê daqui, nunca recalcula. */
export interface EventClassification {
	isTrigger: boolean;
	isUpdate: boolean;
	isRecovery: boolean;
	isProblem: boolean;
}

export interface AckParams {
	eventId: string;
	bits: number;
	severity?: number;
	message?: string;
}
