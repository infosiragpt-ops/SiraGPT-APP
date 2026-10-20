# Document toolkit: dependencies, evidence and limits

Reviewed on 2026-10-20 for the Ubuntu 24.04 / Python 3.12 document runner.
The catalog contains **84 explicit Python entries: the previous 60, twenty-three
newly advertised libraries, and one explicit pin for `packaging`, previously a
transitive dependency**. The first toolkit increment added sixteen libraries;
the extension documented here adds seven more. This count is not the number of
all installed transitive packages or a claim that each package was absent from earlier images.
The previous precision additions remain documented in
[PRECISION_LIBRARIES.md](PRECISION_LIBRARIES.md).

This extension covers document composition, precise structured-data changes,
physical measurements, vector geometry, offline charts, columnar data, Word
merge fields, native OpenDocument edits, bibliography exchange and readable
codes. It does not promise support for every file format, pixel-identical
rendering, an unmeasured speedup, or automatic correctness for arbitrary user documents.
The native helper and proof code use installed libraries; no upstream source
was copied into SiraGPT helpers and no additional core tool or UI is required.

## Exact requirements and original licenses

Each release link identifies the exact PyPI distribution selected by
`capabilities.json`. License links identify the original projects. The installed
artifact license files and their fingerprints are recorded below because a
repository branch or badge alone is not an immutable license audit.

| Exact requirement / release | Original license | Functional proof |
|---|---|---|
| [docxcompose==2.2.0](https://pypi.org/project/docxcompose/2.2.0/) | [MIT](https://github.com/4teamwork/docxcompose/blob/master/LICENSE) | `document-composition` |
| [docx2python==3.7.1](https://pypi.org/project/docx2python/3.7.1/) | [MIT](https://github.com/ShayHill/docx2python/blob/master/LICENSE.txt) | `document-composition` |
| [striprtf==0.0.33](https://pypi.org/project/striprtf/0.0.33/) | [BSD-3-Clause](https://github.com/joshy/striprtf/blob/master/LICENSE) | `document-composition` |
| [jsonschema==4.26.0](https://pypi.org/project/jsonschema/4.26.0/) | [MIT](https://github.com/python-jsonschema/jsonschema/blob/main/COPYING) | `structured-json` |
| [jsonpatch==1.36](https://pypi.org/project/jsonpatch/1.36/) | [BSD-3-Clause](https://github.com/stefankoegl/python-json-patch/blob/master/LICENSE) | `structured-json` |
| [jmespath==1.1.0](https://pypi.org/project/jmespath/1.1.0/) | [MIT](https://github.com/jmespath/jmespath.py/blob/develop/LICENSE) | `structured-json` |
| [ijson==3.6.0](https://pypi.org/project/ijson/3.6.0/) | [BSD-3-Clause AND ISC](https://github.com/ICRAR/ijson/blob/master/LICENSE.txt) | `structured-json` |
| [packaging==26.3](https://pypi.org/project/packaging/26.3/) | [Apache-2.0 OR BSD-2-Clause](https://github.com/pypa/packaging/blob/main/LICENSE) | `structured-json` |
| [rapidfuzz==3.14.6](https://pypi.org/project/rapidfuzz/3.14.6/) | [MIT](https://github.com/rapidfuzz/RapidFuzz/blob/main/LICENSE) | `fuzzy-candidates` |
| [pint==0.25.3](https://pypi.org/project/pint/0.25.3/) | [BSD-3-Clause](https://github.com/hgrecco/pint/blob/master/LICENSE) | `physical-units` |
| [uncertainties==3.2.3](https://pypi.org/project/uncertainties/3.2.3/) | [BSD-3-Clause](https://github.com/lmfit/uncertainties/blob/master/LICENSE.txt) | `physical-units` |
| [svgpathtools==1.8.0](https://pypi.org/project/svgpathtools/1.8.0/) | [MIT](https://github.com/mathandy/svgpathtools/blob/master/LICENSE.txt) | `svg-geometry` |
| [altair==6.3.0](https://pypi.org/project/altair/6.3.0/) | [BSD-3-Clause](https://github.com/vega/altair/blob/main/LICENSE) | `declarative-charts` |
| [vl-convert-python==1.9.0.post1](https://pypi.org/project/vl-convert-python/1.9.0.post1/) | [BSD-3-Clause](https://github.com/jonmmease/vl-convert/blob/main/LICENSE) | `declarative-charts` |
| [duckdb==1.5.6](https://pypi.org/project/duckdb/1.5.6/) | [MIT](https://github.com/duckdb/duckdb-python/blob/v2.0-cyanoptera/LICENSE) | `columnar-data` |
| [pyarrow==26.0.0](https://pypi.org/project/pyarrow/26.0.0/) | [Apache-2.0](https://github.com/apache/arrow/blob/main/LICENSE.txt) | `columnar-data` |
| [ImageHash==4.3.2](https://pypi.org/project/ImageHash/4.3.2/) | [BSD-2-Clause](https://github.com/JohannesBuchner/imagehash/blob/master/LICENSE) | `visual-fingerprints` |

The seven subsequent additions use these exact requirements and their original
package APIs. They extend the same sandbox rather than introducing another
parser, document renderer or core tool.

| Exact requirement / release | Original license | Functional proof | Original API and intended use |
|---|---|---|---|
| [docx-mailmerge2==1.0.3](https://pypi.org/project/docx-mailmerge2/1.0.3/) | [MIT](https://github.com/iulica/docx-mailmerge/blob/master/LICENSE.txt) | `word-mailmerge` | The `mailmerge` API fills existing Word merge fields and table rows; it does not replace ordinary DOCX editing. |
| [bibtexparser==2.1.0](https://pypi.org/project/bibtexparser/2.1.0/) | [MIT](https://github.com/sciunto-org/python-bibtexparser/blob/main/LICENSE) | `bibliography-roundtrip` | The version 2 parser/writer works with BibTeX entries and field values; use its version 2 API rather than version 1 examples. |
| [rispy==0.10.0](https://pypi.org/project/rispy/0.10.0/) | [MIT](https://github.com/MrTango/rispy/blob/main/LICENSE) | `bibliography-roundtrip` | The RIS reader/writer exchanges structured citation metadata. |
| [odfdo==3.27.2](https://pypi.org/project/odfdo/3.27.2/) | [Apache-2.0](https://github.com/jdum/odfdo/blob/main/LICENSE) | `odf-native-edits` | Native OpenDocument objects expose document content, styles and spreadsheet cells. |
| [segno==1.6.6](https://pypi.org/project/segno/1.6.6/) | [BSD-3-Clause](https://github.com/heuer/segno/blob/master/LICENSE) | `qr-roundtrip` | The QR/MicroQR serializer controls vector output, scale and quiet zones; standard QR generation already exists through `qrcode`. |
| [zxing-cpp==3.1.1](https://pypi.org/project/zxing-cpp/3.1.1/) | [Apache-2.0](https://github.com/zxing-cpp/zxing-cpp/blob/master/LICENSE) | `qr-roundtrip` | The `zxingcpp` reader independently decodes image content and reports the code format. |
| [deepdiff==9.1.0](https://pypi.org/project/deepdiff/9.1.0/) | [MIT](https://github.com/qlustered/deepdiff/blob/master/LICENSE) | `structured-diff` | `DeepDiff` identifies changed paths, values and types in structured data. |

`packaging` is an explicit availability/version pin used to check PEP 440
requirements. It is not presented as a new document format. All added
requirements use their base distribution: no broad `all`, `dev` or optional
format-validation extras are enabled.

## Functional proof groups

The functions are registered in `smoke_document_toolkit.py` and imported by the
existing `smoke_precision.py` runner. They create and reopen real artifacts;
merely importing a package is not evidence of a successful document operation.
The first increment defines the following eight groups.

| Proof ID | What the executable fixture checks | Limit of that evidence |
|---|---|---|
| `document-composition` | Two DOCX files retain their text, table values, direct bold/italic formatting, image bytes and image dimensions after composition. A second reader extracts their content, originals retain their hashes, and an RTF fixture preserves Unicode, escapes and paragraph text. | Tests a small fixture and the master-header rule, not arbitrary sections, tracked changes, fields, macros or page layout. RTF extraction returns text, not preserved formatting. |
| `structured-json` | JSON Schema rejects a malformed record; JSON Patch checks old values before replacing one field; JMESPath selects an exact ID; streaming reads preserve decimals, large integers and nulls; PEP 440 requirements accept/reject expected versions. | Does not certify a large-data memory benchmark or turn fuzzy matching into edit authorization. |
| `fuzzy-candidates` | Exact and near matches remain distinct ranked candidates, unrelated text is rejected, and the output requires review without selecting or modifying a record. | A similarity score is a suggestion, not identity or permission to overwrite. |
| `physical-units` | Unit conversions and uncertainty propagation match expected values, shared-measurement correlation is retained, incompatible dimensions fail, and offset temperatures convert correctly. | Input measurements and uncertainty models still need to be appropriate to the task. |
| `svg-geometry` | A closed path retains its expected bounds, path attributes and canvas after serialization; raster checks verify an interior pixel and an untouched exterior region. | A fixture does not establish full SVG compatibility or certify arbitrary typography. |
| `declarative-charts` | An embedded-data chart exports to SVG, PNG and PDF; original values, accented labels, nonblank pixels and PDF page/text geometry are checked with remote data disabled. The PNG is embedded in a PPTX at measured dimensions; editing and reopening its native title preserves the image bytes. | The chart in PPTX is an image, not native editable chart data; the separate Vega-Lite specification remains editable. Does not replace inspection of a delivered report. |
| `columnar-data` | Arrow/Parquet and DuckDB preserve explicit types, decimals, large integers, Unicode and nulls through one requested value change; source bytes remain unchanged and decimal overflow fails. | The fixture is not a throughput claim for millions of rows. Memory, threads and local file access remain bounded. |
| `visual-fingerprints` | A lossless image preserves pixels and its fingerprint; a mirrored fixture differs; different uniform colors demonstrate a perceptual-hash collision. | Fingerprints cannot prove byte equality or preservation of small text and values; exact bytes/pixels are checked separately. |

The seven-library extension adds the following five fixture contracts. Their
actual pass/fail result and check counts come from the generated report, not
from this dependency inventory.

| Proof ID | Required evidence | Limit of that evidence |
|---|---|---|
| `word-mailmerge` | Fill real DOCX merge fields and repeated table rows, reopen the output, check the requested values and verify that the source file remains unchanged. | Word merge fields must exist in the input template. This is not a general-purpose field calculator or a guarantee for arbitrary nested fields, sections or page layout. |
| `bibliography-roundtrip` | Parse and write real BibTeX and RIS fixtures, then re-read the entries and check identifiers, authors, Unicode and requested metadata changes. | Citation metadata does not verify a publication's existence, DOI correctness or compliance with a complete citation style. Serialization may normalize whitespace and ordering. |
| `odf-native-edits` | Save and reopen native OpenDocument fixtures after a targeted text or cell edit, compare requested values and unaffected structure, and keep original files unchanged. | ODF structure checks do not certify an identical layout across office applications or support for every extension, macro or formula. |
| `qr-roundtrip` | Generate QR output, independently decode the rasterized image with ZXing, and compare the exact payload and expected code format. | Decode success is for the fixture at its tested dimensions; printed contrast, material, damage and camera distance still affect readability. |
| `structured-diff` | Detect the specified changed path and type/value differences, and also detect a deliberately introduced unintended change. | A structural comparison is not a visual document comparison. Ignoring order, types or numeric differences can hide changes and must not be enabled by default for preservation checks. |

Use the existing entrypoint for discovery and execution:

```bash
python3 /opt/sira/smoke_precision.py --list-proofs
python3 /opt/sira/smoke_precision.py /workspace/tmp/document-toolkit-proof
```

The second command runs the registered previous precision proofs and document
toolkit groups, including the five extension groups. `precision-report.json`
records group IDs, actual check counts, artifact names, failures and the number of catalog entries requiring a
proof. A missing dependency or failed check returns a nonzero exit status.
Run `verify_env.py` and `smoke_formats.py` as well; they cover the rest of the
catalog and advertised formats. A package resolution, local virtual-environment
run, built image and deployed production image are distinct evidence levels.

## Compatibility and dependency constraints

- The deployment target is Python 3.12. The first sixteen selected releases also
  have universal or compatible Linux wheels for Python 3.11; ImageHash's
  metadata does not declare a Python floor, so its actual interpreter support
  must be checked by the functional proof. Transitive versions may differ by
  interpreter. Do not claim an identical Python 3.11 installation from a
  Python 3.12 resolution alone.
- The seven subsequent releases have universal wheels or a Linux x86_64
  CPython 3.12-compatible wheel. `zxing-cpp==3.1.1` provides a `cp312-abi3`
  manylinux wheel; its compressed size is approximately 1.1 MB. Resolving
  compatible wheel metadata is not a substitute for running the image smoke
  tests. This extension adds no source-build exception to the existing
  `--only-binary=:all:` policy (whose existing exception is `odfpy`).
- Observed dependencies of the extension include `pylatexenc==2.11` (MIT,
  compatible with BibTeXParser's `~=2.10` requirement), `cachebox==5.2.3`
  (MIT, compatible with DeepDiff's `>=5.2,<6` requirement), and
  `orderly-set==5.5.0` (MIT). All three have compatible wheels. They are
  transitive observations, **not additional entries in the 84-entry catalog**
  or a complete dependency lock. Original license evidence is below.
- `docx-mailmerge2` and `odfdo` use the existing `lxml` dependency;
  `odfdo==3.27.2` allows `lxml<7` on Python 3.12. Neither requires a pandas
  downgrade. `xlsx-evaluate==0.5.0` was excluded because its `pandas<2`
  requirement conflicts with the current catalog's `pandas>=2.2`.
- DeepDiff results are data for validation. Do not deserialize untrusted
  pickle or Delta payloads, and do not treat a diff as authorization to apply
  changes. Preserve the original artifact and independently reopen outputs.
- BibTeXParser and rispy operate offline on supplied metadata. This extension
  does not install `citeproc-py` or its style extras: the reviewed 0.11.1 wheel
  includes a Harvard CSL file licensed CC-BY-SA-3.0 even though the processor
  itself is BSD-licensed. No citation-formatting claim is made for these two
  metadata libraries.
- `docx2python` requires `lxml>=6.1.1`, within the existing catalog's `<7` range.
  `docxcompose` requires `Babel>=2.10.0`. Use base `pint==0.25.3`: its optional
  `babel`/`all` extras constrain Babel to an incompatible older range. Newer
  Pint 0.26.2 requires Python 3.12 and is not this pin.
- Use base `jsonschema`. Its optional `format` extra adds a GPL dependency;
  this extension neither enables that extra nor changes the license policy.
- Altair 6.3.0 declares Vega-Lite 6.4.1; the exact `vl-convert-python`
  1.9.0.post1 source distribution includes that renderer. Data and fonts must
  be local or embedded. `allowed_base_urls=[]` disables remote data in the
  chart proof; production sandbox network isolation remains in force.
- DuckDB's proof disables extension auto-install and auto-load, limits it to
  one thread and 128 MB, and locks external access after allowlisting only its
  fixture directory. The libraries do not authorize downloads or broaden the
  agent's filesystem/network access.
- ImageHash adds PyWavelets. The observed Python 3.12 environment selected
  PyWavelets 1.10.0 (MIT AND BSD-3-Clause), which requires Python 3.12; a Python
  3.11 resolver needs a compatible earlier release. PyWavelets is not an
  additional direct pin in this catalog.
- Other observed transitive additions include Babel 2.18.0 (BSD-3-Clause),
  paragraphs 1.0.1 (MIT), narwhals 2.27.1 (MIT), jsonpointer 3.4 (BSD),
  jsonschema-specifications 2025.9.1 (MIT), referencing 0.37.0 (MIT),
  rpds-py 2026.9.1 (MIT), flexcache 0.3 (BSD) and flexparser 0.4
  (BSD-3-Clause). These are observed metadata, not a complete lockfile or new
  advertised formats. Original dependency notices remain installed.
- Linux x86_64 wheels for DuckDB, vl-convert-python and PyArrow are approximately
  21.5 MB, 33.5 MB and 53.9 MB compressed, respectively. Their functional value
  should justify their image-size cost; they are not described as lightweight.

## Artifact license evidence and redistribution

The table records SHA-256 hashes of license files inspected in the first
increment's installed Python 3.12 distributions and in the exact release wheels
for the seven-library extension and its three observed dependencies. Paths are
relative to each named `.dist-info` directory. These hashes identify license text, **not the entire wheel**; build
reports and the actual image identity remain necessary for release evidence.
Keep the installed copyright, LICENSE, COPYING and NOTICE files when packaging
or redistributing the image. Do not replace them with this summary.

| Distribution | Inspected artifact path | License-file SHA-256 |
|---|---|---|
| `docxcompose==2.2.0` | `licenses/LICENSE` | `914c54421243736e33d23101a98017b04bc033d406375666d23996b28a2ca3a8` |
| `docx2python==3.7.1` | `licenses/LICENSE.txt` | `b25c65161b4d675ee65ac545b4980bd8655eb15933ff96dd3d57a86b53e26e34` |
| `striprtf==0.0.33` | `licenses/LICENSE` | `5e3d3399202cd1f80196a3b33836b67d5e27df6cbedd059c3aa6f4ae9f054278` |
| `jsonschema==4.26.0` | `licenses/COPYING` | `4f92a015a13c4d1a040bef018aa13430b4f1bc73b41b16bb846c346766de7439` |
| `jsonpatch==1.36` | `licenses/LICENSE` | `4393eb6733fa1e367f41769b382f4f1be7bf0daeb1e243ed92b3f5d8bafd236f` |
| `jmespath==1.1.0` | `LICENSE` | `6eefacfa4d71b82d08408c751470ac8d9854538da2142cb27be0287fb13d0ab9` |
| `ijson==3.6.0` | `licenses/LICENSE.txt` | `e5c6f4cfe2d71620ea58a4aa9f9b1c61bf6b0e91fbd0e188e0998fe6c3cf8d00` |
| `packaging==26.3` | `licenses/LICENSE` | `cad1ef5bd340d73e074ba614d26f7deaca5c7940c3d8c34852e65c4909686c48` |
| `packaging==26.3` | `licenses/LICENSE.APACHE` | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |
| `packaging==26.3` | `licenses/LICENSE.BSD` | `b70e7e9b742f1cc6f948b34c16aa39ffece94196364bc88ff0d2180f0028fac5` |
| `rapidfuzz==3.14.6` | `licenses/LICENSE` | `f34ccdffdff56fc417785915eedf18601d5479755df3c472b2c754c29802d683` |
| `pint==0.25.3` | `licenses/LICENSE` | `46e43fb463fe2e0e28b32c900bbbdb6f376959df3936e1c134566860a55b2112` |
| `uncertainties==3.2.3` | `licenses/LICENSE.txt` | `607252657d1d0a066e035c00902555a211dc8d34b785b1f4774e926034b747c9` |
| `svgpathtools==1.8.0` | `LICENSE.txt` | `e61b5f4e69dcb874e07ee26762113879ec326a7c98c75c9aa2c8ea5453b4e495` |
| `altair==6.3.0` | `licenses/LICENSE` | `648332da6631555f71f18305b96e9a2c409e73d73613b6c96587cdc0a449e054` |
| `vl-convert-python==1.9.0.post1` | `licenses/LICENSE` | `9a8e49b841a4062ae698bae5c4167cb0834867e4aa81b0a82f750e870bc913ac` |
| `duckdb==1.5.6` | `licenses/LICENSE` | `075c33400ffcb0c586dd106a029d3e733e9da3693f8fcb9cebfc651c8a2f14e3` |
| `pyarrow==26.0.0` | `licenses/LICENSE.txt` | `cd03925a27219d326d622609fbcae6567279af8b8885c33d5969a9e4ef5d7525` |
| `pyarrow==26.0.0` | `licenses/NOTICE.txt` | `afd895d61a00101f6d5a41cf518c83865d815e8109e956f512a0ce4ea9738c06` |
| `ImageHash==4.3.2` | `LICENSE` | `9d0b037853dae7bcf6b19b728559a833993cd8710fc18a261e6026e56bf704be` |
| `docx-mailmerge2==1.0.3` | `licenses/LICENSE.txt` | `f5761d6605cee66a9c2e1ac34d1feec61311498ff80740ec8ef77f336766e061` |
| `bibtexparser==2.1.0` | `licenses/LICENSE` | `1f092a7986b9ac79a4fb08ef0b3a02f1cf2f0a5d9aeab93dc281e3bf7268271c` |
| `rispy==0.10.0` | `licenses/LICENSE` | `e22704b888033bf3ae2c740003266f879066e421c55795d6c693735c6216afc0` |
| `odfdo==3.27.2` | `licenses/LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| `odfdo==3.27.2` | `licenses/NOTICE.txt` | `c8cffb980031ea97f87747e671663bf5713fa3638076e3175d0ea4c57258f455` |
| `segno==1.6.6` | `licenses/LICENSE` | `de6c85fccf5d52902aa13dfe2dc6d2a2a106fc3419ed438f3460f0d4b76a6935` |
| `zxing-cpp==3.1.1` | `licenses/LICENSE` | `c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08` |
| `deepdiff==9.1.0` | `licenses/LICENSE` | `b6a7f272a509d922ca04e71367f90cfc8e7ecf4d38985b453a431b1ea22af7c8` |
| `pylatexenc==2.11` | `licenses/LICENSE.txt` | `90b6f8fc23cb0328a9678562627fb2ebc5f9c871712fad698d781869eb02862c` |
| `cachebox==5.2.3` | `licenses/LICENSE` | `e281fc9d4fab359f61e6d6e1e8ca0f54f160b580eab0f5e502bd909e19f14384` |
| `orderly-set==5.5.0` | `licenses/MIT-LICENSE` | `148a76af346877c70ca60b826ec4175d6d907cb90d781c7b16d854d1c5c1a30c` |

`packaging` offers Apache-2.0 **or** BSD-2-Clause; both supplied license texts
and its license-selection statement remain intact. Ijson's notice includes
its BSD-3-Clause license and the ISC notice for bundled YAJL. PyArrow retains
both `LICENSE.txt` and `NOTICE.txt`, including the notices for its bundled
components; an Apache label does not remove those obligations.

For the exact vl-convert 1.9.0.post1 source, reviewed native components include
resvg/usvg 0.45.1 (Apache-2.0 OR MIT), svg2pdf 0.13.0 (MIT OR Apache-2.0),
fontdb 0.23.0 (MIT), tiny-skia 0.11.4 (BSD-3-Clause) and deno_runtime 0.177.0
(MIT). Their sources and license metadata are published on
[crates.io](https://crates.io/crates/vl-convert-rs).
This is not a blanket license approval for future versions, extras or different
platform bundles. Review the actual artifacts again when changing them.

For the extension, keep Odfdo's `NOTICE.txt` alongside its Apache-2.0 license.
That notice identifies educational recipes derived from lpod-python under
CC-BY-3.0 and runtime code used under Apache-2.0. The SiraGPT fixtures use the
public package API; they do not copy those recipes. The notice and any original
recipe attribution are retained rather than relabelled as Apache-2.0.

The observed transitive projects publish their licenses at
[pylatexenc](https://github.com/phfaist/pylatexenc/blob/main/LICENSE.txt),
[cachebox](https://github.com/awolverp/cachebox/blob/main/LICENSE) and
[orderly-set](https://github.com/seperman/orderly-set/blob/master/MIT-LICENSE).
The hashes above identify the inspected release text, since these repository
links can change with their default branches. Future wheels, bundled native
components and optional extras require their own review.

No upstream source files were vendored by this extension. SiraGPT's integration
code and fixtures remain native wrappers around the pinned installed packages.
General document edits still require source preservation, a narrowly specified
change, independent reopening and appropriate rendered-page inspection.
