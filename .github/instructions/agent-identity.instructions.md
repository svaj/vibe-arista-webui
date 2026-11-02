---
description: "Use before a repository agent runs Git, signs commits, pushes branches, or authenticates GitHub CLI, MCP, or API requests; select the role's Infisical-backed identity."
---

# Agent Git and GitHub identity

Use the active agent profile's credential role for all authenticated Git and
GitHub operations, including issue reads, comments, handoffs, reviews, and PRs.
Never use the developer's account, a parent's inherited credentials, or another
role as an implicit fallback. Authentication does not authorize an operation:
retain the profile's review-only, approval, and infrastructure boundaries.
This rule does not define ticket assignment or QA workflow.

## Role mapping

| Agent profile | Credential role | Status |
| --- | --- | --- |
| Arista Expert | `team-lead` | Dedicated |
| CI/CD Engineer | `cicd` | Dedicated |
| Frontend Engineer | `frontend-engineer` | Dedicated |
| PR Reviewer | `pr-review` | Dedicated |
| Team Lead | `team-lead` | Dedicated |
| Documentation Maintainer | `team-lead` | Interim, explicitly approved |

Use the role declared in the agent file, not its filename as a secret prefix.
If there is no active role, or its mapping is missing or conflicting, ask before
authenticating. Delegates must establish their own mapped identity rather than
reuse the caller's environment, keyring, token, or SSH agent.

## Infisical source

- Organization: `b072b869-2383-43e5-b827-8d02c26e41a7`.
- Project: `devhax-agents` (`562e46e1-4339-451a-bf40-74944216d6bf`).
- Use an already authorized Infisical CLI session or machine identity. Do not
  embed its bootstrap credentials in commands, repository files, or agent text.

The verified locations are below. Environment values are slugs: `prod` is the
environment named `production`. Copies to other environments do not change this
selection automatically; update this rule explicitly rather than probing for a
working credential in another environment.

| Material | Environment | Folder | Secret name |
| --- | --- | --- | --- |
| GPG public key | `prod` | `/gpg` | `<role>-gpg-public` |
| GPG private key | `prod` | `/gpg` | `<role>-gpg-private` |
| SSH public key | `prod` | `/ssh` | `<role>-ssh-public` |
| SSH private key | `prod` | `/ssh` | `<role>-ssh-private` |
| GitHub PAT | `dev` | `/pat` | `<role>-github-PAT` |

Fetch only the named secrets needed for the operation with
`infisical secrets get <secret-name>`, explicitly supplying `--org`,
`--projectId`, `--env`, and `--path` from this section. Use `--expand=false`,
`--include-imports=false`, and `--secret-overriding=false` to avoid expansion,
imports, or personal overrides changing the selected identity.

For private keys, redirect `--plain --silent` output directly into protected
temporary files; for a PAT, capture it directly into the process environment.
Never run these retrievals with uncaptured output. Do not export whole folders,
print secret values, enable shell tracing, or put credentials in command-line
arguments, remote URLs, diffs, logs, artifacts, or conversation/tool inputs.
Secret names and non-secret validation results are sufficient for reporting.

## Isolated setup and identity checks

1. Use a fresh, role-specific temporary directory outside the checkout with
   permissions `0700`, key files `0600`, and `umask 077`. When signing is needed,
   keep an isolated `GNUPGHOME` there and import only this role's GPG
   public/private pair. Do not modify the user's keyring, SSH configuration,
   GitHub login store, or global or shared repository Git configuration.
2. Before signing or SSH use, verify that the required public/private pair
   matches. For signing, select the full fingerprint of a usable signing key
   from the assigned GPG identity, never a short key ID.
   Derive the Git author and committer name/email from its usable UID. If UIDs
   are ambiguous, the key is expired/revoked, or the email is not
   `<user>@devhax.fyi`, stop and ask for corrected identity material. Do not
   invent an email or rewrite an inconsistent UID.
3. Load only the role PAT into `GH_TOKEN`, with `GH_HOST=github.com`, in the
   dedicated child process that runs `gh`. Remove conflicting inherited
   GitHub tokens in that process. Verify the account with `gh api user` before
   other requests and retain the returned login for SSH verification. For
   commits, also confirm that the GPG public key is registered with that GitHub
   account and the UID email is verified for it. If that cannot be established,
   report the blocker; do not upload keys or change account settings implicitly.
4. Verify the selected SSH key authenticates as that same GitHub login before
   network Git operations. Use a key-specific SSH invocation, for example
   `ssh -F /dev/null -i "$ssh_private_key" -o IdentitiesOnly=yes
   -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes`.
   Use trusted known-host entries; never disable host verification. GitHub's
   `ssh -T git@github.com`, with those same key-specific options, normally exits
   `1` on successful authentication: check the authenticated greeting/account,
   not just the exit code.

An API-only task needs only the role PAT; do not fetch private signing or SSH
keys for an issue query or other operation that does not use them.

If a key needs a passphrase or a trusted host key is missing, use the approved
secure provisioning mechanism or ask for help; do not bypass the check. Missing
tools, secrets, permissions, identity mismatches, or authentication failures
must block the affected operation, not cause fallback to ambient credentials.

## Commits and pushes

- For commits the agent produces, set **both author and committer** to the
  validated GPG UID. Use command-scoped Git configuration (`git -c ...`) and
  process-scoped `GIT_AUTHOR_*`/`GIT_COMMITTER_*` variables, overriding any
  inherited identity. Set `user.name`, `user.email`, `user.useConfigOnly=true`,
  `gpg.format=openpgp`, `gpg.program` to the trusted GPG executable,
  `user.signingKey` to the selected full fingerprint, and `commit.gpgSign=true`.
  Use `git commit -S`; never use `--no-gpg-sign` or silently retry unsigned.
- Keep the required Copilot co-author trailer; it does not replace the role's
  author, committer, or cryptographic signature. Preserve existing authorship
  when replaying another contributor's commit unless explicitly authorized to
  change it.
- Before pushing, verify the signatures and author/committer metadata of every
  commit this agent produced for the handoff, using `git verify-commit` and
  `git log --format=fuller --show-signature` in the isolated GPG context.
  Do not report signing success without verification.
- Push through an explicit SSH URL for the intended repository, such as
  `git@github.com:devhax-heavy-industries/services.git`, using the role-specific
  SSH command above via command-scoped `core.sshCommand`. Remove inherited
  `GIT_SSH`, `GIT_SSH_COMMAND`, or Git configuration overrides that could
  substitute another transport or identity. Check for URL rewrites and reject
  transport changes. Never fall back to HTTPS/PAT pushes, change a shared
  remote, disable signing, force-push, or create a commit just to test identity.

## GitHub CLI, API, and MCP

- Prefer `gh` with the isolated role `GH_TOKEN`, including for issue queries,
  comments, reviews, and PR operations. Do not use `gh auth login`,
  `gh auth switch`, or `gh auth setup-git` to replace shared credentials.
- Direct GitHub API calls must use that same PAT through a credential-aware
  client that reads it from the isolated environment, not literal request
  arguments or an authenticated URL. Do not expose it through `curl -H`
  command-line expansion or shell tracing.
- Use GitHub MCP only when its server/session was explicitly provisioned with
  this role's PAT and its authenticated account has been verified. A terminal
  `export GH_TOKEN=...` cannot reauthenticate an already-running MCP server.
  Never paste a PAT into MCP arguments or assume a connection uses the role
  merely because it can access the repository. If per-role MCP authentication
  is unavailable, use role-authenticated `gh` instead or report the blocker.
- Do not use remote file-write APIs as a substitute for local GPG-signed Git
  commits when producing repository changes under this rule.

## Cleanup and handoff

Keep credentials scoped to a single role/operation; do not leave a
credential-bearing shell or MCP process running for later unrelated tasks.
Arrange cleanup on both success and failure: stop only the GPG/SSH/MCP helpers
created for that isolated context, remove only its known temporary files and
directory, and discard tokens from the process environment. Never stop shared
agents or delete a shared keyring.

Report the role, authenticated login, signed commit IDs, target branch/PR, and
validation results as applicable, without credential values. Handoffs pass
issue/PR references and evidence, not secrets. Recipients use their own mapped
identity. Unauthenticated local inspection can continue when credentials are
unavailable; authenticated actions must wait.

## Follow-up

- [ ] Provision a dedicated Documentation Maintainer identity, or explicitly
  approve and define a GitHub App/bot authentication and signing policy.
  Replace its interim `team-lead` mapping in this rule and the agent profile.
- The three Terraform-focused profiles temporarily share `cicd`; do not
  describe those commits as independently attributed per Terraform role.
