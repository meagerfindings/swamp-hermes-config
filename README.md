# @mgreten/hermes-config

Manage [Hermes AI agent](https://github.com/NousResearch/hermes-agent) model configuration from swamp. Set the main inference model, configure per-task auxiliary model overrides, and restart the gateway — all with a safe backup-before-edit protocol.

## What It Does

- **`getConfig`** — read current main model and auxiliary task overrides
- **`setMainModel`** — change the main model, provider, and optionally `num_ctx` / `think`
- **`setAuxiliaryModels`** — override specific auxiliary tasks to a smaller/faster model, or reset them back to auto
- **`restartGateway`** — restart the Hermes gateway to apply changes

## Why Auxiliary Overrides?

Hermes uses the main model for every task by default — including lightweight side-jobs like title generation, session search, and MCP tool routing. Routing those to a smaller model (e.g. a 4B instead of a 35B) frees the main model for actual work and reduces latency on auxiliary calls.

## Prerequisites

- Hermes running as a Docker container (standard deployment)
- SSH key-based access to the Hermes container and its Docker host
- swamp installed locally

## Setup

Create a model instance pointing at your Hermes deployment:

```bash
swamp model create my-hermes-config \
  --type @mgreten/hermes-config \
  --arg hermesHost=youruser@hermes.yourdomain.ts.net \
  --arg dockerHost=dockerhost.yourdomain.ts.net \
  --arg hermesComposePath=/home/youruser/docker-configs/services/hermes
```

## Usage

```bash
# See current model configuration
swamp model method run my-hermes-config getConfig

# Switch main model
swamp model method run my-hermes-config setMainModel \
  --arg modelName=qwen3.6:35b-a3b-coding-nvfp4 \
  --arg provider=lmstudio \
  --arg numCtx=131072

# Route lightweight auxiliary tasks to a 4B model
swamp model method run my-hermes-config setAuxiliaryModels \
  --arg tasks='{"title_generation":{"provider":"lmstudio","model":"qwen3.5:4b-mlx-bf16"},"session_search":{"provider":"lmstudio","model":"qwen3.5:4b-mlx-bf16"},"skills_hub":{"provider":"lmstudio","model":"qwen3.5:4b-mlx-bf16"},"mcp":{"provider":"lmstudio","model":"qwen3.5:4b-mlx-bf16"}}'

# Reset a task back to the main model
swamp model method run my-hermes-config setAuxiliaryModels \
  --arg tasks='{"title_generation":null}'

# Apply changes
swamp model method run my-hermes-config restartGateway
```

## Provider Names

Hermes uses `"lmstudio"` as the provider identifier for Ollama/LM-Studio-compatible OpenAI-compatible endpoints. Use `"auto"` (or pass `null` to `setAuxiliaryModels`) to revert a task to the main model.

## Known Auxiliary Tasks

| Task | Description |
|------|-------------|
| `vision` | Image analysis |
| `web_extract` | Page summarization |
| `compression` | Context compaction |
| `session_search` | Recall queries |
| `skills_hub` | Skill search |
| `approval` | Smart auto-approve |
| `mcp` | MCP tool routing |
| `title_generation` | Session titles |
| `curator` | Skill-usage review |
| `triage_specifier` | Request classification |

**Recommended for auxiliary override** (low complexity, safe with a 4B model): `title_generation`, `session_search`, `skills_hub`, `mcp`

**Keep on main model** (higher stakes): `compression`, `approval`, `vision`, `web_extract`

## Global Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `localMode` | `false` | Set `true` when running from inside the Hermes container |
| `hermesHost` | `""` | SSH target for the Hermes container (`user@hostname`) |
| `configPath` | `/opt/data/config.yaml` | Path to config.yaml inside the container |
| `hermesBin` | `/opt/hermes/.venv/bin/hermes` | Hermes binary (used by `restartGateway` in localMode) |
| `dockerHost` | `""` | SSH target for the Docker host (falls back to `hermesHost`) |
| `hermesComposePath` | `/docker/services/hermes` | docker-compose directory on the Docker host |

## Safe Edit Protocol

Every mutating method (`setMainModel`, `setAuxiliaryModels`) follows this sequence automatically:

1. **Backup** — copies `config.yaml` to `config.yaml.bak.<timestamp>`
2. **Edit** — line-by-line Python edit (PyYAML is not available in the Hermes container)
3. **Validate** — checks key section presence and line count

`restartGateway` is always a separate explicit call — changes are never auto-applied.

## License

Apache 2.0
