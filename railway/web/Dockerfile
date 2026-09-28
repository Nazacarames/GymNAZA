# openGym "web" para Railway.
#
# Parte de la imagen oficial ya publicada (no recompila el frontend) y le suma dos cosas
# que en docker-compose resuelven un servicio aparte y una carpeta compartida:
#
#   1. Las imágenes/GIFs de ejercicios (~140 MB) quedan DENTRO de la imagen. En Railway un
#      volumen no se puede compartir entre servicios, así que el servicio "media" del compose
#      no tiene equivalente: las descargamos en la etapa de build.
#   2. nginx usa el DNS interno de Railway (no el de Docker, 127.0.0.11) para encontrar la API
#      por la red privada, y acepta direcciones IPv6 (la red privada de Railway las usa).
#
# Para actualizar openGym: cambiá OPENGYM_VERSION (y la misma versión en el servicio api).

ARG OPENGYM_VERSION=1.3.8

# ── Etapa 1: descarga de las imágenes de ejercicios ─────────────────────────────────────────
# Fuente: github.com/hasaneyldrm/exercises-dataset. Metadatos y textos: MIT. Imágenes y GIFs:
# © Gym visual (https://gymvisual.com/), usados bajo los términos de ese dataset; ver el
# NOTICE.md de openGym. Fijado a un commit concreto para que cada build sea reproducible.
FROM alpine/git AS media
ARG DATASET_REF=7455efae41b330c265e7cd4b78dfa848e7ce5ebd
RUN git init -q /ds \
 && git -C /ds remote add origin https://github.com/hasaneyldrm/exercises-dataset \
 && git -C /ds fetch -q --depth 1 origin "$DATASET_REF" \
 && git -C /ds checkout -q FETCH_HEAD \
 && mkdir -p /out/img /out/gif \
 && cp /ds/images/*.jpg /out/img/ \
 && cp /ds/videos/*.gif /out/gif/ \
 && echo "media: $(ls /out/img | wc -l) imágenes, $(ls /out/gif | wc -l) GIFs"

# ── Etapa 2: la imagen web oficial + media + ajustes de red para Railway ────────────────────
FROM ghcr.io/duartesantos8/opengym-web:${OPENGYM_VERSION}

COPY --from=media /out/img /usr/share/nginx/html/img
COPY --from=media /out/gif /usr/share/nginx/html/gif

# La red privada de Railway puede responder con direcciones IPv6; la plantilla oficial las
# ignora (ipv6=off). La API escucha en IPv4 e IPv6, así que cualquiera de las dos sirve.
RUN sed -i 's/ ipv6=off;/;/' /etc/nginx/templates/default.conf.template \
 && grep -q 'resolver ${RESOLVER} valid=10s;' /etc/nginx/templates/default.conf.template

# Conector MCP para Claude (ver railway/api): se inserta justo antes del bloque /api/.
COPY mcp.location.conf /tmp/mcp.location.conf
RUN awk 'index($0, "location ^~ ${BASE_PATH}/api/") && !done { while ((getline l < "/tmp/mcp.location.conf") > 0) print l; done=1 } { print }' \
      /etc/nginx/templates/default.conf.template > /tmp/t && mv /tmp/t /etc/nginx/templates/default.conf.template \
 && grep -q 'location ^~ /mcp/' /etc/nginx/templates/default.conf.template \
 && rm /tmp/mcp.location.conf
ENV MCP_PORT=8081

# RESOLVER=auto → toma el DNS del contenedor (/etc/resolv.conf) al arrancar.
COPY --chmod=755 16-railway-resolver.envsh /docker-entrypoint.d/16-railway-resolver.envsh
ENV RESOLVER=auto
