# Distribution

Where this package is listed, and how to list it. Kept in the repo because the
listings have to be re-run on each release, and a runbook that lives in someone's
head is a runbook that stops happening.

## Why this file exists

As of 2026-09-06 the package had 242 npm downloads on its publish day and 0 after,
0 GitHub stars, and one unreviewed upstream PR. The code was not the bottleneck.
Nothing pointed at it. These are the channels that point at it without needing
anyone else's approval.

## Channel 1 — the official MCP registry (highest signal, do this first)

The registry is the index Claude, Cursor, and other MCP clients resolve against.
It verifies that the published npm package really belongs to the claimed name, via
an `mcpName` field in `package.json`. That field is already set to
`io.github.expertvagabond/coldstar-agent-signer` and must match `name` in
`server.json` exactly.

Publish npm **first** — the registry only stores metadata and will reject a name
whose package does not yet carry the matching `mcpName`.

```bash
# 1. npm must already have the version (see Releasing, below)
npm view coldstar-agent-signer version   # must print 0.4.1

# 2. install the publisher CLI
brew install mcp-publisher

# 3. authenticate — this is what grants the io.github.expertvagabond/* namespace
mcp-publisher login github

# 4. validate before publishing; this catches a name/mcpName mismatch
mcp-publisher validate

# 5. publish
mcp-publisher publish
```

On each subsequent release, bump `version` in **both** `package.json` and
`server.json`, publish to npm, then re-run `mcp-publisher publish`.

### A note on the namespace

`io.github.expertvagabond/*` is granted by GitHub authentication and works today
with no extra setup. The registry also supports domain-based namespaces, which
would allow `dev.coldstar/agent-signer` — better branding, and more consistent
with a product whose whole argument is that you can verify its claims. That
requires a DNS TXT record on `coldstar.dev` and a signing key. It is worth doing,
but it is a rename: the registry entry is keyed by name, so switching later means
publishing a second entry and deprecating the first. Ship under `io.github` now;
revisit if the listing gets traction.

## Channel 2 — the one-line install, in the README

Most people will never read `server.json`. They copy a command. This is it:

```bash
claude mcp add coldstar -- npx -y -p coldstar-agent-signer coldstar-signer-mcp
```

with the environment the server needs:

```bash
claude mcp add coldstar \
  -e COLDSTAR_POLICY=/path/to/envelope.json \
  -e COLDSTAR_SESSION_KEYFILE=/path/to/session.json \
  -e COLDSTAR_ROOT_PUBKEY=<root pubkey> \
  -e COLDSTAR_REQUIRE_ENVELOPE=1 \
  -- npx -y -p coldstar-agent-signer coldstar-signer-mcp
```

The second form is the one to put in front of people. The first form runs, but it
runs without a pinned root, which is the configuration the threat model warns
about.

## Channel 3 — awesome-mcp-servers

A PR to `punkpeye/awesome-mcp-servers`. One line, in the Finance / Crypto section,
matching the file's existing format:

```markdown
- [ExpertVagabond/coldstar-agent-signer](https://github.com/ExpertVagabond/coldstar-agent-signer) 📇 ☁️ - Policy-gated Solana signing for AI agents: in-policy transactions auto-sign, out-of-policy transactions escalate to air-gapped human approval, disallowed ones never produce a signature.
```

Check the legend at the top of that README before opening the PR — the emoji
markers encode language and scope, and they change.

## Channel 4 — Smithery

`smithery.ai` lists MCP servers and will build from the repo. Lower signal than the
official registry and it wants its own config file, so it is worth doing only after
channels 1–3 are done.

## Releasing (this is what produces the provenance)

Do **not** `npm publish` from a laptop. v0.4.0 was published that way and therefore
carries no provenance attestation — for a package whose pitch is "the code you can
read is the code you installed," that is a real gap and it is why `release.yml`
exists.

```bash
# preconditions: NPM_TOKEN is set as a repo secret, dist/ is rebuilt and committed
npm run build && git add dist && git commit -m "..."   # only if src changed
git tag v0.4.1
git push origin main --tags
```

The workflow gates on typecheck, tests, build, `dist/` matching `src/`, and the tag
matching `package.json`, then publishes with `--provenance`. Verify afterwards:

```bash
npm view coldstar-agent-signer@0.4.1 dist.attestations
```

An empty result means it published without provenance and the release should be
redone rather than explained away.
