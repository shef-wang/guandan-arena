from __future__ import annotations

import argparse
import json
import random
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch import Tensor
from torch.utils.data import DataLoader, Dataset

from runtime_utils import configure_runtime, get_device_stats, pick_device, read_system_info
from scorenet import ScoreNet


@dataclass
class Sample:
    state_features: list[float]
    action_features: list[list[float]]
    chosen_action_index: int
    old_log_prob: float
    old_value: float
    target_return: float
    advantage: float
    entropy: float


class JsonlDataset(Dataset[Sample]):
    def __init__(self, path: str) -> None:
        self.samples: list[Sample] = []
        with open(path, "r", encoding="utf8") as handle:
            for line in handle:
                raw = line.strip()
                if not raw:
                    continue
                data = json.loads(raw)
                self.samples.append(
                    Sample(
                        state_features=data["state_features"],
                        action_features=data["action_features"],
                        chosen_action_index=data["chosen_action_index"],
                        old_log_prob=data["old_log_prob"],
                        old_value=data["old_value"],
                        target_return=data["target_return"],
                        advantage=data["advantage"],
                        entropy=data.get("entropy", 0.0),
                    )
                )
        if not self.samples:
            raise ValueError(f"No samples found in {path}")

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, index: int) -> Sample:
        return self.samples[index]


def collate_batch(batch: list[Sample]) -> tuple[Tensor, Tensor, Tensor, Tensor, Tensor, Tensor, Tensor]:
    batch_size = len(batch)
    max_actions = max(len(sample.action_features) for sample in batch)
    state_dim = len(batch[0].state_features)
    action_dim = len(batch[0].action_features[0])

    states = torch.zeros((batch_size, state_dim), dtype=torch.float32)
    actions = torch.zeros((batch_size, max_actions, action_dim), dtype=torch.float32)
    legal_mask = torch.zeros((batch_size, max_actions), dtype=torch.bool)
    chosen_action_indices = torch.zeros(batch_size, dtype=torch.long)
    old_log_probs = torch.zeros(batch_size, dtype=torch.float32)
    target_returns = torch.zeros(batch_size, dtype=torch.float32)
    advantages = torch.zeros(batch_size, dtype=torch.float32)

    for idx, sample in enumerate(batch):
        states[idx] = torch.tensor(sample.state_features, dtype=torch.float32)
        chosen_action_indices[idx] = sample.chosen_action_index
        old_log_probs[idx] = sample.old_log_prob
        target_returns[idx] = sample.target_return
        advantages[idx] = sample.advantage
        for action_idx, action_feature in enumerate(sample.action_features):
            actions[idx, action_idx] = torch.tensor(action_feature, dtype=torch.float32)
            legal_mask[idx, action_idx] = True

    return states, actions, legal_mask, chosen_action_indices, old_log_probs, target_returns, advantages


def load_checkpoint(path: str, device: torch.device) -> tuple[ScoreNet, dict]:
    payload = torch.load(path, map_location=device)
    meta = payload["meta"]
    model = ScoreNet(
        state_dim=meta["state_dim"],
        action_dim=meta["action_dim"],
        d_model=meta["d_model"],
        nhead=meta["nhead"],
        num_layers=meta["num_layers"],
        ff_dim=meta["ff_dim"],
    ).to(device)
    model.load_state_dict(payload["model_state"])
    return model, meta


def save_checkpoint(path: Path, model: ScoreNet, optimizer: torch.optim.Optimizer, meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"model_state": model.state_dict(), "optimizer_state": optimizer.state_dict(), "meta": meta}, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rollout", required=True)
    parser.add_argument("--init-checkpoint", required=True)
    parser.add_argument("--output-dir", default="training/scorenet/checkpoints/ppo_run_001")
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--seed", type=int, default=20260416)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--clip-eps", type=float, default=0.15)
    parser.add_argument("--entropy-coef", type=float, default=0.01)
    parser.add_argument("--value-coef", type=float, default=0.5)
    parser.add_argument("--max-grad-norm", type=float, default=1.0)
    parser.add_argument("--cpu-fraction", type=float, default=0.8)
    parser.add_argument("--mps-memory-fraction", type=float, default=0.8)
    parser.add_argument("--device", default=None)
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    device = pick_device(args.device)
    runtime_config = configure_runtime(device, args.cpu_fraction, args.mps_memory_fraction)
    dataset = JsonlDataset(args.rollout)
    loader = DataLoader(dataset, batch_size=args.batch_size, shuffle=True, collate_fn=collate_batch)

    model, base_meta = load_checkpoint(args.init_checkpoint, device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    output_dir = Path(args.output_dir)

    meta = {
        **base_meta,
        "seed": args.seed,
        "ppo_rollout_path": args.rollout,
        "init_checkpoint": args.init_checkpoint,
        "clip_eps": args.clip_eps,
        "entropy_coef": args.entropy_coef,
        "value_coef": args.value_coef,
        "learning_rate": args.learning_rate,
    }
    system_info = read_system_info(device)

    print(
        json.dumps(
            {
                "event": "ppo_training_start",
                "system": system_info,
                "runtime": runtime_config,
                "samples": len(dataset),
                "batch_size": args.batch_size,
                "epochs": args.epochs,
                "init_checkpoint": args.init_checkpoint,
            }
        ),
        flush=True,
    )

    history: list[dict] = []
    save_checkpoint(output_dir / "epoch_000.pt", model, optimizer, meta)

    for epoch in range(1, args.epochs + 1):
        model.train()
        epoch_start = time.perf_counter()
        total_examples = 0
        total_policy_loss = 0.0
        total_value_loss = 0.0
        total_entropy = 0.0
        total_loss = 0.0
        total_ratio = 0.0
        total_clip_fraction = 0.0
        total_approx_kl = 0.0

        for states, actions, legal_mask, chosen_action_indices, old_log_probs, target_returns, advantages in loader:
            states = states.to(device)
            actions = actions.to(device)
            legal_mask = legal_mask.to(device)
            chosen_action_indices = chosen_action_indices.to(device)
            old_log_probs = old_log_probs.to(device)
            target_returns = target_returns.to(device)
            advantages = advantages.to(device)

            advantages = (advantages - advantages.mean()) / (advantages.std(unbiased=False) + 1e-8)

            logits, values = model(states, actions, legal_mask)
            log_probs = F.log_softmax(logits, dim=-1)
            chosen_log_probs = log_probs.gather(1, chosen_action_indices.unsqueeze(1)).squeeze(1)
            ratios = torch.exp(chosen_log_probs - old_log_probs)
            clipped_ratios = torch.clamp(ratios, 1.0 - args.clip_eps, 1.0 + args.clip_eps)

            surrogate_a = ratios * advantages
            surrogate_b = clipped_ratios * advantages
            policy_loss = -torch.min(surrogate_a, surrogate_b).mean()
            value_loss = F.mse_loss(values, target_returns)
            probs = torch.exp(log_probs)
            legal_probs = probs.masked_fill(~legal_mask, 0.0)
            legal_log_probs = log_probs.masked_fill(~legal_mask, 0.0)
            entropy = -(legal_probs * legal_log_probs).sum(dim=-1).mean()
            loss = policy_loss + args.value_coef * value_loss - args.entropy_coef * entropy

            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.max_grad_norm)
            optimizer.step()

            batch_size = states.size(0)
            total_examples += batch_size
            total_policy_loss += policy_loss.item() * batch_size
            total_value_loss += value_loss.item() * batch_size
            total_entropy += entropy.item() * batch_size
            total_loss += loss.item() * batch_size
            total_ratio += ratios.mean().item() * batch_size
            total_clip_fraction += ((ratios - 1.0).abs() > args.clip_eps).float().mean().item() * batch_size
            total_approx_kl += (old_log_probs - chosen_log_probs).mean().item() * batch_size

        epoch_seconds = time.perf_counter() - epoch_start
        samples_per_second = total_examples / epoch_seconds if epoch_seconds > 0 else None
        record = {
            "epoch": epoch,
            "loss": round(total_loss / max(total_examples, 1), 6),
            "policy_loss": round(total_policy_loss / max(total_examples, 1), 6),
            "value_loss": round(total_value_loss / max(total_examples, 1), 6),
            "entropy": round(total_entropy / max(total_examples, 1), 6),
            "mean_ratio": round(total_ratio / max(total_examples, 1), 6),
            "clip_fraction": round(total_clip_fraction / max(total_examples, 1), 6),
            "approx_kl": round(total_approx_kl / max(total_examples, 1), 6),
            "epoch_seconds": round(epoch_seconds, 3),
            "samples_per_second": round(samples_per_second, 2) if samples_per_second else None,
        }
        record.update(get_device_stats(device))
        history.append(record)
        save_checkpoint(output_dir / f"epoch_{epoch:03d}.pt", model, optimizer, meta)
        print(json.dumps(record), flush=True)

    with open(output_dir / "history.json", "w", encoding="utf8") as handle:
        json.dump({"system": system_info, "runtime": runtime_config, "history": history}, handle, indent=2)


if __name__ == "__main__":
    main()
