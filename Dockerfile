# Image du formulaire MDPH vocal (Flask + gunicorn, voix Piper incluses).
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

# Voix Piper (≈ 125 Mo) téléchargées à la construction : aucun texte ne part vers un tiers à l'exécution.
FROM base AS voices
RUN python -m piper.download_voices --data-dir /voices fr_FR-siwis-medium fr_FR-tom-medium

FROM base
COPY --from=voices /voices ./voices
COPY app.py llm.py pdf_cerfa.py tts.py ./
COPY static ./static
COPY pdf ./pdf
USER 1001
# WEB_CONCURRENCY : nombre de processus gunicorn (chacun charge ses voix, ≈ 400 Mo).
ENV PORT=8000 WEB_CONCURRENCY=1
EXPOSE 8000
# Appels à l'IA lents (E/S) : des fils plutôt que des processus, délai large.
CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT} --threads 8 --worker-class gthread --timeout 120 --worker-tmp-dir /tmp --control-socket /tmp/gunicorn.ctl app:app"]
