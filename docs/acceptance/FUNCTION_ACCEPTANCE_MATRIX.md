# Function Acceptance Matrix (Production Closure 2)

Current state only. States per [ACCEPTANCE_STATES.md](./ACCEPTANCE_STATES.md).

| Feature                                                | State             | Evidence                                                              |
| ------------------------------------------------------ | ----------------- | --------------------------------------------------------------------- |
| AI create research figure (mechanism, native editable) | PASS_INTEGRATION  | `create-research-figure.test.ts`                                      |
| AI edit research figure (weak-model EditPlan)          | PASS_INTEGRATION  | `weak-model-edit-plan.test.ts`                                        |
| Statement expression (no cards/lines)                  | PASS_INTEGRATION  | `create-research-figure.test.ts`                                      |
| Timeline / matrix / moderation semantics               | PASS_UNIT         | `figure-plan-protocol-roundtrip.test.ts`                              |
| Quantitative claim without provenance is rejected      | PASS_UNIT         | `contract-provenance-audit.test.ts`                                   |
| Forbidden claims never reach canvas                    | PASS_UNIT         | `contract-provenance-audit.test.ts`                                   |
| Suppressed/spatial relations recoverable after reopen  | PASS_INTEGRATION  | `research-metadata-roundtrip.test.ts`                                 |
| Connector follows node move                            | PASS_INTEGRATION  | `research-group-editability.test.ts`                                  |
| Atomic rollback on post-write failure                  | PASS_INTEGRATION  | `post-write-fail-closed.test.ts`                                      |
| Save → reopen → edit → export chain                    | PASS_INTEGRATION  | `research-export-parity.test.ts`, `research-figure-roundtrip.test.ts` |
| Real Electron E2E (create/edit/save/reopen/export)     | pending (E2E job) | `e2e/research-figure*.spec.ts`                                        |
| Real UI acceptance (Computer Use scenarios)            | pending           | closure report                                                        |
