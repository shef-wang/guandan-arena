# PPO Experiment Results

Date: 2026-04-13

## Machine and Runtime

- Machine: Apple `M2 Pro`
- Memory: `16 GB`
- PPO resource settings:
  - `cpu_fraction=0.8`
  - `torch_num_threads=9`
  - `torch_num_interop_threads=6`
  - `mps_memory_fraction=0.8`

## Run 1

Starting checkpoint:

- `training/danzero_mvp/checkpoints/legacy_imitation_full_run1/epoch_006.pt`

Self-play rollout:

- Matches: `96`
- Temperature: `0.9`
- Samples: `8661`

PPO settings:

- Epochs: `6`
- Batch size: `512`
- Learning rate: `3e-4`
- Clip epsilon: `0.15`
- Entropy coef: `0.01`

Fixed seed eval block A:

- Seed: `20380001`
- Matches: `20`
- `epoch_000`: `4/20` (`20%`)
- `epoch_002`: `5/20` (`25%`)
- `epoch_004`: `8/20` (`40%`)
- `epoch_006`: `8/20` (`40%`)

Fixed seed eval block B:

- Seed: `20390001`
- Matches: `40`
- `epoch_000`: `11/40` (`27.5%`)
- `epoch_004`: `10/40` (`25%`)
- `epoch_006`: `9/40` (`22.5%`)

Takeaway:

- PPO run 1 produced a visible lift on one seed block.
- The lift did not hold on a longer second block.
- This looks more like unstable gain than robust improvement.

## Run 2

Starting checkpoint:

- `training/danzero_mvp/checkpoints/legacy_imitation_full_run1/epoch_006.pt`

Self-play rollout:

- Matches: `192`
- Temperature: `0.85`
- Samples: `17049`

PPO settings:

- Epochs: `4`
- Batch size: `512`
- Learning rate: `1e-4`
- Clip epsilon: `0.12`
- Entropy coef: `0.008`

Fixed seed eval block A:

- Seed: `20380001`
- Matches: `20`
- `epoch_000`: `4/20` (`20%`)
- `epoch_004`: `4/20` (`20%`)

Takeaway:

- The more conservative PPO run was more stable in training metrics.
- It did not improve win rate over the starting checkpoint on the tested block.

## Current Conclusion

- Self-play PPO is wired up and running on Apple Silicon with MPS.
- We can keep CPU and GPU headroom by capping CPU threads and MPS memory fraction.
- PPO can improve win rate on some fixed seed blocks, but the gain is not yet robust.
- The next likely step is stronger rollout targets:
  - larger self-play batches
  - opponent pools, not only pure self-play
  - periodic evaluation against both `legacy-v1` and frozen historical checkpoints
