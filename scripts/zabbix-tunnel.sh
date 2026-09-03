#!/usr/bin/env bash
set -euo pipefail

# Abre um "quick tunnel" do Cloudflare (sem conta, sem config prévia) pro endpoint de ingest do
# bot - assim o Zabbix (fora da rede local) alcança o webhook sem VPN nem porta exposta no
# roteador. A URL impressa é aleatória e muda a cada execução: toda vez que rodar de novo,
# atualize o parâmetro bot_endpoint no Media Type "Discord Bot Webhook" do Zabbix.
#
# ponytail: quick tunnel é descartável de propósito - se a URL mudando a cada restart incomodar,
# a solução é um túnel nomeado (`cloudflared tunnel create` + config.yml com hostname fixo), que
# precisa de conta Cloudflare com domínio próprio. Não vale a complexidade até isso virar problema
# de verdade.

cd "$(dirname "$0")/.."

if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

if ! command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared não encontrado no PATH." >&2
    echo "Instale: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
    exit 1
fi

PORT="${MOD_ZABBIX_INGEST_PORT:-3001}"
WEBHOOK_PATH="${MOD_ZABBIX_WEBHOOK_PATH:-/webhook}"

echo "Abrindo túnel pra http://localhost:${PORT} ..."
echo "Quando a URL 'https://xxxx.trycloudflare.com' aparecer abaixo, o bot_endpoint no Zabbix vira:"
echo "  https://xxxx.trycloudflare.com${WEBHOOK_PATH}"
echo ""

exec cloudflared tunnel --url "http://localhost:${PORT}"
