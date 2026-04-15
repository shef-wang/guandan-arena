from __future__ import annotations

import math
import os
import platform
import subprocess

import torch


def pick_device(preferred: str | None = None) -> torch.device:
    if preferred:
        return torch.device(preferred)
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
