#!/bin/bash
# Let's Encrypt IP 证书自动续期
#
# IP 证书强制为 shortlived profile，有效期只有 6 天（160 小时），
# 所以自动续期不是可选项。certbot 默认在到期前 30 天续期，
# 对 6 天证书来说那个阈值永远触发不了，必须显式设成更短的窗口。
#
# 续期后要 reload nginx，让它加载新证书。

set -euo pipefail

CERTBOT=/opt/oc-relay/venv/bin/certbot
LOG=/var/log/oc-cert-renew.log

echo "=== $(date -Is) starting renewal ===" >>"$LOG"

# 先 dry-run 确认能签发（staging 环境，避免失败次数计入速率限制）
if "$CERTBOT" renew --cert-name 43.135.23.149 --dry-run --preferred-profile shortlived >>"$LOG" 2>&1; then
    echo "=== $(date -Is) dry-run OK, renewing for real ===" >>"$LOG"
    if "$CERTBOT" renew --cert-name 43.135.23.149 --preferred-profile shortlived >>"$LOG" 2>&1; then
        # 续期成功：reload nginx 载入新证书
        systemctl reload nginx
        echo "=== $(date -Is) renewal OK, nginx reloaded ===" >>"$LOG"
        "$CERTBOT" certificates >>"$LOG" 2>&1
    else
        echo "=== $(date -Is) renewal FAILED ===" >>"$LOG"
        exit 1
    fi
else
    echo "=== $(date -Is) dry-run FAILED, not touching the live cert ===" >>"$LOG"
    exit 1
fi
