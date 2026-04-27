from __future__ import annotations

import math
import warnings

import torch
from torch import Tensor, nn


class ScoreNet(nn.Module):
    def __init__(
        self,
        state_dim: int,
        action_dim: int,
        d_model: int = 128,
        nhead: int = 4,
        num_layers: int = 2,
        ff_dim: int = 256,
        dropout: float = 0.05,
    ) -> None:
        super().__init__()
        self.state_encoder = nn.Sequential(
            nn.Linear(state_dim, d_model),
            nn.LayerNorm(d_model),
            nn.ReLU(),
            nn.Linear(d_model, d_model),
            nn.LayerNorm(d_model),
            nn.ReLU(),
        )

        self.action_encoder = nn.Sequential(
            nn.Linear(action_dim, d_model),
            nn.LayerNorm(d_model),
            nn.ReLU(),
            nn.Linear(d_model, d_model),
            nn.LayerNorm(d_model),
            nn.ReLU(),
        )

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=nhead,
            dim_feedforward=ff_dim,
            dropout=dropout,
            batch_first=True,
            norm_first=True,
        )
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message=".*enable_nested_tensor is True.*",
                category=UserWarning,
            )
            self.transformer = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)

        self.policy_head = nn.Linear(d_model, 1)
        self.value_head = nn.Sequential(
            nn.Linear(d_model, d_model),
            nn.ReLU(),
            nn.Linear(d_model, 1),
        )

        self._init_weights()

    def _init_weights(self) -> None:
        for module in self.modules():
            if isinstance(module, nn.Linear):
                nn.init.xavier_uniform_(module.weight, gain=1.0 / math.sqrt(3))
                if module.bias is not None:
                    nn.init.zeros_(module.bias)

    def forward(
        self,
        state_features: Tensor,
        action_features: Tensor,
        legal_mask: Tensor,
    ) -> tuple[Tensor, Tensor]:
        batch_size, num_actions, _ = action_features.shape

        state_latent = self.state_encoder(state_features)
        action_latent = self.action_encoder(action_features)

        cls_token = state_latent.unsqueeze(1)
        tokens = torch.cat([cls_token, action_latent], dim=1)

        cls_mask = torch.zeros(batch_size, 1, dtype=torch.bool, device=legal_mask.device)
        src_key_padding_mask = torch.cat([cls_mask, ~legal_mask], dim=1)
        tokens = self.transformer(tokens, src_key_padding_mask=src_key_padding_mask)

        action_tokens = tokens[:, 1 : num_actions + 1, :]
        logits = self.policy_head(action_tokens).squeeze(-1)
        logits = logits.masked_fill(~legal_mask, torch.finfo(logits.dtype).min)

        state_token = tokens[:, 0, :]
        values = self.value_head(state_token).squeeze(-1)

        return logits, values
