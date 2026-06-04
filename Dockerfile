FROM node:20-slim

RUN apt-get update -qq && apt-get install -y -qq ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# תעודות נטפרי — כל קבצי ה-CRT בתיקייה
COPY certs/ /tmp/certs/
RUN for f in /tmp/certs/*.crt; do \
        if grep -q "BEGIN CERTIFICATE" "$f" 2>/dev/null; then \
            cp "$f" "/usr/local/share/ca-certificates/$(basename $f)"; \
            echo "[CERT] Installed: $(basename $f)"; \
        fi; \
    done && update-ca-certificates

ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY src/ ./src/
COPY knowledge/ ./knowledge/
RUN mkdir -p data

CMD ["node", "src/index.js"]
