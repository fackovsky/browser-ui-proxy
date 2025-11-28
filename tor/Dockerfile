FROM alpine:3.19

RUN apk add --no-cache tor

# Директория для tor-state
RUN mkdir -p /var/lib/tor && \
    chown -R tor:tor /var/lib/tor && \
    chmod 700 /var/lib/tor

COPY torrc /etc/tor/torrc

USER tor

CMD ["tor"]
