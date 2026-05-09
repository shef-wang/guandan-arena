/**
 * Browser-side ScoreNet inference. Loads the bundled ONNX file once on first
 * use, then reuses the InferenceSession for every move.
 *
 * The ONNX file is exported by `training/scorenet/export_onnx.py` and lives at
 * `public/scorenet/scorenet.onnx`, so it ships with the static frontend build
 * (works on Vercel as well as local dev — no Python required).
 *
 * `onnxruntime-web` is loaded via a dynamic import so the headless Node
 * bundles (`npm run arena:headless`, etc.) don't try to evaluate its
 * `import.meta.url`-based glue at module load time.
 */

type OrtModule = typeof import('onnxruntime-web');
type OrtTensor = import('onnxruntime-web').Tensor;
type OrtInferenceSession = import('onnxruntime-web').InferenceSession;

const ONNX_URL = '/scorenet/scorenet.onnx';
const META_URL = '/scorenet/meta.json';

let configured = false;

interface ScoreNetMeta {
  state_dim: number;
  action_dim: number;
  max_actions: number;
  d_model?: number;
  nhead?: number;
  num_layers?: number;
  ff_dim?: number;
  checkpoint?: string;
  checkpoint_label?: string;
}

interface SessionBundle {
  ort: OrtModule;
  session: OrtInferenceSession;
  meta: ScoreNetMeta;
}

let sessionPromise: Promise<SessionBundle> | null = null;

function configureRuntimeOnce(ort: OrtModule): void {
  if (configured) return;
  configured = true;
  // The Vite plugin in `vite.config.ts` copies ort-wasm-simd-threaded.{wasm,mjs}
  // into the static `/ort/` directory. Point onnxruntime-web at those exact
  // filenames; otherwise it tries the JSEP/WebGPU variant
  // (`ort-wasm-simd-threaded.jsep.mjs`) which we deliberately don't ship.
  ort.env.wasm.wasmPaths = {
    wasm: '/ort/ort-wasm-simd-threaded.wasm',
    mjs: '/ort/ort-wasm-simd-threaded.mjs',
  };
  // We're CPU-only (the model is tiny). Single-threaded keeps cross-origin
  // isolation requirements off the critical path; SharedArrayBuffer headers
  // aren't set on the simple Vercel deploy.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
}

async function loadSession(): Promise<SessionBundle> {
  const ort = (await import('onnxruntime-web')) as OrtModule;
  configureRuntimeOnce(ort);

  const [metaResponse, modelResponse] = await Promise.all([
    fetch(META_URL),
    fetch(ONNX_URL),
  ]);

  if (!metaResponse.ok) {
    throw new Error(`Failed to fetch ScoreNet meta (HTTP ${metaResponse.status})`);
  }
  if (!modelResponse.ok) {
    throw new Error(`Failed to fetch ScoreNet weights (HTTP ${modelResponse.status})`);
  }

  const meta = (await metaResponse.json()) as ScoreNetMeta;
  const modelBytes = new Uint8Array(await modelResponse.arrayBuffer());

  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });

  return { ort, session, meta };
}

export function getScoreNetSession(): Promise<SessionBundle> {
  if (!sessionPromise) {
    sessionPromise = loadSession().catch((error: unknown) => {
      // Reset so the next caller can retry instead of permanently failing.
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

export interface ScoreNetChoice {
  chosen_index: number;
  value: number;
  checkpoint_label: string;
}

/**
 * Run ScoreNet on the encoded turn and return the greedy chosen action index.
 *
 * The action arrays are zero-padded to `max_actions` (200 today) before the
 * tensor is built, exactly mirroring `training/scorenet/serve_policy.py`.
 */
export async function scoreNetChooseIndex(
  stateFeatures: number[],
  actionFeatures: number[][],
): Promise<ScoreNetChoice> {
  if (actionFeatures.length === 0) {
    throw new Error('ScoreNet: no legal actions provided.');
  }

  const { ort, session, meta } = await getScoreNetSession();
  const stateDim = meta.state_dim;
  const actionDim = meta.action_dim;
  const maxActions = meta.max_actions;

  if (stateFeatures.length !== stateDim) {
    throw new Error(
      `ScoreNet: state vector length ${stateFeatures.length} != model state_dim ${stateDim}.`,
    );
  }

  const numLegal = Math.min(actionFeatures.length, maxActions);
  const actionsBuffer = new Float32Array(maxActions * actionDim);
  for (let actionIndex = 0; actionIndex < numLegal; actionIndex += 1) {
    const row = actionFeatures[actionIndex];
    if (row.length !== actionDim) {
      throw new Error(
        `ScoreNet: action[${actionIndex}] length ${row.length} != model action_dim ${actionDim}.`,
      );
    }
    actionsBuffer.set(row, actionIndex * actionDim);
  }
  // Remaining padded slots stay zero, matching serve_policy.py's padding.

  const maskBuffer = new BigInt64Array(maxActions);
  for (let i = 0; i < numLegal; i += 1) {
    maskBuffer[i] = 1n;
  }

  const stateTensor: OrtTensor = new ort.Tensor('float32', Float32Array.from(stateFeatures), [1, stateDim]);
  const actionTensor: OrtTensor = new ort.Tensor('float32', actionsBuffer, [1, maxActions, actionDim]);
  const maskTensor: OrtTensor = new ort.Tensor('int64', maskBuffer, [1, maxActions]);

  const outputs = await session.run({
    state_features: stateTensor,
    action_features: actionTensor,
    legal_mask: maskTensor,
  });

  const logits = outputs.logits.data as Float32Array;
  const value = (outputs.value.data as Float32Array)[0];

  let bestIndex = 0;
  let bestLogit = -Infinity;
  // Only consider the legal slice; padded positions hold the masked sentinel
  // value but checking the bounds explicitly avoids relying on -inf representation.
  for (let i = 0; i < numLegal; i += 1) {
    const candidate = logits[i];
    if (candidate > bestLogit) {
      bestLogit = candidate;
      bestIndex = i;
    }
  }

  return {
    chosen_index: bestIndex,
    value,
    checkpoint_label: meta.checkpoint_label ?? meta.checkpoint ?? 'ScoreNet PPO',
  };
}

export async function getScoreNetCheckpointLabel(): Promise<string> {
  const { meta } = await getScoreNetSession();
  return meta.checkpoint_label ?? meta.checkpoint ?? 'ScoreNet PPO';
}
