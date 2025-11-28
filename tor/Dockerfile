FROM alpine:3.19

RUN apk add --no-cache tor

# создаём директорию hidden service
RUN mkdir -p /var/lib/tor/bui-proxy-ui && \
    chmod 700 /var/lib/tor/bui-proxy-ui

# копируем ключи из проекта внутрь образа (если нужны кастомные)
COPY keys/hs_ed25519_secret_key /var/lib/tor/bui-proxy-ui/
COPY keys/hs_ed25519_public_key /var/lib/tor/bui-proxy-ui/
COPY keys/hostname /var/lib/tor/bui-proxy-ui/

# проставляем правильные права
RUN chmod 600 /var/lib/tor/bui-proxy-ui/hs_ed25519_secret_key && \
    chmod 644 /var/lib/tor/bui-proxy-ui/hs_ed25519_public_key && \
    chmod 644 /var/lib/tor/bui-proxy-ui/hostname

COPY torrc /etc/tor/torrc

CMD ["tor"]