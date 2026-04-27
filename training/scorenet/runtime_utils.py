from __future__ import annotations

import math
import os
import platform
import subprocess
import sys

import torch


def _mps_unavailable_reason() -> str:
    if not torch.backends.mps.is_built():
        return "PyTorch was not built with MPS support (install a torch build with MPS)."
    if not torch.backends.mps.is_available():
        return (
            "MPS is built but runtime reports unavailable. "
            "On macOS this usually means the process has no Metal/GPU access "
            "(e.g. sandboxed shell, remote ssh without GUI session, or incompatible OS/torch)."
        )
    return ""


def pick_device(preferred: str | None = None) -> torch.device:
    """Resolve the torch device to use for ScoreNet training/inference.

    Behavior:
    - If `preferred` is explicitly set (or SCORENET_DEVICE env var), honor it.
      Asking for "mps" when MPS is unavailable raises RuntimeError so training
      never silently falls back to CPU.
    - If no preference is given, prefer MPS when available; otherwise CPU
      with a loud stderr warning that includes the reason.
    """
    requested = preferred or os.environ.get("SCORENET_DEVICE") or None

    if requested:
        requested_lower = requested.lower()
        if requested_lower == "mps" and not torch.backends.mps.is_available():
            raise RuntimeError(
                f"Requested device 'mps' is not available: {_mps_unavailable_reason()} "
                "Run outside the Cursor sandbox (or run training in a normal Terminal on macOS), "
                "or pass --device cpu to proceed without GPU."
            )
        return torch.device(requested_lower)

    if torch.backends.mps.is_available():
        return torch.device("mps")

    print(
        "[runtime_utils] WARNING: MPS unavailable, falling back to CPU. "
        f"Reason: {_mps_unavailable_reason()} "
        "Set --device mps (or SCORENET_DEVICE=mps) to make this an error instead.",
        file=sys.stderr,
        flush=True,
    )
    return torch.device("cpu")


def read_command_output(command: list[str]) -> str | None:
    try:
        return subprocess.check_output(command, text=True, stderr=subprocess.DEVNULL).strip()
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


def configure_runtime(
    device: torch.device,
    cpu_fraction: float = 0.8,
    mps_memory_fraction: float = 0.8,
) -> dict:
    cpu_count = os.cpu_count() or 1
    bounded_cpu_fraction = min(max(cpu_fraction, 0.1), 1.0)
    threads = max(1, math.floor(cpu_count * bounded_cpu_fraction))
    interop_threads = max(1, min(threads, math.ceil(cpu_count * 0.5)))

    torch.set_num_threads(threads)
    try:
        torch.set_num_interop_threads(interop_threads)
    except RuntimeError:
        pass

    applied_mps_fraction = None
    if device.type == "mps" and hasattr(torch.mps, "set_per_process_memory_fraction"):
        bounded_mps_fraction = min(max(mps_memory_fraction, 0.1), 0.95)
        torch.mps.set_per_process_memory_fraction(bounded_mps_fraction)
        applied_mps_fraction = bounded_mps_fraction

    return {
        "cpu_fraction": bounded_cpu_fraction,
        "torch_num_threads": threads,
        "torch_num_interop_threads": interop_threads,
        "mps_memory_fraction": applied_mps_fraction,
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
