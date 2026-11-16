# Plan: use a given renderer URL instead of a container

Goal: when a URL is given for a diagram type that needs a server renderer, the stack uses it and does not start a container for it.

## Scope
- Server-rendered types today: PlantUML and Salt (one renderer, `PLANTUML_URL`, canvas `src/server.ts` proxy → `$PLANTUML_URL/svg`).
- Mermaid renders in the browser (`canvas/frontend/src/codeblock/render.ts`); it has no container, so it gets no URL option. Not building one.
- Not building: a per-language renderer registry or a Kroki-for-everything mode. Add the next renderer the same way when a container-backed language appears (one env var + one profile line).
- `compose.test.yaml` keeps its local plantuml: tests must not depend on outside services.

## Decisions
| Decision | Based on |
|---|---|
| One env var, `PLANTUML_URL`, decides both the URL and whether the container runs | The canvas already reads `PLANTUML_URL`; a second switch could disagree with it. |
| `plantuml` gets `profiles: ["${PLANTUML_URL:+external-renderer}"]` | Unset → profile `""` → started by default; set → profile `external-renderer`, inactive → not started. Pure compose, no wrapper script. Verified with `docker compose config --services` (Compose v5.6.1) for unset, set, empty and `.env`. |
| canvas `depends_on.plantuml.required: false` | Compose otherwise fails when the dependency is disabled. |
| Canvas proxy unchanged except error text | It already accepts any base URL and trims trailing slashes; plantuml-server, plantuml.com and Kroki (`…/plantuml`) all answer `POST <base>/svg` with text. Kroki returns syntax errors as text/plain (not an error SVG), so the proxy now forwards that text (≤500 chars) instead of a bare HTTP status. |
| Minimum Compose 2.20 | `depends_on.required` arrived in 2.20; the `[""]` profile behavior is verified only on v5.6.1. |
| Documented privacy trade-off in `docs/setup.md` | The local container exists so diagram text stays on the machine. |

## Steps
1. `compose.yaml`: `PLANTUML_URL` from env with the container as default; profile on `plantuml`; optional dependency.
2. `.env.example` and `docs/setup.md`: how to set it, examples, how to drop an already running container.
3. Verify with `docker compose config` for each case.

## Outcome
Done as planned (2026-11-16), plus after independent review: Kroki error text forwarded by the proxy, docs on Compose version, `host.docker.internal`, `www.` and `docker compose rm -sf plantuml`. Verified only at the compose-config level: the session had no Docker daemon and no route to plantuml.com or kroki.io, so a live render through an external URL was not run. First real check: set `PLANTUML_URL` in `.env`, `docker compose up -d`, paste a PlantUML block.
Learned: a compose profile list of `[""]` counts as "no profile", which makes `${VAR:+name}` a one-variable on/off switch for a service.
