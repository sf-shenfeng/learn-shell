// Whisper (multilingual) ASR via @huggingface/transformers v3+.
//
// 2026-07-01 speed brief: nothing goes on screen until Whisper
// returns a clean final transcript. Target ≤3s round-trip for a 10s
// utterance. Web Speech has been retired — its real-time interim text
// pulled the speaker's attention onto correction rather than expression.
//
// Speed levers pulled here:
//   1. WebGPU device — Chrome 113+, Edge, Arc. Fallback to WASM if
//      absent. On M3 the delta vs WASM is 3-10x.
//   2. q4 quantization — encoder fp16 (accuracy floor), decoder q4
//      (throughput). Effective weight ≈ 70 MB, decodes fast on GPU.
//   3. Singleton pipeline — first load pays download+init, subsequent
//      calls are warm. Preload from Review mount hides the cold hit.
//
// Chinese post-processing (Traditional → Simplified) unchanged — Whisper
// still emits zh-TW-leaning tokens; OpenCC keeps the textarea in zh-CN.
//
// Privacy: model weights fetched from huggingface.co on first run, then
// cached by the browser. Audio + transcript never leave the device.

let pipelinePromise: Promise<unknown> | null = null;
let t2sConverterPromise: Promise<(s: string) => string> | null = null;
let activeDevice: 'webgpu' | 'wasm' | null = null;

const WHISPER_MODEL = 'onnx-community/whisper-small';

export type WhisperProgress = (msg: string) => void;

async function getT2sConverter(): Promise<(s: string) => string> {
  if (!t2sConverterPromise) {
    t2sConverterPromise = (async () => {
      const OpenCC = await import('opencc-js');
      return OpenCC.Converter({ from: 'twp', to: 'cn' });
    })();
  }
  return t2sConverterPromise;
}

async function detectWebGPU(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

async function loadPipeline(onProgress?: WhisperProgress): Promise<unknown> {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    const t0 = performance.now();
    onProgress?.('Loading transformers.js…');
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    // Mirror override for networks where huggingface.co is unreachable
    // (e.g. VITE_HF_REMOTE_HOST=https://hf-mirror.com). Same path layout as
    // the default host — transformers.js appends /{model}/resolve/{rev}/.
    const mirrorHost = import.meta.env.VITE_HF_REMOTE_HOST as string | undefined;
    if (mirrorHost) env.remoteHost = mirrorHost;

    const webgpu = await detectWebGPU();
    activeDevice = webgpu ? 'webgpu' : 'wasm';
    onProgress?.(`Device: ${activeDevice.toUpperCase()}`);

    onProgress?.(`Downloading ${WHISPER_MODEL.split('/').pop()}…`);
    // encoder in fp16 (accuracy floor), decoder in q4 (throughput). On
    // WASM fallback we drop to q8 across the board — q4 without GPU
    // kernels can actually be slower than q8.
    const dtype = webgpu
      ? { encoder_model: 'fp16' as const, decoder_model_merged: 'q4' as const }
      : { encoder_model: 'q8' as const, decoder_model_merged: 'q8' as const };
    const pipe = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
      device: activeDevice,
      dtype,
      progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
        if (p.status === 'progress' && typeof p.progress === 'number') {
          onProgress?.(`Loading ${p.file ?? 'model'} ${Math.round(p.progress)}%`);
        } else if (p.status === 'done') {
          onProgress?.(`Loaded ${p.file ?? 'model'}`);
        }
      },
    });
    const loadMs = Math.round(performance.now() - t0);
    onProgress?.(`Ready (${activeDevice}, ${loadMs}ms)`);
    // eslint-disable-next-line no-console
    console.log(`[whisper] pipeline ready · device=${activeDevice} · load=${loadMs}ms`);
    return pipe;
  })();
  return pipelinePromise;
}

export interface WhisperResult {
  text: string;
  /** Milliseconds spent inside pipeline() (excludes model load). */
  inferenceMs: number;
  /** Backend that actually ran the inference. */
  device: 'webgpu' | 'wasm' | 'unknown';
}

/**
 * Initial prompt for the learner's dictation — CFA review + investment ops,
 * with heavy CJK-English code-switching.
 *
 * Two things this prompt does:
 *   1. Domain steering — seeded vocab primes Whisper to prefer domain
 *      senses of ambiguous phones over general ones ("现值" vs "限值",
 *      "贝塔" vs "杯塔", "折现" vs "这些").
 *   2. English token preservation — with language='chinese' locked,
 *      Whisper defaults to transliterating English acronyms into hanzi
 *      ("WACC"→"沃客", "AAOI"→"阿哦啊哎"). Any Latin token that appears
 *      in the prompt gets seeded in the decoder — those tokens then
 *      become preferred outputs when acoustic match is strong.
 *
 * Vocabulary lives in two files, joined at prompt-build time:
 *   - whisper-terms.default.ts — public, tracked, ships with LS
 *   - whisper-terms.local.ts   — per-user, GITIGNORED, holds personal
 *     terms (portfolio tickers, people's names, private project codes)
 *
 * The local file is loaded via import.meta.glob so fresh clones without
 * a local file still build; only its tracked terms appear in the prompt.
 *
 * Prompt token budget is 224 (Whisper hard cap). Default ships ≈ 160;
 * user's local additions have ~60 tokens of headroom.
 */
import {
  CJK_CONCEPTS,
  EN_TERMS,
  PROJECT_NAMES,
} from './whisper-terms.default';

// Load local terms if present. import.meta.glob returns an empty object
// when no matching file exists, so a missing local file degrades to
// empty arrays instead of a build error.
interface LocalTerms {
  PROJECT_NAMES_LOCAL?: string[];
  STOCK_SYMBOLS?: string[];
  PEOPLE?: string[];
  CJK_CONCEPTS_LOCAL?: string[];
  EN_TERMS_LOCAL?: string[];
}
const localModules = import.meta.glob<LocalTerms>('./whisper-terms.local.ts', {
  eager: true,
});
const local: LocalTerms = localModules['./whisper-terms.local.ts'] ?? {};

const buildPrompt = (): string => {
  const cjk = [...CJK_CONCEPTS, ...(local.CJK_CONCEPTS_LOCAL ?? [])];
  const en = [...EN_TERMS, ...(local.EN_TERMS_LOCAL ?? [])];
  const projects = [...PROJECT_NAMES, ...(local.PROJECT_NAMES_LOCAL ?? [])];
  const stocks = local.STOCK_SYMBOLS ?? [];
  const people = local.PEOPLE ?? [];

  const sections = [
    '以下是 CFA 财务与投资相关的中文语音复述，可能中英文混合。',
    cjk.length > 0 ? '中文概念：' + cjk.join('、') + '。' : '',
    en.length > 0 ? '英文术语：' + en.join(', ') + '.' : '',
    projects.length > 0 ? '项目：' + projects.join(', ') + '.' : '',
    stocks.length > 0 ? '股票代码：' + stocks.join(', ') + '.' : '',
    people.length > 0 ? '人物：' + people.join('、') + '。' : '',
  ].filter(Boolean);

  return sections.join(' ');
};

const CFA_BILINGUAL_PROMPT = buildPrompt();

/**
 * Transcribe an audio blob.
 * `language='chinese'` is the safe default for CFA review (locks the
 * detector to Chinese, avoids the "auto → translation" trap). English
 * tokens the speaker code-switches into are preserved via the initial prompt,
 * not language detection. Pass 'english' for English-only audio.
 */
export async function transcribeBlob(
  blob: Blob,
  opts: {
    language?: 'chinese' | 'english' | 'auto';
    onProgress?: WhisperProgress;
  } = {}
): Promise<WhisperResult> {
  const { language = 'chinese', onProgress } = opts;
  const transcriber = (await loadPipeline(onProgress)) as (
    audio: string,
    opts: Record<string, unknown>
  ) => Promise<{ text: string } | Array<{ text: string }>>;
  const url = URL.createObjectURL(blob);
  const t0 = performance.now();
  try {
    onProgress?.('Transcribing…');
    const out = await transcriber(url, {
      language: language === 'auto' ? undefined : language,
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
      // Domain + code-switching steering. See CFA_BILINGUAL_PROMPT comment.
      // English-only mode gets no prompt (would fight the language lock).
      ...(language === 'chinese'
        ? { initial_prompt: CFA_BILINGUAL_PROMPT }
        : {}),
      // Beam search — explores multiple decoding paths and picks the best.
      // 704ms greedy → ~1.5-2s at beam=3 in tests. Precision gain is
      // significant for homophones ("现值" vs "限值", "资产" vs "自产").
      num_beams: 3,
      // Anti-hallucination guards for laughter / hums / long single-word
      // stretches like "哈哈哈哈…". Without these Whisper can spiral into
      // a repeat loop that burns 5-7s of decoding for a nonsense output.
      // no_repeat_ngram_size hard-forbids repeating any 3-token window.
      no_repeat_ngram_size: 3,
      // Deterministic output — same audio, same transcript.
      do_sample: false,
    });
    const inferenceMs = Math.round(performance.now() - t0);
    let text = Array.isArray(out) ? out.map((p) => p.text).join(' ') : out.text;
    text = (text ?? '').trim();
    if (language === 'chinese' || language === 'auto') {
      try {
        const convert = await getT2sConverter();
        text = convert(text);
      } catch {
        /* OpenCC failed — return raw text */
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[whisper] transcribe · device=${activeDevice ?? 'unknown'} · ${blob.size}B ` +
        `· ${inferenceMs}ms · "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`
    );
    return { text, inferenceMs, device: activeDevice ?? 'unknown' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Pre-warm the model in the background. Optional. */
export function preloadWhisper(onProgress?: WhisperProgress): Promise<unknown> {
  return loadPipeline(onProgress);
}
