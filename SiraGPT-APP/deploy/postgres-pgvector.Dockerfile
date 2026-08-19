FROM postgres:16-alpine

ARG PGVECTOR_VERSION=0.8.1

RUN apk add --no-cache --virtual .build-deps build-base clang21 git llvm21 \
    && ln -sf /usr/lib/llvm21/bin/llvm-link /usr/local/bin/llvm-link \
    && ln -sf /usr/lib/llvm21/bin/llvm-lto /usr/local/bin/llvm-lto \
    && git clone --depth 1 --branch "v${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git /tmp/pgvector \
    && make -C /tmp/pgvector PG_CONFIG=/usr/local/bin/pg_config \
    && make -C /tmp/pgvector PG_CONFIG=/usr/local/bin/pg_config install \
    && rm -rf /tmp/pgvector \
    && apk del .build-deps \
    && test -f "$(pg_config --sharedir)/extension/vector.control"
