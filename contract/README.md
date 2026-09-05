# The wire contract, vendored

`schemas/` is a byte-for-byte copy of the platform repository's `schemas/` directory
(`snoopy-backend`, private) at commit `ab3f1f9`, taken 2026-09-04; the schemas
themselves last changed in `6cb9708` (2026-08-17). The platform emits them with
`npm run schemas:emit` and verifies the committed files against its TypeScript types
byte for byte, so this copy is the contract it publishes to external automation
authors. Known differences from runtime enforcement remain platform findings, not
local schema changes.

They are copied rather than fetched because a public repository's CI cannot read a
private one, and copied rather than imported because the boundary is the **wire
format, not a package** — an automation written anywhere else would have exactly
this and nothing more. To refresh: copy the directory again and update the commit
above in the same change.

`test/architecture.test.ts` validates every file in `manifests/` against
`automation-manifest.json` verbatim. The platform's own `validateManifest` also
admits plain `http` on a `*.internal` host, but the emitted schema does not; that
disagreement is filed with the platform as §12.1 #83. Manifests here follow the
published HTTPS rule rather than depending on the wider implementation.
