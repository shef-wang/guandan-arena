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
    target_action_index: int
    target_value: float


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
                        target_action_index=data["target_action_index"],
                        target_value=data["target_value"],
                    )
                )
        if not self.samples:
            raise ValueError(f"No samples found in {path}")

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, index: int) -> Sample:
        return self.samples[index]


def collate_batch(batch: list[Sample]) -> tuple[Tensor, Tensor, Tensor, Tensor, Tensor]:
    batch_size = len(batch)
    max_actions = max(len(sample.action_features) for sample in batch)
    state_dim = len(batch[0].state_features)
    action_dim = len(batch[0].action_features[0])

    states = torch.zeros((batch_size, state_dim), dtype=torch.float32)
    actions = torch.zeros((batch_size, max_actions, action_dim), dtype=torch.float32)
    legal_mask = torch.zeros((batch_size, max_actions), dtype=torch.bool)
    action_targets = torch.zeros(batch_size, dtype=torch.long)
    value_targets = torch.zeros(batch_size, dtype=torch.float32)

    for idx, sample in enumerate(batch):
        states[idx] = torch.tensor(sample.state_features, dtype=torch.float32)
        action_targets[idx] = sample.target_action_index
        value_targets[idx] = sample.target_value
        for action_idx, action_feature in enumerate(sample.action_features):
            actions[idx, action_idx] = torch.tensor(action_feature, dtype=torch.float32)
            legal_mask[idx, action_idx] = True

    return states, actions, legal_mask, action_targets, value_targets


def evaluate(model: ScoreNet, loader: DataLoader[Sample], device: torch.device) -> tuple[float, float, float]:
    model.eval()
    total_loss = 0.0
    total_correct = 0
    total_examples = 0
    total_value_loss = 0.0

    with torch.no_grad():
        for states, actions, legal_mask, action_targets, value_targets in loader:
            states = states.to(device)
            actions = actions.to(device)
            legal_mask = legal_mask.to(device)
            action_targets = action_targets.to(device)
            value_targets = value_targets.to(device)

            logits, values = model(states, actions, legal_mask)
            policy_loss = F.cross_entropy(logits, action_targets)
            value_loss = F.mse_loss(values, value_targets)
            loss = policy_loss + 0.25 * value_loss

            batch_size = states.size(0)
            total_loss += loss.item() * batch_size
            total_value_loss += value_loss.item() * batch_size
            total_correct += int((torch.argmax(logits, dim=-1) == action_targets).sum().item())
            total_examples += batch_size

    return (
        total_loss / max(total_examples, 1),
        total_correct / max(total_examples, 1),
        total_value_loss / max(total_examples, 1),
    )


def save_checkpoint(path: Path, model: ScoreNet, optimizer: torch.optim.Optimizer, meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "model_state": model.state_dict(),
            "optimizer_state": optimizer.state_dict(),
            "meta": meta,
        },
        path,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--valid", required=True)
    parser.add_argument("--output-dir", default="training/scorenet/checkpoints/imitation_run_001")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--seed", type=int, default=20260416)
    parser.add_argument("--learning-rate", type=float, default=8e-4)
    parser.add_argument("--d-model", type=int, default=128)
    parser.add_argument("--nhead", type=int, default=4)
    parser.add_argument("--num-layers", type=int, default=2)
    parser.add_argument("--ff-dim", type=int, default=256)
    parser.add_argument("--cpu-fraction", type=float, default=0.8)
    parser.add_argument("--mps-memory-fraction", type=float, default=0.8)
    parser.add_argument("--device", default=None)
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    device = pick_device(args.device)
    runtime_config = configure_runtime(device, args.cpu_fraction, args.mps_memory_fraction)
    train_dataset = JsonlDataset(args.train)
    valid_dataset = JsonlDataset(args.valid)

    state_dim = len(train_dataset[0].state_features)
    action_dim = len(train_dataset[0].action_features[0])

    train_loader = DataLoader(train_dataset, batch_size=args.batch_size, shuffle=True, collate_fn=collate_batch)
    valid_loader = DataLoader(valid_dataset, batch_size=args.batch_size, shuffle=False, collate_fn=collate_batch)

    model = ScoreNet(
        state_dim=state_dim,
        action_dim=action_dim,
        d_model=args.d_model,
        nhead=args.nhead,
        num_layers=args.num_layers,
        ff_dim=args.ff_dim,
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-4)

    output_dir = Path(args.output_dir)
    meta = {
        "state_dim": state_dim,
        "action_dim": action_dim,
        "d_model": args.d_model,
        "nhead": args.nhead,
        "num_layers": args.num_layers,
        "ff_dim": args.ff_dim,
        "seed": args.seed,
        "train_path": args.train,
        "valid_path": args.valid,
    }
    system_info = read_system_info(device)

    print(
        json.dumps(
            {
                "event": "imitation_training_start",
                "system": system_info,
                "runtime": runtime_config,
                "train_samples": len(train_dataset),
                "valid_samples": len(valid_dataset),
                "batch_size": args.batch_size,
                "epochs": args.epochs,
                "model": {
                    "state_dim": state_dim,
                    "action_dim": action_dim,
                    "d_model": args.d_model,
                    "nhead": args.nhead,
                    "num_layers": args.num_layers,
                    "ff_dim": args.ff_dim,
                },
            }
        ),
        flush=True,
    )

    history: list[dict] = []
    save_checkpoint(output_dir / "epoch_000.pt", model, optimizer, meta)

    for epoch in range(1, args.epochs + 1):
        model.train()
        total_loss = 0.0
        total_correct = 0
        total_examples = 0
        epoch_start = time.perf_counter()

        for states, actions, legal_mask, action_targets, value_targets in train_loader:
            states = states.to(device)
            actions = actions.to(device)
            legal_mask = legal_mask.to(device)
            action_targets = action_targets.to(device)
            value_targets = value_targets.to(device)

            logits, values = model(states, actions, legal_mask)
            policy_loss = F.cross_entropy(logits, action_targets)
            value_loss = F.mse_loss(values, value_targets)
            loss = policy_loss + 0.25 * value_loss

            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()

            batch_size = states.size(0)
            total_loss += loss.item() * batch_size
            total_correct += int((torch.argmax(logits, dim=-1) == action_targets).sum().item())
            total_examples += batch_size

        train_loss = total_loss / max(total_examples, 1)
        train_acc = total_correct / max(total_examples, 1)
        valid_loss, valid_acc, valid_value_loss = evaluate(model, valid_loader, device)
        epoch_seconds = time.perf_counter() - epoch_start
        samples_per_second = total_examples / epoch_seconds if epoch_seconds > 0 else None

        record = {
            "epoch": epoch,
            "train_loss": round(train_loss, 6),
            "train_accuracy": round(train_acc, 6),
            "valid_loss": round(valid_loss, 6),
            "valid_accuracy": round(valid_acc, 6),
            "valid_value_loss": round(valid_value_loss, 6),
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
