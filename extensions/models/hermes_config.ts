/**
 * Model `@mgreten/hermes-config` — manage Hermes AI agent model configuration.
 *
 * Controls the main inference model and per-task auxiliary model overrides in
 * `/opt/data/config.yaml` inside a Hermes Docker container.
 *
 * **Safe edit protocol**: every mutating method automatically backs up the
 * config before editing and validates it after. Call `restartGateway` as a
 * separate confirmed step once you are happy with the changes.
 *
 * **Provider names**: Hermes uses `"lmstudio"` as the provider identifier for
 * Ollama/LM-Studio-compatible OpenAI-compatible endpoints. Use `"auto"` (or
 * pass `null` to `setAuxiliaryModels`) to revert a task to the main model.
 *
 * **Execution modes** (controlled by `localMode`):
 * - `localMode: false` (default) — runs on your local machine; all file
 *   operations SSH into `hermesHost`; `restartGateway` SSHes to
 *   `dockerHost` and runs `docker compose restart hermes`.
 * - `localMode: true` — runs from inside the Hermes container; file
 *   operations use Deno's file API directly; `restartGateway` runs
 *   `hermes gateway restart` in-process.
 *
 * **Note on PyYAML**: The Hermes container does not ship PyYAML. All config
 * edits use a line-by-line Python approach that is safe for Hermes's
 * fixed-indentation YAML structure.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Known Hermes auxiliary task names. Pass these as keys to `setAuxiliaryModels`.
 * Additional tasks may appear in future Hermes releases — unknown names are
 * passed through unchanged and will produce a warning in the op result.
 */
const AUX_TASKS = [
  "vision",
  "web_extract",
  "compression",
  "session_search",
  "skills_hub",
  "approval",
  "mcp",
  "title_generation",
  "curator",
  "triage_specifier",
] as const;

// ── Schemas ───────────────────────────────────────────────────────────────────

const GlobalArgs = z.object({
  localMode: z
    .boolean()
    .default(false)
    .describe(
      "Set true when running from inside the Hermes container — uses Deno file API instead of SSH",
    ),
  hermesHost: z
    .string()
    .default("")
    .describe(
      "SSH target for the Hermes container (user@hostname, e.g. user@hermes.example.ts.net). Ignored when localMode=true.",
    ),
  configPath: z
    .string()
    .default("/opt/data/config.yaml")
    .describe("Absolute path to Hermes config.yaml inside the container"),
  hermesBin: z
    .string()
    .default("/opt/hermes/.venv/bin/hermes")
    .describe(
      "Hermes binary path — used by restartGateway in localMode",
    ),
  dockerHost: z
    .string()
    .default("")
    .describe(
      "SSH target for the machine running the Hermes Docker container (e.g. dockerhost.example.ts.net). " +
        "Used by restartGateway when localMode=false. Falls back to hermesHost if empty.",
    ),
  hermesComposePath: z
    .string()
    .default("/docker/services/hermes")
    .describe(
      "docker-compose directory on the Docker host — used by restartGateway when localMode=false",
    ),
});

type GA = z.infer<typeof GlobalArgs>;

/** A provider+model pair for an auxiliary task override. */
const AuxOverrideSchema = z.object({
  provider: z.string().describe(
    "Hermes provider name. Use 'lmstudio' for Ollama/LM-Studio-compatible endpoints.",
  ),
  model: z.string().describe(
    "Model name as registered in the provider (e.g. 'qwen3.5:4b-mlx-bf16')",
  ),
});

const ConfigStateSchema = z.object({
  mainModel: z.object({
    name: z.string(),
    provider: z.string(),
    numCtx: z.number().optional(),
    think: z.boolean().optional(),
  }).describe("Current main model settings"),
  auxiliaryOverrides: z.record(z.string(), AuxOverrideSchema).describe(
    "Tasks with non-auto auxiliary model overrides",
  ),
  timestamp: z.string(),
});

const OpResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  warnings: z.array(z.string()).optional(),
  timestamp: z.string(),
});

// ── Shared context type ────────────────────────────────────────────────────────

type MethodContext = {
  globalArgs: GA;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<unknown>;
};

// ── SSH helpers ───────────────────────────────────────────────────────────────

/** Run a shell command on a remote host via SSH; returns stdout. Throws on non-zero exit. */
async function sshExec(host: string, command: string): Promise<string> {
  const cmd = new Deno.Command("ssh", {
    args: ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", host, command],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr).trim();
    throw new Error(`SSH to ${host} failed (exit ${code}): ${err}`);
  }
  return new TextDecoder().decode(stdout);
}

/**
 * Run a Python3 script on the Hermes host (SSH or local) and return stdout.
 * The script is piped via stdin to `sudo python3`.
 */
async function runScript(ga: GA, script: string): Promise<string> {
  if (ga.localMode) {
    const cmd = new Deno.Command("sudo", {
      args: ["python3"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const proc = cmd.spawn();
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(script));
    await writer.close();
    const { code, stdout, stderr } = await proc.output();
    if (code !== 0) {
      throw new Error(
        `Python3 failed (exit ${code}): ${
          new TextDecoder().decode(stderr).trim()
        }`,
      );
    }
    return new TextDecoder().decode(stdout);
  } else {
    // Pipe script via stdin to avoid shell-quoting issues
    const cmd = new Deno.Command("ssh", {
      args: [
        "-o",
        "ConnectTimeout=10",
        "-o",
        "BatchMode=yes",
        ga.hermesHost,
        "sudo python3",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const proc = cmd.spawn();
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(script));
    await writer.close();
    const { code, stdout, stderr } = await proc.output();
    if (code !== 0) {
      throw new Error(
        `SSH python3 on ${ga.hermesHost} failed (exit ${code}): ${
          new TextDecoder().decode(stderr).trim()
        }`,
      );
    }
    return new TextDecoder().decode(stdout);
  }
}

// ── Config helpers ────────────────────────────────────────────────────────────

/** Back up config.yaml with a Unix-timestamp suffix before any mutation. */
async function backupConfig(ga: GA): Promise<void> {
  const script = `
import shutil, time
src = ${JSON.stringify(ga.configPath)}
dst = f"{src}.bak.{int(time.time())}"
shutil.copy2(src, dst)
print(f"backup: {dst}")
`;
  await runScript(ga, script);
}

/**
 * Sanity-check config.yaml after a mutation.
 * PyYAML is unavailable in the Hermes container, so this checks key-presence
 * and line count rather than full YAML parsing.
 */
async function validateConfig(ga: GA): Promise<void> {
  const script = `
with open(${JSON.stringify(ga.configPath)}) as f:
    content = f.read()
assert len(content.splitlines()) > 10, "config.yaml looks truncated"
assert "model:" in content, "missing model: section"
assert "auxiliary:" in content, "missing auxiliary: section"
print("OK")
`;
  const out = await runScript(ga, script);
  if (!out.trim().includes("OK")) {
    throw new Error(`Config validation failed: ${out.trim()}`);
  }
}

// ── Model ─────────────────────────────────────────────────────────────────────

/**
 * Swamp model for managing Hermes AI agent model configuration.
 *
 * Provides four methods: `getConfig` (read current settings), `setMainModel`
 * (change the main inference model), `setAuxiliaryModels` (override or reset
 * per-task auxiliary models), and `restartGateway` (apply changes).
 *
 * All mutating methods follow the safe edit protocol: backup → edit → validate.
 * `restartGateway` is always a separate explicit call.
 */
export const model = {
  type: "@mgreten/hermes-config",
  version: "2026.06.27.2",
  resources: {
    configState: {
      description: "Current Hermes model configuration snapshot",
      schema: ConfigStateSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    opResult: {
      description: "Result of a configuration change operation",
      schema: OpResultSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    getConfig: {
      description:
        "Read the current main model and auxiliary overrides from Hermes config.yaml. " +
        "Stores a snapshot as a configState resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        context.logger.info("Reading Hermes config from {path}", {
          path: ga.configPath,
        });

        const script = `
import json

with open(${JSON.stringify(ga.configPath)}) as f:
    lines = f.readlines()

main = {}
aux_overrides = {}
in_model = in_extra_body = in_options = in_auxiliary = False
current_task = None

for line in lines:
    indent = len(line) - len(line.lstrip())
    content = line.strip()

    if indent == 0:
        in_model = (content == 'model:')
        in_auxiliary = (content == 'auxiliary:')
        if not in_model:
            in_extra_body = in_options = False
        if not in_auxiliary:
            current_task = None

    if in_model:
        if indent == 2:
            if content.startswith('default:'):
                main['name'] = content[len('default:'):].strip()
            elif content.startswith('provider:'):
                main['provider'] = content[len('provider:'):].strip()
            elif content == 'extra_body:':
                in_extra_body = True
        if in_extra_body and indent == 4 and content == 'options:':
            in_options = True
        if in_options and indent == 6:
            if content.startswith('num_ctx:'):
                try: main['numCtx'] = int(content[len('num_ctx:'):].strip())
                except: pass
            elif content.startswith('think:'):
                main['think'] = content[len('think:'):].strip().lower() == 'true'

    if in_auxiliary:
        if indent == 2 and content.endswith(':'):
            current_task = content[:-1]
        if current_task and indent == 4:
            val = content.split(':', 1)[1].strip().strip("'\\"") if ':' in content else ''
            if content.startswith('provider:') and val and val != 'auto':
                aux_overrides.setdefault(current_task, {})['provider'] = val
            elif content.startswith('model:') and val:
                aux_overrides.setdefault(current_task, {})['model'] = val

# Only keep tasks with both provider and model set
aux_overrides = {k: v for k, v in aux_overrides.items() if 'provider' in v and 'model' in v}
print(json.dumps({'main': main, 'auxiliaryOverrides': aux_overrides}))
`;
        const raw = await runScript(ga, script);
        const parsed = JSON.parse(raw.trim());

        context.logger.info(
          "Main model: {model} (provider: {provider}, numCtx: {numCtx})",
          {
            model: parsed.main.name ?? "unknown",
            provider: parsed.main.provider ?? "unknown",
            numCtx: parsed.main.numCtx ?? "unset",
          },
        );
        const overrideCount = Object.keys(parsed.auxiliaryOverrides).length;
        if (overrideCount > 0) {
          context.logger.info("{count} auxiliary override(s): {tasks}", {
            count: overrideCount,
            tasks: Object.keys(parsed.auxiliaryOverrides).join(", "),
          });
        } else {
          context.logger.info(
            "No auxiliary overrides — all tasks use main model",
          );
        }

        const handle = await context.writeResource("configState", "current", {
          mainModel: parsed.main,
          auxiliaryOverrides: parsed.auxiliaryOverrides,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    setMainModel: {
      description:
        "Set the Hermes main model. Updates model.default and model.provider, and " +
        "optionally updates num_ctx and think in model.extra_body.options. " +
        "Backs up config before editing and validates after. " +
        "Call restartGateway to apply.",
      arguments: z.object({
        modelName: z
          .string()
          .describe(
            "Model name as registered in the provider (e.g. 'qwen3.6:35b-a3b-coding-nvfp4')",
          ),
        provider: z
          .string()
          .default("lmstudio")
          .describe(
            "Hermes provider name. Use 'lmstudio' for Ollama/LM-Studio-compatible endpoints.",
          ),
        numCtx: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Context window in tokens. Omit to leave the existing value unchanged.",
          ),
        think: z
          .boolean()
          .optional()
          .describe(
            "Enable/disable chain-of-thought thinking. Omit to leave the existing value unchanged.",
          ),
      }),
      execute: async (
        args: {
          modelName: string;
          provider: string;
          numCtx?: number;
          think?: boolean;
        },
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        context.logger.info(
          "Setting main model to {model} (provider: {provider})",
          { model: args.modelName, provider: args.provider },
        );

        await backupConfig(ga);

        // Serialize optional values as Python literals
        const numCtxPy = args.numCtx !== undefined
          ? String(args.numCtx)
          : "None";
        const thinkPy = args.think !== undefined
          ? args.think ? "True" : "False"
          : "None";

        const script = `
config_path = ${JSON.stringify(ga.configPath)}
model_name = ${JSON.stringify(args.modelName)}
provider = ${JSON.stringify(args.provider)}
num_ctx = ${numCtxPy}
think = ${thinkPy}

with open(config_path) as f:
    lines = f.readlines()

in_model = in_extra_body = in_options = False
result = []

for line in lines:
    indent = len(line) - len(line.lstrip())
    content = line.strip()

    if indent == 0:
        in_model = (content == 'model:')
        if not in_model:
            in_extra_body = in_options = False

    if in_model:
        if indent == 2 and content.startswith('default:'):
            line = f"  default: {model_name}\\n"
        elif indent == 2 and content.startswith('provider:'):
            line = f"  provider: {provider}\\n"
        elif indent == 2 and content == 'extra_body:':
            in_extra_body = True
        if in_extra_body and indent == 4 and content == 'options:':
            in_options = True
        if in_options and indent == 6:
            if num_ctx is not None and content.startswith('num_ctx:'):
                line = f"      num_ctx: {num_ctx}\\n"
            if think is not None and content.startswith('think:'):
                line = f"      think: {'true' if think else 'false'}\\n"

    result.append(line)

import shutil
with open(config_path + '.tmp', 'w') as f:
    f.writelines(result)
shutil.move(config_path + '.tmp', config_path)
print('OK')
`;
        const out = await runScript(ga, script);
        if (!out.trim().includes("OK")) {
          throw new Error(`setMainModel script error: ${out.trim()}`);
        }
        await validateConfig(ga);

        const details: string[] = [
          `model=${args.modelName}`,
          `provider=${args.provider}`,
        ];
        if (args.numCtx !== undefined) details.push(`num_ctx=${args.numCtx}`);
        if (args.think !== undefined) details.push(`think=${args.think}`);

        const handle = await context.writeResource(
          "opResult",
          "set-main-model",
          {
            success: true,
            message: `Main model updated (${
              details.join(", ")
            }). Run restartGateway to apply.`,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    setAuxiliaryModels: {
      description:
        "Override or reset auxiliary task models. Pass a tasks map where each value is " +
        "{provider, model} to set an override or null to reset the task to auto (main model). " +
        `Known task names: ${AUX_TASKS.join(", ")}. ` +
        "Backs up config before editing and validates after. " +
        "Call restartGateway to apply.",
      arguments: z.object({
        tasks: z
          .record(z.string(), z.union([AuxOverrideSchema, z.null()]))
          .describe(
            "Map of task name → {provider, model} to set, or null to reset to auto. " +
              'Example: {"title_generation": {"provider": "lmstudio", "model": "qwen3.5:4b-mlx-bf16"}, "mcp": null}',
          ),
      }),
      execute: async (
        args: {
          tasks: Record<string, { provider: string; model: string } | null>;
        },
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const taskNames = Object.keys(args.tasks);
        context.logger.info("Updating {count} auxiliary task(s): {tasks}", {
          count: taskNames.length,
          tasks: taskNames.join(", "),
        });

        // Warn about unknown task names
        const warnings: string[] = [];
        for (const name of taskNames) {
          if (!(AUX_TASKS as readonly string[]).includes(name)) {
            warnings.push(
              `Unknown auxiliary task '${name}' — will attempt update anyway`,
            );
            context.logger.warning(
              "Unknown auxiliary task '{task}' — not in known list",
              { task: name },
            );
          }
        }

        await backupConfig(ga);

        const tasksJson = JSON.stringify(args.tasks);

        const script = `
import json

config_path = ${JSON.stringify(ga.configPath)}
tasks = json.loads(${JSON.stringify(tasksJson)})

with open(config_path) as f:
    lines = f.readlines()

in_auxiliary = False
current_task = None
result = []
applied = []

for line in lines:
    indent = len(line) - len(line.lstrip())
    content = line.strip()

    if indent == 0:
        in_auxiliary = (content == 'auxiliary:')
        if not in_auxiliary:
            current_task = None

    if in_auxiliary:
        if indent == 2 and content.endswith(':'):
            current_task = content[:-1]
        if current_task in tasks:
            override = tasks[current_task]
            if indent == 4:
                if content.startswith('provider:'):
                    new_val = override['provider'] if override else 'auto'
                    line = f"    provider: {new_val}\\n"
                    applied.append(current_task)
                elif content.startswith('model:'):
                    new_val = override['model'] if override else ''
                    line = f"    model: '{new_val}'\\n"

    result.append(line)

import shutil
with open(config_path + '.tmp', 'w') as f:
    f.writelines(result)
shutil.move(config_path + '.tmp', config_path)

for task, override in tasks.items():
    if override:
        print(f"set {task}: {override['provider']}/{override['model']}")
    else:
        print(f"reset {task} to auto")
not_found = [t for t in tasks if t not in applied]
if not_found:
    print(f"WARNING: tasks not found in config: {', '.join(not_found)}")
print('OK')
`;
        const out = await runScript(ga, script);
        if (!out.trim().includes("OK")) {
          throw new Error(`setAuxiliaryModels script error: ${out.trim()}`);
        }

        // Surface any "not found in config" warnings from Python
        for (const line of out.split("\n")) {
          if (line.startsWith("WARNING:")) warnings.push(line);
        }

        await validateConfig(ga);

        const setCount =
          Object.values(args.tasks).filter((v) => v !== null).length;
        const resetCount =
          Object.values(args.tasks).filter((v) => v === null).length;
        const parts: string[] = [];
        if (setCount > 0) parts.push(`set ${setCount} override(s)`);
        if (resetCount > 0) parts.push(`reset ${resetCount} to auto`);

        const handle = await context.writeResource(
          "opResult",
          "set-aux-models",
          {
            success: true,
            message: `${parts.join(", ")}. Run restartGateway to apply.`,
            warnings: warnings.length > 0 ? warnings : undefined,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    restartGateway: {
      description: "Restart the Hermes gateway to apply config changes. " +
        "localMode=false: SSHes to dockerHost (or hermesHost if dockerHost is empty) and " +
        "runs `docker compose restart hermes` — ~15s downtime. " +
        "localMode=true: runs `hermes gateway restart` inside the container.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;

        let message: string;

        if (ga.localMode) {
          context.logger.info(
            "Restarting gateway process in-container via {bin}",
            { bin: ga.hermesBin },
          );
          // Write resource before spawning — the restart kills this process
          const handle = await context.writeResource(
            "opResult",
            "restart-gateway",
            {
              success: true,
              message:
                "Gateway restart triggered — connection will drop momentarily.",
              timestamp: new Date().toISOString(),
            },
          );
          new Deno.Command(ga.hermesBin, {
            args: ["gateway", "restart"],
            stdout: "null",
            stderr: "null",
            stdin: "null",
          }).spawn();
          return { dataHandles: [handle] };
        } else {
          const host = ga.dockerHost || ga.hermesHost;
          context.logger.info("Restarting hermes container on {host}", {
            host,
          });
          const out = await sshExec(
            host,
            `cd ${ga.hermesComposePath} && docker compose restart hermes 2>&1`,
          );
          context.logger.info("Restart output: {out}", { out: out.trim() });
          message =
            "Hermes container restarted. Allow ~15s for the gateway to come back up.";
        }

        const handle = await context.writeResource(
          "opResult",
          "restart-gateway",
          {
            success: true,
            message,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
