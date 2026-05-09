"""Export the bundled production ScoreNet checkpoint to ONNX for browser inference.

Produces:
  public/scorenet/scorenet.onnx
  public/scorenet/meta.json

After exporting it loads the ONNX model with onnxruntime and verifies that the
greedy chosen index matches PyTorch on a few random legal-action layouts. If
they ever disagree the script exits non-zero.

Usage (from repo root):
  .venv-danzero/bin/python training/scorenet/export_onnx.py

Override the source checkpoint with --checkpoint or the destination with
--out-dir.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "training" / "scorenet"))

from codec_config import MAX_ACTIONS  # noqa: E402
from scorenet import ScoreNet  # noqa: E402

DEFAULT_CHECKPOINT = (
    REPO_ROOT
    / "training"
    / "scorenet"
    / "checkpoints"
    / "stability_v3_20260503_180902"
    / "ppo_iter_080"
    / "ppo"
    / "epoch_010.pt"
)
DEFAULT_OUT_DIR = REPO_ROOT / "public" / "scorenet"


def load_checkpoint(path: Path) -> tuple[ScoreNet, dict]:
    payload = torch.load(path, map_location="cpu")
    meta = payload["meta"]
    model = ScoreNet(
        state_dim=meta["state_dim"],
        action_dim=meta["action_dim"],
        d_model=meta["d_model"],
        nhead=meta["nhead"],
        num_layers=meta["num_layers"],
        ff_dim=meta["ff_dim"],
    )
    model.load_state_dict(payload["model_state"])
    model.eval()
    return model, meta


def _wrap_for_export(model: ScoreNet) -> torch.nn.Module:
    class ScoreNetExportWrapper(torch.nn.Module):
        def __init__(self, inner: ScoreNet):
            super().__init__()
            self.inner = inner

        def forward(
            self,
            state_features: torch.Tensor,
            action_features: torch.Tensor,
            legal_mask_int: torch.Tensor,
        ) -> tuple[torch.Tensor, torch.Tensor]:
            # ONNX has no first-class bool padding mask, so the wrapper accepts
            # an int tensor and converts on the fly. The browser side passes
            # 0/1 ints for the same reason.
            legal_mask = legal_mask_int.bool()
            return self.inner(state_features, action_features, legal_mask)

    return ScoreNetExportWrapper(model).eval()


def export_onnx(model: ScoreNet, meta: dict, onnx_path: Path) -> None:
    state_dim = meta["state_dim"]
    action_dim = meta["action_dim"]

    state_example = torch.randn(1, state_dim, dtype=torch.float32)
    action_example = torch.randn(1, MAX_ACTIONS, action_dim, dtype=torch.float32)
    mask_example = torch.zeros(1, MAX_ACTIONS, dtype=torch.int64)
    mask_example[0, : MAX_ACTIONS // 2] = 1

    wrapper = _wrap_for_export(model)

    onnx_path.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        wrapper,
        (state_example, action_example, mask_example),
        str(onnx_path),
        input_names=["state_features", "action_features", "legal_mask"],
        output_names=["logits", "value"],
        dynamic_axes={
            "state_features": {0: "batch"},
            "action_features": {0: "batch"},
            "legal_mask": {0: "batch"},
            "logits": {0: "batch"},
            "value": {0: "batch"},
        },
        opset_version=17,
        do_constant_folding=True,
    )

    _inline_external_data(onnx_path)


def _inline_external_data(onnx_path: Path) -> None:
    """Re-pack any external-data tensors back into the .onnx file itself.

    Browser onnxruntime-web prefers a single file to fetch. The dynamo exporter
    spills weights into `<name>.onnx.data` once the model crosses a threshold;
    we load+rewrite the model with `save_as_external_data=False` and clean up
    the sidecar.
    """
    import onnx
    from onnx.external_data_helper import load_external_data_for_model

    sidecar = onnx_path.with_suffix(onnx_path.suffix + ".data")
    if not sidecar.exists():
        return

    model_proto = onnx.load(str(onnx_path), load_external_data=False)
    load_external_data_for_model(model_proto, str(onnx_path.parent))
    onnx.save_model(
        model_proto,
        str(onnx_path),
        save_as_external_data=False,
    )
    sidecar.unlink(missing_ok=True)


def parity_check(model: ScoreNet, meta: dict, onnx_path: Path, num_samples: int = 8) -> None:
    import onnxruntime as ort  # imported here so the script still works without it for export-only flows

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    state_dim = meta["state_dim"]
    action_dim = meta["action_dim"]

    rng = np.random.default_rng(seed=0)

    for sample_index in range(num_samples):
        legal_count = int(rng.integers(low=2, high=MAX_ACTIONS // 2))
        state_np = rng.standard_normal((1, state_dim), dtype=np.float32)
        action_np = rng.standard_normal((1, MAX_ACTIONS, action_dim), dtype=np.float32)
        mask_np = np.zeros((1, MAX_ACTIONS), dtype=np.int64)
        mask_np[0, :legal_count] = 1

        with torch.no_grad():
            torch_logits, torch_value = model(
                torch.from_numpy(state_np),
                torch.from_numpy(action_np),
                torch.from_numpy(mask_np).bool(),
            )

        ort_logits, ort_value = session.run(
            ["logits", "value"],
            {
                "state_features": state_np,
                "action_features": action_np,
                "legal_mask": mask_np,
            },
        )

        torch_logits_np = torch_logits.numpy()
        # Compare only the legal slice; -inf masked positions are sensitive to
        # tiny numerical differences in masking ops between backends.
        legal_slice = slice(0, legal_count)
        max_logit_diff = float(np.max(np.abs(torch_logits_np[:, legal_slice] - ort_logits[:, legal_slice])))
        max_value_diff = float(np.max(np.abs(torch_value.numpy() - ort_value)))

        torch_choice = int(np.argmax(torch_logits_np))
        ort_choice = int(np.argmax(ort_logits))

        print(
            f"sample {sample_index}: legal={legal_count} "
            f"max_logit_diff={max_logit_diff:.2e} max_value_diff={max_value_diff:.2e} "
            f"chosen torch={torch_choice} ort={ort_choice}",
        )

        if torch_choice != ort_choice:
            raise AssertionError(
                f"Sample {sample_index}: chosen index disagrees (torch={torch_choice}, ort={ort_choice})",
            )

        if max_logit_diff > 1e-3 or max_value_diff > 1e-3:
            raise AssertionError(
                f"Sample {sample_index}: numeric drift too large "
                f"(logit={max_logit_diff:.2e}, value={max_value_diff:.2e})",
            )


def write_meta(meta: dict, checkpoint: Path, onnx_path: Path, meta_path: Path) -> None:
    meta_payload = {
        "state_dim": meta["state_dim"],
        "action_dim": meta["action_dim"],
        "max_actions": MAX_ACTIONS,
        "d_model": meta["d_model"],
        "nhead": meta["nhead"],
        "num_layers": meta["num_layers"],
        "ff_dim": meta["ff_dim"],
        "checkpoint": str(checkpoint.relative_to(REPO_ROOT)),
        "checkpoint_label": _format_checkpoint_label(checkpoint),
        "onnx_path": f"/{onnx_path.relative_to(REPO_ROOT / 'public').as_posix()}",
    }
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta_payload, indent=2) + "\n", encoding="utf-8")


def _format_checkpoint_label(checkpoint: Path) -> str:
    parts = checkpoint.relative_to(REPO_ROOT / "training" / "scorenet" / "checkpoints").parts
    return "/".join(parts)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--samples", type=int, default=8, help="Parity-check sample count")
    args = parser.parse_args()

    checkpoint: Path = args.checkpoint.resolve()
    out_dir: Path = args.out_dir.resolve()

    if not checkpoint.exists():
        raise SystemExit(f"Checkpoint not found: {checkpoint}")

    print(f"Loading checkpoint: {checkpoint.relative_to(REPO_ROOT)}")
    model, meta = load_checkpoint(checkpoint)

    onnx_path = out_dir / "scorenet.onnx"
    meta_path = out_dir / "meta.json"

    print(f"Exporting ONNX -> {onnx_path.relative_to(REPO_ROOT)}")
    export_onnx(model, meta, onnx_path)

    print(f"Running parity check ({args.samples} samples)")
    parity_check(model, meta, onnx_path, num_samples=args.samples)

    write_meta(meta, checkpoint, onnx_path, meta_path)

    onnx_size_kb = onnx_path.stat().st_size / 1024
    print(
        f"OK  exported {onnx_size_kb:.1f} KiB -> {onnx_path.relative_to(REPO_ROOT)} "
        f"(meta: {meta_path.relative_to(REPO_ROOT)})",
    )


if __name__ == "__main__":
    main()
