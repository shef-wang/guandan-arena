# Learned Agent Baseline Results

Date: 2026-04-13

## Setup

- Training data: `training/danzero_mvp/data/legacy_train_v1.jsonl`
  - Teacher: `legacy-v1`
  - Matches: `160`
  - Samples: `11755`
- Validation data: `training/danzero_mvp/data/legacy_valid_v1.jsonl`
  - Teacher: `legacy-v1`
  - Matches: `32`
  - Samples: `2367`
- Model: `training/danzero_mvp/policy_value_net.py`
- Training command:

```bash
.venv-danzero/bin/python training/danzero_mvp/train_imitation.py \
  --train training/danzero_mvp/data/legacy_train_v1.jsonl \
  --valid training/danzero_mvp/data/legacy_valid_v1.jsonl \
  --output-dir training/danzero_mvp/checkpoints/legacy_imitation_full_run1 \
  --epochs 8 \
  --batch-size 128 \
  --seed 20260413
```

## Training Metrics

- Epoch 1: train accuracy `0.7526`, valid accuracy `0.7719`
- Epoch 2: train accuracy `0.7904`, valid accuracy `0.7867`
- Epoch 4: train accuracy `0.8094`, valid accuracy `0.8141`
- Epoch 6: train accuracy `0.8598`, valid accuracy `0.8335`
- Epoch 8: train accuracy `0.8649`, valid accuracy `0.8475`

## Match Results vs `legacy-v1`

Fixed seed block: `BASE_SEED=20300001`, `MATCHES=20`

- `epoch_000`: learned `1/20` (`5%`)
- `epoch_002`: learned `5/20` (`25%`)
- `epoch_004`: learned `2/20` (`10%`)
- `epoch_006`: learned `7/20` (`35%`)
- `epoch_008`: learned `4/20` (`20%`)

Best checkpoint from this run: `epoch_006`

Confirmation block: `BASE_SEED=20310001`, `MATCHES=40`

- `epoch_000`: learned `1/40` (`2.5%`)
- `epoch_006`: learned `10/40` (`25%`)

## Takeaways

- The learned policy is improving over random initialization in direct play.
- Pure imitation of `legacy-v1` does not yet reach `legacy-v1` strength.
- Overtraining appears possible: win rate peaked before the last epoch in this run.
- The next likely improvement is to move from pure imitation to self-play fine-tuning or stronger action/value targets.
