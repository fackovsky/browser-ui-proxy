FROM alpine:3.19

RUN apk add --no-cache tor

# Директория для tor-state
RUN mkdir -p /var/lib/tor && \
    chown -R tor:tor /var/lib/tor && \
    chmod 700 /var/lib/tor

# копируем ключи из проекта внутрь образа (если нужны кастомные)
COPY keys/hs_ed25519_secret_key /var/lib/tor/
COPY keys/hs_ed25519_public_key /var/lib/tor/
COPY keys/hostname /var/lib/tor/

# проставляем правильные права
RUN chmod 600 /var/lib/tor/hs_ed25519_secret_key && \
    chmod 644 /var/lib/tor/hs_ed25519_public_key && \
    chmod 644 /var/lib/tor/hostname

COPY torrc /etc/tor/torrc

CMD ["tor"]
