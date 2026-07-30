# Setup Guide

From-zero bring-up for a Learn Shell code snapshot — no shared git history required, just this tree on your machine.

This assumes you're comfortable with a terminal. Everything below is a real command copy-pasted from this repo's own config (`package.json`, `docker-compose.yml`, `.env.example`) — nothing invented.

新手上路（中文教程）：装完之后怎么用——冷启动排坑、推荐学习路径、agent 上岗须知——见 [docs/TUTORIAL.md](./docs/TUTORIAL.md)。

---

## 0. ⚠️ Security notice — read this first

**v1's trust model is single-machine.** The server binds `127.0.0.1` by default (see `HOST` in step 5) — your teaching data is visible only to processes on the same machine. There's no account system because this is local-first by design, not an oversight: no per-agent credential, no scoped token, no audit trail beyond "actor: mcp".

**Cross-device deployment (`HOST=0.0.0.0`) is an explicit opt-in, not the default.** Setting it means you trust every device on that network. Real authentication is on the roadmap for the multi-device case — until it lands:

**Practical rule: leave `HOST` at its default (localhost-only), or at most opt in on a trusted home LAN you control. Never put port `3000` (or the MCP stdio bridge) on the public internet.** If you expose it, anyone who can reach it has full read/write access to your teaching data.

---

## 1. Prerequisites

- **Node.js ≥ 22** (`engines.node` in the root `package.json`)
- **pnpm 11.x** — the repo pins `packageManager: "pnpm@11.1.3"`. If you don't have pnpm:
  ```bash
  corepack enable
  corepack prepare pnpm@11.1.3 --activate
  ```
- **Docker** (Docker Desktop, or the Docker CLI + Compose plugin — `docker compose`, not the old standalone `docker-compose`)

---

## 2. Database — Postgres via Docker

From the repo root:

```bash
docker compose up -d
```

This starts one container (`docker-compose.yml`): Postgres 16 (alpine, pulled via a Docker-Hub mirror for GFW-friendliness — same image content as `postgres:16-alpine`), exposed on `5432`, with:

- `POSTGRES_DB=learn_shell`
- `POSTGRES_USER=learn_shell`
- `POSTGRES_PASSWORD=learn_shell_dev` (dev-only credential, matches the `DATABASE_URL` below — fine for local use, not meant to guard anything)

Data persists in a named Docker volume (`learn-shell-postgres-data`), so `docker compose down` (without `-v`) won't wipe your DB between restarts.

Connection string for the container above:

```
DATABASE_URL=postgresql://learn_shell:learn_shell_dev@localhost:5432/learn_shell
```

**`DATABASE_URL` has no default in the code — every database entrypoint refuses to start without it** (`apps/server/src/db/require-database-url.ts`). This is deliberate: a baked-in default would let "I thought I was pointing at the test DB" and "I was actually migrating the real one" both be true at once. Compose sets the variable *inside* the Postgres container only — it does not reach the `pnpm` processes you run on the host.

So copy the example env file — this step is **not** optional:

```bash
cp apps/server/.env.example apps/server/.env
```

The server, `db:migrate` and `db:seed:demo` load that file automatically at startup (`src/load-env.ts`, `process.loadEnvFile`), no extra flag or export needed. **The MCP server entrypoint does not** — see step 4, where you pass `DATABASE_URL` to your agent's MCP config explicitly.

(`apps/server/.env` is gitignored — safe to keep local secrets there if you later change the password. Variables already set in your shell environment take priority — `.env` fills in only what's missing, it never overrides an existing value. If you'd rather not keep a file, `export DATABASE_URL=…` in every shell that runs these commands works just as well.)

---

## 3. Install, migrate, seed

From the repo root:

```bash
pnpm install
```

Run migrations (applies every SQL file in `apps/server/drizzle/` against the DB above):

```bash
pnpm --filter @learn-shell/server db:migrate
```

**Optional** — seed demo data (样板间): a real CFA "Time Value of Money" quantitative-methods course (not lorem ipsum), plus one demo learner/agent/pair identity record so the app has something to show in `live` mode within ten minutes of install. The demo pair is marked `is_demo` and never outranks a real pair; real enrollment goes through the `create_pair` MCP tool instead (see step 4) — the demo is a showroom, not a prerequisite:

```bash
pnpm --filter @learn-shell/server db:seed:demo
```

(`db:seed` still works as an alias of `db:seed:demo`.) The seed is safe to re-run (`ON CONFLICT DO NOTHING` on every insert — re-running never duplicates or corrupts rows).

**Make it yours** — the identity fields (learner display name, agent display name, timezone, locale) are overridable via env vars, so the seeded course shows up under *your* name instead of the original author's:

```bash
LS_LEARNER_NAME="Alex" \
LS_AGENT_NAME="My Claude" \
LS_TIMEZONE="America/Los_Angeles" \
LS_LOCALE="en-US" \
pnpm --filter @learn-shell/server db:seed:demo
```

Defaults if you omit these: `LS_LEARNER_NAME=Learner`, `LS_AGENT_NAME=My Agent`, `LS_TIMEZONE=UTC`, `LS_LOCALE=en`. Internal row IDs (`lrn_demo`, `pair_demo_cfa`, etc.) stay fixed regardless — the demo course content and the web app's default pair-lookup key off them — only the human-facing display fields change.

Two things to know about these variables:

- **They only apply to the first seed.** Because every identity insert is `ON CONFLICT DO NOTHING`, re-running the seed with different values will *not* update rows that already exist. To change them after the fact, edit the names in Settings (通用) rather than re-seeding.
- **`LS_LOCALE` does not set the learner's language contract.** The seed writes it to `preferences.locale`; the authoritative column the agent's brief reads is `learners.locale`, which the seed leaves null. A freshly seeded demo learner therefore reads back as "no stated language preference" — which is honest, since nobody stated one. The learner's real locale is set through `create_pair`'s `locale` argument or in Settings (外观), not by this variable.

---

## 4. Wire your agent to the MCP server

Learn Shell exposes 50 MCP tools (count at this writing — it grows) + 21 resources (7 `pair://` data surfaces, the `manifest://capabilities` menu, and one `recipe://` volume per recipe file — 13 today) over **stdio**. The intended flow is: your own AI (Claude Code, or any MCP-capable client) becomes the teacher, and this server is where it puts the teaching materials.

This is a step you do by hand — edit your agent's config yourself. There's no installer script for it, and there won't be one: given the no-auth gap in the security notice above, you deciding to point an agent at this server *is* the one deliberate consent gate in the pipeline right now.

**Two things every one of these configs has to get right:**

1. **`DATABASE_URL` must be in the MCP process's own environment.** Unlike the REST server and the db scripts, the MCP entrypoint does not load `apps/server/.env` — it talks to Postgres directly and will fail on its first database call without the variable. Either `export DATABASE_URL=…` in the shell your agent inherits, or (better, and what's shown below) declare it in the MCP server entry itself.
2. **`tsx` is not installed globally.** It's a devDependency of the `apps/server` workspace only, so a bare `tsx` command will not resolve on a fresh install. Use `pnpm -C <repo> --filter @learn-shell/server mcp`, or the absolute path to the workspace-local binary at `apps/server/node_modules/.bin/tsx`. (Note the path: it is *not* in the repo-root `node_modules/.bin`.)

**Claude Code:**

```bash
claude mcp add learn-shell \
  -e DATABASE_URL="postgresql://learn_shell:learn_shell_dev@localhost:5432/learn_shell" \
  -- pnpm -C /absolute/path/to/learn-shell --filter @learn-shell/server mcp
```

(`pnpm -C <dir>` makes this independent of the directory you invoke `claude` from; the `mcp` script runs `tsx src/mcp/server.ts` inside the server workspace.)

Equivalently, via the workspace-local binary:

```bash
claude mcp add learn-shell \
  -e DATABASE_URL="postgresql://learn_shell:learn_shell_dev@localhost:5432/learn_shell" \
  -- /absolute/path/to/learn-shell/apps/server/node_modules/.bin/tsx \
     /absolute/path/to/learn-shell/apps/server/src/mcp/server.ts
```

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.learn-shell]
command = "/absolute/path/to/learn-shell/apps/server/node_modules/.bin/tsx"
args = ["/absolute/path/to/learn-shell/apps/server/src/mcp/server.ts"]
env = { DATABASE_URL = "postgresql://learn_shell:learn_shell_dev@localhost:5432/learn_shell" }
```

**OpenClaw** — the CLI has no `mcp add`; it sets a server from a JSON object (`openclaw mcp set <name> <json>`, alongside `list` / `show` / `unset`):

```bash
openclaw mcp set learn-shell '{
  "command": "/absolute/path/to/learn-shell/apps/server/node_modules/.bin/tsx",
  "args": ["/absolute/path/to/learn-shell/apps/server/src/mcp/server.ts"],
  "env": {"DATABASE_URL": "postgresql://learn_shell:learn_shell_dev@localhost:5432/learn_shell"}
}'
```

(Same object can be written straight into the `mcp.servers` map in `~/.openclaw/openclaw.json`. Verify with `openclaw mcp show learn-shell`.)

**Any other MCP client (generic stdio):** point it at command `/absolute/path/to/learn-shell/apps/server/node_modules/.bin/tsx` with arg `/absolute/path/to/learn-shell/apps/server/src/mcp/server.ts` (equivalently, command `pnpm` with args `-C /absolute/path/to/learn-shell --filter @learn-shell/server mcp`), and set `DATABASE_URL` in the server entry's `env` block. Transport is stdio — there's no HTTP endpoint to configure.

Once connected, tell your agent to read the `manifest://capabilities` MCP resource first — it's the live, generated capability menu (every tool/resource/prompt this server exposes). From there it can pull `recipe://<name>` resources — step-by-step tool-call scripts for common flows (negotiating a contract, delivering a lesson, grading, resuming cold). The same recipes are readable as plain markdown in `docs/recipes/`.

**Important:** real enrollment (creating your own learner/agent/pair) goes through the `create_pair` MCP tool — the learner first types their own name on the web first-run page (`POST /api/onboarding/learner` behind the scenes; the name is the learner's sovereign act, the agent must not fill it in), then the agent calls `create_pair` with that exact name. Flow: `recipe://bootstrap`'s "无 pair 分支". The optional `db:seed:demo` pair (step 3) is a demo showroom marked `is_demo` — usable for a quick look, but never a prerequisite for, nor ranked above, a real pair.

---

## 5. Run it

Two long-running dev processes, in separate terminals, both from the repo root:

```bash
pnpm --filter @learn-shell/server dev   # Hono REST API — http://localhost:3000
```

```bash
pnpm --filter @learn-shell/web dev      # Vite dev server — http://localhost:5173
```

Open **http://localhost:5173**.

**Make it an app (optional):** Learn Shell ships as an installable PWA. In Chrome/Edge, open the install icon in the address bar (or ⋮ → *Cast, save, and share* → *Install page as app*); in Safari, *File → Add to Dock*. You get a standalone window with the Learn Shell icon in your Dock — no address bar, no tabs. The backend still runs as before (the app window is just the frontend); a one-click native bundle that starts the whole stack is on the roadmap.


(The server binds `127.0.0.1` by default — `HOST` env var overrides this, see §5.5 below. CORS defaults to allowing `:5173`/`:4173`, matching the Vite dev/preview ports — no config needed for a same-machine setup. Only touch `CORS_ORIGINS` in `apps/server/.env` if you're serving the web app from a different host/port.)

---

## 5.5 Deployment topologies — where does the backend live?

**Topology A — everything on one machine (recommended, and what every command above assumes).** Postgres (Docker), server (`:3000`), web (`:5173`), and your AI client all on the same laptop/desktop. Zero extra config: the web app resolves its API base automatically (explicit `VITE_API_BASE_URL` env override → else same host the page was loaded from, port `3000` → else `localhost:3000`), and every process points at the same local Postgres. What Topology A does *not* buy you is a free `DATABASE_URL`: there is no default anywhere in the code, so the REST server and db scripts still need `apps/server/.env`, and the MCP entrypoint — which does not read that file — still needs the variable declared in its own MCP server entry (§4). Same connection string, three places that have to be told it. If you're unsure, use this.

**Topology B — backend on a home server / second machine on your LAN (advanced).** Run Docker + server + web on the server machine; browse and run your AI from your laptop. This crosses the single-machine trust boundary in the security notice (§0) — you're explicitly deciding to trust every device on your LAN. Four knobs plus one file edit:

0. **⚠️ Trust warning** — the server has no authentication. `HOST=0.0.0.0` means *any* device that can reach this machine's IP on your network has full read/write access to your teaching data, not just the laptop you intend to use. Only do this on a network you control (home LAN); never on a shared/public/office network, and never combine it with any port-forwarding or tunnel that reaches the public internet (see Topology C).
1. **Server machine** — set `HOST=0.0.0.0` when starting `apps/server` (defaults to `127.0.0.1`, i.e. off-machine requests are refused at the socket regardless of CORS). Also set `CORS_ORIGINS` in `apps/server/.env` to include the origin your browser will actually use, e.g. `http://192.0.2.50:5173` (the default only allows `localhost`) — `HOST` opens the socket, `CORS_ORIGINS` is the separate allowlist for which browser origins may call it; you need both. Also start Vite with `--host` (or set `server.host`) so `:5173` is reachable off-machine.
2. **Browser** — open `http://<server-ip>:5173`. The web app then calls `http://<server-ip>:3000/api` automatically (same-host rule above); you only need `VITE_API_BASE_URL` if web and API live on *different* hosts.
3. **Postgres port binding (a file edit, not an env var)** — `docker-compose.yml` hard-binds the database to loopback:
   ```yaml
   ports:
     - '127.0.0.1:5432:5432'   # change to '0.0.0.0:5432:5432' for LAN access
   ```
   That value is not env-interpolated, so it has to be edited in the file and the container recreated (`docker compose up -d`). Until you do, the AI machine cannot reach Postgres at all — and note this exposes a database running on public default credentials to your whole LAN — Postgres does authenticate, but the username/password shipped in `docker-compose.yml` are published in this repo, so in practice it is open to anyone on that network. Same trust decision as the warning above.
4. **Your AI's machine** — the MCP server process runs wherever your AI client runs (stdio transport), and it talks straight to Postgres. Point it at the server machine's DB when adding it:
   ```bash
   claude mcp add learn-shell \
     -e DATABASE_URL="postgresql://learn_shell:learn_shell_dev@<server-ip>:5432/learn_shell" \
     -- pnpm -C /absolute/path/to/learn-shell --filter @learn-shell/server mcp
   ```
   (This requires the repo checked out — and `pnpm install` run — on the AI's machine too: the MCP process is part of this codebase and needs the workspace-local `tsx`. Postgres's `5432` must be reachable on the LAN per step 3.)

**Topology C — anything that crosses the public internet: don't.** No authentication (section 0). A cloud VM with an open port is exactly the deployment this codebase is not ready for yet.

---

## 6. What will this cost in AI usage?

Three separate bills, if your AI does the work:

1. **Deployment (one-time) — cheap.** This guide is ~5K tokens; the install itself is a dozen commands. A smooth run is comparable to a light coding task — fine on an entry-level paid plan ($20-tier) inside one session. Environment trouble (missing Docker, wrong Node, port conflicts) multiplies it 2–5×, still nothing dramatic.
2. **The first course — the real meal.** First-time lesson prep means reading the capability manifest + recipes + skill stack (~30–50K tokens), negotiating a contract, authoring an 8–14 page lesson plus flashcards/exercises/mindmap, and passing the server-side validators. Budget on the order of a few hundred K tokens of context churn for the first full lesson bundle; later lessons get noticeably cheaper (cache + familiarity). The hidden cost is validator-rejection loops — error messages come with correction hints, so agents usually pass within two rounds.
3. **Daily operation — light.** Grading, Q&A, review scheduling are single-digit-K to tens-of-K per action. One lesson a day is comfortable on a $20-tier plan; authoring several courses a day is heavy-subscription territory.

Rule of thumb: **deployment is a rounding error; teaching volume decides your subscription tier.** (Estimates from real production use; your agent's verbosity and your subject's difficulty can move these ±2×.)

---

## 7. First run — what to actually do

1. Open `http://localhost:5173`. On a browser that has never picked a mode, the app probes `/health` once: if your backend answers healthy, it switches itself to **`live`** and reloads — you land on your real Postgres-backed data without doing anything. If no backend is reachable, it stays on **demo mode** (`seeded`) — static fixture data.
2. So the manual switch is a fallback, not a required step. If you got demo data anyway (backend not up yet, or you'd picked a mode before), press **⌘K** (or Ctrl+K), type `mode live`, hit enter. Once you have chosen a mode by hand the app never auto-probes again — your choice outranks the probe, in both directions (`mode seeded` gets you back to the fixtures).
3. Go to **Settings** (`/settings`) — six tabs: 通用 (identity — learner/agent display names, the note your agent left about itself), 外观 (theme/language), 教学契约 (the signed teaching contract as a certificate, plus its cadence clause), 学习者模型 (learner-model observations), 反馈 (the feedback ledger), and 数据与隐私 (data export). Worth a look before anything else.
4. The seeded demo course ("CFA L1 — Time Value of Money") shows up under **Courses** once you're in `live` mode — it's a fully worked example (2 lessons, flashcards, exercises, a mindmap, quiz questions) so you can see what a real lesson bundle looks like before your own agent builds one.
5. To get your agent to build its *own* first course, **make yourself a real pair first.** The seeded demo pair is a showroom: poke at it, propose a throwaway contract against it to see the mechanics, then leave it alone. Anything you actually intend to study should not live under the `lrn_demo` / `pair_demo_cfa` identity — it is marked `is_demo`, it carries someone else's name, and it is what a re-seed or a reset is expected to overwrite.

   The front door is `create_pair`: you type your own name on the web first-run page (name sovereignty — the agent must not fill it in), then your agent calls `create_pair` with that exact name. See `recipe://bootstrap`'s "无 pair 分支".

6. With your own pair in hand, have the agent call `propose_contract` to negotiate a teaching goal, then follow `docs/recipes/first-contract-and-lesson.md` (same content served live as the `recipe://first-contract-and-lesson` MCP resource) to build a course + deliver a full lesson.

---

## 8. Voice input (optional)

The Review page has a mic button for voice-to-text; it runs Whisper client-side in the browser (`@huggingface/transformers`, model `onnx-community/whisper-small`). First use downloads the model weights from `huggingface.co`; the browser caches it after that — audio and transcript never leave the device.

**Budget roughly 250–410 MB for that first download**, depending on which backend your browser gives us:

- **WebGPU** (Chrome/Edge on most modern GPUs) — fp16 encoder + q4 merged decoder, **≈ 410 MB** (177 MB + 233 MB).
- **WASM fallback** (no WebGPU available) — q8 across the board, **≈ 250 MB** (92 MB + 157 MB). Slower, but a smaller download.

It's a one-time cost per browser profile, and it's a real download — start it on a connection where a few hundred megabytes is not a surprise.

Mainland-China users: `huggingface.co` needs a proxy to reach. Alternatively set a mirror host at build/dev time — `VITE_HF_REMOTE_HOST=https://hf-mirror.com` in `apps/web/.env.local` (or in the shell env of your `web dev` process) redirects the model download; everything else stays client-side as above.

---

🖤
