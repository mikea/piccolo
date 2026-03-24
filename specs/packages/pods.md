# `@mariozechner/pi` (pods) — Specification

**Package:** `packages/pods/`  
**npm name:** `@mariozechner/pi`  
**Binary:** `pi-pods`  
**Version:** lockstep with monorepo  
**Runtime:** Node.js ≥ 20, ESM only

---

## Purpose

CLI tool for provisioning and managing vLLM model servers on remote GPU machines accessed via SSH. Handles pod setup, GPU inventory detection, model server lifecycle (start/stop/health/logs), GPU allocation, and port management.

---

## Directory Structure

```
src/
├── cli.ts              # Entry: command routing
├── types.ts            # GPU, Model, Pod, Config interfaces
├── config.ts           # ~/.pi/pods.json read/write; active pod management
├── model-configs.ts    # models.json loader; getModelConfig() best-fit selector
├── models.json         # Hardcoded model configs
├── ssh.ts              # sshExec, sshExecStream, scpFile
└── commands/
    ├── pods.ts         # setupPod, listPods, switchActivePod, removePodCommand
    ├── models.ts       # startModel, stopModel, stopAllModels, listModels, viewLogs, showKnownModels
    └── prompt.ts       # promptModel (stub — not yet implemented)
scripts/
├── pod_setup.sh        # Remote setup script (scp'd to pod, installs vLLM)
└── model_run.sh        # Template for model server launch scripts
```

---

## CLI Commands

```
pi-pods pods setup <name> "<ssh-command>" [--mount "<mount-cmd>"] [--models-path <path>] [--vllm release|nightly|gpt-oss]
pi-pods pods
pi-pods pods active <name>
pi-pods pods remove <name>

pi-pods shell [<pod-name>]
pi-pods ssh [<pod-name>] "<command>"

pi-pods start <model-id> --name <name> [--memory <pct>] [--context <size>] [--gpus <n>] [--vllm <args...>] [--pod <pod-name>]
pi-pods stop [<name>] [--pod <pod-name>]    # no name = stop all
pi-pods list [--pod <pod-name>]
pi-pods logs <name> [--pod <pod-name>]

pi-pods agent <name> [messages/options...] [--pod <pod-name>]   # currently stubbed (not implemented in prompt.ts)
```

---

## Core Types (`src/types.ts`)

```typescript
interface GPU {
  id: number;
  name: string;      // e.g., "NVIDIA H200 80GB HBM3"
  memory: string;    // e.g., "80 GiB"
}

interface Model {
  model: string;     // HuggingFace model ID, e.g., "Qwen/Qwen2.5-Coder-32B-Instruct"
  port: number;      // listening port on remote host
  gpu: number[];     // GPU IDs allocated to this model
  pid: number;       // process ID of vLLM server
}

interface Pod {
  ssh: string;                         // SSH command, e.g., "ssh root@1.2.3.4"
  gpus: GPU[];                         // detected GPU inventory
  models: Record<string, Model>;       // name → Model (running models)
  modelsPath?: string;                 // path to model files on pod (optional)
  vllmVersion?: "release" | "nightly" | "gpt-oss";
}

interface Config {
  pods: Record<string, Pod>;           // podName → Pod
  active?: string;                     // name of currently active pod
}
```

---

## Configuration (`src/config.ts`)

### Storage

Config file: `$PI_CONFIG_DIR/pods.json` (default `~/.pi/pods.json`)

```typescript
function loadConfig(): Config;
function saveConfig(config: Config): void;
```

### Active Pod Management

```typescript
function getActivePod(): { name: string; pod: Pod } | null;
function addPod(name: string, pod: Pod): void;
function removePod(name: string): void;
function setActivePod(name: string): void;
```

---

## Pod Setup (`src/commands/pods.ts`)

### `setupPod(name, sshCmd, options)`

```
1. Validate required env vars:
   - `HF_TOKEN` (required)
   - `PI_API_KEY` (required)

2. Resolve `modelsPath`:
   - use `options.modelsPath` if provided
   - else extract from trailing path in `options.mount`
   - error if still missing

3. Verify SSH access: `sshExec(sshCmd, "echo 'SSH OK'")`

4. Copy `pod_setup.sh` to remote:
   scpFile(sshCmd, "scripts/pod_setup.sh", "/tmp/pod_setup.sh")

5. Run setup script on remote (streaming output):
   `sshExecStream(sshCmd, setupCmd, { forceTTY: true })`
   where setupCmd includes:
   - `--models-path '<path>'`
   - `--hf-token '<HF_TOKEN>'`
   - `--vllm-api-key '<PI_API_KEY>'`
   - optional `--mount '<mount command>'`
   - `--vllm '<release|nightly|gpt-oss>'`

   pod_setup.sh does:
     - Ensure Python / venv tooling
     - Install selected vLLM variant
     - Create ~/.vllm_logs/ directory
     - Configure HuggingFace auth and API key
     - Optional mount command execution

6. Detect GPU inventory:
   sshExec(sshCmd, "nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader")
   Parse lines into `{ id, name, memory }` (memory remains textual from nvidia-smi output)

7. Save pod config with `modelsPath` and `vllmVersion`; `addPod()` sets active when none exists
```

---

## Model Lifecycle (`src/commands/models.ts`)

### `startModel(modelId, name, options)`

```typescript
interface StartModelOptions {
  pod?: string;
  vllmArgs?: string[];
  memory?: string;   // e.g. "50%"
  context?: string;  // e.g. "32k" or numeric
  gpus?: number;     // only for predefined models
}
```

**Algorithm:**

```
1. Resolve active pod

2. Check model name not already in pod.models

3. Determine port:
   port = getNextPort(pod)  // starts at 8001, increments until unused

4. Determine GPU allocation and vLLM args:
   - If `options.vllmArgs`: use as-is and skip model-based GPU planning
   - Else if known model:
     - with `options.gpus`: require matching `getModelConfig(modelId, pod.gpus, options.gpus)`
     - without `options.gpus`: search from pod GPU count down to 1 for compatible config
     - GPU ids chosen by `selectGPUs(pod, gpuCount)`
     - base args from model config
   - Else (unknown model): reject `--gpus`, default to `selectGPUs(pod, 1)`

5. Apply `--memory` / `--context` overrides unless custom `--vllm` args are used

6. Substitute placeholders in `scripts/model_run.sh`:
    script = MODEL_RUN_TEMPLATE
      .replace("{{MODEL_ID}}", modelId)
      .replace("{{NAME}}", name)
      .replace("{{PORT}}", port)
      .replace("{{VLLM_ARGS}}", vllmArgs.join(" "))

7. Upload script and build runtime env exports (`HF_TOKEN`, `PI_API_KEY`, CUDA env, config env)

8. Launch wrapper script in background via `setsid` and capture PID

9. Save running model in config immediately: `{ model, port, gpu, pid }`

10. Stream startup logs through SSH tail, detect:
    - success: "Application startup complete"
    - failures: OOM, wrapper/script non-zero exit, engine initialization failures
    On failure: remove model from config and exit non-zero

11. On success print endpoint and export snippets:
    "Model {name} is running at http://{host}:{port}/v1"
    "export OPENAI_BASE_URL=http://{host}:{port}/v1"
    "export OPENAI_API_KEY={pi_api_key}"
```

### `stopModel(name)`

```
1. Get pod.models[name]
2. sshExec(sshCmd, `pkill -TERM -P ${model.pid}`)
3. delete pod.models[name]
4. saveConfig(config)
```

### `stopAllModels()`

```
Kill all tracked wrapper PIDs and clear pod.models in config
```

### `listModels()`

```
Print configured model rows (name, model id, port, GPUs, pid, URL), then verify each model by:
  - process existence (`ps -p pid`)
  - health endpoint (`curl .../health`)
  - recent log errors (tail + grep)
Statuses: running / starting / crashed / dead
```

### `viewLogs(name)`

```
sshExecStream(sshCmd, `tail -f ~/.vllm_logs/${name}.log`, (line) => process.stdout.write(line + "\n"))
```

Streams until Ctrl+C (SIGINT).

---

## GPU Allocation (`selectGPUs`)

```typescript
function selectGPUs(
  pod: Pod,
  count?: number,
): number[]
```

**Algorithm:**

```
1. Count current GPU usage across all running models:
   usageCounts: Map<gpuId, number> = {}
   For each running model:
     For each gpu in model.gpu:
       usageCounts[gpu]++

2. If `count === pod.gpus.length`, return all GPU IDs directly

3. Sort by usage (ascending — least used first):
   available.sort((a, b) => (usageCounts[a.id] || 0) - (usageCounts[b.id] || 0))

4. Take first `count` GPUs:
   return available.slice(0, count).map(g => g.id)
```

---

## Port Allocation (`getNextPort`)

```typescript
function getNextPort(pod: Pod): number
```

```
usedPorts = new Set(Object.values(pod.models).map(m => m.port))
port = 8001
while usedPorts.has(port): port++
return port
```

---

## Model Configs (`src/model-configs.ts`)

### `getModelConfig(modelId, gpus, requestedGpuCount)`

```typescript
interface ModelConfig {
  gpuCount: number;
  gpuTypes?: string[];
  args: string[];
  env?: Record<string, string>;
  notes?: string;
}

function getModelConfig(
  modelId: string,
  gpus: GPU[],
  requestedGpuCount?: number,
): ModelConfig | null
```

**Selection algorithm:**
```
configs = KNOWN_MODELS[modelId] (sorted by gpuCount ascending)
if not found: return null

if requestedGpuCount:
  find config with gpuCount === requestedGpuCount
  if not found: find config with smallest gpuCount >= requestedGpuCount
else:
  detectedGpuType = gpus[0]?.name (if all same type)
  find first config whose gpuTypes[] includes detectedGpuType
  if not found: use config with smallest gpuCount
```

### Known Models (`models.json`)

| Model ID | Configs (GPU count × type) | Special args |
|---|---|---|
| `Qwen/Qwen2.5-Coder-32B-Instruct` | 1×H100, 1×H200, 2×H100, 2×H200 | `--max-model-len 32768` |
| `Qwen/Qwen3-Coder-30B-A3B-Instruct` | 1×H100, 1×H200, 2×H100, 2×H200 | standard |
| `Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8` | 1×H100, 1×H200 | `VLLM_USE_DEEP_GEMM=1` |
| `Qwen/Qwen3-Coder-480B-A35B-Instruct` | 8×H200, 8×H20 | `--tensor-parallel-size 8 --max-model-len 32000` |
| `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` | 8×H200, 8×H20 | data-parallel + expert-parallel flags |
| `openai/gpt-oss-20b` | 1×H100, 1×H200, 1×B200 | async-scheduling, gpt-oss vllm version |
| `openai/gpt-oss-120b` | 1/2/4/8×H100, 1/2/4/8×H200 | async-scheduling |
| `zai-org/GLM-4.5` | 16×H100, 8×H200 | TP, glm45 parsers |
| `zai-org/GLM-4.5-FP8` | 8×H100, 4×H200 | FP8 quantization |
| `zai-org/GLM-4.5-Air` | 2×H100, 2×H200, 1×H200 | standard |
| `zai-org/GLM-4.5-Air-FP8` | 2×H100, 1×H200 | XFORMERS attention |
| `moonshotai/Kimi-K2-Instruct` | 16×H200, 16×H20 | `--tensor-parallel-size 16 --kimi_k2` parser |

### vLLM Version Variants

| Variant | Description |
|---|---|
| `"release"` | Latest stable vLLM ≥ 0.10.0 |
| `"nightly"` | Latest vLLM nightly build |
| `"gpt-oss"` | vLLM 0.10.1+gptoss with PyTorch nightly (for GPT-OSS models only) |

---

## SSH Utilities (`src/ssh.ts`)

```typescript
interface SSHResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface SSHOptions {
  timeout?: number;  // ms; default: 30000
  signal?: AbortSignal;
}

// Execute a command and return result
async function sshExec(
  sshCmd: string,           // e.g., "ssh root@1.2.3.4"
  command: string,
  options?: SSHOptions,
): Promise<SSHResult>

// Execute and stream output line-by-line
async function sshExecStream(
  sshCmd: string,
  command: string,
  onLine: (line: string) => void,
  options?: SSHOptions,
): Promise<number>  // exit code

// Copy a local file to remote via SCP
async function scpFile(
  sshCmd: string,
  localPath: string,
  remotePath: string,
): Promise<boolean>
```

**Implementation:** Uses `spawn("ssh", [...sshCmdParts, command])` directly — no SSH library dependency, relies on system OpenSSH binary.  
**SCP:** Uses `spawn("scp", [localPath, `${host}:${remotePath}`])`.

---

## `pod_setup.sh` (Remote Setup Script)

```bash
#!/bin/bash
# Executed on remote pod after scp

# Install Python 3.11 if needed
# Install pip
# Install vLLM:
#   release: pip install vllm>=0.10.0
#   nightly: pip install vllm-nightly
#   gpt-oss: pip install vllm==0.10.1+gptoss --extra-index-url ...
# Create ~/.vllm_logs/
# If HF_TOKEN set: huggingface-cli login --token $HF_TOKEN
# If PI_API_KEY set: echo $PI_API_KEY > ~/.pi_api_key
```

## `model_run.sh` Template

```bash
#!/bin/bash
# Template substituted at model start time:
# {MODEL_ID}, {NAME}, {PORT}, {GPUS}, {VLLM_ARGS}, {ENV_VARS}

export CUDA_VISIBLE_DEVICES={GPUS}
{ENV_VARS}

python -m vllm.entrypoints.openai.api_server \
  --model {MODEL_ID} \
  --port {PORT} \
  --api-key $(cat ~/.pi_api_key 2>/dev/null || echo "no-key") \
  {VLLM_ARGS}
```

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `HF_TOKEN` | HuggingFace token for model downloads (passed to pod during setup) |
| `PI_API_KEY` | API key set on vLLM endpoints (passed to pod during setup) |
| `PI_CONFIG_DIR` | Config directory override (default: `~/.pi`) |

---

## Public Exports (`index.ts`)

```typescript
export type { GPU, Model, Pod, Config } from "./types.js";
```

Only types are exported. The CLI is the sole user interface.
