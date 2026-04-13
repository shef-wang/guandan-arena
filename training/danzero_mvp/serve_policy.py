from __future__ import annotations

import argparse
import json
import sys

import torch

from policy_value_net import LegalActionPolicyValueNet


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


def choose_index(model: LegalActionPolicyValueNet, device: torch.device, request: dict) -> int:
    state = torch.tensor(request["state_features"], dtype=torch.float32, device=device).unsqueeze(0)
    actions = torch.tensor(request["action_features"], dtype=torch.float32, device=device).unsqueeze(0)
    legal_mask = torch.ones((1, actions.shape[1]), dtype=torch.bool, device=device)

    with torch.no_grad():
      logits, _ = model(state, actions, legal_mask)
      return int(torch.argmax(logits, dim=-1).item())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--device", default=None)
    args = parser.parse_args()

    if args.device:
        device = torch.device(args.device)
    elif torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")

    model, meta = load_checkpoint(args.checkpoint, device)
    print(json.dumps({"ready": True, "device": str(device), "meta": meta}), flush=True)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        request = json.loads(line)
        request_id = request["id"]
        try:
            chosen_index = choose_index(model, device, request)
            print(json.dumps({"id": request_id, "chosen_index": chosen_index}), flush=True)
        except Exception as exc:  # pragma: no cover - CLI surface
            print(json.dumps({"id": request_id, "error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
