# F83 — Prepared Extension cannot run in Floe

## Observed outcome

The original campaign request asked Floe to prepare an external image-service
capability, retain exact source and test evidence, and stop at a supported
installation decision. Existing reviewed work had to remain unchanged.

After installed 0.1.80 restarted, Floe recovered the interrupted Builder and
eventually returned five named attachments at approximately 02:08 UTC on
8 September: Source manifest, Package archive, Package verification,
Real-network test evidence, and Permissions & recovery record. Actual browser
use opened Package verification and displayed its exact saved version. Floe
reported missing lifecycle grants and created no installation approval.

The read-only preservation check at 02:14:20 UTC passed against the original
pre-attempt baseline: 14 earlier campaign files, three retained versions,
earlier Scope executions, approval requests and approval uses remain unchanged.
The release steward's participation was evidence recovery, not another Gallery
review. The original request was not resent by Astra.

## Independent host diagnosis

The retained archive is:

`C:/Development/_temp/floe-campaign-proof-20260905/extension-output/picsum-image-acquisition-1.0.0/floe-picsum-image-acquisition-1.0.0.tgz`

Its independently calculated SHA-256 matches the saved evidence:
`4d859e2655af781ddf3aeafd66e043d3100a408941a62bb67db7edfba5cf907f`.

At 02:14:21 UTC Astra extracted the entry-point text directly to memory from
that archive and passed it unchanged to the repository's
`QuickJsExtensionSandbox.activate`. The diagnostic used an explicitly
unregistered fixture with all host calls denied. It made zero broker calls,
registered and installed nothing, and wrote no production state. Activation
was refused with `extension_code_failed`, message **Extension package imports
are not allowed.** This is an actual realm compatibility check, not a complete
installed lifecycle or successful invocation test.

The package imports Node HTTPS, Node crypto, and another module. The actual host
denies imports and ambient Node access. Source inspection also shows a named
`invoke` export where the host requires a default function, and operation IDs
inside `operation_contract_versions` where the supported contract version is
`1`. These additional mismatches are source findings; activation stopped at
the import failure. The canonical executable digest is
`sha256:c19d85b85ae4b4d659017e5735f66ed30aac46d295a6f484863bb4a0c811b119`,
which is distinct from an archive checksum.

The Builder retained logs reporting seven unit tests and one real Picsum
network test under Node in an extracted directory. This evidence demonstrates
that test environment, not Floe host compatibility. ADR-0002 also states that
network/filesystem calls fail closed until canonical brokers are connected;
the current Bus supplies unavailable brokers for those calls. Declaring a
network permission cannot make that broker available.

The checked workspace substrate-build reference matches the current guidance
about isolated execution. Its presence alone did not prevent the incompatible
package. Do not attribute this result to an outdated installed reference.

Diagnostic source and result are retained under
`C:/Development/_temp/floe-image-service-extension-evidence-20260907/` as
`verify-host-compatibility.mts` and `host-compatibility.json`. The existing
`attempt.mjs observe` and `observe.mjs` retain preservation and turn evidence.

## Next proving boundary

The smallest observed need is for an actor to establish a package's actual
execution contract and test its compatibility before describing preparation as
verified. Start with actor behaviour and discoverable existing contracts.
Determine what cannot be discovered or tested through supported capabilities
before adding machinery. Keep package source independent of Floe core.

Evidence handoff also caused repeated work: the first returned result had text
and an exact result Event/Context reference but no attachment IDs in its text.
Floe requested another Builder turn; the Builder then requested the existing
release steward to recover saved references. Diagnose accessible result and
Artefact discovery before changing request semantics or broadening authority.

Success requires the real Floe attempt to produce host-compatible source,
readable immutable evidence, and an honestly supported next decision. No full
acceptance gate, installation, external-service capability, or efficient
successful outcome is established by this checkpoint.
