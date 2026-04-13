from __future__ import annotations

import random
from dataclasses import dataclass

import torch
import torch.nn.functional as F

from policy_value_net import LegalActionPolicyValueNet


STATE_DIM = 128
ACTION_DIM = 32
MAX_ACTIONS = 64
BATCH_SIZE = 16
STEPS = 20


@dataclass
class Batch:
    state_features: torch.Tensor
    action_features: torch.Tensor
    legal_mask: torch.Tensor
    target_action_index: torch.Tensor
    target_value: torch.Tensor


def pick_device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def create_synthetic_batch(device: torch.device) -> Batch:
    state_features = torch.randn(BATCH_SIZE, STATE_DIM, device=device)
    action_features = torch.randn(BATCH_SIZE, MAX_ACTIONS, ACTION_DIM, device=device)
    legal_mask = torch.zeros(BATCH_SIZE, MAX_ACTIONS, dtype=torch.bool, device=device)
    target_action_index = []

    for batch_index in range(BATCH_SIZE):
        legal_count = random.randint(2, MAX_ACTIONS)
        legal_mask[batch_index, :legal_count] = True
        target_action_index.append(random.randint(0, legal_count - 1))

    target_value = torch.empty(BATCH_SIZE, device=device).uniform_(-3.0, 3.0)

    return Batch(
        state_features=state_features,
        action_features=action_features,
        legal_mask=legal_mask,
        target_action_index=torch.tensor(target_action_index, dtype=torch.long, device=device),
        target_value=target_value,
    )


def main() -> None:
    device = pick_device()
    print(f"device={device}")
    print(f"mps_built={torch.backends.mps.is_built()}")
    print(f"mps_available={torch.backends.mps.is_available()}")

    model = LegalActionPolicyValueNet(
        state_dim=STATE_DIM,
        action_dim=ACTION_DIM,
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)

    for step in range(1, STEPS + 1):
        batch = create_synthetic_batch(device)
        logits, value = model(
            batch.state_features,
            batch.action_features,
            batch.legal_mask,
        )
        policy_loss = F.cross_entropy(logits, batch.target_action_index)
        value_loss = F.mse_loss(value, batch.target_value)
        loss = policy_loss + 0.25 * value_loss

        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()

        if step == 1 or step == STEPS or step % 5 == 0:
            print(
                f"step={step} "
                f"loss={loss.item():.4f} "
                f"policy={policy_loss.item():.4f} "
                f"value={value_loss.item():.4f}"
            )

    print("smoke_train_complete=true")


if __name__ == "__main__":
    main()
