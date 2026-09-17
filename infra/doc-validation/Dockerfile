# Build with an audited ubuntu:24.04 digest supplied by CI/release tooling.
# Runtime requires the resulting image@sha256 digest; mutable tags are rejected.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# Content-addressed indexes avoid mirror publication races; signature, date and
# package hash verification stay enabled. Fail on any incomplete index update.
RUN apt-get -o Acquire::By-Hash=force -o APT::Update::Error-Mode=any update && apt-get install -y --no-install-recommends \
    python3 python3-venv libreoffice-writer libreoffice-calc libreoffice-impress \
    poppler-utils qpdf fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/validator-venv
COPY infra/doc-validation/requirements.txt /opt/validator/requirements.txt
RUN /opt/validator-venv/bin/pip install --no-cache-dir -r /opt/validator/requirements.txt \
    && dpkg-query -W > /opt/validator/os-packages.lock \
    && /opt/validator-venv/bin/pip freeze > /opt/validator/python-packages.lock
COPY backend/src/modules/doc-sandbox/validation/validator.py /opt/validator/validator.py
USER 65532:65532
WORKDIR /tmp
# Independent upper bound even if the worker/launcher dies. GNU timeout is PID 1;
# killing/finishing it tears down all remaining validator/LibreOffice processes.
ENTRYPOINT ["/usr/bin/timeout", "--signal=KILL", "600s", "/opt/validator-venv/bin/python", "/opt/validator/validator.py"]
