#!/bin/bash
set -e

VPS_USER=ubuntu
VPS_HOST=SEU_IP_VPS
VPS_PATH=/opt/ownerinc-portal

echo "Sincronizando arquivos para o VPS..."
rsync -avz --delete \
  --exclude='.env' \
  --exclude='cron/node_modules' \
  --exclude='.git' \
  ./ ${VPS_USER}@${VPS_HOST}:${VPS_PATH}/

echo "Reconstruindo e subindo containers..."
ssh ${VPS_USER}@${VPS_HOST} "cd ${VPS_PATH} && docker compose up -d --build"

echo "Deploy concluido: http://${VPS_HOST}"
