import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { detectPastedContentKind } from "../lib/long-paste"

/**
 * Extras for detectPastedContentKind. The base suite has 32 content-
 * kind tests but a handful of kinds in the PastedContentKind union
 * aren't tested individually. Pins:
 *
 *   - markdown (score-based heuristic ≥ 3)
 *   - tsv (tab-separated, distinct from csv)
 *   - xml (declaration + root element)
 *   - shell_session (prompt-prefix lines)
 *   - ini (section headers + key=value)
 *   - ssh_key (ssh-rsa / OPENSSH PRIVATE KEY)
 *   - transcript (timestamped speaker labels)
 */

describe("detectPastedContentKind · missing kind branches", () => {
  it("identifies markdown via headings + lists + links (no code blocks)", () => {
    // The fenced-code detector runs before markdown, so a markdown
    // document with code blocks would be classified as code. Use a
    // text-heavy markdown sample to land on the markdown branch.
    const md = `# Section

Paragraph with **bold** and _italic_.

## Subheading 1

- item one
- item two
- item three
- item four

## Subheading 2

| Col A | Col B |
|-------|-------|
| 1     | 2     |
| 3     | 4     |

See the [link](https://example.com), the [docs](https://docs.example.com)
and the \`inline code\` reference for \`details\` about \`config\`.
`
    const detection = detectPastedContentKind(md)
    assert.equal(detection.kind, "markdown")
  })

  it("identifies TSV via consistent tab columns", () => {
    const tsv = [
      "name\tage\tcity\trole\tnotes",
      "ana\t30\tMadrid\tlead\tgood",
      "beto\t25\tCDMX\tdev\tlearning",
      "carlos\t40\tLima\tarch\trelocated",
      "dora\t35\tBA\tdesigner\trolling",
      "elena\t28\tSantiago\tQA\ttester",
      "fer\t45\tBogota\tmgr\tplanning",
    ].join("\n")
    const detection = detectPastedContentKind(tsv)
    assert.equal(detection.kind, "tsv")
  })

  it("identifies XML via declaration + root element", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <person id="1">
    <name>Ana</name>
    <age>30</age>
  </person>
  <person id="2">
    <name>Beto</name>
    <age>25</age>
  </person>
</root>`
    const detection = detectPastedContentKind(xml)
    assert.equal(detection.kind, "xml")
  })

  it("identifies a shell session via prompt-prefix lines", () => {
    const shell = `$ ls -la
total 24
drwxr-xr-x  5 user user 4096 May 14 10:00 .
drwxr-xr-x  3 user user 4096 May 14 09:30 ..
$ cd src
$ npm install
added 234 packages in 12s
$ npm test
> my-project@1.0.0 test
> jest
PASS src/index.test.ts
$ exit
`
    const detection = detectPastedContentKind(shell)
    assert.equal(detection.kind, "shell_session")
  })

  it("identifies INI via section headers + key=value", () => {
    const ini = `[database]
host=localhost
port=5432
user=admin
password=secret

[cache]
host=127.0.0.1
port=6379
ttl=3600

[logging]
level=info
output=stdout
format=json
`
    const detection = detectPastedContentKind(ini)
    assert.equal(detection.kind, "ini")
  })

  it("identifies an SSH public key (ssh-rsa prefix)", () => {
    const sshKey = `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDjP9Cw3vKLOdT5BgIxKqzPsW7Jh8FzZeKvKb6ZjAxFQzVdY9j6xPzCgBaOgEzqHKnZQ user@host`
    const detection = detectPastedContentKind(sshKey)
    assert.equal(detection.kind, "ssh_key")
  })

  it("identifies a transcript via timestamped speaker lines", () => {
    const transcript = `[00:00] Host: Welcome to the show today.
[00:15] Guest: Thanks for having me.
[00:20] Host: Let's dive into the first topic.
[00:35] Guest: Sounds great. As I was saying earlier...
[01:00] Host: That's a fascinating point.
[01:20] Guest: I think we should explore this more.
[02:00] Host: Absolutely. Let's continue.`
    const detection = detectPastedContentKind(transcript)
    assert.equal(detection.kind, "transcript")
  })
})
