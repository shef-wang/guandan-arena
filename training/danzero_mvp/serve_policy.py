from __future__ import annotations

import argparse
import json
import sys

import torch
import torch.nn.functional as F

from policy_value_net import LegalActionPolicyValueNet
from runtime_utils import configure_runtime, pick_device
from codec_config import MAX_ACTIONS


def load_checkpoint(path: str, device: torch.device) -> tuple[LegalActionPolicyValueNet, dict]:
    payload = torch.load(path, map_location=device)
    meta = payload["meta"]
    model = LegalActionPolicyValueNet(
        state_dim=meta["state_dim"],
        action_dim=meta["action_dim"],
        hidden_dim=meta["hidden_dim"],
        action_hidden_dim=meta["action_hidden_dim"],
    ).to(device)
    model.load_state_dict(payload["model_state"])
    model.eval()
    return model, meta


def evaluate_request(model: LegalActionPolicyValueNet, device: torch.device, request: dict) -> dict:
    state = torch.tensor(request["state_features"], dtype=torch.float32, device=device).unsqueeze(0)
    raw_actions = request["action_features"]
    num_legal = len(raw_actions)
    padded = raw_actions + [[0.0] * len(raw_actions[0])] * (MAX_ACTIONS - num_legal) if num_legal < MAX_ACTIONS else raw_actions[:MAX_ACTIONS]
    actions = torch.tensor([padded], dtype=torch.float32, device=device)
    legal_mask = torch.zeros((1, MAX_ACTIONS), dtype=torch.bool, device=device)
    legal_mask[0, :num_legal] = True
    sample = bool(request.get("sample", False))
    temperature = max(float(request.get("temperature", 1.0)), 1e-4)

    with torch.no_grad():
        logits, values = model(state, actions, legal_mask)
        logits = logits / temperature
        log_probs = F.log_softmax(logits, dim=-1)
        probs = torch.exp(log_probs)
        if sample:
            chosen_tensor = torch.distributions.Categorical(probs=probs).sample()
        else:
            chosen_tensor = torch.argmax(logits, dim=-1)

        chosen_index = int(chosen_tensor.item())
        return {
            "chosen_index": chosen_index,
            "chosen_log_prob": float(log_probs[0, chosen_index].item()),
            "value": float(values.item()),
            "entropy": float((-(probs * log_probs).sum(dim=-1)).item()),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--device", default=None)
    parser.add_argument("--cpu-fraction", type=float, default=0.8)
    parser.add_argument("--mps-memory-fraction", type=float, default=0.8)
    args = parser.parse_args()

    device = pick_device(args.device)
    runtime = configure_runtime(device, args.cpu_fraction, args.mps_memory_fraction)

    model, meta = load_checkpoint(args.checkpoint, device)
    print(json.dumps({"ready": True, "device": str(device), "meta": meta, "runtime": runtime}), flush=True)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        request = json.loads(line)
        request_id = request["id"]
        try:
            response = evaluate_request(model, device, request)
            print(json.dumps({"id": request_id, **response}), flush=True)
        except Exception as exc:  # pragma: no cover - CLI surface
            print(json.dumps({"id": request_id, "error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
