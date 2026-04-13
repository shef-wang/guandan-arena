from __future__ import annotations

import torch
from torch import Tensor, nn


class LegalActionPolicyValueNet(nn.Module):
    def __init__(
        self,
        state_dim: int,
        action_dim: int,
        hidden_dim: int = 256,
        action_hidden_dim: int = 128,
    ) -> None:
        super().__init__()
        self.state_encoder = nn.Sequential(
            nn.Linear(state_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
        )
        self.action_encoder = nn.Sequential(
            nn.Linear(action_dim, action_hidden_dim),
            nn.ReLU(),
            nn.Linear(action_hidden_dim, action_hidden_dim),
            nn.ReLU(),
        )
        self.policy_head = nn.Sequential(
            nn.Linear(hidden_dim + action_hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, 1),
        )
        self.value_head = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, 1),
        )

    def forward(
        self,
        state_features: Tensor,
        action_features: Tensor,
        legal_mask: Tensor,
    ) -> tuple[Tensor, Tensor]:
        state_latent = self.state_encoder(state_features)
        action_latent = self.action_encoder(action_features)

        repeated_state = state_latent.unsqueeze(1).expand(-1, action_latent.shape[1], -1)
        joint = torch.cat([repeated_state, action_latent], dim=-1)
        logits = self.policy_head(joint).squeeze(-1)
        logits = logits.masked_fill(~legal_mask, torch.finfo(logits.dtype).min)

        value = self.value_head(state_latent).squeeze(-1)
        return logits, value
