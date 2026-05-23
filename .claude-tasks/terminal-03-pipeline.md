# Task for Pipeline Terminal

## Build: EPUB generation capability

Add EPUB generator support to `backend/src/services/sira/document-pipeline-registry.js`:

1. Add pandoc-epub entry to GENERATORS (format: "epub")
2. Add `epub` to MIME_TO_FORMAT map (application/epub+zip)
3. Add `epub` to the format list in inferFormat()
4. Create `backend/src/services/sira/generators/generate-epub.js`:
   - Receives content (markdown), title, author
   - Generates a valid EPUB3 file using basic OPF + XHTML + ZIP
   - Fall back to simple HTML → rename to .epub if zip lib missing
   - Returns { ok, buffer, filename, mime }
5. Add 2 tests in document-pipeline-registry-formats.test.js

Then: `npm test && git add -A && git commit -m "feat(document-pipeline): add EPUB format generator" && git push sira-org main`
