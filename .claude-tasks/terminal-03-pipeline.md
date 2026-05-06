# Task for Code Sandbox + Pipeline Terminal

## Priority: Medium

Improve document pipeline with ODT and EPUB generators:

1. Open `backend/src/services/sira/document-pipeline-registry.js`
2. Add ODT generator entries to `GENERATORS`:
   - `odf-weasy` (format: "odt", python, uses odfpy)
   - `pandoc-odt` (format: "odt", python, uses pandoc)
3. Add EPUB generator entries:
   - `pandoc-epub` (format: "epub", python, uses pandoc)
4. Add `odt` and `epub` to `MIME_TO_FORMAT` map
5. Add ODT/EPUB to `inferFormat()` supported extensions
6. Add 2 test cases to `backend/tests/document-pipeline-registry-formats.test.js`
7. TEST: `npm test` in backend/
8. PUSH: `git add -A && git commit -m "feat(document-pipeline): add ODT and EPUB format support" && git push sira-org main`
