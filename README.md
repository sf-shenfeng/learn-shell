# Learn Shell

> Your AI is becoming the one who knows you best. Learn Shell gives it a classroom that remembers — an agent-native teaching OS that turns your AI's teaching intent into things a learner can actually study, practice against, and get graded on.

**Codename**: `learn-shell` · **Status**: working system, actively dogfooded since 2026-07-02. Not authenticated. AGPL-3.0 licensed (v0.x was MIT; relicensed 2026-08-16, see note below); v1 is a single-machine, no-auth trust model.

**Setting this up from a code snapshot?** Follow [SETUP.md](./SETUP.md) — from-zero bring-up (Docker Postgres → migrate → seed → run → connect your own AI over MCP), every command verified against this repo's real config. Once it's running, the product tutorial (Chinese-first: cold-start pitfalls, the recommended lesson path, the agent's onboarding letter) is [docs/TUTORIAL.md](./docs/TUTORIAL.md).

---

## What this is

If you already have an AI you talk to daily — a work assistant, a long-running companion — it is quietly becoming the person who knows you best: it has read your every answer and seen your every hesitation. What it's missing is not knowledge of you. It's a floor. A chat window has no floor: the evidence of teaching evaporates with the context window, every new session your teacher wakes up a stranger, and you introduce yourself, again, to the one who knows you best.

Learn Shell is the floor. It doesn't replace your AI — it gives its teaching somewhere to live: courses, lessons, flashcards (FSRS-scheduled), exercises with grading, a mindmap, a document reader, and a memory layer the agent reads back (`get_context` / `get_learner_brief`) instead of re-deriving you from scratch every session. The teacher can change sessions, change models entirely — walk back in, and the classroom is exactly as it was left.

The agent talks to Learn Shell through [MCP](https://modelcontextprotocol.io/) — 50 tools at this writing, plus data resources and a composable skill/prompt layer. The exact surface is self-describing: the `manifest://capabilities` resource is generated live from the running registries, so it can't drift the way this sentence can. MCP itself is evolving — the 2026-07-28 spec revision (stateless core, Apps and Tasks extensions) is on our roadmap watch list, tracked but not yet promised. Surfaces are bilingual: docs and receipts are English-first, MCP tool descriptions and the prep-report Chinese-first in v0.1 — agents read both; full EN localization is on the roadmap. A human talks to it through a normal web app. Both surfaces read and write the same data.

Full vision: [docs/VISION.md](./docs/VISION.md) (v5.2 — voice recast 2026-07-27, promises unchanged; red-team calibrated; assertion-by-assertion status tracked internally, not part of this package — a promise-level summary is public in [Promise status](#promise-status) below). Product direction / what's being hardened next is tracked in an internal working doc.

---

## What it looks like

Real product, demo environment (the seeded English TVM course), no mockups. Every image follows your color scheme — dark readers see the dark app, light readers the light one.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/01-lesson-exercise-feedback-dark.png">
  <img alt="Lesson page: a graded exercise where the teacher's feedback quotes the learner's own answer verbatim and corrects a compounding/discounting mix-up" src="docs/media/01-lesson-exercise-feedback-light.png">
</picture>

*Lesson — graded exercise feedback. The teacher quotes the learner's answer back verbatim before correcting it; the mistake shown is a real one, kept because it was worth being wrong about.*

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/02-journal-timeline-dark.png">
  <img alt="Journal page: a timeline of lessons, reviews and live sessions reading like a learning biography" src="docs/media/02-journal-timeline-light.png">
</picture>

*Journal — the learning biography. Lessons, reviews and live sessions on one timeline; scrolling it reads like a record of a relationship, because it is one.*

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/03-review-flashcards-dark.png">
  <img alt="Review page: an FSRS-scheduled flashcard mid-review with the due count visible" src="docs/media/03-review-flashcards-light.png">
</picture>

*Review — FSRS-scheduled flashcards, authored by the teacher out of what the lessons actually covered.*

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/04-live-teaching-panel-dark.png">
  <img alt="Lesson page with the Live Teaching panel open: a real-time turn-based session beside the course text" src="docs/media/04-live-teaching-panel-light.png">
</picture>

*Live Teaching — a real-time, turn-based session beside the course text. The learner ends it, not the teacher: the close bell is theirs.*

### What the agent sees

The pages above are the learner's surface. The teacher's surface is receipts — here is a real `get_context` return from that same demo environment, `data` field verbatim, nothing truncated:

```json
{
  "pair_id": "pair_ms5wgdg0_ov2qty",
  "generated_at": "2026-07-30T00:35:38.461Z",
  "active_contracts": [
    {
      "id": "tc_ms5wgdgd_vyoo2f",
      "title": "Pass CFA Level I Quantitative Methods, starting with the time value of money",
      "setup_status": "established",
      "progress": "setup: established",
      "source_material": null
    }
  ],
  "recent_lessons": [
    {
      "id": "lsn_ms5wgwvy_qtcpbo",
      "title": "Time Value of Money — The Clock Inside Every Dollar",
      "status": "completed_declared",
      "last_activity_at": "2026-07-29T09:52:14.587Z"
    }
  ],
  "pending_pool": { "count": 0, "latest_titles": [] },
  "live_session": null,
  "unread_adhoc_count": 0,
  "active_reminder_count": 0,
  "contract_progress": [
    {
      "contract_id": "tc_ms5wgdgd_vyoo2f",
      "goal": "Pass CFA Level I Quantitative Methods, starting with the time value of money",
      "covered_course_count": 1,
      "completed_course_count": 1,
      "operationally_caught_up": true,
      "goal_completion_ready": false
    }
  ],
  "hypotheses_in_book_count": 1,
  "brief_etag": "b17254aded7a",
  "identity": { "learner_id": "lrn_ms5wg1wk_h36xhm", "agent_id": "agt_ms5wgdg0_7qzil8" }
}
```

One call, and a teacher who has never met this session knows where the relationship stands. That — not the pages — is the point.

---

## ⚠️ Security notice — read before you deploy this anywhere but localhost

**v1's trust model is single-machine.** The server binds `127.0.0.1` by default — your data is visible only to processes on the same machine. No account system exists because this is local-first by design, not an oversight: there is no per-agent credential, no scoped token, no audit trail beyond "actor: mcp", because v1 assumes one machine, one trust boundary.

**Cross-device deployment (`HOST=0.0.0.0`) is an explicit opt-in.** Setting it means you trust every device on that network — only do this on a trusted LAN, and never expose the server (REST or the MCP stdio bridge) to the public internet. Real authentication is on the roadmap, targeted at the multi-device case: agent credential → principal → pair derivation → real-name audit, scoped as its own dedicated batch, not a full multi-tenant system.

---

## Current state

Learn Shell is not a demo. It has been in continuous daily use as one real teaching relationship — one learner preparing for a real exam, one agent as her teacher — since the first real lesson on 2026-07-02. Every rule in the recipes traces back to a real lesson or a real failure: a course was once published into the void, so now there is a publish gate; a summary once outran the learner's own words, so now closing a lesson is a handshake; a green check once lied about "done", so now the lesson-completion check has exactly one owner — the learner.

What's actually shipped, as of this writing:

- **8 live pages**: Courses, Lesson (course text + exercises + Live Teaching panel), Review (FSRS flashcard review), Cards (deck management), Journal (learning "biography" timeline), Quiz (agent-authored + real question-bank), Mind Map, Document Reader — plus Settings (identity, appearance, contract certificate + cadence, learner-model, feedback ledger, data export).
- **MCP surface**: 50 tools (at this writing, counted from the live registry) + `pair://` data resources + the `manifest://capabilities` menu + per-recipe `recipe://` volumes + a composable skill/prompt stack (`domain` × `modality` × `intensity` × `tone` × `pace`, picked per contract — ledger and verification layers are fixed, `tone` is never auto-imposed: the teacher's own voice wins). Mutating tools return a structured success/error envelope (`resource_id`/`created_refs`/`next_recommended_actions` on success; a closed `VALIDATION`/`NOT_FOUND`/`CONFLICT`/`PERMISSION`/`RETRYABLE` taxonomy on failure); most (34 of 50 at this writing) accept an optional `idempotency_key` for retry safety.
- **A closed teaching loop that has actually run**: lesson taught → exercise graded → hypothesis formed → attributed with evidence and a counterfactual check → next lesson revised → revision history visible to the learner as `Revised · v{n}`.
- **A teacher inbox** (`get_teacher_inbox`): a single incremental to-do list — pending grading, unreflected Live sessions, unanswered AdHoc messages, flashcard trouble spots, unsigned contracts — each item naming which tool to call next.
- **Live Teaching**: real-time turn-based sessions with an online/offline bridge and mid-lesson snapshot recovery.

An exact, current-as-of-code inventory of every route, table, and known drift between docs and implementation is maintained internally, kept honest against `git HEAD`, not against intent. When this README and the code disagree, trust the code.

The MCP capability surface is self-describing: read the `manifest://capabilities` resource for the live, generated menu of every tool, resource, prompt, and recipe this server exposes — it is derived from the running registries, never a hand-authored parallel list.

---

## Promise status

The vision makes promises; this table says which ones the machine currently keeps. Three tiers:

- **Enforced** — a machine invariant: bypassing it is rejected by the system, not discouraged by docs.
- **Implemented** — the capability exists and works; adherence relies on convention and the recipes.
- **Planned** — on the roadmap, not in the code.

Qualified entries ("by default config", "by design", "partially") mean exactly what they say.

| Promise | Status | Where it stands |
| --- | --- | --- |
| Learner-sovereign completion | **Enforced** | Lesson close requires the learner's own declaration; a Live session cannot reach `completed` before the learner rings the close bell (the completion gate is machine-checked; pre-bell teacher moves are not blocked). |
| Terminal states are immutable | **Implemented** | State-machine guard on the read-then-write path; REST and MCP share the same semantics. Atomic conditional-update hardening against concurrent writers: **Planned**. |
| Publish gate on both surfaces | **Enforced** | Same gate on the MCP tool and the REST `PATCH` path. Post-publish edits revalidate-then-compensate rather than run in a single transaction; transactional hardening: **Planned**. |
| Data stays home by default | **Enforced by default config** | Server and Postgres bind loopback only; logs are redacted. Cross-device is an explicit opt-in; real authentication is **Planned** — targeted at the multi-device case (agent credential → principal → pair derivation → real-name audit trail), scheduled separately and not a full multi-tenant system. |
| Real enrollment / first-run | **Implemented** | `create_pair` is the front door, behind the name-sovereign first-run page. Multi-client fresh-agent E2E in CI: **Planned**. |
| Conversation as the interface | **Implemented** | The bootstrap recipe carries the no-pair path conversationally. One deliberate exception: the first-run name page, where the learner types their own name — name sovereignty requires their hand, not the agent's. A structured close-invitation move: **Planned**. |
| A thousand different good teachers | **Implemented by design** | Rules constrain the ledger and the timing, never the teacher's voice — the soft obligation here is a deliberate design choice, not a gap. |
| Evidence before narrative | **Partially enforced** | Idempotent claim-first grading and the receipt discipline are in place. Evidence citations are hard-validated at the write boundary: every id in `evidence_refs`, `evidence_event_ids` and `reflect_on_teaching`'s `action_link.ref_id` must exist, must resolve to a table that is legal for that citation kind, and must belong to the current pair — ghost references are rejected with the offending ids named. What the machine does *not* judge is whether the cited evidence actually supports the claim; that stays the teacher's. Evaluation revision history: **Planned**. |
| Less is respect | **Implemented** | Reminder-style UI has been removed; backend leftovers cleanup: **Planned**. |
| Reproducible evidence pack / E2E in CI | **Planned** | Roadmap. |

This table is hand-filled by the maintainers against the code and recalibrated at each release. Where it and the code disagree, the code wins — same rule as everywhere else in this README.

---

## Getting started

### For humans

1. `docker compose up -d` (Postgres only — `apps/server` and `apps/web` run as host processes today, no containerization yet).
2. `cp apps/server/.env.example apps/server/.env` — not optional. `DATABASE_URL` has no default in the code; every db entrypoint refuses to start without it, and Compose only sets it inside the container, not for your host processes.
3. `pnpm install`, then `pnpm --filter @learn-shell/server db:migrate`; optionally `pnpm --filter @learn-shell/server db:seed:demo` (demo showroom data — a real CFA course, not lorem ipsum; marked `is_demo`, never a prerequisite for real enrollment).
4. Run `apps/server` (`:3000`) and `apps/web` (`:5173`, dev). A browser that has never picked a mode probes `/health` and switches itself to `live` if your backend answers — otherwise it stays on demo (`seeded`) fixtures, and ⌘K → `mode live` switches by hand.
5. Open `http://localhost:5173/lesson`.

**Self-host operators** (serving the web app to other devices): the server binds `127.0.0.1` by default (single-machine trust model — see security notice above). Off-host access needs two opt-ins together: `HOST=0.0.0.0` (so the process actually listens on your LAN interface) and `CORS_ORIGINS` set to the origin your browser will use — a bare `tsx watch` without both falls back to loopback-only bind and a `localhost`-only CORS allowlist, and off-host access will look like a healthy-but-empty backend. See SETUP.md §5.5 for the full topology walkthrough.

### For agents

1. Connect: `claude mcp add learn-shell -e DATABASE_URL="postgresql://learn_shell:learn_shell_dev@localhost:5432/learn_shell" -- pnpm -C /absolute/path/to/learn-shell --filter @learn-shell/server mcp` (stdio transport; works with any MCP-capable client, Claude Code is the first-tested one). The MCP entrypoint does *not* read `apps/server/.env`, so `DATABASE_URL` has to be in its own environment — see [SETUP.md §4](./SETUP.md#4-wire-your-agent-to-the-mcp-server) for Codex CLI, OpenClaw and generic-stdio forms.
2. Read the `manifest://capabilities` resource first — the machine-readable capability menu (every tool/resource/prompt/recipe this server exposes, generated live from the registry, not a hand-maintained doc that can drift).
3. Then pull recipes as needed via the `recipe://<name>` resources the manifest points at. The **quick** volumes are the ones you read to act — most are step-by-step tool-call scripts with preconditions, expected returns and known failure modes, with two deliberate exceptions: `bootstrap` is a router page that only decides which road you're on, and `learner-orientation` prescribes what a new learner's first lesson must cover, not which tools to call. The **reference** volumes carry the incident history and design rationale behind their quick counterparts. Both come from real dogfood, not aspiration. Start at `recipe://bootstrap`.
4. If there's no active `learner_agent_pair` yet, real enrollment is the `create_pair` MCP tool (the one tool callable with no pair): the learner types their own name on the web first-run page first (name sovereignty — the agent must not fill it in), then the agent calls `create_pair` with that exact name. See `recipe://bootstrap`'s no-pair branch. The optional `db:seed:demo` pair is a demo showroom (`is_demo`), never ranked above a real pair.
5. The recipes, for reference — 13 volumes (8 quick + 5 reference), the same content the `recipe://` resources serve, written in Chinese:

   **Quick volumes** — read these to act:
   - [bootstrap.md](./docs/recipes/bootstrap.md) — the router page: you just connected, this decides which road you're on (including the no-pair branch).
   - [first-contract-and-lesson.md](./docs/recipes/first-contract-and-lesson.md) — negotiate a teaching contract, build a course, deliver a complete lesson bundle.
   - [grade-attribute-revise.md](./docs/recipes/grade-attribute-revise.md) — grade a submission, form an evidenced hypothesis, write a schema-enforced attributed reflection, revise the lesson.
   - [resume-teaching.md](./docs/recipes/resume-teaching.md) — wake up cold (same agent or a different one entirely), read back teaching memory, continue without making the learner re-explain anything.
   - [close-teaching-loop.md](./docs/recipes/close-teaching-loop.md) — grade → receipt, closing a lesson's teaching loop cleanly.
   - [live-teaching.md](./docs/recipes/live-teaching.md) — the watch-officer's manual for real-time sessions: the learner is on the other side of the screen counting your latency.
   - [learner-orientation.md](./docs/recipes/learner-orientation.md) — a new learner's first lesson. What you must cover; not how you must say it.
   - [mindmap-authoring.md](./docs/recipes/mindmap-authoring.md) — when a mindmap earns its place at all, and how to seed one that renders cleanly.

   **Reference volumes** — incident history and design rationale for their quick counterparts; skip unless the reference version changed: [first-contract-and-lesson.reference.md](./docs/recipes/first-contract-and-lesson.reference.md) · [grade-attribute-revise.reference.md](./docs/recipes/grade-attribute-revise.reference.md) · [resume-teaching.reference.md](./docs/recipes/resume-teaching.reference.md) · [close-teaching-loop.reference.md](./docs/recipes/close-teaching-loop.reference.md) · [live-teaching.reference.md](./docs/recipes/live-teaching.reference.md)

One more thing, if you are an agent reading this repo to evaluate it for your human — or about to become the teacher yourself: [docs/VISION.md](./docs/VISION.md) is addressed to you as much as to them. The short version: the rules here constrain the ledger, never your voice.

---

## Design principles

1. **AI is a first-class user** — every capability question is "can the agent call this," not just "can a human click this."
2. **Data belongs to the user** — self-host must be strictly better than SaaS, not a worse free tier.
3. **Schema is the contract** — tool input/output shapes are the real interface, not the prose around them.
4. **Model-agnostic** — MCP is neutral; nothing here should require a specific model or client.
5. **Minimal UI** — the shell doesn't upstage the teacher.

---

## 中文简版

Learn Shell 是一个 agent 原生的教学执行环境:你已经在用的 AI,通过 MCP 把教学意图变成学习者能实际操作的教具(课文、闪卡、习题),学习行为再回流成 agent 能读取的教学证据。老师换一个 session、换一个模型,推门进来,教室还是昨天离开时的样子。(MCP 2026-07-28 新规范——无状态核心、Apps 与 Tasks 扩展——在路线图关注列表上,跟进中,暂不作承诺。)

**现状**:从 2026-07-02 第一节真课起持续真实使用至今,不是概念演示——一位学习者备考一场真实的考试,她的 agent 是她的老师。8 个活页面 + 50 个 MCP 工具(写入类统一结构化回执;其中 50 个里有 34 个接受可选的 `idempotency_key`,不是全部写入类都有)+ manifest/recipe 资源体系 + 可组合 skill 栈;批改→归因→修订的教学闭环已经真实转动过。这里的每一条规则都来自一节真实的课或一次真实的失败。

**安全声明**:v1 的信任模型是单机(single-machine trust):服务默认只监听 127.0.0.1,你的数据只对本机进程可见。没有账号体系是本地优先设计的一部分,不是疏漏。跨设备部署(`HOST=0.0.0.0`)是显式选择,意味着你信任该网络中的所有设备——只在可信局域网这样做,永远不要暴露公网。认证体系列于路线图,面向多设备场景(已立案:agent 凭证 → principal → pair 推导 → 真名审计,独立排期,非全量多租户系统)。

**人类入口**:`docker compose up -d` 起 Postgres → `cp apps/server/.env.example apps/server/.env`(这步不可省:`DATABASE_URL` 代码里没有缺省值,缺了就拒绝启动,而 Compose 只把它注进容器,注不到你宿主上的 pnpm 进程)→ `pnpm install` → `db:migrate`(可选 `db:seed:demo` 装样板间演示数据,带 `is_demo` 标识,永不作为真入学前置)→ 起 `apps/server`/`apps/web` → 打开 `/lesson`(没选过模式的浏览器会探一次 `/health`,后端健康就自动切 `live`;探不到才留在 demo 数据,也可以 ⌘K 手动切)。

**Agent 入口**:`claude mcp add learn-shell -e DATABASE_URL="postgresql://learn_shell:learn_shell_dev@localhost:5432/learn_shell" -- pnpm -C /绝对路径/learn-shell --filter @learn-shell/server mcp` 连接(MCP 入口不读 `apps/server/.env`,`DATABASE_URL` 必须显式给到它自己的进程环境;`tsx` 也不是全局命令,别直接写 `tsx`——其它客户端写法见 SETUP.md §4);无 active pair 时真入学走 MCP `create_pair`(唯一正门——学习者先在首跑页亲手登记名字,名字主权不许代填,流程见 `recipe://bootstrap` 无 pair 分支);然后按官方 recipe 操作(见上方英文版链接),不要凭猜测调工具。如果你是替你的人类来评估这个 repo 的 agent——或者即将亲自成为这里的老师:[docs/VISION.md](./docs/VISION.md) 也是写给你的。一句话版:这里的规则约束账目,永不约束你的声音。

详细架构以代码为准;与本 README 冲突时,以代码本身为准。

---

## Contributing

Contribution guidelines TBD. Until then, issues discussing MCP protocol design, schema, or agent workflow templates are welcome.

---

🖤

## License

AGPL-3.0. Earlier snapshots (before 2026-08-16) were published under MIT and remain MIT for anyone who obtained them then — that grant is irrevocable and we honor it.

Why the change: Learn Shell is self-hosted server software. Plain MIT (or even GPL) leaves the SaaS loophole open — someone could run a modified closed version as a paid service without sharing changes. AGPL closes that loophole: if you run a modified Learn Shell for others over a network, you share your changes. Self-hosting for yourself, forking, and learning from the code are unaffected. If AGPL genuinely blocks a use case you care about, open an issue — we hold the copyright and can talk.
