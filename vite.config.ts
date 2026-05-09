import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

const OPENROUTER_LOCAL_KEY_CANDIDATES = ['apikey/key.rtf', 'key.rtf', 'apikey/key', 'key'] as const;

/** Files onnxruntime-web needs to load alongside its main JS bundle. */
const ORT_RUNTIME_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
] as const;

const __dirname = dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

export default defineConfig({
  plugins: [react(), localDevApi(), copyOnnxRuntimeAssets()],
  resolve: {
    // Pick onnxruntime-web's lean CPU build (`ort.min.mjs`) instead of the
    // default bundled flavor that statically imports the 26 MB JSEP/WebGPU
    // wasm. We supply our own wasm via /ort/ so the bundled glue isn't needed.
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
});

/**
 * Local-dev convenience: surface the OpenRouter API key from the user's
 * `apikey/key.rtf` file so the Practice page can autopopulate without leaking
 * the key into the bundle.
 *
 * ScoreNet inference is in-browser ONNX (`public/scorenet/scorenet.onnx`) so
 * we no longer need a Python policy-server middleware here. The headless
 * training tooling still talks to `serve_policy.py` directly.
 */
function localDevApi() {
  return {
    name: 'local-dev-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split('?')[0];
        if (pathname !== '/api/openrouter/local-key') {
          next();
          return;
        }

        try {
          if (req.method === 'GET') {
            const localKey = resolveLocalOpenRouterKey();
            sendJson(res, {
              available: Boolean(localKey),
              key: localKey?.key ?? null,
              source: localKey?.source ?? null,
            });
            return;
          }

          sendJson(res, { error: 'Unsupported method.' }, 405);
        } catch (error) {
          sendJson(res, { error: error instanceof Error ? error.message : 'Unknown dev API error.' }, 500);
        }
      });
    },
  };
}

function sendJson(res: import('node:http').ServerResponse, body: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function resolveLocalOpenRouterKey(): { key: string; source: string } | null {
  for (const relativePath of OPENROUTER_LOCAL_KEY_CANDIDATES) {
    const absolutePath = resolve(process.cwd(), relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }

    const key = readOpenRouterKeyFile(absolutePath).replace(/\s+/g, '');
    if (key) {
      return {
        key,
        source: relative(process.cwd(), absolutePath),
      };
    }
  }

  return null;
}

function readOpenRouterKeyFile(absolutePath: string): string {
  if (absolutePath.endsWith('.rtf')) {
    try {
      return execFileSync('textutil', ['-convert', 'txt', '-stdout', absolutePath], { encoding: 'utf8' });
    } catch {
      // Fall back to raw file read if textutil fails.
    }
  }

  return readFileSync(absolutePath, 'utf8');
}

/**
 * Serve onnxruntime-web's WASM glue from `/ort/*`.
 *
 * In dev, files are streamed directly from `node_modules/onnxruntime-web/dist`
 * through middleware (not from `/public`, which Vite blocks for module
 * imports). In production builds, the same files are copied into `dist/ort/`.
 */
function copyOnnxRuntimeAssets(): Plugin {
  // The package's `exports` map blocks `require.resolve('onnxruntime-web/package.json')`,
  // so resolve a known dist file instead and walk back up to the package root.
  const distMjs = requireFromHere.resolve('onnxruntime-web');
  const ortPkgRoot = dirname(dirname(distMjs));
  const sourceDir = resolve(ortPkgRoot, 'dist');
  function copyToTarget(targetDir: string): void {
    mkdirSync(targetDir, { recursive: true });
    for (const file of ORT_RUNTIME_FILES) {
      const source = resolve(sourceDir, file);
      if (!existsSync(source)) {
        throw new Error(`onnxruntime-web is missing ${file} (looked for ${source})`);
      }
      copyFileSync(source, resolve(targetDir, file));
    }
  }

  return {
    name: 'copy-onnxruntime-assets',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split('?')[0];
        if (!pathname?.startsWith('/ort/')) {
          next();
          return;
        }

        const file = pathname.slice('/ort/'.length);
        if (!ORT_RUNTIME_FILES.includes(file as (typeof ORT_RUNTIME_FILES)[number])) {
          next();
          return;
        }

        const source = resolve(sourceDir, file);
        if (!existsSync(source)) {
          res.statusCode = 404;
          res.end('Not Found');
          return;
        }

        const contentType = file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8';
        res.statusCode = 200;
        res.setHeader('content-type', contentType);
        res.end(readFileSync(source));
      });
    },
    writeBundle() {
      copyToTarget(resolve(__dirname, 'dist/ort'));
    },
  };
}
