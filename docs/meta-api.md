# Meta Model API reference

This reference describes the M2 diagnostics implementation. The wire contract and rates below are based on Meta documentation checked on November 24, 2026. Offline fixtures cover encoding, parsing, cost calculations and native request policy. A macOS development smoke test verified one live response per modality. Repeated output quality, cache hits, and billing reconciliation remain unverified.

## Request contract

- Send a bearer-authenticated JSON POST to `https://api.meta.ai/v1/responses` using `muse-ember-1.0`. Use developer-level `instructions` and one `user` message in `input`. Text uses an `input_text` part. The image diagnostic adds an `input_image` part whose `image_url` is a PNG base64 data URL. Native policy accepts the two bundled examples, their versioned instructions and their schema. It rejects arbitrary input, remote URLs, history and tools.
- Request strict JSON Schema via `text.format` with `type: "json_schema"`, a stable name and `strict: true`. Use a shallow object with all properties required and `additionalProperties: false`. The adapter derives the schema from Zod and tests it against the native policy. Zod also checks tighter field and list limits on the final answer.
- Set `reasoning.effort` to `minimal` and `max_output_tokens` to 512. The budget includes reasoning and visible output. Keep `stream`, `background` and `store` false. Repeated live requests are needed to assess output reliability at this budget.
- Keep instructions and the schema stable across requests. Meta can automatically cache matching prefixes. Place variable input in the user message and keep requests stateless. Explicit routing keys and extended retention are outside M2. Consider the Responses input-token counting endpoint when larger inputs need preflight checks. Image bytes alone do not establish token usage.

## Response and usage

Read the raw `output` array after checking response status. Reasoning and commentary are not result text. Read assistant `output_text` parts, distinguish refusal and token exhaustion, and validate the parsed JSON before displaying it. Failed and incomplete responses can still provide valid usage. Unrecognized output, malformed JSON and schema failures return distinct errors.

The dated USD rates per million tokens are $0.10 input, $0.004 cached input and $0.50 output. Above 200,000 input tokens, the full request uses $0.30, $0.012 and $1.50 respectively. Cached input is a subset of input and reasoning is a subset of output. When only cache detail is missing, price input at the uncached rate and label it an upper estimate. Unknown usage remains unreconciled. The $0.01 estimated session threshold can be crossed by a request already dispatched. Rust separately limits dispatch to ten attempts per process.

## Transport and privacy

The pooled native HTTPS client uses a fixed endpoint, TLS verification, no redirects or proxies, 10-second connect and 45-second total timeouts, and bounded request and response bodies. There are no automatic retries. Rate-limited responses preserve bounded retry delays when recognized. Cancellation and transport timeouts can leave provider processing and charges unresolved.

The OS vault persists the key. The webview can submit a key for saving, remove it, or check presence. Native code attaches the stored key to requests. Diagnostics are in memory and exclude raw inputs, credentials and provider error bodies. Each explicit send submits a bundled example. The `store: false` setting requests response storage to be disabled. Provider retention is governed separately by Meta.

## Local credentials and verification

Run `npm run tauri -- dev` from the repository. Native Rust checks a nonempty `META_API_KEY` in the process environment, then checks the single repository-root `.env`, then checks the OS vault. If the vault is empty the UI requests a key. Copy `.env.example` to `.env` if you need a local file. The file is ignored by Git and read at runtime. A blank value falls through to the next source. An authentication failure returns to the UI with no retry or credential substitution. Vite does not load dotenv files.

The renderer receives only the credential source (`environment`, `secureStore` or `missing`) and diagnostic session metadata. An active environment credential takes precedence over the vault and hides the key-entry and removal controls. Packaged builds, including debug bundles, use only the OS vault. A local arm64 debug bundle displayed the normal key-entry workflow with both development credential sources present.

On November 24, 2026, one synthetic text request and one synthetic image request returned schema-valid results using the default reasoning and output budgets. Reported input/output tokens were 177/131 for text and 171/160 for image. Reported reasoning tokens were 78 and 101, with zero cache hits. The combined estimate was $0.000180300, with zero unreconciled attempts after both responses.

## Official references

- [Muse Ember](https://dev.meta.ai/docs/muse-ember)
- [Create response](https://dev.meta.ai/docs/api-reference/responses/create-response)
- [Responses schemas](https://dev.meta.ai/docs/api-reference/responses/schemas)
- [Responses protocol](https://dev.meta.ai/docs/protocols/responses)
- [Structured output](https://dev.meta.ai/docs/structured-output)
- [Image understanding](https://dev.meta.ai/docs/image-understanding)
- [Prompt caching](https://dev.meta.ai/docs/prompt-caching)
- [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits)

## M3 file analysis

The approved-file command uses the same fixed Responses endpoint and native credential resolver. Its request is built in Rust from native-held content and the versioned `fixtures/file-semantic-v1.json` configuration. A compatibility test compares the fixture schema to the TypeScript Zod wire contract. The native command accepts opaque session, request, plan, and file IDs. It sends an inline PNG or JPEG or normalized UTF-8 text with a short coverage instruction. It omits original filenames, paths, and directory metadata.

`file_semantic_v1` uses explicit minimal reasoning, up to 1,024 output tokens, strict JSON Schema, and stateless requests with `store`, `stream`, and `background` disabled. File requests are limited to 3 MiB serialized and responses to 256 KiB. The existing synthetic command retains its original allowlist and request bounds. Both share fixed-endpoint TLS transport and no automatic retries.

The native per-process dispatch limit now defaults to 20 and survives reload and credential changes. HTTP 429 sets a shared cooldown using the bounded retry delay when available or 30 seconds otherwise. The file workflow tracks confirmed local failures, dispatched attempts with missing usage, ambiguous IPC outcomes and reconciled costs separately. The initial per-request reserve is a local allowance rather than a measured provider cost. Meta retention is governed independently of `store: false`.

No paid requests were made during M3 implementation. Live analysis and billing reconciliation are pending.

### Targeted macOS live verification

On November 24, 2026, the development app used its existing environment credential and dispatched five synthetic samples through the native consent workflow. The request configuration above was retained. All five returned HTTP 200 with provider status `completed` and valid usage. All five failed the local semantic validator in the build that sent them. The measurements below are app round-trip times and estimates based on reported usage.

| Fixture                | Source → prepared bytes | Image dimensions or source coverage | Round trip | Input / output | Cached / reasoning | Estimated USD |
| ---------------------- | ----------------------: | ----------------------------------- | ---------: | -------------: | -----------------: | ------------: |
| Receipt PNG            |       110,368 → 142,122 | 1800 × 1200, full frame             |   1,725 ms |    3,126 / 305 |              0 / 6 |   0.000465100 |
| Long text              |         25,709 → 16,352 | 16,352 of 25,709 bytes              |   1,292 ms |    3,093 / 274 |             0 / 28 |   0.000446300 |
| Procedural apple JPEG  |         50,742 → 42,724 | 720 × 480, full frame               |   1,148 ms |      773 / 216 |             0 / 27 |   0.000185300 |
| Markdown project notes |               238 → 238 | Full text                           |   1,897 ms |      377 / 368 |            0 / 144 |   0.000221700 |
| Inventory CSV          |               108 → 108 | Full text                           |   1,559 ms |      375 / 352 |            0 / 166 |   0.000213500 |

The five dispatches totaled 7,744 input tokens, 1,515 output tokens, 371 reasoning tokens, and an estimated $0.001531900. All were reconciled locally. The JPEG exceeded the app's tag count, the Markdown response exceeded summary and observation bounds, and the CSV response exceeded observation and entity bounds. Validation field diagnostics were unavailable for the first two attempts. The app now normalizes these fields for bounded display while preserving independent type validation and the wire contract. The final normalization was checked offline. The five-attempt run did not verify semantic quality, screenshot readability, or provider billing.

### M3 staged live retest

On November 24, 2026, the macOS development app reused the same fixtures and existing development credential. After a clean restart, the visible native Cancel action left the process counter at 20 and the provisional reserve at zero. The receipt and Markdown passed first, followed by JPEG, long text, and CSV. All five returned HTTP 200 with provider status `completed`. Four passed local validation. The request, prompt, wire schema, and token limit were unchanged.

| Fixture       | Source → prepared bytes and coverage      | Round trip (previous) | Input / output (previous output) | Cached / reasoning | Local result and normalized fields      | Estimated USD |
| ------------- | ----------------------------------------- | --------------------: | -------------------------------: | -----------------: | --------------------------------------- | ------------: |
| Receipt PNG   | 110,368 → 142,122, 1800 × 1200 full frame |      1,906 ms (1,725) |                3,126 / 328 (305) |             0 / 20 | Passed. Observations and entities       |   0.000476600 |
| Markdown      | 238 → 238, full text                      |      1,566 ms (1,897) |                  377 / 412 (368) |            0 / 160 | Passed. Summary, observations, and tags |   0.000243700 |
| Apple JPEG    | 50,742 → 42,724, 720 × 480 full frame     |      1,421 ms (1,148) |                  773 / 253 (216) |             0 / 72 | Passed. Observations                    |   0.000203800 |
| Long text     | 25,709 → 16,352, excerpt                  |        863 ms (1,292) |                3,093 / 261 (274) |             0 / 58 | Rejected by the local uncertainty limit |   0.000439800 |
| Inventory CSV | 108 → 108, full text                      |      1,708 ms (1,559) |                  375 / 309 (352) |            0 / 112 | Passed. Observations and entities       |   0.000192000 |

The native counter finished at 15. All five attempts reconciled locally, with zero outstanding reserves or ambiguous attempts. The total was 7,744 input, 1,563 output and 422 reasoning tokens, with no cached input. Estimated cost was $0.001555900, up $0.000024000 from the preceding run. Input was identical and output increased by 48 tokens, including 51 more reasoning tokens. No request exhausted its output budget.

The receipt was correctly classified as a screenshot of a purchase receipt. The response read Cedar Market, order CM-0427, the date and time, and the $21.15 total. It retained a financial sensitivity flag. The Markdown result grounded the sprint goal, completed work, and accessibility blocker. Its bounded summary ended before the full next step and the model called the complete short note an excerpt. The JPEG correctly recognized a stylized apple illustration and qualified its inferred purpose. The CSV identified an inventory list, matched the header and row count, and reported accurate visible quantities and costs. Its shortened observation omitted the final SKU's item details. All four proposals retained their original extensions.

The long-text manifest accurately marked a 16,352-byte excerpt. The response failed with `uncertainty: too_big`, with sanitized diagnostics identifying the field but leaving the exact returned text and sublimit unknown. Local validation now preserves complete uncertainty notes within the aggregate response and field bounds, deduplicates sensitivity labels without suppressing categories, and drops oversized filename proposals. Tests cover valid long caveats and malformed structures. The live dispatch limit was reached before this correction, so the long-text result and its semantic grounding are still unverified.
