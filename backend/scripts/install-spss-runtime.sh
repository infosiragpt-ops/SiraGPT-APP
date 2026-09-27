#!/bin/sh
set -eu

# The production backend runs agent Python with the image's python3. Alpine
# has pandas/numpy packages, but pyreadstat publishes glibc Linux wheels, so
# build its pinned source release against musl and remove the compiler.
apk add --no-cache python3 py3-pip py3-pandas py3-openpyxl
apk add --no-cache --virtual .spss-build-deps \
  build-base python3-dev py3-setuptools py3-wheel cython zlib-dev

python3 -m pip install --break-system-packages --disable-pip-version-check \
  --no-cache-dir --no-deps 'narwhals==2.10.1'
python3 -m pip install --break-system-packages --disable-pip-version-check \
  --no-cache-dir --no-deps --no-build-isolation --no-binary=pyreadstat \
  'pyreadstat==1.3.6'

apk del .spss-build-deps
python3 -c 'import pandas, pyreadstat, narwhals; assert hasattr(pyreadstat, "write_sav") and hasattr(pyreadstat, "read_sav")'
