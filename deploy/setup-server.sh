#!/usr/bin/env bash
# One-time server bootstrap. Idempotent: safe to re-run.
#
# Usage (as root on a fresh Ubuntu droplet):
#   HOSTNAME=167-99-2-144.sslip.io EMAIL=you@example.com bash setup-server.sh
set -euo pipefail

HOSTNAME="${HOSTNAME:?set HOSTNAME, e.g. 167-99-2-144.sslip.io}"
EMAIL="${EMAIL:?set EMAIL for certificate expiry notices}"

echo "==> 1/6 base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw nginx

echo "==> 2/6 swap"
# 1 GB of swap on a 1 GB box. Not there to be used: it is there so a memory
# spike degrades performance instead of having the OOM killer take out MySQL,
# which would look like an application bug and could happen unattended during
# the evaluation window.
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Prefer RAM; only spill to swap under real pressure.
  sysctl -w vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
else
  echo "    swap already configured"
fi

echo "==> 3/6 firewall"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
# MySQL is deliberately absent: it is only reachable inside the compose network.

echo "==> 4/6 docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "    docker already installed"
fi

echo "==> 5/6 nginx reverse proxy"
cat > /etc/nginx/sites-available/taskapi <<NGINX
server {
    listen 80;
    server_name ${HOSTNAME};

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/taskapi /etc/nginx/sites-enabled/taskapi
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> 6/6 TLS"
# certbot --nginx rewrites the site config above for 443 and installs a systemd
# timer that renews unattended. That timer is the reason nginx runs on the host
# instead of inside compose.
if [ ! -d "/etc/letsencrypt/live/${HOSTNAME}" ]; then
  apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "${HOSTNAME}" --non-interactive --agree-tos -m "${EMAIL}" --redirect
else
  echo "    certificate already present"
fi

echo
echo "Server ready. https://${HOSTNAME}"
