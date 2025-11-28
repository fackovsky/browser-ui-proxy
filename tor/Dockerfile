FROM alpine:3.19
RUN apk add --no-cache tor

# создаём директорию под hidden service
RUN mkdir -p /var/lib/tor/bui-onion-proxy && \
    chmod 700 /var/lib/tor/bui-onion-proxy

# копируем ключи из проекта внутрь образа (для начального состояния)
COPY keys/hs_ed25519_secret_key /var/lib/tor/bui-onion-proxy/
COPY keys/hs_ed25519_public_key /var/lib/tor/bui-onion-proxy/
COPY keys/hostname /var/lib/tor/bui-onion-proxy/

# проставляем правильные права
RUN chmod 600 /var/lib/tor/bui-onion-proxy/hs_ed25519_secret_key && \
    chmod 644 /var/lib/tor/bui-onion-proxy/hs_ed25519_public_key && \
    chmod 644 /var/lib/tor/bui-onion-proxy/hostname

# конфиг tor
COPY torrc /etc/tor/torrc

CMD ["tor"]
