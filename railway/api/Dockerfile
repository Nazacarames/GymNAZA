# openGym "api" para Railway + conector MCP para Claude.
#
# La imagen oficial de la API, sin cambios, más el servidor MCP oficial de openGym (mcp/, solo
# lectura) expuesto por HTTP en MCP_PORT. Tienen que correr en el mismo servicio porque el MCP lee
# los archivos de /data, y en Railway el volumen solo se monta en un servicio.
#
# Para actualizar openGym: cambiá OPENGYM_VERSION (y la misma versión en railway/web/Dockerfile).

ARG OPENGYM_VERSION=1.3.8

# ── Etapa 1: el MCP oficial, del mismo tag que la imagen ────────────────────────────────────
FROM node:22-alpine AS mcp
ARG OPENGYM_VERSION
RUN apk add --no-cache git \
 && git clone -q --depth 1 --branch "v${OPENGYM_VERSION}" https://github.com/DuarteSantos8/openGym /src
WORKDIR /src/mcp
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY http.mjs write-tools.mjs ./
# Falla el build si algo del grafo de imports no carga en Node puro.
RUN node scripts/check-node-loadable.mjs && node --check http.mjs && node --check write-tools.mjs

# ── Etapa 2: la API oficial + el MCP al lado ────────────────────────────────────────────────
FROM ghcr.io/duartesantos8/opengym-api:${OPENGYM_VERSION}
# Misma estructura relativa que en el repo: mcp/src importa ../../frontend/src/lib/*.
COPY --from=mcp /src/mcp /opt/opengym/mcp
COPY --from=mcp /src/frontend/package.json /opt/opengym/frontend/package.json
COPY --from=mcp /src/frontend/src /opt/opengym/frontend/src
COPY --from=mcp /src/api/coach/core /opt/opengym/api/coach/core
COPY --chmod=755 start.sh /opt/opengym/start.sh

ENV MCP_PORT=8081
ENV OPENGYM_DATA=/data
CMD ["/opt/opengym/start.sh"]
