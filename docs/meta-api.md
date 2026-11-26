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

### Final M3 long-text checkpoint

On November 25, 2026, exactly one additional request ran in a clean macOS development instance with the existing development credential. Native consent showed only the long-text excerpt. Native preparation reported 16,352 submitted source bytes out of 25,709, with 16,352 prepared UTF-8 bytes. The existing provider configuration was retained. Meta returned HTTP 200 and status `completed` after 2,187 ms. Local validation passed. Usage was 3,093 input and 358 output tokens, with 0 cached input and 103 reasoning tokens. Estimated cost was $0.000488300. The provisional $0.002912000 reserve reconciled to zero, with zero unreconciled or ambiguous attempts. The native counter decreased from 20 to 19.

The result identified a synthetic Willow Observatory maintenance log excerpt, the telescope mirror cleaning purpose, and the repeated dome latch and humidity recorder instruction. It stated what the excerpt could establish and did not mention the unsubmitted synthetic tail. Its broad “no names” observation was imprecise since it correctly named Willow Observatory elsewhere. Both uncertainty notes were retained, with no semantic field normalization needed on this response. The expanded observation showed the full stored text, and the filename proposal was `willow-observatory-maintenance-log.txt`.

The strict wire schema still validates structure. Local resource bounds cap prose at 2,048 UTF-16 code units per field or item and each semantic list at 32 entries, in addition to the existing 256 KiB provider-response cap. Limit violations identify the affected field and reject the analysis rather than silently omit safety information. Accepted prose and lists remain available in the app. Compact previews expand to their full contents. Tag case and duplicate labels are normalized, and unsafe filename proposals are dropped. Native preparation metadata is displayed under Submission coverage and remains authoritative if the model makes a different claim.

### M3.1 synthetic original-file probes

The development-only experiment uses the existing native file plan, consent, single-use authorization, credentials, HTTP client, cancellation, and usage reconciliation. Exact byte matches against four bundled synthetic fixtures are required. The route accepts one fixture per review and at most seven experimental dispatches per process. Native consent identifies the representation, original byte count, potential embedded metadata and hidden content, provider, and possible charges. Original filenames, paths, and format hints in the prompt are omitted. The prepared-content workflow remains the default. The experiment retains the 2 MiB source, 3 MiB serialized request, and 256 KiB response limits and the established Ember generation settings.

| Probe                       | Original representation                          | Outcome                                                  | Request bytes / encoding | Round trip | Input / output | Cached / reasoning | Estimated USD |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------------- | -----------------------: | ---------: | -------------: | -----------------: | ------------: |
| A, 110,368-byte receipt PNG | Typed `input_file`, `image/png`, no filename     | HTTP 200, completed, locally valid                       |           149,065 / 6 ms |   3,085 ms |    3,123 / 502 |            0 / 152 |   0.000563300 |
| B, same PNG                 | Bare base64 `input_file`, no MIME or filename    | HTTP 200, completed, locally valid                       |           149,043 / 6 ms |   2,982 ms |    3,123 / 346 |             0 / 21 |   0.000485300 |
| C, same PNG                 | `application/octet-stream` data URL, no filename | HTTP 400, sanitized category: format or decoder rejected |           149,080 / 6 ms |     757 ms |     Unreported |         Unreported |  Unreconciled |
| D, 50,742-byte apple JPEG   | Bare base64 `input_file`, no MIME or filename    | HTTP 200, completed, locally valid                       |            69,539 / 4 ms |   2,946 ms |      770 / 378 |            0 / 112 |   0.000266000 |
| E, 238-byte Markdown        | Bare base64 `input_file`, no MIME or filename    | HTTP 400, sanitized category: format or decoder rejected |             2,203 / 0 ms |     763 ms |     Unreported |         Unreported |  Unreconciled |
| F, 784-byte one-page PDF    | Bare base64 `input_file`, no MIME or filename    | HTTP 200, completed, locally valid                       |             2,931 / 0 ms |   4,277 ms |    2,461 / 354 |            0 / 138 |   0.000423100 |
| G, same Markdown as E       | Typed `input_file`, `text/plain`, no filename    | HTTP 200, completed, locally valid                       |             2,226 / 0 ms |   2,605 ms |      374 / 298 |             0 / 70 |   0.000186400 |

Both valid receipt results identified a screenshot of the Cedar Market purchase receipt and read CM-0427, 2026-11-21 at 09:42, and $21.15. Both proposed `cedar-market-receipt.png`. Probe A flagged financial sensitivity. Probe B reported no sensitivity flags. The prepared baseline retained the same key facts and used 3,126 input and 328 output tokens in 1,906 ms for an estimated $0.000476600. The original receipt sent 110,368 file bytes instead of 142,122 prepared image bytes. Probe B demonstrates successful inference without caller-supplied MIME or filename for this PNG. The API did not return a detector format field or explain how it selected a decoder.

Known estimated spend through C was $0.001048600, from 6,246 input and 848 output tokens. The HTTP 400 provided no usable usage and retained one $0.002912 provisional reserve under normal admission rules. The generic MIME rejection is evidence about this endpoint and sample. It does not invalidate the successful bare-base64 path.

After explicit reauthorization, D and E ran through native consent in the same process. The JPEG identified the stylized apple-like illustration, its stem, beige background, and shadow. It proposed `red-fruit-illustration.jpg`. The prepared baseline proposed the more specific `red-apple-illustration.jpg` and had a 1,421 ms round trip and an estimated $0.000203800 cost. The Markdown rejection produced no structured output, filename, or token usage. Its previously verified prepared `input_text` path captured the sprint goal, completed work, and blocker.

After E, the next reservation would have required $0.010050600. The user approved raising the threshold to $0.02 in the same process. F sent the original PDF bytes without hints. Ember identified Fenglass Station, calibration record RQ-71, the February 18, 2027 inspection date, and both the blue triangle and orange square. It proposed `fenglass-station-calibration-rq-71.pdf`. G then isolated the Markdown compatibility question by adding only the `text/plain` data URL prefix to the same bytes from E. It correctly described the offline field-guide goal, completed map legend and twelve specimen cards, and the accessibility review blocker. It proposed `kestrel-demo-sprint.md`.

The session ended at seven of seven dispatches with $0.001924100 in known estimated spend. Successful responses reported 9,851 input and 1,878 output tokens, including 493 reasoning tokens and zero cached input. The two HTTP 400 reserves remained outstanding at $0.005824000, with zero ambiguous attempts. The experiment used no automatic retries or accounting resets.

The financial flag difference is present in the model results after validation. The prompt asks for a concise semantic description and secret omission, and the schema permits either a financial flag or an empty array. The validator deduplicates reported categories. It does not infer a category from the receipt contents. Both responses recognized the same purchase and total. This pair cannot isolate an effect of the wire representation from normal generation variability. Use sensitivity flags as advisory output. Native consent, metadata disclosure, and preparation policy apply regardless of the returned flags.

Prefer bare original bytes for supported PNG, JPEG, and bounded PDF when native policy and explicit consent permit original transmission. The experiment only admits exact synthetic fixtures. The tested binary files worked without format hints on the wire. The app still needs local evidence where admission policy, disclosure, or limits depend on file type. Bare Markdown failed and typed `text/plain` passed. Keep bounded UTF-8 `input_text` as the simple production text path, with no format-specific parsing required for analysis. Retain image preparation for metadata removal or size limits. Typed inline PDF was unnecessary for the experiment. Larger, scanned, encrypted, and malformed PDF behavior remains unverified.

The development suite passed 24 Rust and 29 TypeScript tests, type checking, lint, formatting, and the frontend build before the live continuation. The native release check passed with the existing unused development-only dotenv dependency warning.

### M3.1 production file requests

Production uses `input_file.file_data` with bare base64 for approved original PNG, JPEG, and bounded PDF. It sends no filename, MIME declaration, or format hint alongside these bytes. Prepared images continue to use `input_image`. Bounded UTF-8 text continues to use `input_text`, with optional BOM removal, newline normalization, and excerpt coverage. Text admission uses the submitted bytes rather than requiring a listed suffix or locally parsing JSON. The versioned output contract, minimal reasoning, 1,024 output token limit, stateless options, fixed endpoint, response size bound, and retry policy are unchanged.

Original images are limited to 2 MiB. PDFs are limited to 256 KiB and a supported classic cross-reference structure with up to 64 entries. Embedded metadata and hidden content may be included, as disclosed by native consent. PDF page count is not established locally. Full byte submission does not establish complete provider-side coverage. PDF requests retain a $0.006 provisional reservation until usage can be reconciled, and the overall session threshold remains user controlled. The documented synthetic experiment totals are carried forward as historical evidence. The production change adds no live requests.

### Provider panel connection health

The provider panel uses the existing native credential status and diagnostic session. The refresh icon first checks the effective credential locally. A live check requires explicit confirmation because it sends the built-in text example and can consume one dispatch and API credits. A successful response marks the last check healthy. Saving or removing a key clears that result. The eye icon toggles only the new or replacement key currently being typed. The vault and development environment never return stored secrets to the renderer.
