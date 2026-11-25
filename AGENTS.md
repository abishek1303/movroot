# Working on Movroot

Movroot is a desktop-first file organizer. The desktop targets are macOS and Windows. Build with React, TypeScript, Vite, Zod, npm, and Tauri 2 with Rust. Use Kotlin or Swift only for future native mobile capabilities. SQLite and Muse Ember are planned.

- Keep views in React and product workflows in portable TypeScript. Use Zod for TypeScript runtime contracts. Keep Node, UI, IPC, filesystem APIs, and concrete adapters outside application and domain logic.
- Put adapter interfaces beside their consumers. Wire implementations in `src/app/`. Feature views call use cases rather than native commands or infrastructure. Add shared modules when there is demonstrated reuse.
- Treat the webview, file content, and provider output as untrusted at native boundaries. Rust independently enforces access, scope, resource identity, and operation safety. User approval and Zod validation are inputs, not native authorization.
- Keep commands and permissions narrow. Use opaque file IDs and explicit, revocable capabilities. Keep credentials and raw file data out of frontend bundles, source control, and routine logs. Obtain consent before sending file data to a provider.
- Use the pinned toolchains and commit both lockfiles with dependency changes. Use Context7 for library and tool documentation, and verify platform and version requirements against official sources. Keep changes scoped and review observable differences on macOS and Windows.
- Run the checks in `ARCHITECTURE.md`. Prefer portable unit tests with fakes and native tests for OS behavior. Require durable recovery records before introducing filesystem mutation.
- Preserve established decisions unless explicitly revisited. Update `ARCHITECTURE.md` with material decisions and the actual verification status.

Consult [the Meta API implementation reference](docs/meta-api.md) before changing the Muse Ember integration.
