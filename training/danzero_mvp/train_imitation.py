from __future__ import annotations

import argparse
import json
import os
import platform
import random
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch import Tensor
from torch.utils.data import DataLoader, Dataset

from policy_value_net import LegalActionPolicyValueNet


def pick_device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def read_command_output(command: list[str]) -> str | None:
    try:
        return subprocess.check_output(command, text=True).strip()
    except Exception:
        return None


def read_system_info(device: torch.device) -> dict:
    chip_name = read_command_output(["sysctl", "-n", "machdep.cpu.brand_string"])
    if not chip_name:
        chip_name = read_command_output(["sysctl", "-n", "hw.model"]) or platform.processor() or "unknown"

    memory_bytes = read_command_output(["sysctl", "-n", "hw.memsize"])
    total_memory_gb = None
    if memory_bytes and memory_bytes.isdigit():
        total_memory_gb = round(int(memory_bytes) / (1024**3), 2)

    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": chip_name,
        "cpu_count": os.cpu_count(),
        "total_memory_gb": total_memory_gb,
        "device": str(device),
        "mps_built": bool(torch.backends.mps.is_built()),
        "mps_available": bool(torch.backends.mps.is_available()),
    }


def get_device_stats(device: torch.device) -> dict:
    stats: dict[str, float | int | None] = {}
    if device.type == "mps":
        try:
            stats["mps_current_allocated_mb"] = round(torch.mps.current_allocated_memory() / (1024**2), 2)
            stats["mps_driver_allocated_mb"] = round(torch.mps.driver_allocated_memory() / (1024**2), 2)
            stats["mps_recommended_max_mb"] = round(torch.mps.recommended_max_memory() / (1024**2), 2)
        except Exception:
            stats["mps_current_allocated_mb"] = None
            stats["mps_driver_allocated_mb"] = None
            stats["mps_recommended_max_mb"] = None
    return stats


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

    for index, sample in enumerate(batch):
        states[index] = torch.tensor(sample.state_features, dtype=torch.float32)
        action_targets[index] = sample.target_action_index
        value_targets[index] = sample.target_value

        for action_index, action_feature in enumerate(sample.action_features):
            actions[index, action_index] = torch.tensor(action_feature, dtype=torch.float32)
            legal_mask[index, action_index] = True

    return states, actions, legal_mask, action_targets, value_targets


def evaluate(
    model: LegalActionPolicyValueNet,
    loader: DataLoader[Sample],
    device: torch.device,
) -> tuple[float, float, float]:
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

            total_loss += loss.item() * states.size(0)
            total_value_loss += value_loss.item() * states.size(0)
            total_correct += int((torch.argmax(logits, dim=-1) == action_targets).sum().item())
            total_examples += states.size(0)

    return (
        total_loss / total_examples,
        total_correct / total_examples,
        total_value_loss / total_examples,
    )


def save_checkpoint(
    path: Path,
    model: LegalActionPolicyValueNet,
    optimizer: torch.optim.Optimizer,
    meta: dict,
) -> None:
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
    parser.add_argument("--output-dir", default="training/danzero_mvp/checkpoints/run_001")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--seed", type=int, default=20260413)
    parser.add_argument("--hidden-dim", type=int, default=256)
    parser.add_argument("--action-hidden-dim", type=int, default=128)
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    device = pick_device()
    train_dataset = JsonlDataset(args.train)
    valid_dataset = JsonlDataset(args.valid)

    state_dim = len(train_dataset[0].state_features)
    action_dim = len(train_dataset[0].action_features[0])

    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        shuffle=True,
        collate_fn=collate_batch,
    )
    valid_loader = DataLoader(
        valid_dataset,
        batch_size=args.batch_size,
        shuffle=False,
        collate_fn=collate_batch,
    )

    model = LegalActionPolicyValueNet(
        state_dim=state_dim,
        action_dim=action_dim,
        hidden_dim=args.hidden_dim,
        action_hidden_dim=args.action_hidden_dim,
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)

    output_dir = Path(args.output_dir)
    meta = {
        "state_dim": state_dim,
        "action_dim": action_dim,
        "hidden_dim": args.hidden_dim,
        "action_hidden_dim": args.action_hidden_dim,
        "seed": args.seed,
        "train_path": args.train,
        "valid_path": args.valid,
    }
    system_info = read_system_info(device)
    print(
        json.dumps(
            {
                "event": "training_start",
                "system": system_info,
                "train_samples": len(train_dataset),
                "valid_samples": len(valid_dataset),
                "batch_size": args.batch_size,
                "epochs": args.epochs,
                "model": {
                    "state_dim": state_dim,
                    "action_dim": action_dim,
                    "hidden_dim": args.hidden_dim,
                    "action_hidden_dim": args.action_hidden_dim,
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
            optimizer.step()

            total_loss += loss.item() * states.size(0)
            total_correct += int((torch.argmax(logits, dim=-1) == action_targets).sum().item())
            total_examples += states.size(0)

        train_loss = total_loss / total_examples
        train_acc = total_correct / total_examples
        valid_loss, valid_acc, valid_value_loss = evaluate(model, valid_loader, device)
        epoch_seconds = time.perf_counter() - epoch_start
        samples_per_second = total_examples / epoch_seconds if epoch_seconds > 0 else None

        epoch_record = {
            "epoch": epoch,
            "train_loss": round(train_loss, 6),
            "train_accuracy": round(train_acc, 6),
            "valid_loss": round(valid_loss, 6),
            "valid_accuracy": round(valid_acc, 6),
            "valid_value_loss": round(valid_value_loss, 6),
            "epoch_seconds": round(epoch_seconds, 3),
            "samples_per_second": round(samples_per_second, 2) if samples_per_second else None,
        }
        epoch_record.update(get_device_stats(device))
        history.append(epoch_record)
        save_checkpoint(output_dir / f"epoch_{epoch:03d}.pt", model, optimizer, meta)
        print(json.dumps(epoch_record), flush=True)

    with open(output_dir / "history.json", "w", encoding="utf8") as handle:
        json.dump(
            {
                "system": system_info,
                "history": history,
            },
            handle,
            indent=2,
        )


if __name__ == "__main__":
    main()
