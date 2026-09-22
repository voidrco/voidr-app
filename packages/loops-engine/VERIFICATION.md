# Structured verification v1

A journey keeps its readable `steps` and adds optional `verifications`, aligned by step index (`null` for actions). In platform plans the same contract is stored as `steps[].verification`. New generated assertions require it; existing plans remain valid without migration.

The wire contract lives in `capture-contracts/src/verification.ts`, mirrored in `voidr-service/src/modules/loop-test/ai-tester/verification-contract.ts`. Changes to v1 must remain compatible in both repositories.

Each condition has a semantic target, an operator, an explicit page/region scope, and required evidence. Playwright searches all elements of the supplied role, or all elements when no role is supplied. Names guide semantic identity without excluding renamed but equivalent controls from the candidate universe. A selector is an auxiliary identity hint only: it never restricts the candidate universe or overrides semantic identity. `frameUrl` restricts the scope to observed frames with that exact URL.

The root refers to a condition or an `all`/`any` group; groups refer to condition/group IDs. IDs must be unique; references, reachability, cycles and depth are validated. Every referenced leaf is evaluated and recorded, including leaves in non-winning `any` branches.

| Group | Passed | Failed | Unverified |
| --- | --- | --- | --- |
| all | Every child passed | At least one child failed | Otherwise |
| any | At least one child passed | Every child failed | Otherwise |

## Logout UI example

```json
{
  "version": 1,
  "root": "logout_ui",
  "groups": [{ "id": "logout_ui", "operator": "all", "children": ["login", "email", "password", "enter", "no_exit"] }],
  "conditions": [
    { "id": "login", "target": { "description": "Formulário de login do analista" }, "operator": "visible", "scope": { "kind": "page" }, "evidence": { "completeness": "target", "transition": false } },
    { "id": "email", "target": { "description": "Campo de e-mail do login", "name": "E-mail do analista" }, "operator": "visible", "scope": { "kind": "page" }, "evidence": { "completeness": "target", "transition": false } },
    { "id": "password", "target": { "description": "Campo de senha do login", "name": "Senha" }, "operator": "visible", "scope": { "kind": "page" }, "evidence": { "completeness": "target", "transition": false } },
    { "id": "enter", "target": { "description": "Botão de entrada do login", "role": "button", "name": "Entrar" }, "operator": "visible", "scope": { "kind": "page" }, "evidence": { "completeness": "target", "transition": false } },
    { "id": "no_exit", "target": { "description": "Botão de encerramento da sessão", "role": "button", "name": "Sair" }, "operator": "not_visible", "scope": { "kind": "page" }, "evidence": { "completeness": "scope", "transition": false } }
  ]
}
```

This example proves only login UI state. Backend session invalidation and protected-route denial require additional explicit conditions and observed access/response evidence. The engine does not invent a protected route or perform extra mutations during assertions.

## Evidence and decisions

- Playwright reads visibility (layout visibility, including elements outside the viewport), DOM presence, exact field/text values, DOM counts, URLs and enabled state. `not_visible` allows hidden DOM matches; `absent` does not. Count includes hidden matches. A scalar value/state assertion needs one unambiguous target.
- Jev identifies semantic candidates with match/none/uncertain, selects scopes with a no-match option, and independently judges evidence sufficiency, satisfaction and contradiction per semantic condition. Thresholds are conservative policy constants (0.8), not a claim of calibrated accuracy for this product.
- Unreadable frames, busy/partial scopes, known virtualization and collection limits prevent proving absence/count. Region scopes containing frames are conservatively incomplete until nested-frame coverage is implemented. Open shadow DOM is searched by Playwright; closed shadow internals are unavailable.
- The first collection is bounded to 120 candidates, recovery expands to 240. Unchanged condition/evidence/action fingerprints reuse the prior judgment. The journey keeps its existing maximum of three recoveries and stops earlier when the expanded observation brings no new information.
- Each condition rereads its evidence after judgment. A page fingerprint also guards composition across conditions. Changed evidence yields `unverified`, not a fabricated pass or failure.
- Completed and uncertain action records retain observed before/after state and entered references. Jev receives the latest eight action records, explicitly marked as partial when earlier records are omitted. Recorded instructions are not execution evidence. Password comparisons occur locally; secret values are redacted before model requests, events and persisted results.
- `result.json` contains the complete condition, observed evidence, judgments, fingerprints and reason per leaf. Platform result updates carry compact condition summaries and fingerprints; the full artifact remains the diagnostic source.

Legacy text-only assertions run as one semantic condition with complete-scope evidence. Their full wording remains authoritative, with no quote extraction or global literal predicate. They gain no invented structured decomposition and are not automatically rewritten in the database.

Implementation follows the [TypeSafe building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one): code owns exact facts, composition and recovery; Jev handles narrow semantic judgments.

No automated tests, builds, typechecks or services were run for this change. Runtime behavior, threshold calibration and regression coverage remain pending explicit validation authorization. Existing assertion fixtures target the previous assertion interface and were not edited.
