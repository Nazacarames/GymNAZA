#!/bin/sh
# Arranca el conector MCP (en segundo plano, se reinicia solo si se cae) y la API de openGym
# como proceso principal: si la API muere, el contenedor muere y Railway lo reinicia.
(
  while true; do
    node /opt/opengym/mcp/http.mjs
    echo "[start] el conector MCP terminó (código $?), reinicio en 5 s" >&2
    sleep 5
  done
) &
exec node server.js
