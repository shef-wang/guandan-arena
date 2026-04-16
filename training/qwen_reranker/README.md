# Qwen-7B Reranker Training

Fine-tune Qwen-7B to rerank candidate actions from legacy-v1, using QLoRA
to fit in 24GB (Mac Mini M3 Pro).

## Pipeline

1. **Export SFT dataset** (`export_reranker_sft.ts`)
   - Run games with `legacy-v1` teacher
   - For each turn, rank candidates via `rankLegacyV1ActionCandidates`
   - Format as chat: system prompt + state → JSON action choice
   - Output: JSONL with `{"messages": [...]}` format for SFT

2. **Train QLoRA** (`train_qlora.py`)
   - Load Qwen-2.5-7B-Instruct (4-bit quantized)
   - LoRA on attention layers (r=16, alpha=32)
   - Train on SFT dataset
   - Save adapter weights

3. **Serve for inference** (`serve_qwen_reranker.py`)
   - Load base model + LoRA adapter
   - Stdin/stdout JSON protocol (same as `serve_policy.py`)
   - Returns reranked action from candidates

4. **Evaluate** - Use existing headless runner with `llmreranker` mode

## Requirements

```bash
pip install torch transformers peft bitsandbytes accelerate datasets
```

## Usage

```bash
# Step 1: Export SFT data
npx esbuild training/qwen_reranker/export_reranker_sft.ts --bundle --platform=node --format=cjs --outfile=/tmp/export_sft.cjs
MATCHES=500 BASE_SEED=20260413 OUTPUT_PATH=training/qwen_reranker/data/sft.jsonl node /tmp/export_sft.cjs

# Step 2: Train
python training/qwen_reranker/train_qlora.py \
  --data training/qwen_reranker/data/sft.jsonl \
  --output training/qwen_reranker/checkpoints/qlora_v1

# Step 3: Serve (plugs into arena via createLearnedPolicyAgent)
python training/qwen_reranker/serve_qwen_reranker.py \
  --base-model Qwen/Qwen2.5-7B-Instruct \
  --adapter training/qwen_reranker/checkpoints/qlora_v1
```
