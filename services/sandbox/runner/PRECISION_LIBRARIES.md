# Document precision toolkit

Prepared on 2026-10-20 for the Ubuntu 24.04 / Python 3.12 document runner;
validation evidence and its platform limits are listed below.
The package set adds ten explicit capabilities to the existing 50-entry catalog.
It does not claim universal document editing or pixel-identical output from all
Office renderers. Measurement, independent rereading, and preservation checks
provide evidence for a specific edit before an artifact is delivered.

The runner and backend catalogs remain byte-identical. Each new entry has a
`proof` identifier registered in `smoke_precision.py`; the image build and the
runtime smoke gate execute these proofs as the unprivileged sandbox user.
The existing tools call the helpers in `/opt/sira`; no new core tool or UI is
introduced. `sira_preserve.py` checks package preservation and `sira_layout.py`
provides text, color, and PDF measurements.

## Direct packages and source licenses

The links below are the original project licenses inspected before integration,
not license names inferred from package names. PyPI links identify the exact
release selected. Wheel distributions keep their original copyright and license
files; none of this third-party source has been copied into SiraGPT helpers.

| Exact requirement | License inspected | Purpose and proof |
|---|---|---|
| [uharfbuzz==0.56.3](https://pypi.org/project/uharfbuzz/0.56.3/) | [Apache-2.0](https://github.com/harfbuzz/uharfbuzz/blob/main/LICENSE) | Real glyph shaping, advances, and kerning; `typography`. |
| [fonttools[woff]==4.67.0](https://pypi.org/project/fonttools/4.67.0/) | [MIT](https://github.com/fonttools/fonttools/blob/main/LICENSE) | Font coverage and metrics; WOFF2 round trip; `typography`. |
| [brotli==1.2.0](https://pypi.org/project/brotli/1.2.0/) | [MIT](https://github.com/google/brotli/blob/master/LICENSE) | Lossless font compression underlying WOFF2; `typography`. |
| [coloraide==8.13.1](https://pypi.org/project/coloraide/8.13.1/) | [MIT](https://github.com/facelessuser/coloraide/blob/main/LICENSE.md) | Measurable color conversion and contrast; `color`. |
| [xmldiff==3.0](https://pypi.org/project/xmldiff/3.0/) | [MIT](https://github.com/Shoobx/xmldiff/blob/master/LICENSE.txt) | Explain structural differences in XML parts; `preservation`. Only the modern MIT rewrite is selected, not legacy GPL releases. |
| [defusedxml==0.7.1](https://pypi.org/project/defusedxml/0.7.1/) | [PSF-2.0](https://github.com/tiran/defusedxml/blob/main/LICENSE) | Reject XML entity expansion while inspecting uploaded packages; `preservation`. |
| [pypdfium2==5.14.0](https://pypi.org/project/pypdfium2/5.14.0/) | [Apache-2.0 / BSD-3-Clause, with bundled notices](https://github.com/pypdfium2-team/pypdfium2#licensing) | Independent PDF geometry and raster verification; `pdf-geometry`. See the wheel-specific review below. |
| [python-calamine==0.9.0](https://pypi.org/project/python-calamine/0.9.0/) | [MIT](https://github.com/dimastbk/python-calamine/blob/master/LICENSE) | Independently reread worksheet values written with the existing Office libraries; `spreadsheet-roundtrip`. This is a reader, not a formatting-preserving writer. |
| [msoffcrypto-tool==6.0.0](https://pypi.org/project/msoffcrypto-tool/6.0.0/) | [MIT](https://github.com/nolze/msoffcrypto-tool/blob/master/LICENSE.txt) | Office encryption/decryption round trip with a supplied password; `encrypted-office-roundtrip`. |
| [olefile==0.47](https://pypi.org/project/olefile/0.47/) | [BSD-2-Clause and retained original notices](https://github.com/decalage2/olefile/blob/master/LICENSE.txt) | Inspect encrypted Office compound-file streams; `encrypted-office-roundtrip`. |

All ten releases provide wheels usable by Python 3.12: CPython 3.12 wheels,
compatible stable-ABI wheels, or platform-independent Python wheels. In
particular, uharfbuzz uses the CPython 3.10 stable ABI on Linux; pypdfium2 uses a
`py3-none-manylinux` wheel containing PDFium. The existing `odfpy` exception
remains the only permitted source distribution in the runner installation.

Some entries were already transitive dependencies of the base catalog:
fonttools/Brotli (fonts), pypdfium2 (pdfplumber), defusedxml (XML), and possibly
olefile through other packages. The improvement is making these capabilities
explicit, pinned, available to the agent, and covered by real artifact proofs;
it is not a claim that every entry is a previously absent installation.

## Transitive dependency review

The isolated Python 3.12 resolution selected `zopfli==0.4.3` for the WOFF extra,
`cryptography==50.0.2` for Office crypto, `cffi==2.1.1`, and `pycparser==3.11`.
`lxml==6.1.3` is shared with the existing Office catalog and xmldiff.
These are observed resolution versions, not additional direct locks; the
existing catalog still has bounded ranges and is not a complete lockfile.

- [py-zopfli](https://github.com/fonttools/py-zopfli/blob/master/COPYING) is
  Apache-2.0; only the `woff` extra is enabled, not fonttools' broad `all` extra.
- [cryptography](https://github.com/pyca/cryptography/blob/main/LICENSE) is
  available under Apache-2.0 or BSD-3-Clause; its wheel retains the bundled
  library notices, including OpenSSL.
- [CFFI](https://cffi.readthedocs.io/en/latest/) and
  [pycparser](https://github.com/eliben/pycparser/blob/main/LICENSE) retain their
  MIT-0 and BSD-3-Clause notices, respectively. These are shared infrastructure already needed by
  the image's PDF/rendering stack.
- The existing [lxml](https://github.com/lxml/lxml/blob/master/LICENSE.txt)
  license and bundled libxml2/libxslt notices remain intact.

### PDFium wheel review

The reviewed Linux x86_64 artifact is
`pypdfium2-5.14.0-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl`,
SHA-256 `11f281613fa22313d9c7ab89947665e84eccf8ebe40e1198a84a88352305648d`.
Its `.dist-info/licenses` directory includes the binding's Apache-2.0 and
BSD-3-Clause licenses, the CC-BY-4.0 documentation notice, and the bundled
PDFium notices. The native bundle has BSD/MIT/Apache, FreeType, Unicode, IJG,
libpng, and zlib notices, including LLVM's Apache license with exception.
Those files remain in the installed wheel and must remain with redistribution.

The upstream repository also contains license texts for development assets
that are not shipped in this reviewed Linux wheel. Selecting a different
platform, PDFium build, or release requires reviewing its actual bundled
notices again; a repository's license badge alone is insufficient.

## Validation and operating limits

Validation on 2026-10-20 installed all 60 catalog requirements in a fresh
Python 3.12 virtual environment with the runner's wheel/odfpy policy;
`pip check` reported no broken requirements. All ten precision imports passed.
The full import pass was 58/60 on macOS: the existing WeasyPrint and CairoSVG
entries require native Cairo/Pango libraries supplied by the Linux Dockerfile.
A separate resolver pass for CPython 3.12 / manylinux x86_64 resolved the entire
catalog successfully, using a locally built universal odfpy wheel for that
existing source-distribution exception. This validates package resolution,
not execution of the Linux native libraries; image and smoke gates remain
required.


- Install the complete catalog in an isolated Python 3.12 environment using
  `--only-binary=:all: --no-binary=odfpy`, then run `pip check`.
- Run `verify_env.py`, `smoke_formats.py`, and `smoke_precision.py` inside the
  built runner. The production-equivalent CI gate uses a read-only root,
  disabled networking, and UID 10001. A local macOS Python run alone is not
  evidence of a successful Linux container build or a production release.
- Font measurements require the actual font and shaping settings. Missing
  glyphs, different fonts, font substitution, or different Office engines can
  change layout. Keep source documents and compare the relevant rendered pages.
- PDFium calls must be serialized within a process; the upstream library is not
  thread-safe. Close document/page/text objects and keep their parents alive
  while reading child objects.
- Calamine proves values can be read independently. It does not prove that
  formulas, named ranges, charts, macros, or formatting were preserved; those
  require targeted package checks and the existing render/reopen workflow.
- Office decryption requires a user-supplied password. Passwords are never
  inferred, guessed, logged, or persisted in generated reports. Decrypted
  temporary files remain inside the task workspace.
- Preservation checks are explicit about allowed changed parts. Merely
  reopening an Office ZIP or producing a valid-looking screenshot does not
  prove that unrelated parts survived an edit.

## License audit fingerprints

Git blob fingerprints of the original license files inspected on 2026-10-20:

| Source | License blob |
|---|---|
| harfbuzz/uharfbuzz | `261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64` |
| fonttools/fonttools | `cc633905d333c4b42c1a0c8b34e9f734adeb6e1e` |
| google/brotli | `33b7cdd2dbaeddce1e35aa1a13f63d71154dc42f` |
| facelessuser/coloraide | `f64baddfe04b0a504399978ef6434f4d132a77b8` |
| Shoobx/xmldiff | `0f39b3880ae769d34124cdf8741d1f066d5e2438` |
| tiran/defusedxml | `311690c68fe4af37f8136cc05e62e9d51942b46a` |
| dimastbk/python-calamine | `46cf986840c5def0ff367d83a439c190c2b1d76e` |
| nolze/msoffcrypto-tool | `99b4e87a6994b79c588029fe0f397b5357717c3a` |
| decalage2/olefile | `5f53714a94bac986009e275ca0b79e06510a5456` |
| fonttools/py-zopfli | `2e64530473452df1e6f8293a2474b511d438282f` |
| pyca/cryptography | `b11f379efe1504d235b4d2d42685ba5dc6af6e9f` |
